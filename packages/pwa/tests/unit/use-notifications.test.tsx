import type { PushDeviceView, PushPreferences, SessionStatus, SessionView } from '@ferretry/protocol';
import { describe, expect, it } from 'bun:test';

import {
  type NotificationControls,
  type NotificationControlsHost,
  type NotificationWatchHost,
  useNotificationControls,
  useNotificationPreferences,
  useNotificationWatch,
} from '../../src/hooks/use-notifications.ts';
import { type DaemonConnection, daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import type { FleetSnapshot } from '../../src/lib/fleet-store.ts';
import type { SessionsSource } from '../../src/lib/notification-ledger.ts';
import { DaemonNotificationPreferences } from '../../src/lib/notification-preferences.ts';
import type {
  NotificationPermissionState,
  NotificationPresentationData,
  NotificationSurface,
} from '../../src/lib/notify.ts';
import {
  PUSH_INACTIVE_MESSAGE,
  PUSH_UNSUPPORTED_MESSAGE,
  type DaemonPushService,
  type PushEnrolment,
  type PushRegistrationLike,
  type PushSubscriptionHandle,
  DaemonPushDevices,
} from '../../src/lib/push-enrolment.ts';
import { render, run, runAsync } from '../support/react.ts';
import { sessionView } from '../support/sessions.ts';

const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceToken: 'token-a' });
const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.example.test', deviceToken: 'token-b' });

/** The SAME daemon after a credential rotation: a different live connection. */
const rotatedA = daemonConnection({
  daemonId: 'daemon-a',
  baseUrl: 'https://a.example.test',
  deviceToken: 'token-a-rotated',
});

/** The same daemon and credential reached at a new address. */
const movedA = daemonConnection({
  daemonId: 'daemon-a',
  baseUrl: 'https://a2.example.test',
  deviceToken: 'token-a',
});

const prefs: PushPreferences = {
  events: { attention: true, question: true, failed: true, completed: true },
  interactiveOnly: false,
};

const DEVICE: PushDeviceView = {
  id: 'push-00000000-0000-4000-8000-000000000000',
  deviceName: 'this browser',
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-01T10:00:00.000Z',
  expirationTime: null,
  prefs,
};

/** A second device record, so a readout can be told apart by identity alone. */
const ROTATED_DEVICE: PushDeviceView = {
  ...DEVICE,
  id: 'push-00000000-0000-4000-8000-000000000001',
  deviceName: 'this browser, re-paired',
};

const view = (id: string, status: SessionStatus): SessionView => sessionView(id, { state: { status } });

const snapshot = (sessions: readonly SessionView[] | null): FleetSnapshot => ({
  daemons: new Map([
    [daemonA.daemonId, { sessions, byId: new Map(), status: sessions === null ? 'idle' : 'ready', error: null }],
  ]),
});

/** A fleet source the test advances by hand, so no socket or clock is involved. */
const sessionsSource = (initial: FleetSnapshot | null = null) => {
  const listeners = new Set<() => void>();
  let current = initial;
  const source: SessionsSource = {
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => current,
  };
  return {
    source,
    listenerCount: () => listeners.size,
    publish: (next: FleetSnapshot) => {
      current = next;
      for (const listener of [...listeners]) listener();
    },
  };
};

const subscriptionHandle = (): PushSubscriptionHandle => ({
  toJSON: () => ({
    endpoint: 'https://push.example.test/x',
    expirationTime: null,
    keys: { p256dh: 'B'.repeat(87), auth: 'C'.repeat(22) },
  }),
  unsubscribe: async () => true,
});

const enrolment = (): PushEnrolment => {
  const registration: PushRegistrationLike = {
    pushManager: {
      getSubscription: async () => subscriptionHandle(),
      subscribe: async () => subscriptionHandle(),
    },
  };
  return { registration: async () => registration, deviceName: () => 'this browser' };
};

/** What reached the OS: the title and the presentation data a click resolves. */
interface ShownNotification {
  readonly title: string;
  readonly tag: string | undefined;
  readonly body: string | undefined;
  readonly data: NotificationPresentationData;
}

