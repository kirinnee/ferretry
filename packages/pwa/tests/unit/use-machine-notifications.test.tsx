import { describe, expect, it } from 'bun:test';
import type { PushDeviceView } from '@ferretry/protocol';

import { MachineNotificationList, NotificationsOffBanner } from '../../src/features/settings/notification-machines.tsx';
import {
  type MachineNotificationSource,
  type MachineNotifications,
  useMachineNotifications,
} from '../../src/hooks/use-machine-notifications.ts';
import type { NotificationControlsHost } from '../../src/hooks/use-notifications.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonNotificationPreferences } from '../../src/lib/notification-preferences.ts';
import type { NotificationPermissionState } from '../../src/lib/notify.ts';
import {
  DaemonPushDevices,
  type DaemonPushService,
  type MachinePushRegistrationLike,
  type PushEnrolment,
  type PushSubscriptionHandle,
} from '../../src/lib/push-enrolment.ts';
import { DaemonResponseError } from '../../src/lib/runtime-models.ts';
import { render, run, runAsync } from '../support/react.ts';

const connection = (id: string) =>
  daemonConnection({ daemonId: id, baseUrl: `https://${id}.example.test`, deviceId: `token-${id}` });

const device = (id: string): PushDeviceView => ({
  id,
  deviceName: id,
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-01T10:00:00.000Z',
  expirationTime: null,
});

const handle = (): PushSubscriptionHandle => ({
  toJSON: () => ({
    endpoint: 'https://push.example.test/x',
    expirationTime: null,
    keys: { p256dh: 'B'.repeat(87), auth: 'C'.repeat(22) },
  }),
  unsubscribe: async () => true,
});

const enrolment = (): PushEnrolment => {
  const registration: MachinePushRegistrationLike = {
    pushManager: { getSubscription: async () => handle(), subscribe: async () => handle() },
    unregister: async () => true,
  };
  return {
    register: async () => registration,
    existing: async () => registration,
    shared: async () => null,
    deviceName: () => 'this browser',
  };
};

type Machine = 'devices' | 'offline' | 'old';

/** Per-machine fakes behind the push port: what each one lists, and every call made against it. */
const fleet = (machines: Readonly<Record<string, Machine>>, others: Readonly<Record<string, number>> = {}) => {
  const lists = new Map<string, PushDeviceView[]>(
    Object.keys(machines).map(id => [
      id,
      Array.from({ length: others[id] ?? 0 }, (_, index) => device(`${id}-other-${index}`)),
    ]),
  );
  const registered: string[] = [];
  const revoked: string[] = [];
  const service: DaemonPushService = {
    vapidKey: async () => 'key',
    list: async conn => {
      const kind = machines[conn.daemonId];
      if (kind === 'offline') throw new Error('network down');
      if (kind === 'old') throw new DaemonResponseError(404, 'not found');
      return [...(lists.get(conn.daemonId) ?? [])];
    },
    register: async conn => {
      registered.push(conn.daemonId);
      const mine = device(`${conn.daemonId}-mine`);
      lists.set(conn.daemonId, [...(lists.get(conn.daemonId) ?? []), mine]);
      return mine;
    },
    revoke: async (conn, id) => {
      revoked.push(`${conn.daemonId}:${id}`);
      lists.set(
        conn.daemonId,
        (lists.get(conn.daemonId) ?? []).filter(entry => entry.id !== id),
      );
      return device(id);
    },
  };
  return { service, registered, revoked };
};

const hostOf = (
  service: DaemonPushService,
  permission: NotificationPermissionState = 'granted',
): NotificationControlsHost & { readonly asked: () => number } => {
  let asked = 0;
  return {
    preferences: new DaemonNotificationPreferences(null),
    devices: new DaemonPushDevices(null),
    service,
    enrolment: enrolment(),
    asked: () => asked,
    surface: {
      permission: () => permission,
      requestPermission: async () => {
        asked += 1;
        return 'granted';
      },
      registration: async () => ({ getNotifications: async () => [], showNotification: async () => undefined }),
      showOnPage: null,
      navigate: () => undefined,
    },
  };
};

const sourcesOf = (ids: readonly string[], muted: readonly string[] = []): readonly MachineNotificationSource[] =>
  ids.map(id => ({ connection: connection(id), label: `Machine ${id}`, muted: muted.includes(id) }));

const drain = async (turns = 24) => {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
};
const settle = () => runAsync(() => drain());

/** Mounts the hook, the list and the banner over it, the way Settings and Attention do. */
const mount = (host: NotificationControlsHost, sources: readonly MachineNotificationSource[]) => {
  const latest: { current: MachineNotifications | null } = { current: null };
  const shown: [string, boolean][] = [];
  const Probe = () => {
    const machines = useMachineNotifications(host, sources);
    latest.current = machines;
    return (
      <>
        <NotificationsOffBanner rows={machines.rows} canEnrol busy={machines.busy} onEnable={machines.enable} />
        <MachineNotificationList
          rows={machines.rows}
          canEnrol
          busy={machines.busy}
          failures={machines.failures}
          onEnable={machines.enable}
          onDisable={machines.disable}
          onTurnOnAll={machines.turnOnAll}
          onToggleShown={(daemonId, next) => shown.push([daemonId, next])}
        />
      </>
    );
  };
  const renderer = render(<Probe />);
  return {
    renderer,
    shown,
    machines: (): MachineNotifications => {
      if (latest.current === null) throw new Error('the hook did not render');
      return latest.current;
    },
  };
};

const statuses = (view: ReturnType<typeof mount>) =>
  Object.fromEntries(view.machines().rows.map(row => [row.daemonId, row.status]));
