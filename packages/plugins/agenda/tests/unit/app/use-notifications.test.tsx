import { describe, expect, it } from 'bun:test';
import type {
  NotifiedFleet as FleetSnapshot,
  NotifiedStatus as SessionStatus,
  NotifiedView as SessionView,
} from '../../../app/lib/notification-ledger.ts';

import {
  type NotificationControls,
  type NotificationControlsHost,
  type NotificationWatchHost,
  useNotificationControls,
  useNotificationPreferences,
  useNotificationWatch,
} from '../../../app/hooks/use-notifications.ts';
import { type DaemonConnection, daemonConnection } from '../../../app/shell.ts';
import { daemonSessionScope } from '../../../app/shell.ts';
import { DeviceNotificationFilterStore } from '../../../app/lib/notification-filter.ts';
import type { SessionsSource } from '../../../app/lib/notification-ledger.ts';
import { DaemonNotificationPreferences } from '../../../app/lib/notification-preferences.ts';
import type {
  NotificationPermissionState,
  NotificationPresentationData,
  NotificationSurface,
} from '../../../app/lib/notify.ts';
import { PUSH_UNSUPPORTED_MESSAGE, type PushDeviceView } from '../../../app/lib/push-delivery.ts';
import { render, run, runAsync } from '@ferretry/app/testing';
import { notifiedView as sessionView } from '../../support/app/notified-views.ts';
import { DEVICE, fakeDelivery, type ListRead, PUSH_INACTIVE_MESSAGE } from '../../support/app/push-delivery.ts';

const daemonA = daemonConnection({ daemonId: 'daemon-a' });
const daemonB = daemonConnection({ daemonId: 'daemon-b' });

/** A second device record, so a readout can be told apart by identity alone. */
const ROTATED_DEVICE: PushDeviceView = {
  ...DEVICE,
  id: 'push-00000000-0000-4000-8000-000000000001',
  deviceName: 'this browser, re-paired',
};

const view = (id: string, status: SessionStatus): SessionView => sessionView(id, { state: { status } });

const snapshot = (sessions: readonly SessionView[] | null): FleetSnapshot => ({
  daemons: new Map([[daemonA.daemonId, { sessions }]]),
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

/** Drains the microtask queue; callable from INSIDE an `act` scope. */
const drain = async (turns = 6) => {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
};

const settle = () => runAsync(() => drain());

/** A deeper drain, for a chain that confirms an enrolment before it lists. */
const settleDeep = () => runAsync(() => drain(24));

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
    filter: new DeviceNotificationFilterStore(),
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

    run(() => fleet.publish(snapshot([view('s1', 'failed')])));
    await settle();

    expect(target.shown).toHaveLength(1);
    expect(target.shown[0]?.data.daemonId).toBe(daemonA.daemonId);
    expect(target.shown[0]?.data.sessionId).toBe('s1');
    expect(target.shown[0]?.tag).toBe('fy-session:daemon-a:s1');
    expect(target.shown[0]?.body).toBe('Failed.');
    probe.unmount();
  });

  it('never notifies a ferret that is only waiting or finished', async () => {
    const fleet = sessionsSource(snapshot([view('s1', 'running'), view('s2', 'running')]));
    const target = surface('granted');
    const store = new DaemonNotificationPreferences();
    store.set(daemonA.daemonId, { enabled: true });
    const probe = mount(watchHost(fleet.source, target.surface, { preferences: store }), 'granted');

    run(() => fleet.publish(snapshot([view('s1', 'awaiting_user'), view('s2', 'completed')])));
    await settle();

    expect(target.shown).toHaveLength(0);
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

    run(() => watch.fleet.publish(snapshot([view('s1', 'failed')])));
    await settle();

    // Attempted, rejected, and never reported as delivered.
    expect(target.failures()).toBe(1);
    expect(target.shown).toHaveLength(0);

    // The subscription survived the failure, so the next transition still lands.
    run(() => watch.fleet.publish(snapshot([view('s1', 'stalled')])));
    await settle();

    expect(target.shown).toHaveLength(1);
    // The ledger counted the attempt it planned, so this one carries the group
    // tail; the LINE it announces is the new transition, not the lost one.
    expect(target.shown[0]?.data.latestBody).toBe('Stalled.');
    watch.probe.unmount();
  });

  it('contains a delivery whose getNotifications rejects before anything is shown', async () => {
    const target = brittleSurface('getNotifications');
    const watch = brittleWatch(target);

    run(() => watch.fleet.publish(snapshot([view('s1', 'failed')])));
    await settle();

    expect(target.failures()).toBe(1);
    expect(target.shown).toHaveLength(0);

    run(() => watch.fleet.publish(snapshot([view('s1', 'stalled')])));
    await settle();

    expect(target.shown).toHaveLength(1);
    expect(target.shown[0]?.data.latestBody).toBe('Stalled.');
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

    run(() => fleet.publish(snapshot([view('s1', 'failed')])));
    await settle();

    expect(target.shown).toHaveLength(0);
    probe.unmount();
  });

  it('defers to the device-wide filter store, not just the per-daemon master switch', async () => {
    const fleet = sessionsSource(snapshot([view('s1', 'running')]));
    const target = surface('granted');
    const store = new DaemonNotificationPreferences();
    store.set(daemonA.daemonId, { enabled: true });
    const filter = new DeviceNotificationFilterStore();
    filter.set({ categories: { failed: false } });
    const probe = mount(watchHost(fleet.source, target.surface, { preferences: store, filter }), 'granted');

    run(() => fleet.publish(snapshot([view('s1', 'failed')])));
    await settle();

    expect(target.shown).toHaveLength(0);
    probe.unmount();
  });
});