interface SurfaceHarness {
  readonly surface: NotificationSurface;
  readonly shown: ShownNotification[];
  readonly requests: number;
}

const surface = (
  permission: NotificationPermissionState,
  requested: NotificationPermissionState = 'granted',
): SurfaceHarness => {
  const shown: ShownNotification[] = [];
  const harness = {
    shown,
    requests: 0,
    surface: {
      permission: () => permission,
      requestPermission: async () => {
        harness.requests += 1;
        return requested;
      },
      registration: async () => ({
        getNotifications: async () => [],
        showNotification: async (title: string, options?: NotificationOptions) => {
          shown.push({
            title,
            tag: options?.tag,
            body: options?.body,
            data: options?.data as NotificationPresentationData,
          });
        },
      }),
      showOnPage: null,
      navigate: () => undefined,
    } satisfies NotificationSurface,
  };
  return harness;
};

/**
 * A granted surface whose registration rejects the FIRST delivery it is asked
 * for, then works. A worker that dies between the permission read and the show
 * is an ordinary browser event, and both registration calls are asynchronous, so
 * either one can be the rejection the hook has to contain.
 */
const brittleSurface = (
  failing: 'getNotifications' | 'showNotification',
): SurfaceHarness & { failures: () => number } => {
  const shown: ShownNotification[] = [];
  let failures = 0;
  const fail = (stage: 'getNotifications' | 'showNotification'): never => {
    failures += 1;
    throw new Error(`the worker went away during ${stage}`);
  };
  return {
    shown,
    requests: 0,
    failures: () => failures,
    surface: {
      permission: () => 'granted',
      requestPermission: async () => 'granted',
      registration: async () => ({
        getNotifications: async () => {
          if (failing === 'getNotifications' && failures === 0) fail('getNotifications');
          return [];
        },
        showNotification: async (title: string, options?: NotificationOptions) => {
          if (failing === 'showNotification' && failures === 0) fail('showNotification');
          shown.push({
            title,
            tag: options?.tag,
            body: options?.body,
            data: options?.data as NotificationPresentationData,
          });
        },
      }),
      showOnPage: null,
      navigate: () => undefined,
    } satisfies NotificationSurface,
  };
};

const service = (over: Partial<DaemonPushService> = {}) => {
  const log = { registered: 0, revoked: [] as string[], listed: 0 };
  const base: DaemonPushService = {
    vapidKey: async () => 'key',
    list: async () => {
      log.listed += 1;
      return [DEVICE];
    },
    register: async () => {
      log.registered += 1;
      return DEVICE;
    },
    revoke: async (_connection, deviceId) => {
      log.revoked.push(deviceId);
      return DEVICE;
    },
  };
  return { service: { ...base, ...over }, log };
};

/** Drains the microtask queue; callable from INSIDE an `act` scope. */
const drain = async (turns = 6) => {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
};

const settle = () => runAsync(() => drain());

/** A deeper drain, for a chain that confirms an enrolment before it lists. */
const settleDeep = () => runAsync(() => drain(24));

/**
 * A push service whose device list resolves only when the test says so, which is
 * what makes a read's resolution ORDER something a test can choose.
 */
const deferredService = () => {
  const reads: {
    readonly connection: DaemonConnection;
    readonly settle: (devices: readonly PushDeviceView[]) => void;
  }[] = [];
  const push = service({
    list: connection =>
      new Promise<readonly PushDeviceView[]>(resolve => {
        reads.push({ connection, settle: resolve });
      }),
  });
  return {
    ...push,
    count: () => reads.length,
    /** Resolves the n-th started read and lets its whole chain finish. */
    finish: async (index: number, devices: readonly PushDeviceView[]) => {
      const read = reads[index];
      if (read === undefined) throw new Error(`no delivery read #${index} has been started`);
      await runAsync(async () => {
        read.settle(devices);
        await drain(12);
      });
      return read.connection;
    },
  };
};

