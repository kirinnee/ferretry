import { describe, expect, it } from 'bun:test';
import { noteClientDaemon } from '@ferretry/app/testing';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { InstantSchema } from '@ferretry/std';
import type { ReactTestRenderer } from 'react-test-renderer';
import type { PushDeviceView } from '../../../../../contract/index.ts';
import {
  MachineNotificationsSettings,
  NotificationsOffPanel,
  THIS_MACHINE,
} from '../../../../../app/features/settings/machine-notifications-settings.tsx';
import { DaemonPushDevices, type PushEnrolment } from '../../../../../app/lib/push-enrolment.ts';
import type { NotificationPermissionState, PushHost } from '../../../../../app/lib/push-host.ts';
import { PushPreferences } from '../../../../../app/lib/push-preferences.ts';
import { render, run, runUntil } from '../../../../support/app/react.ts';

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/secret-endpoint';
const P256DH = 'B'.repeat(87);
const AUTH = 'C'.repeat(22);
const VAPID = Buffer.from(new Uint8Array(65).fill(4)).toString('base64url');

const deviceOf = (id: string, deviceName: string): PushDeviceView => ({
  id,
  deviceName,
  createdAt: InstantSchema.parse('2026-08-01T10:00:00.000Z'),
  updatedAt: InstantSchema.parse('2026-08-01T10:00:00.000Z'),
  expirationTime: null,
});

/** A machine that keeps its enrolled devices, answering the push routes the way the daemon does. */
const machine = (initial: readonly PushDeviceView[] = []) => {
  const devices = [...initial];
  const calls: string[] = [];
  const client = {
    call: async (route: string, init?: { params?: Record<string, string> }) => {
      calls.push(route);
      if (route === 'GET /v1/push/vapid') return { publicKey: VAPID };
      if (route === 'GET /v1/push/subscriptions') return { devices };
      if (route === 'POST /v1/push/subscriptions') {
        const created = deviceOf('push-11111111-1111-4111-8111-111111111111', 'Chrome on Test');
        devices.push(created);
        return created;
      }
      if (route === 'DELETE /v1/push/subscriptions/:pushId') {
        const at = devices.findIndex(device => device.id === init?.params?.pushId);
        const [gone] = devices.splice(at, 1);
        return gone;
      }
      throw new Error(`unscripted ${route}`);
    },
    subscribe: () => () => undefined,
  } as unknown as PluginClient;
  noteClientDaemon(client, 'daemon-a');
  return { client, calls, devices };
};

const browser = (permission: NotificationPermissionState, answer: NotificationPermissionState = 'granted') => {
  const asked: string[] = [];
  let current = permission;
  let subscription: { toJSON(): unknown; unsubscribe(): Promise<boolean> } | null = null;
  const made = {
    toJSON: () => ({ endpoint: ENDPOINT, expirationTime: null, keys: { p256dh: P256DH, auth: AUTH } }),
    unsubscribe: async () => {
      subscription = null;
      return true;
    },
  };
  const registration = {
    pushManager: {
      getSubscription: async () => subscription,
      subscribe: async () => {
        subscription = made;
        return made;
      },
    },
    unregister: async () => true,
  };
  const enrolment: PushEnrolment = {
    register: async () => registration as never,
    existing: async () => (subscription === null ? null : (registration as never)),
    deviceName: () => 'Chrome on Test',
  };
  const host: PushHost = {
    devices: new DaemonPushDevices(null),
    preferences: new PushPreferences(null),
    enrolment: () => enrolment,
    permission: () => current,
    requestPermission: async () => {
      asked.push('asked');
      current = answer;
      return current;
    },
  };
  return { host, asked };
};

const marked = (surface: ReactTestRenderer, marker: string) =>
  surface.root.findAll(node => typeof node.type === 'string' && node.props[marker] !== undefined);

const text = (surface: ReactTestRenderer): string => JSON.stringify(surface.toJSON());

const BANNER = `Notifications are off for ${THIS_MACHINE} on every device — turn them on`;

describe('Access draws this machine’s Web Push', () => {
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
    const settings = render(<MachineNotificationsSettings client={client} host={host} />);
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
    const settings = render(<MachineNotificationsSettings client={client} host={host} />);
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
    const settings = render(<MachineNotificationsSettings client={client} host={host} />);
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
      const settings = render(<MachineNotificationsSettings client={client} host={host} />);
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

  it('draws nothing for a client the shell did not make', () => {
    const { client } = machine();
    const stranger = { ...client } as PluginClient;
    const { host } = browser('granted');
    const view = render(<MachineNotificationsSettings client={stranger} host={host} />);
    expect(text(view)).toBe('null');
    run(() => view.unmount());
  });
});
