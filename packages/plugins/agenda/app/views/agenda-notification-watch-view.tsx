/**
 * AGENDA'S IN-APP NOTIFICATION WATCH (shell contract S5, triage B11): a background view the shell mounts ONCE PER PAIRED
 * DAEMON at the frame root, outside the router, so the fleet-diff watch keeps running whatever page is open. It draws
 * nothing. Each instance watches ITS daemon's ferrets over its own background-origin client: a call to a locked machine
 * waits for the unlock and never raises a prompt, and nothing here asks for notification permission — that is the reader's
 * control (`useNotificationControls`), this only reads it.
 *
 * The runtime is made here, not by the half's fleet: the fleet keeps the ordinary client of each machine and a background
 * client handed to it would replace that one.
 */

import { type BackgroundViewProps, useOptionalRouter } from '@ferretry/app';
import { getForegroundPinScope } from '@ferretry/app/ui';
import { useMemo, useRef, useSyncExternalStore } from 'react';
import { type NotificationWatchHost, useNotificationWatch } from '../hooks/use-notifications.ts';
import { browserNotificationSurface, subscribeNotificationPermission } from '../lib/browser-notification-surface.ts';
import { deviceFilterStore } from '../lib/device-filter-store.ts';
import { createAgendaRuntime, type RuntimeClient } from '../lib/agenda-runtime.ts';
import { daemonId, daemonSessionScope } from '../lib/machine.ts';
import type { NotifiedFleet } from '../lib/notification-ledger.ts';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_PREFERENCES_KEY,
  parseNotificationPreferenceStore,
} from '../lib/notification-preferences.ts';
import type { NotificationPermissionState } from '../lib/notify.ts';

/** What the view runs on: the host the watch reads, and the permission it only reads. */
export interface NotificationWatchWiring {
  readonly host: NotificationWatchHost;
  readonly permission: () => NotificationPermissionState;
  readonly subscribePermission: (listener: () => void) => () => void;
}

export interface NotificationWatchInput extends BackgroundViewProps {
  readonly navigate: (path: string) => void;
}

const storageOf = (): Pick<Storage, 'getItem'> | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

/**
 * This daemon's preferences, read from the record each time: Access's switch writes the same versioned record in this
 * browser's storage, so a copy held in memory would never hear a switch flipped after the app opened.
 */
const livePreferences = (): NotificationWatchHost['preferences'] => ({
  get: daemon => {
    let raw: string | null = null;
    try {
      raw = storageOf()?.getItem(NOTIFICATION_PREFERENCES_KEY) ?? null;
    } catch {
      // Denied storage reads as the defaults: off.
    }
    return parseNotificationPreferenceStore(raw).get(daemon) ?? { ...DEFAULT_NOTIFICATION_PREFERENCES };
  },
});

/** The browser's wiring for one daemon's background client. */
export const browserNotificationWatchWiring = ({
  client,
  navigate,
}: NotificationWatchInput): NotificationWatchWiring => {
  const runtime = createAgendaRuntime(client as unknown as RuntimeClient);
  const surface = browserNotificationSurface(navigate);
  return {
    host: {
      sessions: {
        subscribe: listener => runtime.ferrets.subscribe(listener),
        snapshot: () => runtime.ferrets.getSnapshot() as NotifiedFleet,
      },
      preferences: livePreferences(),
      filter: deviceFilterStore(),
      surface,
      hidden: () => globalThis.document?.hidden ?? false,
      foregroundSession: () => {
        const scope = getForegroundPinScope();
        return scope === null ? null : daemonSessionScope({ daemonId: daemonId(scope.daemonId) }, scope.sessionId);
      },
      now: Date.now,
    },
    permission: surface.permission,
    subscribePermission: subscribeNotificationPermission,
  };
};

/** The view over a wiring (the browser's by default, a scripted one in tests). */
export const createNotificationWatchView = (wiringOf: (input: NotificationWatchInput) => NotificationWatchWiring) =>
  function AgendaNotificationWatchView(props: BackgroundViewProps) {
    const navigateRef = useRef<(path: string) => void>(() => {});
    navigateRef.current = useOptionalRouter()?.navigate ?? navigateRef.current;
    // One wiring for the client's life: the shell hands the same client object for a connection's life.
    // biome-ignore lint/correctness/useExhaustiveDependencies: the client is the deliberate identity, see above
    const wiring = useMemo(() => wiringOf({ ...props, navigate: path => navigateRef.current(path) }), [props.client]);
    const permission = useSyncExternalStore(wiring.subscribePermission, wiring.permission, wiring.permission);
    useNotificationWatch(wiring.host, permission);
    return null;
  };

export const AgendaNotificationWatchView = createNotificationWatchView(browserNotificationWatchWiring);
