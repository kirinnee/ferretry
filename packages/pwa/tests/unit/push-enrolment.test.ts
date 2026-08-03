import type { PushDeviceView, PushPreferences } from '@ferretry/protocol';
import { describe, it } from 'bun:test';
import should from 'should';

import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonNotificationPreferences } from '../../src/lib/notification-preferences.ts';
import {
  DaemonPushDevices,
  PUSH_CREATE_FAILED_MESSAGE,
  PUSH_DEVICE_STORAGE_KEY,
  PUSH_INACTIVE_MESSAGE,
  PUSH_REVOKE_FAILED_MESSAGE,
  PUSH_SYNC_FAILED_MESSAGE,
  PUSH_UNREACHABLE_MESSAGE,
  PUSH_UNSUPPORTED_MESSAGE,
  type DaemonPushService,
  type PushEnrolment,
  type PushEnrolmentContext,
  type PushRegistrationLike,
  type PushSubscriptionHandle,
  daemonPushService,
  disablePushDelivery,
  enablePushDelivery,
  enrolDaemonPushDevice,
  parsePushDeviceStore,
  readPushDelivery,
  revokePushDevice,
  supportsWebPush,
  syncPushPreferences,
  unsubscribeLocalPush,
} from '../../src/lib/push-enrolment.ts';

const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceToken: 'token-a' });
const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.example.test', deviceToken: 'token-b' });

const prefs: PushPreferences = {
  events: { attention: true, question: true, failed: false, completed: false },
  interactiveOnly: true,
};

const deviceView = (id: string, deviceName = 'this browser'): PushDeviceView =>
  ({
    id,
    deviceName,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    expirationTime: null,
    prefs,
  }) satisfies PushDeviceView;

const DEVICE_A = deviceView('push-00000000-0000-4000-8000-000000000000');
const DEVICE_B = deviceView('push-11111111-1111-4111-8111-111111111111', 'another browser');

/** An in-memory storage whose failures the test chooses. */
const memoryStorage = (over: { failRead?: boolean; failWrite?: boolean } = {}) => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string): string | null => {
      if (over.failRead === true) throw new Error('storage is denied');
      return values.get(key) ?? null;
    },
    setItem: (key: string, value: string): void => {
      if (over.failWrite === true) throw new Error('quota exceeded');
      values.set(key, value);
    },
  };
};

const subscriptionHandle = (unsubscribed: string[] = []): PushSubscriptionHandle => ({
  toJSON: () => ({
    endpoint: 'https://push.example.test/x',
    expirationTime: null,
    keys: { p256dh: 'B'.repeat(87), auth: 'C'.repeat(22) },
  }),
  unsubscribe: async () => {
    unsubscribed.push('unsubscribed');
    return true;
  },
});

