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
 * NO BROWSER GLOBAL IS READ IN HERE. Permission, the registration and the
 * page-level constructor arrive as a `NotificationSurface`; the push enrolment
 * arrives as a `PushEnrolment`. That is what lets the whole subsystem be proved
 * by executed tests, and it is also why a static bundle carries no daemon URL:
 * the only URL this module ever follows is the in-app path the ledger produced.
 */

import type { PushDeviceView, PushPreferences } from '@ferretry/protocol';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
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
        void showNotification(host.surface, notificationPayload(spec));
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

  const markChecking = useCallback(() => {
    setReport(current => ({ ...current, status: 'checking', message: null }));
  }, []);

  const refresh = useCallback(() => {
    markChecking();
    void readPushDelivery(context).then(setReport);
  }, [context, markChecking]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const setEnabled = useCallback(
    (next: boolean) => {
      markChecking();
      if (!next) {
        void disablePushDelivery(context).then(setReport);
        return;
      }
      void (async () => {
        const current = host.surface.permission();
        // Asked at most once, and only from here. A denied or unsupported browser
        // is never re-prompted, because only the browser's own settings can
        // change that answer.
        const granted = current === 'default' ? await host.surface.requestPermission() : current;
        setPermission(granted);
        if (granted !== 'granted') {
          host.preferences.set(connection.daemonId, { enabled: false });
          setReport(IDLE_REPORT);
          return;
        }
        setReport(await enablePushDelivery(context));
      })();
    },
    [connection.daemonId, context, host, markChecking],
  );

  const setPreferences = useCallback(
    (next: PushPreferences) => {
      void syncPushPreferences(context, next).then(result => {
        if (result !== null) setReport(result);
      });
    },
    [context],
  );

  const revokeDevice = useCallback(
    (deviceId: string) => {
      markChecking();
      void revokePushDevice(context, deviceId).then(setReport);
    },
    [context, markChecking],
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