describe('useNotificationPreferences', () => {
  it('re-renders on this daemon’s change and ignores another pairing’s', () => {
    const store = new DaemonNotificationPreferences();
    let renders = 0;
    function Probe() {
      renders += 1;
      const preferences = useNotificationPreferences(store, daemonA.daemonId);
      return <span>{String(preferences.enabled)}</span>;
    }
    const renderer = render(<Probe />);

    expect(renderer.root.findByType('span').children).toEqual(['false']);
    const before = renders;

    run(() => {
      store.set(daemonB.daemonId, { enabled: true });
    });
    expect(renders).toBe(before);

    run(() => {
      store.set(daemonA.daemonId, { enabled: true });
    });
    expect(renderer.root.findByType('span').children).toEqual(['true']);

    run(() => renderer.unmount());
  });
});

describe('useNotificationWatch', () => {
  const mount = (host: NotificationWatchHost, permission: NotificationPermissionState) => {
    function Probe({ granted }: { readonly granted: NotificationPermissionState }) {
      useNotificationWatch(host, granted);
      return null;
    }
    const renderer = render(<Probe granted={permission} />);
    return {
      setPermission: (next: NotificationPermissionState) =>
        run(() => {
          renderer.update(<Probe granted={next} />);
        }),
      unmount: () => run(() => renderer.unmount()),
    };
  };

  const watchHost = (
    source: SessionsSource,
    view: NotificationSurface,
    over: Partial<NotificationWatchHost> = {},
  ): NotificationWatchHost => ({
    sessions: source,
    preferences: new DaemonNotificationPreferences(),
    surface: view,
    hidden: () => true,
    foregroundSession: () => null,
    now: () => 1_000,
    ...over,
  });

  it('costs one subscription and nothing else until permission is granted', () => {
    const fleet = sessionsSource(snapshot([view('s1', 'running')]));
    const target = surface('default');
    const host = watchHost(fleet.source, target.surface);
    const probe = mount(host, 'default');

    expect(fleet.listenerCount()).toBe(0);

    probe.setPermission('granted');
    expect(fleet.listenerCount()).toBe(1);

    probe.unmount();
    expect(fleet.listenerCount()).toBe(0);
  });

  it('shows one daemon-qualified notification per real transition', async () => {
    const fleet = sessionsSource(snapshot([view('s1', 'running')]));
    const target = surface('granted');
    const store = new DaemonNotificationPreferences();
    store.set(daemonA.daemonId, { enabled: true });
    const probe = mount(watchHost(fleet.source, target.surface, { preferences: store }), 'granted');

    run(() => fleet.publish(snapshot([view('s1', 'awaiting_user')])));
    await settle();

    expect(target.shown).toHaveLength(1);
    expect(target.shown[0]?.data.daemonId).toBe(daemonA.daemonId);
    expect(target.shown[0]?.data.sessionId).toBe('s1');
    expect(target.shown[0]?.tag).toBe('fy-session:daemon-a:s1');
    expect(target.shown[0]?.body).toBe('Waiting for you at the prompt.');
    probe.unmount();
  });

  /**
   * A rejecting delivery must not escape the hook. Bun fails any test that lets
   * an unhandled rejection reach the runtime, so these two cases are red without
   * the containment and green with it — the assertions then prove the rest: the
   * failed transition was never counted as shown, and the watch is still alive.
   */
  const brittleWatch = (target: SurfaceHarness) => {
    const fleet = sessionsSource(snapshot([view('s1', 'running')]));
    const store = new DaemonNotificationPreferences();
    store.set(daemonA.daemonId, { enabled: true });
    return { fleet, probe: mount(watchHost(fleet.source, target.surface, { preferences: store }), 'granted') };
  };

  it('contains a delivery whose showNotification rejects and keeps watching', async () => {
    const target = brittleSurface('showNotification');
    const watch = brittleWatch(target);

    run(() => watch.fleet.publish(snapshot([view('s1', 'awaiting_user')])));
    await settle();

    // Attempted, rejected, and never reported as delivered.
    expect(target.failures()).toBe(1);
    expect(target.shown).toHaveLength(0);

    // The subscription survived the failure, so the next transition still lands.
    run(() => watch.fleet.publish(snapshot([view('s1', 'completed')])));
    await settle();

    expect(target.shown).toHaveLength(1);
    // The ledger counted the attempt it planned, so this one carries the group
    // tail; the LINE it announces is the new transition, not the lost one.
    expect(target.shown[0]?.data.latestBody).toBe('Finished its task.');
    watch.probe.unmount();
  });

  it('contains a delivery whose getNotifications rejects before anything is shown', async () => {
    const target = brittleSurface('getNotifications');
    const watch = brittleWatch(target);

    run(() => watch.fleet.publish(snapshot([view('s1', 'awaiting_user')])));
    await settle();

    expect(target.failures()).toBe(1);
    expect(target.shown).toHaveLength(0);

    run(() => watch.fleet.publish(snapshot([view('s1', 'failed')])));
    await settle();

    expect(target.shown).toHaveLength(1);
    expect(target.shown[0]?.data.latestBody).toBe('Failed.');
    watch.probe.unmount();
  });

  it('never notifies about the pane the reader is already looking at', async () => {
    const fleet = sessionsSource(snapshot([view('s1', 'running')]));
    const target = surface('granted');
    const store = new DaemonNotificationPreferences();
    store.set(daemonA.daemonId, { enabled: true, onlyWhenHidden: false });
    const probe = mount(
      watchHost(fleet.source, target.surface, {
        preferences: store,
        hidden: () => false,
        foregroundSession: () => daemonSessionScope(daemonA, 's1'),
      }),
      'granted',
    );

    run(() => fleet.publish(snapshot([view('s1', 'awaiting_user')])));
    await settle();

    expect(target.shown).toHaveLength(0);
    probe.unmount();
  });
});

