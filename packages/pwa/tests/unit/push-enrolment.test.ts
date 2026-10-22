import { describe, expect, it } from 'bun:test';
import type { PushDeviceView } from '@ferretry/protocol';
import should from 'should';

import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonNotificationPreferences } from '../../src/lib/notification-preferences.ts';
import {
  type ContainerPushEnrolmentDeps,
  containerPushEnrolment,
  DaemonPushDevices,
  type DaemonPushService,
  daemonPushService,
  disablePushDelivery,
  enablePushDelivery,
  enrolDaemonPushDevice,
  type MachinePushRegistrationLike,
  moveOffSharedPush,
  PUSH_CREATE_FAILED_MESSAGE,
  PUSH_DEVICE_STORAGE_KEY,
  PUSH_INACTIVE_MESSAGE,
  PUSH_REVOKE_FAILED_MESSAGE,
  PUSH_UNREACHABLE_MESSAGE,
  PUSH_UNSUPPORTED_MESSAGE,
  type PushEnrolment,
  type PushEnrolmentContext,
  type PushRegistrationLike,
  type PushSubscriptionHandle,
  parsePushDeviceStore,
  readPushDelivery,
  revokePushDevice,
  supportsWebPush,
  unsubscribeLocalPush,
} from '../../src/lib/push-enrolment.ts';

const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceId: 'token-a' });
const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.example.test', deviceId: 'token-b' });

const deviceView = (id: string, deviceName = 'this browser'): PushDeviceView =>
  ({
    id,
    deviceName,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    expirationTime: null,
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
    endpoint: 'https://fcm.googleapis.com/x',
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
  readonly registered: { daemonId: string; deviceName: string }[];
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
    register: async (connection, _subscription, deviceName) => {
      log.registered.push({ daemonId: connection.daemonId, deviceName });
      return DEVICE_A;
    },
    revoke: async (connection, deviceId) => {
      log.revoked.push({ daemonId: connection.daemonId, deviceId });
      return DEVICE_A;
    },
  };
  return { service: { ...base, ...over }, log };
};

interface EnrolmentOver {
  readonly rejectRegistration?: boolean;
  readonly subscribed?: PushSubscriptionHandle[];
  /** This daemon has no registration of its own yet. */
  readonly unregistered?: boolean;
  /** The app-wide registration's subscription, from before per-daemon registrations. */
  readonly shared?: PushSubscriptionHandle | null;
  readonly rejectShared?: boolean;
  /** Every daemon id `register` was called for, and every unregister. */
  readonly log?: { registered: string[]; unregistered: string[] };
}

