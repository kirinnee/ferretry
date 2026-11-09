/**
 * A push-capable machine and a push-capable browser for the Notifications suites: a machine that keeps its enrolled
 * devices and answers the push routes as the daemon does (recording each route it was asked), and a browser host with a
 * scripted permission and a service-worker enrolment. Nothing here touches a network, a real service worker or storage.
 */
import { noteClientDaemon } from '@ferretry/app/testing';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { InstantSchema } from '@ferretry/std';
import type { PushDeviceView } from '../../../contract/index.ts';
import { DaemonPushDevices, type PushEnrolment } from '../../../app/lib/push-enrolment.ts';
import type { NotificationPermissionState, PushHost } from '../../../app/lib/push-host.ts';
import { PushPreferences } from '../../../app/lib/push-preferences.ts';

export const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/secret-endpoint';
export const P256DH = 'B'.repeat(87);
export const AUTH = 'C'.repeat(22);
const VAPID = Buffer.from(new Uint8Array(65).fill(4)).toString('base64url');

export const deviceOf = (id: string, deviceName: string): PushDeviceView => ({
  id,
  deviceName,
  createdAt: InstantSchema.parse('2026-08-01T10:00:00.000Z'),
  updatedAt: InstantSchema.parse('2026-08-01T10:00:00.000Z'),
  expirationTime: null,
});

/** A machine that keeps its enrolled devices, answering the push routes the way the daemon does. */
export const machine = (initial: readonly PushDeviceView[] = [], daemon = 'daemon-a') => {
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
  noteClientDaemon(client, daemon);
  return { client, calls, devices };
};

export const browser = (permission: NotificationPermissionState, answer: NotificationPermissionState = 'granted') => {
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
