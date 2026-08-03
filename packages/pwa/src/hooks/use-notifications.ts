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
 * page-level constructor arrive as a `NotificationSurface`; the push enrolment
 * arrives as a `PushEnrolment`. That is what lets the whole subsystem be proved
 * by executed tests, and it is also why a static bundle carries no daemon URL:
 * the only URL this module ever follows is the in-app path the ledger produced.
 */

import type { PushDeviceView, PushPreferences } from '@ferretry/protocol';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { DaemonConnection, DaemonId } from '../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../lib/daemon-scope.ts';
import { startNotificationWatch, type SessionsSource } from '../lib/notification-ledger.ts';
import type { DaemonNotificationPreferences, NotificationPreferences } from '../lib/notification-preferences.ts';
import {
  notificationPayload,
  showNotification,
  type NotificationPermissionState,
  type NotificationSurface,
} from '../lib/notify.ts';
import {
  disablePushDelivery,
  enablePushDelivery,
  readPushDelivery,
  revokePushDevice,
  syncPushPreferences,
  type DaemonPushDevices,
  type DaemonPushService,
  type PushDeliveryReport,
  type PushDeliveryStatus,
  type PushEnrolment,
  type PushEnrolmentContext,
} from '../lib/push-enrolment.ts';

/** One daemon's live preference slice; another pairing's changes never re-render it. */
export const useNotificationPreferences = (
  store: DaemonNotificationPreferences,
  daemon: DaemonId,
): NotificationPreferences => {
  const subscribe = useCallback((listener: () => void) => store.subscribe(daemon, listener), [daemon, store]);
  const snapshot = useCallback(() => store.get(daemon), [daemon, store]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
};

export interface NotificationWatchHost {
  /** The fleet cache, whose `null` snapshot means "not yet" rather than "empty". */
  readonly sessions: SessionsSource;
  readonly preferences: DaemonNotificationPreferences;
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
  readonly service: DaemonPushService;
  readonly devices: DaemonPushDevices;
  /** `null` where this browser cannot do Web Push; local delivery still works. */
  readonly enrolment: PushEnrolment | null;
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
  readonly setPreferences: (preferences: PushPreferences) => void;
  /** Per-device revocation against the daemon that issued the device id. */
  readonly revokeDevice: (deviceId: string) => void;
  readonly refresh: () => void;
}

const IDLE_REPORT: PushDeliveryReport = { status: 'idle', message: null, devices: [], currentDeviceId: null };

/**
 * The settings surface's controls for exactly one paired daemon.
 *
 * It reads that daemon's device list on mount, because "Registered devices" is
 * part of what the screen exists to show, and re-reads it whenever the selected
 * connection changes. A preference toggle does NOT re-read the list: it sends the
 * new preferences to the daemon holding this device and keeps the readout it has.
 */
export const useNotificationControls = (
  host: NotificationControlsHost,
  connection: DaemonConnection,
): NotificationControls => {
  const [permission, setPermission] = useState<NotificationPermissionState>(() => host.surface.permission());
  const [report, setReport] = useState<PushDeliveryReport>(IDLE_REPORT);
  const preferences = useNotificationPreferences(host.preferences, connection.daemonId);

  // Field by field, not by object identity: a root that rebuilds an equivalent
  // connection each render has not re-paired, while a rotated device token or a
  // moved base URL is a different live connection and must re-read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: connection fields are the deliberate re-pair trigger, see above
  const context = useMemo<PushEnrolmentContext>(
    () => ({
      connection,
      service: host.service,
      devices: host.devices,
      preferences: host.preferences,
      enrolment: host.enrolment,
    }),
    [connection.daemonId, connection.baseUrl, connection.deviceToken, host],
  );

  // ONLY THE NEWEST CONNECTION CONTEXT MAY PUBLISH A READOUT.
  //
  // Every delivery read is asynchronous and none of them can be cancelled, so a
  // read started for the previous context is still in flight when a rotated
  // device token or a moved base URL produces a new one. Whichever resolves last
  // would otherwise win, and the loser is not merely stale: it is a different
  // live connection's device list, presented as this one's.
  //
  // The fence is the context IDENTITY, which is exactly what the memo above
  // re-creates on a re-pair — the same identity the mount effect re-reads on. It
  // is applied at resolution rather than at launch, because the side effects of
  // an enrolment, a revoke or a preference sync were already asked for and must
  // still complete against the daemon they were addressed to.
  const currentContext = useRef(context);
  if (currentContext.current !== context) currentContext.current = context;

  const publish = useCallback(
    (from: PushEnrolmentContext) =>
      (report: PushDeliveryReport): void => {
        if (currentContext.current !== from) return;
        setReport(report);
      },
    [],
  );

  const markChecking = useCallback(() => {
    setReport(current => ({ ...current, status: 'checking', message: null }));
  }, []);

  const refresh = useCallback(() => {
    markChecking();
    void readPushDelivery(context).then(publish(context));
  }, [context, markChecking, publish]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const setEnabled = useCallback(
    (next: boolean) => {
      markChecking();
      const started = context;
      if (!next) {
        void disablePushDelivery(started).then(publish(started));
        return;
      }
      void (async () => {
        const current = host.surface.permission();
        // Asked at most once, and only from here. A denied or unsupported browser
        // is never re-prompted, because only the browser's own settings can
        // change that answer.
        const granted = current === 'default' ? await host.surface.requestPermission() : current;
        // Permission is a fact about the BROWSER, not about a connection, so a
        // late answer is still the truth for whichever daemon is now selected and
        // is deliberately outside the fence. The same goes for storing the
        // refusal: it is written against the daemon the gesture named.
        setPermission(granted);
        if (granted !== 'granted') {
          host.preferences.set(connection.daemonId, { enabled: false });
          publish(started)(IDLE_REPORT);
          return;
        }
        publish(started)(await enablePushDelivery(started));
      })();
    },
    [connection.daemonId, context, host, markChecking, publish],
  );

  const setPreferences = useCallback(
    (next: PushPreferences) => {
      const started = context;
      void syncPushPreferences(started, next).then(result => {
        // `null` means nothing was sent onward, so the existing readout stands.
        if (result !== null) publish(started)(result);
      });
    },
    [context, publish],
  );

  const revokeDevice = useCallback(
    (deviceId: string) => {
      markChecking();
      const started = context;
      void revokePushDevice(started, deviceId).then(publish(started));
    },
    [context, markChecking, publish],
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
    setPreferences,
    revokeDevice,
    refresh,
  };
};