describe('useNotificationControls', () => {
  const controlsHost = (over: Partial<NotificationControlsHost> = {}): NotificationControlsHost => ({
    preferences: new DaemonNotificationPreferences(),
    surface: surface('granted').surface,
    service: service().service,
    devices: new DaemonPushDevices(),
    enrolment: enrolment(),
    ...over,
  });

  /**
   * Mounting is asynchronous because the mount effect is: it reads this daemon's
   * device list, and the render is not finished until that has settled. Handing
   * back a probe before then would leave the first delivery readout landing
   * outside every `act` scope the test opens.
   */
  const mount = async (host: NotificationControlsHost, connection: DaemonConnection = daemonA) => {
    let latest: NotificationControls | undefined;
    function Probe({ daemon }: { readonly daemon: DaemonConnection }) {
      latest = useNotificationControls(host, daemon);
      return null;
    }
    const renderer = render(<Probe daemon={connection} />);
    await settle();
    return {
      controls: () => {
        if (latest === undefined) throw new Error('the hook did not run');
        return latest;
      },
      setConnection: async (daemon: DaemonConnection) => {
        await runAsync(async () => {
          renderer.update(<Probe daemon={daemon} />);
        });
      },
      unmount: async () => {
        await runAsync(async () => {
          renderer.unmount();
        });
      },
    };
  };

  it('reads this daemon’s device list on mount and again after a re-pair', async () => {
    const push = service();
    const host = controlsHost({ service: push.service });
    const probe = await mount(host);

    expect(push.log.listed).toBe(1);
    expect(probe.controls().devices).toHaveLength(1);
    expect(probe.controls().delivery).toBe('unavailable');
    expect(probe.controls().deliveryMessage).toBe(PUSH_INACTIVE_MESSAGE);
    expect(probe.controls().enabled).toBe(false);

    await probe.setConnection(daemonB);
    await settle();
    expect(push.log.listed).toBe(2);

    await probe.unmount();
  });

  it('asks the browser once, then enrols this browser with the selected daemon', async () => {
    const target = surface('default', 'granted');
    const push = service();
    const host = controlsHost({ surface: target.surface, service: push.service });
    const probe = await mount(host);

    await runAsync(async () => {
      probe.controls().setEnabled(true);
    });
    await settle();

    expect(target.requests).toBe(1);
    expect(probe.controls().permission).toBe('granted');
    expect(probe.controls().enabled).toBe(true);
    expect(probe.controls().delivery).toBe('active');
    expect(probe.controls().currentDeviceId).toBe(DEVICE.id);
    expect(push.log.registered).toBeGreaterThan(0);

    await probe.unmount();
  });

  it('leaves the switch off when the browser refuses', async () => {
    const target = surface('default', 'denied');
    const host = controlsHost({ surface: target.surface });
    const probe = await mount(host);

    await runAsync(async () => {
      probe.controls().setEnabled(true);
    });
    await settle();

    expect(probe.controls().permission).toBe('denied');
    expect(probe.controls().enabled).toBe(false);
    expect(probe.controls().delivery).toBe('idle');
    expect(probe.controls().deliveryMessage).toBeNull();

    await probe.unmount();
  });

  it('does not re-prompt a browser that has already answered', async () => {
    const target = surface('granted');
    const host = controlsHost({ surface: target.surface, enrolment: null });
    const probe = await mount(host);

    await runAsync(async () => {
      probe.controls().setEnabled(true);
    });
    await settle();

    expect(target.requests).toBe(0);
    expect(probe.controls().enabled).toBe(true);
    expect(probe.controls().deliveryMessage).toBe(PUSH_UNSUPPORTED_MESSAGE);

    await probe.unmount();
  });

  it('turns delivery off and revokes this daemon’s device', async () => {
    const push = service();
    const devices = new DaemonPushDevices();
    devices.remember(daemonA.daemonId, DEVICE.id);
    const host = controlsHost({ service: push.service, devices });
    host.preferences.set(daemonA.daemonId, { enabled: true });
    const probe = await mount(host);

    await runAsync(async () => {
      probe.controls().setEnabled(false);
    });
    await settle();

    expect(push.log.revoked).toEqual([DEVICE.id]);
    expect(probe.controls().enabled).toBe(false);

    await probe.unmount();
  });

  it('sends changed events onward only while delivery is on', async () => {
    const push = service();
    const host = controlsHost({ service: push.service });
    const probe = await mount(host);
    const quiet = push.log.registered;

    await runAsync(async () => {
      probe.controls().setPreferences({ events: { ...prefs.events, completed: false }, interactiveOnly: true });
    });
    await settle();

    expect(push.log.registered).toBe(quiet);
    expect(probe.controls().preferences.interactiveOnly).toBe(true);
    expect(probe.controls().preferences.events.completed).toBe(false);

    // The mounted probe subscribes to this store, so turning the master switch on
    // re-renders it: an unwrapped write here is a state update outside `act`.
    run(() => {
      host.preferences.set(daemonA.daemonId, { enabled: true });
    });
    await runAsync(async () => {
      probe.controls().setPreferences({ events: prefs.events, interactiveOnly: false });
    });
    await settle();

    expect(push.log.registered).toBeGreaterThan(quiet);
    expect(probe.controls().delivery).toBe('active');

    await probe.unmount();
  });

  it('revokes a named device and re-reads the list', async () => {
    const push = service();
    const host = controlsHost({ service: push.service });
    const probe = await mount(host);

    await runAsync(async () => {
      probe.controls().revokeDevice(DEVICE.id);
    });
    await settle();

    expect(push.log.revoked).toEqual([DEVICE.id]);
    expect(push.log.listed).toBe(2);

    await probe.unmount();
  });

  it('re-reads on request', async () => {
    const push = service();
    const probe = await mount(controlsHost({ service: push.service }));

    await runAsync(async () => {
      probe.controls().refresh();
    });
    await settle();

    expect(push.log.listed).toBe(2);

    await probe.unmount();
  });

  /**
   * THE READOUT BELONGS TO THE NEWEST CONNECTION, WHATEVER RESOLVES LAST.
   *
   * A rotated device token is the hard case: the daemon id is unchanged, so a
   * fence keyed on identity alone would let the previous pairing's device list
   * land as though this pairing had answered. Here the NEWER read resolves first
   * and the superseded one second, which is exactly the order a last-write-wins
   * reader gets wrong.
   */
  it('never lets a superseded pairing’s delayed read publish over the newer one', async () => {
    const push = deferredService();
    const probe = await mount(controlsHost({ service: push.service }));

    expect(push.count()).toBe(1);
    expect(probe.controls().delivery).toBe('checking');

    await probe.setConnection(rotatedA);
    await settleDeep();
    expect(push.count()).toBe(2);

    const newer = await push.finish(1, [ROTATED_DEVICE]);
    expect(newer.deviceToken).toBe(rotatedA.deviceToken);
    expect(probe.controls().devices).toEqual([ROTATED_DEVICE]);

    const superseded = await push.finish(0, [DEVICE]);
    expect(superseded.deviceToken).toBe(daemonA.deviceToken);
    expect(probe.controls().devices).toEqual([ROTATED_DEVICE]);
    expect(probe.controls().delivery).toBe('unavailable');
    expect(probe.controls().deliveryMessage).toBe(PUSH_INACTIVE_MESSAGE);

    // The fence discards the loser; it does not wedge the hook.
    await runAsync(async () => {
      probe.controls().refresh();
    });
    await settle();
    await push.finish(2, [DEVICE]);
    expect(probe.controls().devices).toEqual([DEVICE]);

    await probe.unmount();
  });

  it('fences a delayed read when only the base URL moved', async () => {
    const push = deferredService();
    const probe = await mount(controlsHost({ service: push.service }));

    await probe.setConnection(movedA);
    await settleDeep();

    const newer = await push.finish(1, [ROTATED_DEVICE]);
    expect(newer.baseUrl).toBe(movedA.baseUrl);
    await push.finish(0, [DEVICE]);

    expect(probe.controls().devices).toEqual([ROTATED_DEVICE]);

    await probe.unmount();
  });

  it('keeps another daemon’s delayed read out of this daemon’s readout', async () => {
    const push = deferredService();
    const probe = await mount(controlsHost({ service: push.service }));

    await probe.setConnection(daemonB);
    await settleDeep();

    const newer = await push.finish(1, [ROTATED_DEVICE]);
    expect(newer.daemonId).toBe(daemonB.daemonId);
    await push.finish(0, [DEVICE]);

    expect(probe.controls().devices).toEqual([ROTATED_DEVICE]);

    await probe.unmount();
  });

  it('never lets a superseded revoke publish its result', async () => {
    const push = deferredService();
    const probe = await mount(controlsHost({ service: push.service }));
    await push.finish(0, [DEVICE]);
    expect(probe.controls().devices).toEqual([DEVICE]);

    await runAsync(async () => {
      probe.controls().revokeDevice(DEVICE.id);
      await drain(12);
    });

    // The revoke itself reached the daemon that issued the id; only its readout
    // is still in flight when the pairing rotates underneath it.
    expect(push.log.revoked).toEqual([DEVICE.id]);
    expect(push.count()).toBe(2);

    await probe.setConnection(rotatedA);
    await settleDeep();
    await push.finish(2, [ROTATED_DEVICE]);
    await push.finish(1, []);

    expect(probe.controls().devices).toEqual([ROTATED_DEVICE]);

    await probe.unmount();
  });

  /**
   * Enabling is asked of ONE daemon and must still finish against it: the fence
   * withholds the readout, never the enrolment, so the device the reader asked
   * for exists even though a newer pairing now owns the screen.
   */
  it('completes a superseded enrolment without publishing its readout', async () => {
    const push = deferredService();
    const host = controlsHost({ service: push.service });
    const probe = await mount(host);
    await push.finish(0, [DEVICE]);

    await runAsync(async () => {
      probe.controls().setEnabled(true);
      await drain(12);
    });
    expect(push.log.registered).toBe(1);
    expect(push.count()).toBe(2);

    await probe.setConnection(rotatedA);
    await settleDeep();
    await push.finish(2, [ROTATED_DEVICE]);
    await push.finish(1, [DEVICE]);

    expect(probe.controls().devices).toEqual([ROTATED_DEVICE]);
    // The stored preference for that daemon still records what was asked for.
    expect(probe.controls().enabled).toBe(true);

    await probe.unmount();
  });
});