/** A browser with one push registration per daemon; only ONE daemon's subscription is modelled. */
const enrolment = (subscription: PushSubscriptionHandle | null, over: EnrolmentOver = {}): PushEnrolment => {
  let exists = over.unregistered !== true;
  const registration: MachinePushRegistrationLike = {
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
    unregister: async () => {
      over.log?.unregistered.push('unregistered');
      exists = false;
      return true;
    },
  };
  const shared: PushRegistrationLike = {
    pushManager: {
      getSubscription: async () => {
        if (over.rejectShared === true) throw new Error('the app-wide worker is gone');
        return over.shared ?? null;
      },
      subscribe: async () => {
        throw new Error('the app-wide registration never subscribes any more');
      },
    },
  };
  return {
    register: async daemon => {
      if (over.rejectRegistration === true) throw new Error('no service worker is ready');
      over.log?.registered.push(daemon);
      exists = true;
      return registration;
    },
    existing: async () => {
      if (over.rejectRegistration === true) throw new Error('no service worker is ready');
      return exists ? registration : null;
    },
    shared: async () => shared,
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
    should(await bound.register(daemonA, subscriptionHandle(), 'this browser')).deepEqual(DEVICE_A);
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

    should(await enrolDaemonPushDevice(ctx, false)).deepEqual(DEVICE_A);
    should(log.registered[0]?.daemonId).equal('daemon-a');
    should(log.registered[0]?.deviceName).equal('this browser');
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
  it('drops the endpoint this browser holds for THIS daemon, and its registration with it', async () => {
    const unsubscribed: string[] = [];
    const log = { registered: [], unregistered: [] as string[] };
    should(
      await unsubscribeLocalPush(enrolment(subscriptionHandle(unsubscribed), { log }), daemonA.daemonId),
    ).be.true();
    should(unsubscribed).have.length(1);
    should(log.unregistered).have.length(1);
  });

  it('is silent about an absent subscription, an absent registration or an unavailable one', async () => {
    const log = { registered: [], unregistered: [] as string[] };
    should(await unsubscribeLocalPush(enrolment(null, { log }), daemonA.daemonId)).be.false();
    should(log.unregistered).have.length(1);
    should(
      await unsubscribeLocalPush(enrolment(subscriptionHandle(), { unregistered: true }), daemonA.daemonId),
    ).be.false();
    should(
      await unsubscribeLocalPush(enrolment(subscriptionHandle(), { rejectRegistration: true }), daemonA.daemonId),
    ).be.false();
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

describe('one subscription per daemon (cross-machine §4b)', () => {
  it('refuses a refresh for a daemon with no registration of its own, and registers nothing', async () => {
    const log = { registered: [] as string[], unregistered: [] };
    await enrolDaemonPushDevice(
      context({ enrolment: enrolment(null, { unregistered: true, log }) }),
      false,
    ).should.be.rejectedWith(/no push subscription/u);
    should(log.registered).be.empty();
  });

  it('registers THIS daemon’s own worker when it enrols', async () => {
    const log = { registered: [] as string[], unregistered: [] };
    await enrolDaemonPushDevice(context({ enrolment: enrolment(null, { unregistered: true, log }) }), true);
    should(log.registered).deepEqual(['daemon-a']);
  });

  it('moves a daemon off the shared subscription on a refresh, dropping it and the device it issued for it', async () => {
    const sharedGone: string[] = [];
    const subscribed: PushSubscriptionHandle[] = [];
    const { service: push, log } = service();
    const ctx = context({
      service: push,
      enrolment: enrolment(null, { unregistered: true, shared: subscriptionHandle(sharedGone), subscribed }),
    });
    ctx.devices.remember(daemonA.daemonId, DEVICE_B.id);

    should(await enrolDaemonPushDevice(ctx, false)).deepEqual(DEVICE_A);
    should(subscribed).have.length(1);
    should(sharedGone).have.length(1);
    should(log.revoked).deepEqual([{ daemonId: 'daemon-a', deviceId: DEVICE_B.id }]);
    should(ctx.devices.get(daemonA.daemonId)).equal(DEVICE_A.id);
  });

  it('keeps going when the old device cannot be revoked or the shared subscription is unreadable', async () => {
    const ctx = context({
      service: service({
        revoke: async () => {
          throw new Error('offline');
        },
      }).service,
      enrolment: enrolment(subscriptionHandle(), { rejectShared: true }),
    });
    ctx.devices.remember(daemonA.daemonId, DEVICE_B.id);

    should(await enrolDaemonPushDevice(ctx, false)).deepEqual(DEVICE_A);
  });

  it('revokes nothing when the daemon answers with the device it already issued', async () => {
    const { service: push, log } = service();
    const ctx = context({ service: push });
    ctx.devices.remember(daemonA.daemonId, DEVICE_A.id);

    await enrolDaemonPushDevice(ctx, false);
    should(log.revoked).be.empty();
  });

  it('turns ONE daemon off without touching the shared or any other subscription', async () => {
    const sharedGone: string[] = [];
    const log = { registered: [], unregistered: [] as string[] };
    const ctx = context({
      enrolment: enrolment(subscriptionHandle(), { shared: subscriptionHandle(sharedGone), log }),
    });
    ctx.devices.remember(daemonA.daemonId, DEVICE_A.id);

    await disablePushDelivery(ctx);
    should(log.unregistered).have.length(1);
    should(sharedGone).be.empty();
  });
});

/* ---------- the container binding ------------------------------------------ */

interface FakeWorker {
  state: string;
  scriptURL: string;
  listeners: (() => void)[];
  addEventListener(type: 'statechange', listener: () => void): void;
  removeEventListener(type: 'statechange', listener: () => void): void;
}

const fakeWorker = (scriptURL: string, state = 'activated'): FakeWorker => {
  const worker: FakeWorker = {
    state,
    scriptURL,
    listeners: [],
    addEventListener: (_type, listener) => worker.listeners.push(listener),
    removeEventListener: (_type, listener) => {
      worker.listeners = worker.listeners.filter(candidate => candidate !== listener);
    },
  };
  return worker;
};

const advance = (worker: FakeWorker, state: string): void => {
  worker.state = state;
  for (const listener of [...worker.listeners]) listener();
};

interface FakeRegistration {
  scope: string;
  active: FakeWorker | null;
  installing: FakeWorker | null;
  waiting: FakeWorker | null;
  unsubscribed: number;
  unregistered: number;
  hasSubscription: boolean;
  pushManager: PushRegistrationLike['pushManager'];
  unregister(): Promise<boolean>;
}

const ORIGIN = 'https://app.example.test';

const fakeRegistration = (scope: string, active: FakeWorker | null, hasSubscription = true): FakeRegistration => {
  const registration: FakeRegistration = {
    scope: new URL(scope, ORIGIN).href,
    active,
    installing: null,
    waiting: null,
    unsubscribed: 0,
    unregistered: 0,
    hasSubscription,
    pushManager: {
      getSubscription: async () =>
        registration.hasSubscription
          ? {
              ...subscriptionHandle(),
              unsubscribe: async () => {
                registration.unsubscribed += 1;
                return true;
              },
            }
          : null,
      subscribe: async () => subscriptionHandle(),
    },
    unregister: async () => {
      registration.unregistered += 1;
      return true;
    },
  };
  return registration;
};

const containerFor = (
  existing: FakeRegistration[],
  onRegister: (url: string, scope: string) => unknown = (url, scope) =>
    fakeRegistration(scope, fakeWorker(new URL(url, ORIGIN).href)),
) => {
  const registered: { url: string; scope: string }[] = [];
  const deps: ContainerPushEnrolmentDeps = {
    container: {
      register: async (url, options) => {
        registered.push({ url, scope: options.scope });
        return onRegister(url, options.scope);
      },
      getRegistrations: async () => [...existing, { scope: 'not a registration' }],
    },
    origin: ORIGIN,
    workerUrl: '/sw.verified.js',
    label: daemon => (daemon === daemonA.daemonId ? 'Work laptop' : 'Studio'),
    deviceName: 'Ferretry PWA',
  };
  return { enrolment: containerPushEnrolment(deps), registered };
};

describe('containerPushEnrolment', () => {
  it('registers the signed worker at the daemon’s own scope, labelled with the reader’s name for it', async () => {
    const { enrolment: browser, registered } = containerFor([]);

    const registration = await browser.register(daemonA.daemonId);

    should(registered).deepEqual([{ url: '/sw.verified.js?machine=Work%20laptop', scope: '/push/daemon-a/' }]);
    should((registration as unknown as FakeRegistration).scope).equal(`${ORIGIN}/push/daemon-a/`);
    should(browser.deviceName()).equal('Ferretry PWA');
  });

  it('waits for a freshly installed worker to activate before it can subscribe', async () => {
    const installing = fakeWorker(`${ORIGIN}/sw.verified.js`, 'installing');
    const { enrolment: browser } = containerFor([], (_url, scope) => ({
      ...fakeRegistration(scope, null),
      installing,
    }));

    const pending = browser.register(daemonA.daemonId);
    advance(installing, 'installed');
    advance(installing, 'activated');

    should(await pending).be.ok();
    should(installing.listeners).be.empty();
  });

  it('refuses a worker that never starts, and a registration that cannot hold a subscription', async () => {
    const dying = fakeWorker(`${ORIGIN}/sw.verified.js`, 'installing');
    const redundant = containerFor([], (_url, scope) => ({ ...fakeRegistration(scope, null), waiting: dying }));
    const pending = redundant.enrolment.register(daemonA.daemonId);
    advance(dying, 'redundant');
    await pending.should.be.rejectedWith(/did not start/u);

    const none = containerFor([], (_url, scope) => fakeRegistration(scope, null));
    await none.enrolment.register(daemonA.daemonId).should.be.rejectedWith(/did not start/u);

    const bare = containerFor([], () => ({}));
    await bare.enrolment.register(daemonA.daemonId).should.be.rejectedWith(/cannot hold a push subscription/u);
  });

  it('finds a daemon’s own registration and the app-wide one by their exact scopes', async () => {
    const own = fakeRegistration('/push/daemon-a/', fakeWorker(`${ORIGIN}/sw.verified.js?machine=Work%20laptop`));
    const app = fakeRegistration('/', fakeWorker(`${ORIGIN}/sw.verified.js`));
    const { enrolment: browser } = containerFor([app, own]);

    should(await browser.existing(daemonA.daemonId)).equal(own);
    should(await browser.existing(daemonB.daemonId)).be.null();
    should(await browser.shared()).equal(app);
    should(await containerFor([own]).enrolment.shared()).be.null();
  });

  it('reconciles: drops an unpaired daemon’s worker, re-labels a renamed one, leaves the rest', async () => {
    const app = fakeRegistration('/', fakeWorker(`${ORIGIN}/sw.verified.js`));
    const kept = fakeRegistration('/push/daemon-a/', fakeWorker(`${ORIGIN}/sw.verified.js?machine=Work%20laptop`));
    const renamed = fakeRegistration('/push/daemon-b/', null);
    renamed.waiting = fakeWorker(`${ORIGIN}/sw.verified.js?machine=Old%20name`);
    const gone = fakeRegistration('/push/daemon-c/', null);
    gone.installing = fakeWorker(`${ORIGIN}/sw.verified.js`);
    const silent = fakeRegistration('/push/daemon-d/', fakeWorker(`${ORIGIN}/sw.verified.js`), false);
    const { enrolment: browser, registered } = containerFor([app, kept, renamed, gone, silent]);

    await browser.reconcile([
      { daemonId: daemonA.daemonId, label: 'Work laptop' },
      { daemonId: daemonB.daemonId, label: 'Studio' },
    ]);

    should(registered).deepEqual([{ url: '/sw.verified.js?machine=Studio', scope: '/push/daemon-b/' }]);
    should([gone.unsubscribed, gone.unregistered]).deepEqual([1, 1]);
    should([silent.unsubscribed, silent.unregistered]).deepEqual([0, 1]);
    should([kept.unregistered, app.unregistered]).deepEqual([0, 0]);
  });

  it('swallows a reconcile the browser refuses', async () => {
    const broken = fakeRegistration('/push/daemon-c/', fakeWorker(`${ORIGIN}/sw.verified.js`));
    broken.unregister = async () => {
      throw new Error('denied');
    };
    await containerFor([broken]).enrolment.reconcile([]);
  });
});

describe('moveOffSharedPush: every machine off the shared subscription at start (review M3)', () => {
  it('enrols a machine whose delivery is on, revokes one whose delivery is off, and drops the shared one', async () => {
    const sharedGone: string[] = [];
    const shared = subscriptionHandle(sharedGone);
    const subscribed: PushSubscriptionHandle[] = [];
    const a = service();
    const b = service();
    const preferences = new DaemonNotificationPreferences();
    preferences.set(daemonA.daemonId, { enabled: true });
    const devices = new DaemonPushDevices();
    devices.remember(daemonB.daemonId, DEVICE_B.id);
    const browser = enrolment(null, { unregistered: true, shared, subscribed });

    await moveOffSharedPush([
      { connection: daemonA, service: a.service, devices, preferences, enrolment: browser },
      { connection: daemonB, service: b.service, devices, preferences, enrolment: browser },
    ]);

    expect(subscribed).toHaveLength(1);
    expect(a.log.registered.map(entry => entry.daemonId)).toEqual(['daemon-a']);
    expect(b.log.registered).toEqual([]);
    expect(b.log.revoked).toEqual([{ daemonId: 'daemon-b', deviceId: DEVICE_B.id }]);
    expect(devices.get(daemonB.daemonId)).toBeNull();
    expect(sharedGone.length).toBeGreaterThan(0);
  });

  it('FAILS CLOSED: drops the shared subscription even when the move-over throws', async () => {
    const sharedGone: string[] = [];
    const preferences = new DaemonNotificationPreferences();
    preferences.set(daemonA.daemonId, { enabled: true });
    const failing = service({
      register: async () => {
        throw new Error('the daemon refused');
      },
    });
    const browser = enrolment(null, { unregistered: true, shared: subscriptionHandle(sharedGone) });

    await moveOffSharedPush([
      {
        connection: daemonA,
        service: failing.service,
        devices: new DaemonPushDevices(),
        preferences,
        enrolment: browser,
      },
    ]);

    expect(sharedGone.length).toBeGreaterThan(0);
  });

  it('ONE MACHINE THAT NEVER ANSWERS holds nobody: the others move over and the shared one still goes', async () => {
    const sharedGone: string[] = [];
    const preferences = new DaemonNotificationPreferences();
    preferences.set(daemonA.daemonId, { enabled: true });
    preferences.set(daemonB.daemonId, { enabled: true });
    const hung = service({ register: () => new Promise(() => {}) });
    const fine = service();
    const subscribed: PushSubscriptionHandle[] = [];
    const browser = enrolment(null, { unregistered: true, shared: subscriptionHandle(sharedGone), subscribed });
    const devices = new DaemonPushDevices();

    await moveOffSharedPush(
      [
        { connection: daemonA, service: hung.service, devices, preferences, enrolment: browser },
        { connection: daemonB, service: fine.service, devices, preferences, enrolment: browser },
      ],
      20,
    );

    expect(fine.log.registered.map(entry => entry.daemonId)).toEqual(['daemon-b']);
    expect(sharedGone.length).toBeGreaterThan(0);
  });

  it('does nothing without Web Push, without a shared subscription, or for a machine it never enrolled', async () => {
    await moveOffSharedPush([context({ enrolment: null })]);
    const quiet = service();
    await moveOffSharedPush([context({ service: quiet.service })]);
    const sharedGone: string[] = [];
    await moveOffSharedPush([
      context({ service: quiet.service, enrolment: enrolment(null, { shared: subscriptionHandle(sharedGone) }) }),
    ]);
    expect(quiet.log.registered).toEqual([]);
    expect(quiet.log.revoked).toEqual([]);
    expect(sharedGone).toHaveLength(1);
  });
});
