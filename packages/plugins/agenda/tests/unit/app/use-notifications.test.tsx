import { describe, expect, it } from 'bun:test';
import type {
  NotifiedFleet as FleetSnapshot,
  NotifiedStatus as SessionStatus,
  NotifiedView as SessionView,
} from '../../../app/lib/notification-ledger.ts';

import {
  type NotificationWatchHost,
  useNotificationPreferences,
  useNotificationWatch,
} from '../../../app/hooks/use-notifications.ts';
import { daemonConnection } from '../../../app/shell.ts';
import { daemonSessionScope } from '../../../app/shell.ts';
import { DeviceNotificationFilterStore } from '../../../app/lib/notification-filter.ts';
import type { SessionsSource } from '../../../app/lib/notification-ledger.ts';
import { DaemonNotificationPreferences } from '../../../app/lib/notification-preferences.ts';
import type {
  NotificationPermissionState,
  NotificationPresentationData,
  NotificationSurface,
} from '../../../app/lib/notify.ts';
import { render, run, runAsync } from '@ferretry/app/testing';
import { notifiedView as sessionView } from '../../support/app/notified-views.ts';

const daemonA = daemonConnection({ daemonId: 'daemon-a' });
const daemonB = daemonConnection({ daemonId: 'daemon-b' });

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
