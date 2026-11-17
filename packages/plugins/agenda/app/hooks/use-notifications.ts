/**
 * NOTIFICATION WIRING — the React shell over the notification subsystem.
 *
 * Ported from kteam `ui/src/hooks/useNotifications.ts`: a composition root mounts
 * `useNotificationWatch` once to run the fleet-diff watch, and
 * `useNotificationPreferences` reads one daemon's stored switch. The per-machine
 * controls (the master switch, the ONE reader-initiated permission request and this
 * browser's push enrolment) are Access's, end to end — it writes the same record
 * this watch reads.
 *
 * EVERYTHING IS DAEMON SCOPED. kteam held one preference snapshot in a module
 * global, because there was one daemon. Here the preference store names its
 * `DaemonId`, so the watch reads each daemon's own preferences on every tick
 * rather than whichever was read last.
 *
 * ASYNCHRONOUS WORK IS CONTAINED. Nothing in here can cancel a delivery already in
 * flight, so `useNotificationWatch` contains a rejected delivery instead of letting
 * it escape the effect that started it. It is spelled out where it happens.
 *
 * NO BROWSER GLOBAL IS READ IN HERE. Permission, the registration and the
 * page-level constructor arrive as a `NotificationSurface`. That is what lets the
 * whole subsystem be proved by executed tests, and it is also why a static bundle
 * carries no daemon URL: the only URL this module ever follows is the in-app path
 * the ledger produced.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { DaemonId } from '../shell.ts';
import type { DaemonSessionScope } from '../shell.ts';
import type { DeviceNotificationFilterStore } from '../lib/notification-filter.ts';
import { type SessionsSource, startNotificationWatch } from '../lib/notification-ledger.ts';
import type { DaemonNotificationPreferences, NotificationPreferences } from '../lib/notification-preferences.ts';
import {
  type NotificationPermissionState,
  type NotificationSurface,
  notificationPayload,
  showNotification,
} from '../lib/notify.ts';

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
  /** Read live on every tick, so only the read half is asked for: Access's switch writes the same record. */
  readonly preferences: Pick<DaemonNotificationPreferences, 'get'>;
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