/** Answers one waiting device list read and lets its whole chain finish. */
const finish = async (read: ListRead, devices: readonly PushDeviceView[]): Promise<void> => {
  await runAsync(async () => {
    read.settle(devices);
    await drain(12);
  });
};

/**
 * The controls over a scripted push delivery (`tests/support/app/push-delivery.ts`): the enrolment itself is Access's,
 * so these prove what the Agenda's controls do with what delivery answers — the stored switch, the one permission
 * prompt, and the fence that keeps a superseded readout off the screen. A RE-PAIR, in 5.0, is the shell rebuilding the
 * machine's client, so the controls are handed a new delivery: that is the identity the fence compares now, where
 * today it compared a connection's device token and base URL.
 */
describe('useNotificationControls', () => {
  const controlsHost = (over: Partial<NotificationControlsHost> = {}): NotificationControlsHost => ({
    preferences: new DaemonNotificationPreferences(),
    surface: surface('granted').surface,
    delivery: fakeDelivery().port,
    ...over,
  });

  /**
   * Mounting is asynchronous because the mount effect is: it reads this daemon's
   * delivery, and the render is not finished until that has settled. Handing
   * back a probe before then would leave the first delivery readout landing
   * outside every `act` scope the test opens.
   */
  const mount = async (initial: NotificationControlsHost, connection: DaemonConnection = daemonA) => {
    let latest: NotificationControls | undefined;
    let host = initial;
    let daemon = connection;
    function Probe(props: { readonly host: NotificationControlsHost; readonly daemon: DaemonConnection }) {
      latest = useNotificationControls(props.host, props.daemon);
      return null;
    }
    const renderer = render(<Probe daemon={daemon} host={host} />);
    await settle();
    return {
      controls: () => {
        if (latest === undefined) throw new Error('the hook did not run');
        return latest;
      },
      setConnection: async (next: DaemonConnection) => {
        daemon = next;
        await runAsync(async () => {
          renderer.update(<Probe daemon={daemon} host={host} />);
        });
      },
      /** A re-pair: the same machine, reached through the client the shell rebuilt. */
      setHost: async (next: NotificationControlsHost) => {
        host = next;
        await runAsync(async () => {
          renderer.update(<Probe daemon={daemon} host={host} />);
        });
      },
      unmount: async () => {
        await runAsync(async () => {
          renderer.unmount();
        });
      },
    };
  };

  it('reads this daemon’s device list on mount and again after another machine is selected', async () => {
    const push = fakeDelivery();
    const host = controlsHost({ delivery: push.port });
    const probe = await mount(host);

    expect(push.log.listed).toBe(1);
    expect(probe.controls().devices).toHaveLength(1);
    expect(probe.controls().delivery).toBe('unavailable');
    expect(probe.controls().deliveryMessage).toBe(PUSH_INACTIVE_MESSAGE);
    expect(probe.controls().enabled).toBe(false);

    await probe.setConnection(daemonB);
    await settle();
    expect(push.log.listed).toBe(2);
    expect(push.log.reads).toEqual(['daemon-a', 'daemon-b']);

    await probe.unmount();
  });

  it('asks the browser once, then enrols this browser with the selected daemon', async () => {
    const target = surface('default', 'granted');
    const push = fakeDelivery();
    const host = controlsHost({ surface: target.surface, delivery: push.port });
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
    const push = fakeDelivery();
    const host = controlsHost({ surface: target.surface, delivery: push.port });
    const probe = await mount(host);

    await runAsync(async () => {
      probe.controls().setEnabled(true);
    });
    await settle();

    expect(probe.controls().permission).toBe('denied');
    expect(probe.controls().enabled).toBe(false);
    expect(probe.controls().delivery).toBe('idle');
    expect(probe.controls().deliveryMessage).toBeNull();
    expect(push.log.registered).toBe(0);

    await probe.unmount();
  });

  it('does not re-prompt a browser that has already answered', async () => {
    const target = surface('granted');
    const host = controlsHost({ surface: target.surface, delivery: fakeDelivery({ supported: false }).port });
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
    const push = fakeDelivery({ remembered: { [daemonA.daemonId]: DEVICE.id } });
    const host = controlsHost({ delivery: push.port });
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

  it('revokes a named device and re-reads the list', async () => {
    const push = fakeDelivery();
    const host = controlsHost({ delivery: push.port });
    const probe = await mount(host);

    await runAsync(async () => {
      probe.controls().revokeDevice(DEVICE.id);
    });
    await settle();

    expect(push.log.revoked).toEqual([DEVICE.id]);
    expect(push.log.listed).toBe(2);

    await probe.unmount();
  });

  it('turns the switch off when the device revoked is this browser’s own', async () => {
    const push = fakeDelivery({ remembered: { [daemonA.daemonId]: DEVICE.id } });
    const host = controlsHost({ delivery: push.port });
    host.preferences.set(daemonA.daemonId, { enabled: true });
    const probe = await mount(host);
    expect(probe.controls().currentDeviceId).toBe(DEVICE.id);

    await runAsync(async () => {
      probe.controls().revokeDevice(DEVICE.id);
    });
    await settle();

    expect(probe.controls().enabled).toBe(false);
    expect(probe.controls().currentDeviceId).toBeNull();

    await probe.unmount();
  });

  it('re-reads on request', async () => {
    const push = fakeDelivery();
    const probe = await mount(controlsHost({ delivery: push.port }));

    await runAsync(async () => {
      probe.controls().refresh();
    });
    await settle();

    expect(push.log.listed).toBe(2);

    await probe.unmount();
  });

  /**
   * THE READOUT BELONGS TO THE NEWEST PAIRING, WHATEVER RESOLVES LAST.
   *
   * A re-pair is the hard case: the daemon id is unchanged, so a fence keyed on
   * the id alone would let the previous pairing's device list land as though this
   * pairing had answered. Here the NEWER read resolves first and the superseded one
   * second, which is exactly the order a last-write-wins reader gets wrong.
   */
  it('never lets a superseded pairing’s delayed read publish over the newer one', async () => {
    const first = fakeDelivery({ deferred: true });
    const repaired = fakeDelivery({ deferred: true });
    const host = controlsHost({ delivery: first.port });
    const probe = await mount(host);

    expect(first.count()).toBe(1);
    expect(probe.controls().delivery).toBe('checking');

    await probe.setHost({ ...host, delivery: repaired.port });
    await settleDeep();
    expect(repaired.count()).toBe(1);

    await finish(repaired.read(0), [ROTATED_DEVICE]);
    expect(probe.controls().devices).toEqual([ROTATED_DEVICE]);

    await finish(first.read(0), [DEVICE]);
    expect(probe.controls().devices).toEqual([ROTATED_DEVICE]);
    expect(probe.controls().delivery).toBe('unavailable');
    expect(probe.controls().deliveryMessage).toBe(PUSH_INACTIVE_MESSAGE);

    // The fence discards the loser; it does not wedge the hook.
    await runAsync(async () => {
      probe.controls().refresh();
    });
    await settle();
    await finish(repaired.read(1), [DEVICE]);
    expect(probe.controls().devices).toEqual([DEVICE]);

    await probe.unmount();
  });

  /** Today: "fences a delayed read when only the base URL moved". A connection has no address now; the other order. */
  it('fences a superseded pairing’s delayed read that resolves before the newer one', async () => {
    const first = fakeDelivery({ deferred: true });
    const repaired = fakeDelivery({ deferred: true });
    const host = controlsHost({ delivery: first.port });
    const probe = await mount(host);

    await probe.setHost({ ...host, delivery: repaired.port });
    await settleDeep();

    await finish(first.read(0), [DEVICE]);
    expect(probe.controls().devices).toEqual([]);
    expect(probe.controls().delivery).toBe('checking');

    await finish(repaired.read(0), [ROTATED_DEVICE]);
    expect(probe.controls().devices).toEqual([ROTATED_DEVICE]);

    await probe.unmount();
  });

  it('keeps another daemon’s delayed read out of this daemon’s readout', async () => {
    const push = fakeDelivery({ deferred: true });
    const probe = await mount(controlsHost({ delivery: push.port }));

    await probe.setConnection(daemonB);
    await settleDeep();

    expect(push.read(1).connection.daemonId).toBe(daemonB.daemonId);
    await finish(push.read(1), [ROTATED_DEVICE]);
    await finish(push.read(0), [DEVICE]);

    expect(probe.controls().devices).toEqual([ROTATED_DEVICE]);

    await probe.unmount();
  });

  it('never lets a superseded revoke publish its result', async () => {
    const first = fakeDelivery({ deferred: true });
    const repaired = fakeDelivery({ deferred: true });
    const host = controlsHost({ delivery: first.port });
    const probe = await mount(host);
    await finish(first.read(0), [DEVICE]);
    expect(probe.controls().devices).toEqual([DEVICE]);

    await runAsync(async () => {
      probe.controls().revokeDevice(DEVICE.id);
      await drain(12);
    });

    // The revoke itself reached the daemon that issued the id; only its readout
    // is still in flight when the pairing changes underneath it.
    expect(first.log.revoked).toEqual([DEVICE.id]);
    expect(first.count()).toBe(2);

    await probe.setHost({ ...host, delivery: repaired.port });
    await settleDeep();
    await finish(repaired.read(0), [ROTATED_DEVICE]);
    await finish(first.read(1), []);

    expect(probe.controls().devices).toEqual([ROTATED_DEVICE]);

    await probe.unmount();
  });

  /**
   * Enabling is asked of ONE daemon and must still finish against it: the fence
   * withholds the readout, never the enrolment, so the device the reader asked
   * for exists even though a newer pairing now owns the screen.
   */
  it('completes a superseded enrolment without publishing its readout', async () => {
    const first = fakeDelivery({ deferred: true });
    const repaired = fakeDelivery({ deferred: true });
    const host = controlsHost({ delivery: first.port });
    const probe = await mount(host);
    await finish(first.read(0), [DEVICE]);

    await runAsync(async () => {
      probe.controls().setEnabled(true);
      await drain(12);
    });
    expect(first.log.registered).toBe(1);
    expect(first.count()).toBe(2);

    await probe.setHost({ ...host, delivery: repaired.port });
    await settleDeep();
    await finish(repaired.read(0), [ROTATED_DEVICE]);
    await finish(first.read(1), [DEVICE]);

    expect(probe.controls().devices).toEqual([ROTATED_DEVICE]);
    // The stored preference for that daemon still records what was asked for.
    expect(probe.controls().enabled).toBe(true);

    await probe.unmount();
  });
});
