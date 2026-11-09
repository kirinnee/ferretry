import { describe, expect, it } from 'bun:test';
import type { PluginClient } from '@ferretry/kernel/manifest';
import type { ReactTestRenderer } from 'react-test-renderer';
import {
  MachinesNotificationsSettings,
  NotificationsOffPanel,
  THIS_MACHINE,
} from '../../../../../app/features/settings/machine-notifications-settings.tsx';
import type { MachineSource } from '../../../../../app/hooks/use-machines-notifications.ts';
import type { PushHost } from '../../../../../app/lib/push-host.ts';
import { AUTH, browser, deviceOf, ENDPOINT, machine, P256DH } from '../../../../support/app/push.ts';
import { render, run, runUntil } from '../../../../support/app/react.ts';

/** One machine as the device panel hands it over (from `useEveryDaemon`): the press runs the act, unless a test says. */
const sourceOf = (
  client: PluginClient,
  overrides: Partial<MachineSource> & { readonly pressed?: string[] } = {},
): MachineSource => {
  const { pressed, ...rest } = overrides;
  const daemon = rest.daemon ?? 'daemon-a';
  return {
    daemon,
    label: THIS_MACHINE,
    client,
    locked: false,
    press: async act => {
      pressed?.push(daemon);
      return await act();
    },
    unlock: async () => true,
    ...rest,
  };
};

const panel = (sources: readonly MachineSource[], host: PushHost) =>
  render(<MachinesNotificationsSettings sources={sources} host={host} />);

const marked = (surface: ReactTestRenderer, marker: string) =>
  surface.root.findAll(node => typeof node.type === 'string' && node.props[marker] !== undefined);

const text = (surface: ReactTestRenderer): string => JSON.stringify(surface.toJSON());

const BANNER = `Notifications are off for ${THIS_MACHINE} on every device — turn them on`;

describe('Access draws every machine’s Web Push', () => {
  it('shows the "Notifications are off" banner when no device is enrolled anywhere, and never asks by itself', async () => {
    const { client } = machine();
    const { host, asked } = browser('default');
    const banner = render(<NotificationsOffPanel client={client} host={host} />);
    await runUntil(
      () => undefined,
      () => text(banner).includes(BANNER),
      'the banner',
    );
    expect(asked).toEqual([]);
    run(() => banner.unmount());
  });

  it('turns the machine on from the banner: asks once, enrols this browser, and the banner goes', async () => {
    const { client, calls, devices } = machine();
    const { host, asked } = browser('default');
    const banner = render(<NotificationsOffPanel client={client} host={host} />);
    await runUntil(
      () => undefined,
      () => marked(banner, 'data-notifications-off-enable').length > 0,
      'the Turn on button',
    );
    await runUntil(
      () => marked(banner, 'data-notifications-off-enable')[0]?.props.onClick(),
      () => text(banner) === 'null',
      'the banner to clear',
    );
    expect(asked).toEqual(['asked']);
    expect(devices.map(device => device.deviceName)).toEqual(['Chrome on Test']);
    expect(calls).toContain('GET /v1/push/vapid');
    run(() => banner.unmount());
  });

  it('offers no switch to turn on once the browser has blocked notifications, and does not ask again', async () => {
    const { client } = machine();
    const { host, asked } = browser('denied');
    const settings = panel([sourceOf(client)], host);
    await runUntil(
      () => undefined,
      () => marked(settings, 'data-machine-notification').length > 0,
      'the machine row',
    );
    const toggle = settings.root.findByProps({ role: 'switch' });
    expect(toggle.props.disabled).toBe(true);
    expect(text(settings)).toContain('Blocked in this browser.');
    expect(asked).toEqual([]);
    run(() => settings.unmount());
  });

  it('lists the registered devices and revokes the exact one pressed', async () => {
    const mine = deviceOf('push-22222222-2222-4222-8222-222222222222', 'Pixel 8');
    const { client, devices } = machine([mine]);
    const { host } = browser('granted');
    const settings = panel([sourceOf(client)], host);
    await runUntil(
      () => undefined,
      () => text(settings).includes('Pixel 8'),
      'the device list',
    );
    const revoke = settings.root.findByProps({ 'aria-label': 'Revoke push notifications for Pixel 8' });
    await runUntil(
      () => revoke.props.onClick(),
      () => !text(settings).includes('Pixel 8'),
      'the device to go',
    );
    expect(devices).toEqual([]);
    run(() => settings.unmount());
  });

  it('shows an unreachable machine as offline rather than off', async () => {
    const { client } = machine();
    (client as { call: unknown }).call = async () => {
      throw new Error('network down');
    };
    const { host } = browser('granted');
    const settings = panel([sourceOf(client)], host);
    await runUntil(
      () => undefined,
      () => text(settings).includes('Machine offline'),
      'the offline status',
    );
    run(() => settings.unmount());
  });

  it('never renders or logs a push endpoint or subscription key', async () => {
    const { client } = machine();
    const { host } = browser('granted');
    const logged: unknown[] = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = (...args: unknown[]) => void logged.push(args);
    try {
      const settings = panel([sourceOf(client)], host);
      await runUntil(
        () => undefined,
        () => marked(settings, 'data-machine-notification').length > 0,
        'the machine row',
      );
      await runUntil(
        () => settings.root.findByProps({ role: 'switch' }).props.onClick(),
        () => text(settings).includes('On · this device'),
        'this device to be on',
      );
      for (const secret of [ENDPOINT, 'secret-endpoint', P256DH, AUTH]) {
        expect(text(settings)).not.toContain(secret);
        expect(JSON.stringify(logged)).not.toContain(secret);
      }
      run(() => settings.unmount());
    } finally {
      Object.assign(console, original);
    }
  });

  it('draws the permission block alone when the panel reaches no machine', () => {
    const { host } = browser('granted');
    const view = panel([], host);
    expect(text(view)).toContain('Allowed in this browser.');
    expect(marked(view, 'data-machine-notification')).toHaveLength(0);
    run(() => view.unmount());
  });
});