/** A VAPID key is an uncompressed P-256 point: one tag byte then 64 more. */
const vapidKey = (): string =>
  btoa(String.fromCharCode(...new Uint8Array(65).fill(4)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');

interface ServiceLog {
  readonly registered: { daemonId: string; deviceName: string; preferences: PushPreferences }[];
  readonly revoked: { daemonId: string; deviceId: string }[];
  readonly listed: string[];
}

const service = (
  over: Partial<DaemonPushService> = {},
): { readonly service: DaemonPushService; readonly log: ServiceLog } => {
  const log: ServiceLog = { registered: [], revoked: [], listed: [] };
  const base: DaemonPushService = {
    vapidKey: async () => vapidKey(),
    list: async connection => {
      log.listed.push(connection.daemonId);
      return [DEVICE_A, DEVICE_B];
    },
    register: async (connection, _subscription, deviceName, preferences) => {
      log.registered.push({ daemonId: connection.daemonId, deviceName, preferences });
      return DEVICE_A;
    },
    revoke: async (connection, deviceId) => {
      log.revoked.push({ daemonId: connection.daemonId, deviceId });
      return DEVICE_A;
    },
  };
  return { service: { ...base, ...over }, log };
};

const enrolment = (
  subscription: PushSubscriptionHandle | null,
  over: { rejectRegistration?: boolean; subscribed?: PushSubscriptionHandle[] } = {},
): PushEnrolment => {
  const registration: PushRegistrationLike = {
    pushManager: {
      getSubscription: async () => subscription,
      subscribe: async options => {
        should(options.userVisibleOnly).be.true();
        should(options.applicationServerKey.byteLength).equal(65);
        const created = subscriptionHandle();
        over.subscribed?.push(created);
        return created;
      },
    },
  };
  return {
    registration: async () => {
      if (over.rejectRegistration === true) throw new Error('no service worker is ready');
      return registration;
    },
    deviceName: () => 'this browser',
  };
};

const context = (over: Partial<PushEnrolmentContext> = {}): PushEnrolmentContext => ({
  connection: daemonA,
  service: service().service,
  devices: new DaemonPushDevices(),
  preferences: new DaemonNotificationPreferences(),
  enrolment: enrolment(subscriptionHandle()),
  ...over,
});

describe('supportsWebPush', () => {
  it('needs a secure context, a worker and a push manager together', () => {
    should(supportsWebPush({ secureContext: true, serviceWorker: true, pushManager: true })).be.true();
    should(supportsWebPush({ secureContext: false, serviceWorker: true, pushManager: true })).be.false();
    should(supportsWebPush({ secureContext: true, serviceWorker: false, pushManager: true })).be.false();
    should(supportsWebPush({ secureContext: true, serviceWorker: true, pushManager: false })).be.false();
  });
});

describe('parsePushDeviceStore', () => {
  it('reads a versioned envelope and discards every unusable row', () => {
    const raw = JSON.stringify({
      version: 1,
      daemons: { 'daemon-a': 'push-a', '  ': 'push-blank-key', 'daemon-b': 42, 'daemon-c': '  ' },
    });
    const parsed = parsePushDeviceStore(raw);

    should([...parsed.entries()]).deepEqual([['daemon-a', 'push-a']] as unknown as [string, string][]);
  });

  it('answers empty for absent, malformed and foreign payloads', () => {
    should(parsePushDeviceStore(null).size).equal(0);
    should(parsePushDeviceStore('{').size).equal(0);
    should(parsePushDeviceStore('"a string"').size).equal(0);
    should(parsePushDeviceStore(JSON.stringify({ version: 2, daemons: {} })).size).equal(0);
    should(parsePushDeviceStore(JSON.stringify({ version: 1, daemons: 'nope' })).size).equal(0);
  });
});

describe('DaemonPushDevices', () => {
  it('remembers one device per daemon and forgets only the named one', () => {
    const storage = memoryStorage();
    const devices = new DaemonPushDevices(storage);

    should(devices.get(daemonA.daemonId)).be.null();
    devices.remember(daemonA.daemonId, 'push-a');
    devices.remember(daemonB.daemonId, 'push-b');
    should(devices.get(daemonA.daemonId)).equal('push-a');

    devices.remember(daemonA.daemonId, null);
    should(devices.get(daemonA.daemonId)).be.null();
    should(devices.get(daemonB.daemonId)).equal('push-b');

    const reloaded = new DaemonPushDevices(storage);
    should(reloaded.get(daemonB.daemonId)).equal('push-b');
  });

  it('clears one daemon and reports whether anything was there', () => {
    const devices = new DaemonPushDevices(memoryStorage());
    devices.remember(daemonA.daemonId, 'push-a');

    should(devices.clearDaemon(daemonA.daemonId)).be.true();
    should(devices.clearDaemon(daemonA.daemonId)).be.false();
  });

  it('survives denied reads, refused writes and no storage at all', () => {
    should(new DaemonPushDevices(memoryStorage({ failRead: true })).get(daemonA.daemonId)).be.null();

    const refusing = new DaemonPushDevices(memoryStorage({ failWrite: true }));
    refusing.remember(daemonA.daemonId, 'push-a');
    should(refusing.get(daemonA.daemonId)).equal('push-a');

    const memoryOnly = new DaemonPushDevices();
    memoryOnly.remember(daemonA.daemonId, 'push-a');
    should(memoryOnly.get(daemonA.daemonId)).equal('push-a');
  });

  it('keeps a daemon fingerprint that names an object metaproperty as an ordinary row', () => {
    const storage = memoryStorage();
    const devices = new DaemonPushDevices(storage);
    devices.remember(daemonConnection({ ...daemonA, daemonId: '__proto__' }).daemonId, 'push-x');

    const persisted = JSON.parse(storage.values.get(PUSH_DEVICE_STORAGE_KEY) ?? '{}') as {
      daemons: Record<string, string>;
    };
    should(Object.hasOwn(persisted.daemons, '__proto__')).be.true();
  });
});

describe('daemonPushService', () => {
  it('binds every call to the connection it was given', async () => {
    const calls: string[] = [];
    const bound = daemonPushService(async url => {
      calls.push(String(url));
      const path = String(url);
      if (path.endsWith('/vapid')) return new Response(JSON.stringify({ publicKey: vapidKey() }));
      if (path.endsWith('/subscriptions')) {
        return new Response(JSON.stringify(calls.length === 3 ? { devices: [DEVICE_A] } : DEVICE_A));
      }
      return new Response(JSON.stringify(DEVICE_A));
    });

    should(await bound.vapidKey(daemonA)).equal(vapidKey());
    should(await bound.register(daemonA, subscriptionHandle(), 'this browser', prefs)).deepEqual(DEVICE_A);
    should(await bound.list(daemonA)).deepEqual([DEVICE_A]);
    should(await bound.revoke(daemonB, DEVICE_A.id)).deepEqual(DEVICE_A);

    should(calls[0]).equal('https://a.example.test/v1/push/vapid');
    should(calls[3]).equal(`https://b.example.test/v1/push/subscriptions/${DEVICE_A.id}`);
  });
});

describe('enrolDaemonPushDevice', () => {
  it('registers an existing subscription under this daemon and remembers its device id', async () => {
    const { service: push, log } = service();
    const ctx = context({ service: push });
    ctx.preferences.set(daemonA.daemonId, { interactiveOnly: true });

    should(await enrolDaemonPushDevice(ctx, false)).deepEqual(DEVICE_A);
    should(log.registered[0]?.daemonId).equal('daemon-a');
    should(log.registered[0]?.deviceName).equal('this browser');
    should(log.registered[0]?.preferences.interactiveOnly).be.true();
    should(ctx.devices.get(daemonA.daemonId)).equal(DEVICE_A.id);
    should(ctx.devices.get(daemonB.daemonId)).be.null();
  });

  it('mints a subscription only when asked to create one', async () => {
    const subscribed: PushSubscriptionHandle[] = [];
    const ctx = context({ enrolment: enrolment(null, { subscribed }) });

    should(await enrolDaemonPushDevice(ctx, true)).deepEqual(DEVICE_A);
    should(subscribed).have.length(1);
  });

  it('refuses to invent an endpoint on a refresh', async () => {
    await enrolDaemonPushDevice(context({ enrolment: enrolment(null) }), false).should.be.rejectedWith(
      /no push subscription/u,
    );
  });

  it('refuses outright where the browser cannot do Web Push', async () => {
    await enrolDaemonPushDevice(context({ enrolment: null }), true).should.be.rejectedWith(/cannot register/u);
  });
});

describe('unsubscribeLocalPush', () => {
  it('drops the endpoint this browser holds', async () => {
    const unsubscribed: string[] = [];
    should(await unsubscribeLocalPush(enrolment(subscriptionHandle(unsubscribed)))).be.true();
    should(unsubscribed).have.length(1);
  });

  it('is silent about an absent subscription or an unavailable registration', async () => {
    should(await unsubscribeLocalPush(enrolment(null))).be.false();
    should(await unsubscribeLocalPush(enrolment(subscriptionHandle(), { rejectRegistration: true }))).be.false();
  });
});

describe('readPushDelivery', () => {
  it('reports unsupported without reaching any daemon', async () => {
    const { service: push, log } = service();
    const report = await readPushDelivery(context({ service: push, enrolment: null }));

    should(report.status).equal('unavailable');
    should(report.message).equal(PUSH_UNSUPPORTED_MESSAGE);
    should(log.listed).be.empty();
  });

  it('confirms an enabled enrolment against the daemon that holds it', async () => {
    const ctx = context();
    ctx.preferences.set(daemonA.daemonId, { enabled: true });

    const report = await readPushDelivery(ctx);

    should(report.status).equal('active');
    should(report.message).be.null();
    should(report.currentDeviceId).equal(DEVICE_A.id);
    should(report.devices).have.length(2);
  });

  it('keeps the remembered device when the confirmation fails', async () => {
    const ctx = context({ enrolment: enrolment(null) });
    ctx.preferences.set(daemonA.daemonId, { enabled: true });
    ctx.devices.remember(daemonA.daemonId, DEVICE_B.id);

    const report = await readPushDelivery(ctx);

    should(report.status).equal('active');
    should(report.currentDeviceId).equal(DEVICE_B.id);
  });

  it('never confirms an enrolment the reader has not switched on', async () => {
    const { service: push, log } = service();
    const report = await readPushDelivery(context({ service: push }));

    should(log.registered).be.empty();
    should(report.status).equal('unavailable');
    should(report.message).equal(PUSH_INACTIVE_MESSAGE);
    should(report.currentDeviceId).be.null();
  });

  it('reports a daemon that cannot be reached, keeping the remembered device', async () => {
    const ctx = context({
      service: service({
        list: async () => {
          throw new Error('the daemon push service is unreachable');
        },
      }).service,
    });
    ctx.devices.remember(daemonA.daemonId, DEVICE_A.id);

    const report = await readPushDelivery(ctx);

    should(report.status).equal('unavailable');
    should(report.message).equal('the daemon push service is unreachable');
    should(report.currentDeviceId).equal(DEVICE_A.id);
  });

  it('falls back to its own wording for a failure that carries no message', async () => {
    const report = await readPushDelivery(
      context({
        service: service({
          list: async () => {
            throw new Error('   ');
          },
        }).service,
      }),
    );

    should(report.message).equal(PUSH_UNREACHABLE_MESSAGE);
  });
});

describe('enablePushDelivery', () => {
  it('stores the preference and enrols this browser with the selected daemon', async () => {
    const ctx = context();
    const report = await enablePushDelivery(ctx);

    should(ctx.preferences.get(daemonA.daemonId).enabled).be.true();
    should(ctx.preferences.get(daemonB.daemonId).enabled).be.false();
    should(report.status).equal('active');
    should(report.currentDeviceId).equal(DEVICE_A.id);
  });

  it('keeps the preference when only closed-app delivery is impossible', async () => {
    const ctx = context({ enrolment: null });
    const report = await enablePushDelivery(ctx);

    should(ctx.preferences.get(daemonA.daemonId).enabled).be.true();
    should(report.status).equal('unavailable');
    should(report.message).equal(PUSH_UNSUPPORTED_MESSAGE);
  });

  it('says plainly when the subscription could not be created', async () => {
    const report = await enablePushDelivery(
      context({
        service: service({
          register: async () => {
            throw new Error('');
          },
        }).service,
      }),
    );

    should(report.status).equal('unavailable');
    should(report.message).equal(PUSH_CREATE_FAILED_MESSAGE);
  });
});

describe('disablePushDelivery', () => {
  it('revokes this daemon device, forgets it and unsubscribes the endpoint', async () => {
    const unsubscribed: string[] = [];
    const { service: push, log } = service();
    const ctx = context({ service: push, enrolment: enrolment(subscriptionHandle(unsubscribed)) });
    ctx.preferences.set(daemonA.daemonId, { enabled: true });
    ctx.devices.remember(daemonA.daemonId, DEVICE_A.id);

    const report = await disablePushDelivery(ctx);

    should(log.revoked).deepEqual([{ daemonId: 'daemon-a', deviceId: DEVICE_A.id }]);
    should(unsubscribed).have.length(1);
    should(ctx.devices.get(daemonA.daemonId)).be.null();
    should(ctx.preferences.get(daemonA.daemonId).enabled).be.false();
    should(report.status).equal('unavailable');
  });

  it('turns off even when the revoke cannot be delivered', async () => {
    const ctx = context({
      service: service({
        revoke: async () => {
          throw new Error('offline');
        },
      }).service,
    });
    ctx.devices.remember(daemonA.daemonId, DEVICE_A.id);

    should((await disablePushDelivery(ctx)).status).equal('unavailable');
    should(ctx.devices.get(daemonA.daemonId)).be.null();
  });

  it('has nothing to revoke or unsubscribe when it was never enrolled', async () => {
    const { service: push, log } = service();
    const ctx = context({ service: push, enrolment: null });

    should((await disablePushDelivery(ctx)).message).equal(PUSH_UNSUPPORTED_MESSAGE);
    should(log.revoked).be.empty();
  });
});

describe('syncPushPreferences', () => {
  it('sends changed events to the daemon holding this device', async () => {
    const { service: push, log } = service();
    const ctx = context({ service: push });
    ctx.preferences.set(daemonA.daemonId, { enabled: true });

    const report = await syncPushPreferences(ctx, { events: prefs.events, interactiveOnly: false });

    should(ctx.preferences.get(daemonA.daemonId).events.completed).be.false();
    should(ctx.preferences.get(daemonA.daemonId).interactiveOnly).be.false();
    should(log.registered).have.length(2);
    should(report?.status).equal('active');
  });

  it('stores the preference without a daemon round trip while delivery is off', async () => {
    const { service: push, log } = service();
    const ctx = context({ service: push });

    should(await syncPushPreferences(ctx, prefs)).be.null();
    should(ctx.preferences.get(daemonA.daemonId).interactiveOnly).be.true();
    should(log.registered).be.empty();
  });

  it('stores the preference where this browser cannot enrol at all', async () => {
    const ctx = context({ enrolment: null });
    ctx.preferences.set(daemonA.daemonId, { enabled: true });

    should(await syncPushPreferences(ctx, prefs)).be.null();
  });

  it('reports a preference the daemon would not accept', async () => {
    const ctx = context({
      service: service({
        register: async () => {
          throw new Error('   ');
        },
      }).service,
    });
    ctx.preferences.set(daemonA.daemonId, { enabled: true });

    should((await syncPushPreferences(ctx, prefs))?.message).equal(PUSH_SYNC_FAILED_MESSAGE);
  });
});

describe('revokePushDevice', () => {
  it('turns this browser off when it revokes itself', async () => {
    const unsubscribed: string[] = [];
    const ctx = context({ enrolment: enrolment(subscriptionHandle(unsubscribed)) });
    ctx.preferences.set(daemonA.daemonId, { enabled: true });
    ctx.devices.remember(daemonA.daemonId, DEVICE_A.id);

    const report = await revokePushDevice(ctx, DEVICE_A.id);

    should(ctx.preferences.get(daemonA.daemonId).enabled).be.false();
    should(ctx.devices.get(daemonA.daemonId)).be.null();
    should(unsubscribed).have.length(1);
    should(report.status).equal('unavailable');
  });

  it('leaves this browser alone when it revokes another device', async () => {
    const unsubscribed: string[] = [];
    const ctx = context({ enrolment: enrolment(subscriptionHandle(unsubscribed)) });
    ctx.preferences.set(daemonA.daemonId, { enabled: true });
    ctx.devices.remember(daemonA.daemonId, DEVICE_A.id);

    const report = await revokePushDevice(ctx, DEVICE_B.id);

    should(ctx.preferences.get(daemonA.daemonId).enabled).be.true();
    should(ctx.devices.get(daemonA.daemonId)).equal(DEVICE_A.id);
    should(unsubscribed).be.empty();
    should(report.status).equal('active');
  });

  it('revokes its own last device without a local endpoint to drop', async () => {
    const ctx = context({ enrolment: null });
    ctx.devices.remember(daemonA.daemonId, DEVICE_A.id);

    should((await revokePushDevice(ctx, DEVICE_A.id)).message).equal(PUSH_UNSUPPORTED_MESSAGE);
    should(ctx.devices.get(daemonA.daemonId)).be.null();
  });

  it('reports a revocation the daemon refused', async () => {
    const ctx = context({
      service: service({
        revoke: async () => {
          throw new Error('   ');
        },
      }).service,
    });

    should((await revokePushDevice(ctx, DEVICE_A.id)).message).equal(PUSH_REVOKE_FAILED_MESSAGE);
  });
});
