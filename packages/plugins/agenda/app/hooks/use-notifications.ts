/**
 * NOTIFICATION WIRING — the React shell over the notification subsystem.
 *
 * Ported from kteam `ui/src/hooks/useNotifications.ts`, with its two consumers
 * intact: a composition root mounts `useNotificationWatch` once to run the
 * fleet-diff watch, and the settings surface uses `useNotificationControls` to
 * render the toggles, run the ONE reader-initiated permission request, and manage
 * this browser's push enrolment.
 *
 * PERMISSION IS NEVER REQUESTED BY AN EFFECT. It is asked only from
 * `setEnabled`, which a reader reaches by pressing the master control. Browsers
 * punish ambient prompts, and quiet-by-default is what the preference store
 * already encodes.
 *
 * EVERYTHING IS DAEMON SCOPED. kteam held one preference snapshot, one permission
 * snapshot and one push device id in module globals, because there was one daemon.
 * Here the preference store, the device memory, the enrolment and every control
 * callback name their `DaemonConnection`, so a reader paired to two daemons
 * configures, enrols and revokes each independently — and the watch reads each
 * daemon's own preferences on every tick rather than whichever was read last.
 *
 * ASYNCHRONOUS WORK IS FENCED AND CONTAINED. Nothing in here can cancel a read
 * or a delivery already in flight, so `useNotificationControls` publishes a
 * readout only while the connection context that started it is still the current
 * one, and `useNotificationWatch` contains a rejected delivery instead of letting
 * it escape the effect that started it. Both are spelled out where they happen.
 *
 * NO BROWSER GLOBAL IS READ IN HERE. Permission, the registration and the
 * page-level constructor arrive as a `NotificationSurface`; push delivery
 * arrives as a `PushDeliveryPort` (the enrolment itself is Access's). That is what lets the whole subsystem be proved
 * by executed tests, and it is also why a static bundle carries no daemon URL:
 * the only URL this module ever follows is the in-app path the ledger produced.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { DaemonConnection, DaemonId } from '../shell.ts';
import type { DaemonSessionScope } from '../shell.ts';
import type { DeviceNotificationFilterPreferences, DeviceNotificationFilterStore } from '../lib/notification-filter.ts';
import { type SessionsSource, startNotificationWatch } from '../lib/notification-ledger.ts';
import type { DaemonNotificationPreferences, NotificationPreferences } from '../lib/notification-preferences.ts';
import {
  type NotificationPermissionState,
  type NotificationSurface,
  notificationPayload,
  showNotification,
} from '../lib/notify.ts';
import type { PushDeliveryPort, PushDeliveryReport, PushDeliveryStatus, PushDeviceView } from '../lib/push-delivery.ts';

/** One daemon's live preference slice; another pairing's changes never re-render it. */
export const useNotificationPreferences = (
  store: DaemonNotificationPreferences,
  daemon: DaemonId,
): NotificationPreferences => {
  const subscribe = useCallback((listener: () => void) => store.subscribe(daemon, listener), [daemon, store]);
  const snapshot = useCallback(() => store.get(daemon), [daemon, store]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
};

/** This browser's one device-wide filter — the same for every daemon (`notification-filter.ts`). */
export const useNotificationFilterPreferences = (
  store: DeviceNotificationFilterStore,
): DeviceNotificationFilterPreferences => useSyncExternalStore(store.subscribe, store.get, store.get);

export interface NotificationWatchHost {
  /** The fleet cache, whose `null` snapshot means "not yet" rather than "empty". */
  readonly sessions: SessionsSource;
  readonly preferences: DaemonNotificationPreferences;
  readonly filter: DeviceNotificationFilterStore;
  readonly surface: NotificationSurface;
  /** Whether the app is currently out of sight. */
  readonly hidden: () => boolean;
  /** The exact pane the reader is looking at, so it is never notified about. */
  readonly foregroundSession: () => DaemonSessionScope | null;
  readonly now: () => number;
}

/**
 * Mounts the fleet watch ONCE, for every paired daemon at the same time.
 *
 * Permission is the only gate here. The per-daemon master switch is not: the
 * watch reads each daemon's preferences live on every tick, so a daemon whose
 * reader has notifications off is silently skipped while the others keep working,
 * and flipping a switch needs no restart. While permission is not granted this
 * costs one subscription and nothing else.
 */
export const useNotificationWatch = (host: NotificationWatchHost, permission: NotificationPermissionState): void => {
  useEffect(() => {
    if (permission !== 'granted') return;
    return startNotificationWatch(host.sessions, {
      prefs: daemon => host.preferences.get(daemon),
      filter: () => host.filter.get(),
      hidden: host.hidden,
      foregroundSession: host.foregroundSession,
      show: spec => {
        // DELIVERY FAILURE IS CONTAINED HERE, AT THE BOUNDARY THAT STARTED IT.
        //
        // A registration is remote machinery: `getNotifications` and
        // `showNotification` are both asynchronous and both can reject — a worker
        // that died between the permission read and this call, or an engine that
        // refuses the tag. Left as a bare fire-and-forget, that rejection escapes
        // as an unhandled rejection, which a browser logs and a test host treats
        // as a failure of whatever happened to be running.
        //
        // The rejection is swallowed rather than reported, and swallowing it
        // claims NOTHING: `showNotification` answers an outcome for a delivery
        // that happened, and a rejected transport produced no outcome at all. The
        // fleet UI still shows the status change the notification would have
        // announced, and the next transition tries again with a fresh read.
        void showNotification(host.surface, notificationPayload(spec)).catch(() => undefined);
      },
      now: host.now,
    });
  }, [host, permission]);
};

export interface NotificationControlsHost {
  readonly preferences: DaemonNotificationPreferences;
  readonly surface: NotificationSurface;
  /** This browser's push delivery with each machine: Access's, handed in (`UNBOUND_PUSH_DELIVERY` when none is). */
  readonly delivery: PushDeliveryPort;
}

export interface NotificationControls {
  readonly permission: NotificationPermissionState;
  readonly preferences: NotificationPreferences;
  /** The reader's stored master switch for THIS daemon. */
  readonly enabled: boolean;
  readonly delivery: PushDeliveryStatus;
  readonly deliveryMessage: string | null;
  readonly devices: readonly PushDeviceView[];
  readonly currentDeviceId: string | null;
  /**
   * Flips the master switch. Enabling while permission is still undecided runs
   * the browser prompt FIRST, so this must be reached from a reader gesture; a
   * denial leaves the switch off, because the UI may not claim a capability it
   * does not have.
   */
  readonly setEnabled: (enabled: boolean) => void;
  /** Per-device revocation against the daemon that issued the device id. */
  readonly revokeDevice: (deviceId: string) => void;
  readonly refresh: () => void;
}

const IDLE_REPORT: PushDeliveryReport = { status: 'idle', message: null, devices: [], currentDeviceId: null };

/** The machine and the delivery one readout was asked of: the identity the fence below compares. */
interface DeliveryContext {
  readonly connection: DaemonConnection;
  readonly delivery: PushDeliveryPort;
}

/**
 * The settings surface's controls for exactly one paired daemon.
 *
 * It reads that daemon's delivery on mount, because "Registered devices" is
 * part of what the screen exists to show, and re-reads it whenever the selected
 * machine or the delivery handed in changes. A preference toggle does NOT re-read
 * the list: it asks delivery to enrol or revoke and keeps the readout it gets.
 *
 * The stored switch is the Agenda's (`DaemonNotificationPreferences`): enabling
 * stores it on before enrolling — permission still has value, because the live
 * app notifies while it is open — and disabling, or revoking THIS browser's own
 * device, stores it off, so the UI never claims delivery it no longer has.
 */
export const useNotificationControls = (
  host: NotificationControlsHost,
  connection: DaemonConnection,
): NotificationControls => {
  const [permission, setPermission] = useState<NotificationPermissionState>(() => host.surface.permission());
  const [report, setReport] = useState<PushDeliveryReport>(IDLE_REPORT);
  const preferences = useNotificationPreferences(host.preferences, connection.daemonId);

  // By the machine's id and the delivery itself, not by the connection object: a root that rebuilds an equivalent
  // connection each render has not re-paired, while a re-pair hands a new delivery (the shell rebuilt the client).
  // biome-ignore lint/correctness/useExhaustiveDependencies: the daemon id is the deliberate re-read trigger, see above
  const context = useMemo<DeliveryContext>(
    () => ({ connection, delivery: host.delivery }),
    [connection.daemonId, host.delivery],
  );

  // ONLY THE NEWEST CONTEXT MAY PUBLISH A READOUT.
  //
  // Every delivery read is asynchronous and none of them can be cancelled, so a
  // read started for the previous context is still in flight when another machine
  // is selected or a re-pair hands a new delivery. Whichever resolves last would
  // otherwise win, and the loser is not merely stale: it is a different machine's
  // (or a superseded pairing's) device list, presented as this one's.
  //
  // The fence is applied at resolution rather than at launch, because an enrolment
  // or a revoke was already asked for and must still complete against the machine
  // it was addressed to.
  const currentContext = useRef(context);
  if (currentContext.current !== context) currentContext.current = context;
  const lastReport = useRef(report);
  lastReport.current = report;

  const publish = useCallback(
    (from: DeliveryContext) =>
      (next: PushDeliveryReport): void => {
        if (currentContext.current !== from) return;
        setReport(next);
      },
    [],
  );

  const markChecking = useCallback(() => {
    setReport(current => ({ ...current, status: 'checking', message: null }));
  }, []);

  const refresh = useCallback(() => {
    markChecking();
    const started = context;
    void started.delivery
      .read(started.connection, host.preferences.get(started.connection.daemonId).enabled)
      .then(publish(started));
  }, [context, host.preferences, markChecking, publish]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const setEnabled = useCallback(
    (next: boolean) => {
      markChecking();
      const started = context;
      const daemon = started.connection.daemonId;
      if (!next) {
        host.preferences.set(daemon, { enabled: false });
        void started.delivery.disable(started.connection).then(publish(started));
        return;
      }
      void (async () => {
        const current = host.surface.permission();
        // Asked at most once, and only from here. A denied or unsupported browser
        // is never re-prompted, because only the browser's own settings can
        // change that answer.
        const granted = current === 'default' ? await host.surface.requestPermission() : current;
        // Permission is a fact about the BROWSER, not about a machine, so a late
        // answer is still the truth for whichever daemon is now selected and is
        // deliberately outside the fence. The same goes for the stored switch: it
        // is written against the daemon the gesture named.
        setPermission(granted);
        if (granted !== 'granted') {
          host.preferences.set(daemon, { enabled: false });
          publish(started)(IDLE_REPORT);
          return;
        }
        host.preferences.set(daemon, { enabled: true });
        publish(started)(await started.delivery.enable(started.connection));
      })();
    },
    [context, host, markChecking, publish],
  );

  const revokeDevice = useCallback(
    (deviceId: string) => {
      markChecking();
      const started = context;
      // Revoking THIS browser's own device turns its switch off: it no longer receives anything from that machine.
      if (deviceId === lastReport.current.currentDeviceId)
        host.preferences.set(started.connection.daemonId, { enabled: false });
      void started.delivery.revoke(started.connection, deviceId).then(publish(started));
    },
    [context, host.preferences, markChecking, publish],
  );

  return {
    permission,
    preferences,
    enabled: preferences.enabled,
    delivery: report.status,
    deliveryMessage: report.message,
    devices: report.devices,
    currentDeviceId: report.currentDeviceId,
    setEnabled,
    revokeDevice,
    refresh,
  };
};