const rowOf = (surface: ReactTestRenderer, daemon: string) =>
  surface.root.find(node => typeof node.type === 'string' && node.props['data-machine-notification'] === daemon);

describe('Access draws several machines in ONE list (R1 M2)', () => {
  it('draws the permission block once, one row per machine, and registered devices under their own machine', async () => {
    const a = machine([deviceOf('push-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Pixel A')], 'daemon-a');
    const b = machine([deviceOf('push-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Pixel B')], 'daemon-b');
    const { host } = browser('granted');
    const view = panel(
      [
        sourceOf(a.client, { daemon: 'daemon-a', label: 'laptop' }),
        sourceOf(b.client, { daemon: 'daemon-b', label: 'desk' }),
      ],
      host,
    );
    await runUntil(
      () => undefined,
      () => text(view).includes('Pixel A') && text(view).includes('Pixel B'),
      'both machines’ devices',
    );
    expect(text(view).split('Permission: ').length - 1).toBe(1);
    expect(marked(view, 'data-machine-notification')).toHaveLength(2);
    const wordsIn = (node: { children: readonly unknown[] }): string =>
      node.children.map(child => (typeof child === 'string' ? child : wordsIn(child as typeof node))).join(' ');
    expect(wordsIn(rowOf(view, 'daemon-a'))).toContain('Pixel A');
    expect(wordsIn(rowOf(view, 'daemon-a'))).not.toContain('Pixel B');
    expect(wordsIn(rowOf(view, 'daemon-b'))).toContain('Pixel B');
    run(() => view.unmount());
  });

  it('enrols on the machine whose switch was pressed and on no other (each row writes through its own client)', async () => {
    const a = machine([], 'daemon-a');
    const b = machine([], 'daemon-b');
    const { host } = browser('granted');
    const pressed: string[] = [];
    const view = panel(
      [
        sourceOf(a.client, { daemon: 'daemon-a', label: 'laptop', pressed }),
        sourceOf(b.client, { daemon: 'daemon-b', label: 'desk', pressed }),
      ],
      host,
    );
    await runUntil(
      () => undefined,
      () => marked(view, 'data-machine-notification').length === 2 && text(view).includes('Off'),
      'both rows',
    );
    await runUntil(
      () => rowOf(view, 'daemon-b').findByProps({ role: 'switch' }).props.onClick(),
      () => b.devices.length === 1,
      'machine b to enrol',
    );
    expect(a.calls).not.toContain('POST /v1/push/subscriptions');
    expect(b.calls).toContain('POST /v1/push/subscriptions');
    expect(a.devices).toEqual([]);
    expect(pressed).toEqual(['daemon-b']);
    run(() => view.unmount());
  });

  it('revokes a device on the machine that lists it, never on another', async () => {
    const mine = deviceOf('push-22222222-2222-4222-8222-222222222222', 'Pixel 8');
    const a = machine([], 'daemon-a');
    const b = machine([mine], 'daemon-b');
    const { host } = browser('granted');
    const view = panel(
      [
        sourceOf(a.client, { daemon: 'daemon-a', label: 'laptop' }),
        sourceOf(b.client, { daemon: 'daemon-b', label: 'desk' }),
      ],
      host,
    );
    await runUntil(
      () => undefined,
      () => text(view).includes('Pixel 8'),
      'the device list',
    );
    await runUntil(
      () => view.root.findByProps({ 'aria-label': 'Revoke push notifications for Pixel 8' }).props.onClick(),
      () => !text(view).includes('Pixel 8'),
      'the device to go',
    );
    expect(b.devices).toEqual([]);
    expect(a.calls.filter(call => call.startsWith('DELETE'))).toEqual([]);
    run(() => view.unmount());
  });

  it('"Turn on for all machines" asks once and enrols every machine that answers and is off, each through its own press', async () => {
    const a = machine([], 'daemon-a');
    const b = machine([], 'daemon-b');
    const { host, asked } = browser('default');
    const pressed: string[] = [];
    const view = panel(
      [
        sourceOf(a.client, { daemon: 'daemon-a', label: 'laptop', pressed }),
        sourceOf(b.client, { daemon: 'daemon-b', label: 'desk', pressed }),
      ],
      host,
    );
    await runUntil(
      () => undefined,
      () => marked(view, 'data-notification-turn-on-all')[0]?.props.disabled === false,
      'turn on all to be offered',
    );
    await runUntil(
      () => marked(view, 'data-notification-turn-on-all')[0]?.props.onClick(),
      () => a.devices.length === 1 && b.devices.length === 1,
      'both machines to enrol',
    );
    expect(asked).toEqual(['asked']);
    expect([...pressed].sort()).toEqual(['daemon-a', 'daemon-b']);
    run(() => view.unmount());
  });

  it('"Turn on for all machines" does nothing when the browser refuses, and is off when every machine is on', async () => {
    const a = machine([], 'daemon-a');
    const { host, asked } = browser('default', 'denied');
    const view = panel([sourceOf(a.client, { daemon: 'daemon-a', label: 'laptop' })], host);
    await runUntil(
      () => undefined,
      () => marked(view, 'data-notification-turn-on-all')[0]?.props.disabled === false,
      'turn on all to be offered',
    );
    await runUntil(
      () => marked(view, 'data-notification-turn-on-all')[0]?.props.onClick(),
      () => asked.length === 1,
      'the browser to be asked',
    );
    expect(a.devices).toEqual([]);
    run(() => view.unmount());
  });

  it('a locked machine says "Locked — unlock …" with Unlock, is not read, has no switch and is left out of "turn on all"', async () => {
    const a = machine([], 'daemon-a');
    const b = machine([], 'daemon-b');
    const { host } = browser('granted');
    const unlocked: string[] = [];
    const view = panel(
      [
        sourceOf(a.client, { daemon: 'daemon-a', label: 'laptop' }),
        sourceOf(b.client, {
          daemon: 'daemon-b',
          label: 'desk',
          locked: true,
          unlock: async () => {
            unlocked.push('daemon-b');
            return true;
          },
        }),
      ],
      host,
    );
    await runUntil(
      () => undefined,
      () => marked(view, 'data-machine-locked').length === 1 && a.calls.includes('GET /v1/push/subscriptions'),
      'the locked row',
    );
    expect(text(view)).toContain('Locked — unlock desk');
    expect(b.calls).toEqual([]);
    expect(rowOf(view, 'daemon-b').findAllByProps({ role: 'switch' })).toHaveLength(0);
    run(() => marked(view, 'data-machine-unlock')[0]?.props.onClick());
    expect(unlocked).toEqual(['daemon-b']);
    await runUntil(
      () => marked(view, 'data-notification-turn-on-all')[0]?.props.onClick(),
      () => a.devices.length === 1,
      'the unlocked machine to enrol',
    );
    expect(b.calls).toEqual([]);
    run(() => view.unmount());
  });

  it('a press the person dismisses (the unlock was refused) changes nothing and reads nothing more', async () => {
    const a = machine([], 'daemon-a');
    const { host } = browser('granted');
    const view = panel(
      [sourceOf(a.client, { daemon: 'daemon-a', label: 'laptop', press: async () => undefined })],
      host,
    );
    await runUntil(
      () => undefined,
      () => marked(view, 'data-machine-notification').length === 1 && text(view).includes('Off'),
      'the row',
    );
    const before = a.calls.length;
    await runUntil(
      () => rowOf(view, 'daemon-a').findByProps({ role: 'switch' }).props.onClick(),
      () => !text(view).includes('Working'),
      'the press to settle',
    );
    expect(a.calls.length).toBe(before);
    expect(a.devices).toEqual([]);
    run(() => view.unmount());
  });

  it('un-enrols a machine that is on, through its own client', async () => {
    const a = machine([], 'daemon-a');
    const { host } = browser('granted');
    const view = panel([sourceOf(a.client, { daemon: 'daemon-a', label: 'laptop' })], host);
    await runUntil(
      () => undefined,
      () => marked(view, 'data-machine-notification').length === 1 && text(view).includes('Off'),
      'the row',
    );
    await runUntil(
      () => rowOf(view, 'daemon-a').findByProps({ role: 'switch' }).props.onClick(),
      () => text(view).includes('On · this device'),
      'the machine to be on',
    );
    await runUntil(
      () => rowOf(view, 'daemon-a').findByProps({ role: 'switch' }).props.onClick(),
      () => text(view).includes('Off') && a.devices.length === 0,
      'the machine to go off',
    );
    run(() => view.unmount());
  });
});
