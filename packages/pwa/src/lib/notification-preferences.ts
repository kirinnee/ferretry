/**
 * Reader notification preferences, isolated per paired daemon.
 *
 * kteam's source `ui/src/lib/notify.ts` owned one module-global preference
 * snapshot under one localStorage key. That was safe only while the browser
 * could talk to exactly one daemon. Ferretry can keep several pairings alive,
 * so a singleton would make whichever daemon was read last silently configure
 * all the others.
 *
 * This store keeps the source's tolerant, field-by-field decoding, but every
 * snapshot and subscription is keyed by `DaemonId`. Storage is injected: the
 * public static bundle contains no daemon identity, URL, token, or
 * browser-global singleton. A composition host may register the store as a
 * `DaemonScopedCache`, because `clearDaemon` has the same seam used by the
 * pairing registry on unpair, eviction, and credential rotation.
 *
 * WHICH EVENT KINDS AND QUIET HOURS SHOW IS NOT HERE. That decision is made
 * once per browser, not once per daemon — see
 * `packages/pwa/src/lib/notification-filter.ts`. What stays per-daemon is only
 * what is genuinely about ONE machine: whether this device even wants Web
 * Push from it (`enabled`, which is also this screen's "per machine on/off"),
 * and whether a foreground notification should wait until the tab is hidden.
 */

import { type DaemonId, daemonId } from './daemon-connection.ts';

export interface NotificationPreferences {
  /** Quiet until the reader explicitly enables delivery for this daemon. */
  readonly enabled: boolean;
  /** Suppress foreground notifications while the page is visible. */
  readonly onlyWhenHidden: boolean;
}

export type NotificationPreferencePatch = Readonly<{
  enabled?: boolean;
  onlyWhenHidden?: boolean;
}>;

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = Object.freeze({
  enabled: false,
  onlyWhenHidden: true,
});

export const NOTIFICATION_PREFERENCES_KEY = 'fy-pwa-notifications-by-daemon-v1';

export interface NotificationPreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const copyDefaults = (): NotificationPreferences => ({ ...DEFAULT_NOTIFICATION_PREFERENCES });

/** Decode one daemon's row without allowing one malformed field to poison it. */
export const parseNotificationPreferences = (value: unknown): NotificationPreferences => {
  if (!isRecord(value)) return copyDefaults();
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : DEFAULT_NOTIFICATION_PREFERENCES.enabled,
    onlyWhenHidden:
      typeof value.onlyWhenHidden === 'boolean'
        ? value.onlyWhenHidden
        : DEFAULT_NOTIFICATION_PREFERENCES.onlyWhenHidden,
  };
};

/** Decode the complete versioned store into daemon-qualified snapshots. */
export const parseNotificationPreferenceStore = (
  raw: string | null,
): ReadonlyMap<DaemonId, NotificationPreferences> => {
  if (raw === null) return new Map();
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.daemons)) return new Map();
    const snapshots = new Map<DaemonId, NotificationPreferences>();
    for (const [rawDaemonId, preferences] of Object.entries(value.daemons)) {
      if (rawDaemonId.trim() === '' || !isRecord(preferences)) continue;
      snapshots.set(daemonId(rawDaemonId), parseNotificationPreferences(preferences));
    }
    return snapshots;
  } catch {
    return new Map();
  }
};

const mergePreferences = (
  current: NotificationPreferences,
  patch: NotificationPreferencePatch,
): NotificationPreferences => ({
  enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
  onlyWhenHidden: typeof patch.onlyWhenHidden === 'boolean' ? patch.onlyWhenHidden : current.onlyWhenHidden,
});

/** A synchronously readable external store with one immutable slice per daemon. */
export class DaemonNotificationPreferences {
  readonly #storage: NotificationPreferenceStorage | null;
  readonly #snapshots: Map<DaemonId, NotificationPreferences>;
  readonly #listeners = new Map<DaemonId, Set<() => void>>();

  constructor(storage: NotificationPreferenceStorage | null = null) {
    this.#storage = storage;
    let raw: string | null = null;
    try {
      raw = storage?.getItem(NOTIFICATION_PREFERENCES_KEY) ?? null;
    } catch {
      // Denied storage is an ordinary browser mode; memory state still works.
    }
    this.#snapshots = new Map(parseNotificationPreferenceStore(raw));
  }

  get(daemon: DaemonId): NotificationPreferences {
    const existing = this.#snapshots.get(daemon);
    if (existing !== undefined) return existing;
    const initial = copyDefaults();
    this.#snapshots.set(daemon, initial);
    return initial;
  }

  set(daemon: DaemonId, patch: NotificationPreferencePatch): NotificationPreferences {
    const next = mergePreferences(this.get(daemon), patch);
    this.#snapshots.set(daemon, next);
    this.#persist();
    this.#notify(daemon);
    return next;
  }

  subscribe(daemon: DaemonId, listener: () => void): () => void {
    const listeners = this.#listeners.get(daemon) ?? new Set<() => void>();
    listeners.add(listener);
    this.#listeners.set(daemon, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(daemon);
    };
  }

  /** Drop only one daemon's state; another pairing is never disturbed. */
  clearDaemon(daemon: DaemonId): boolean {
    const deleted = this.#snapshots.delete(daemon);
    if (!deleted) return false;
    this.#persist();
    this.#notify(daemon);
    return true;
  }

  #persist(): void {
    if (this.#storage === null) return;
    // A daemon fingerprint is opaque input. A null-prototype dictionary keeps
    // values such as `__proto__` and `constructor` as ordinary own keys rather
    // than letting object metaproperties alter or disappear from persistence.
    const daemons = Object.create(null) as Record<string, NotificationPreferences>;
    for (const [id, preferences] of this.#snapshots) daemons[id] = preferences;
    try {
      this.#storage.setItem(NOTIFICATION_PREFERENCES_KEY, JSON.stringify({ version: 1, daemons }));
    } catch {
      // Private mode and exhausted quota must not break the live store.
    }
  }

  #notify(daemon: DaemonId): void {
    for (const listener of this.#listeners.get(daemon) ?? []) listener();
  }
}