const bannerIds = (view: ReturnType<typeof mount>) =>
  view.renderer.root
    .findAll(node => typeof node.props['data-notifications-off-machine'] === 'string')
    .map(node => node.props['data-notifications-off-machine'] as string);

describe('useMachineNotifications', () => {
  it('lists every paired machine with its own status, the active one included', async () => {
    const world = fleet({ a: 'devices', b: 'offline', c: 'old' });
    const view = mount(hostOf(world.service), sourcesOf(['a', 'b', 'c']));
    await settle();
    expect(statuses(view)).toEqual({ a: 'off', b: 'offline', c: 'needs-update' });
  });

  it('turns exactly one machine on through the per-daemon enrolment, and leaves the rest alone', async () => {
    const world = fleet({ a: 'devices', b: 'devices' });
    const view = mount(hostOf(world.service), sourcesOf(['a', 'b']));
    await settle();
    await runAsync(async () => view.machines().enable('b'));
    await settle();
    expect(world.registered).toEqual(['b']);
    expect(statuses(view)).toEqual({ a: 'off', b: 'on' });
  });

  it('turns a machine off again by revoking its device with that machine', async () => {
    const world = fleet({ a: 'devices' });
    const view = mount(hostOf(world.service), sourcesOf(['a']));
    await settle();
    await runAsync(async () => view.machines().enable('a'));
    await settle();
    await runAsync(async () => view.machines().disable('a'));
    await settle();
    expect(world.revoked).toEqual(['a:a-mine']);
    expect(statuses(view)).toEqual({ a: 'off' });
  });

  it('"Turn on for all machines" enrols only machines that are answering and off', async () => {
    const world = fleet({ a: 'devices', b: 'devices', c: 'offline', d: 'old' });
    const host = hostOf(world.service);
    const view = mount(host, sourcesOf(['a', 'b', 'c', 'd']));
    await settle();
    await runAsync(async () => view.machines().enable('a'));
    await settle();
    world.registered.length = 0;
    const all = view.renderer.root.findByProps({ 'data-notification-turn-on-all': '' });
    await runAsync(async () => all.props.onClick());
    await settle();
    expect(world.registered).toEqual(['b']);
    expect(statuses(view)).toEqual({ a: 'on', b: 'on', c: 'offline', d: 'needs-update' });
  });

  it('asks the browser for permission once, from the tap, and enrols nothing when it is refused', async () => {
    const world = fleet({ a: 'devices', b: 'devices' });
    const host = hostOf(world.service, 'default');
    const view = mount(host, sourcesOf(['a', 'b']));
    await settle();
    expect(host.asked()).toBe(0);
    await runAsync(async () => view.machines().turnOnAll());
    await settle();
    expect(host.asked()).toBe(1);
    expect(world.registered.sort()).toEqual(['a', 'b']);

    const refusing = hostOf(world.service, 'default');
    (refusing.surface as { requestPermission: () => Promise<NotificationPermissionState> }).requestPermission =
      async () => 'denied';
    const refused = fleet({ a: 'devices' });
    const second = mount({ ...refusing, service: refused.service }, sourcesOf(['a']));
    await settle();
    await runAsync(async () => second.machines().enable('a'));
    await settle();
    expect(refused.registered).toEqual([]);
    expect(second.machines().permission).toBe('denied');
  });

  it('shows the folded mute and reports it without enrolling anything', async () => {
    const world = fleet({ a: 'devices', b: 'devices' });
    const view = mount(hostOf(world.service), sourcesOf(['a', 'b'], ['b']));
    await settle();
    expect(view.machines().rows.map(row => row.shown)).toEqual([true, false]);
    const mutes = view.renderer.root.findAll(node => node.props['data-machine-mute'] === '');
    expect(mutes.map(node => node.children.join(''))).toEqual(['Mute', 'Unmute']);
    run(() => mutes[1]?.props.onClick());
    run(() => mutes[0]?.props.onClick());
    expect(view.shown).toEqual([
      ['b', true],
      ['a', false],
    ]);
    expect(world.registered).toEqual([]);
  });
});

describe('NotificationsOffBanner', () => {
  it('shows for a machine nobody is enrolled with, and names it', async () => {
    const world = fleet({ a: 'devices' });
    const view = mount(hostOf(world.service), sourcesOf(['a']));
    await settle();
    expect(bannerIds(view)).toEqual(['a']);
    expect(JSON.stringify(view.renderer.toJSON())).toContain(
      'Notifications are off for Machine a on every device — turn them on',
    );
  });

  it('hides once any device — this one or another — is enrolled', async () => {
    const world = fleet({ a: 'devices', b: 'devices' }, { b: 1 });
    const view = mount(hostOf(world.service), sourcesOf(['a', 'b']));
    await settle();
    expect(bannerIds(view)).toEqual(['a']);
    await runAsync(async () => view.machines().enable('a'));
    await settle();
    expect(bannerIds(view)).toEqual([]);
  });

  it('never claims a machine is off when it could not be asked', async () => {
    const world = fleet({ a: 'offline', b: 'old' });
    const view = mount(hostOf(world.service), sourcesOf(['a', 'b']));
    await settle();
    expect(bannerIds(view)).toEqual([]);
  });

  it('enables through the same per-daemon enrolment on one tap', async () => {
    const world = fleet({ a: 'devices', b: 'devices' });
    const view = mount(hostOf(world.service), sourcesOf(['a', 'b']));
    await settle();
    const enable = view.renderer.root.findByProps({ 'data-notifications-off-machine': 'b' }).findByProps({
      'data-notifications-off-enable': '',
    });
    await runAsync(async () => enable.props.onClick());
    await settle();
    expect(world.registered).toEqual(['b']);
    expect(bannerIds(view)).toEqual(['a']);
  });
});
