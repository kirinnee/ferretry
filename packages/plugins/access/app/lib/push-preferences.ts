/**
 * Whether THIS browser wants Web Push from each machine: one `enabled` switch per daemon, kept in this browser's
 * local storage under the key today keeps it (`fy-pwa-notifications-by-daemon-v1`).
 *
 * The same record carries `onlyWhenHidden`, which belongs to Agenda's foreground notifications: it is read and written
 * back untouched, so flipping a machine's switch here never resets it. Storage is injected and allowed to throw;
 * a denied or full store leaves the in-memory answer working. Copied from today's `notification-preferences.ts`.
 */
import { type DaemonId, daemonId, type DaemonNotificationPreferences } from '../shell-pairing.ts';

export const NOTIFICATION_PREFERENCES_KEY = 'fy-pwa-notifications-by-daemon-v1';

export interface PushPreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface Row {
  readonly enabled: boolean;
  readonly onlyWhenHidden: boolean;
}

const DEFAULT_ROW: Row = { enabled: false, onlyWhenHidden: true };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const rowOf = (value: Record<string, unknown>): Row => ({
  enabled: typeof value.enabled === 'boolean' ? value.enabled : DEFAULT_ROW.enabled,
  onlyWhenHidden: typeof value.onlyWhenHidden === 'boolean' ? value.onlyWhenHidden : DEFAULT_ROW.onlyWhenHidden,
});

/** Decodes the versioned store into one row per daemon, dropping anything that is not one. */
const parsePushPreferenceStore = (raw: string | null): ReadonlyMap<DaemonId, Row> => {
  if (raw === null) return new Map();
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.daemons)) return new Map();
    const rows = new Map<DaemonId, Row>();
    for (const [id, row] of Object.entries(value.daemons)) {
      if (id.trim() !== '' && isRecord(row)) rows.set(daemonId(id), rowOf(row));
    }
    return rows;
  } catch {
    return new Map();
  }
};

export class PushPreferences implements DaemonNotificationPreferences {
  readonly #storage: PushPreferenceStorage | null;
  readonly #rows: Map<DaemonId, Row>;

  constructor(storage: PushPreferenceStorage | null = null) {
    this.#storage = storage;
    let raw: string | null = null;
    try {
      raw = storage?.getItem(NOTIFICATION_PREFERENCES_KEY) ?? null;
    } catch {
      // Denied storage is an ordinary browser mode; memory state still works.
    }
    this.#rows = new Map(parsePushPreferenceStore(raw));
  }

  get(daemon: DaemonId): { readonly enabled: boolean } {
    return this.#rows.get(daemon) ?? DEFAULT_ROW;
  }

  set(daemon: DaemonId, patch: { readonly enabled: boolean }): Row {
    const next: Row = { ...(this.#rows.get(daemon) ?? DEFAULT_ROW), enabled: patch.enabled };
    this.#rows.set(daemon, next);
    this.#persist();
    return next;
  }

  #persist(): void {
    if (this.#storage === null) return;
    // A daemon id is opaque input: a null-prototype dictionary keeps `__proto__` an ordinary own key.
    const daemons = Object.create(null) as Record<string, Row>;
    for (const [id, row] of this.#rows) daemons[id] = row;
    try {
      this.#storage.setItem(NOTIFICATION_PREFERENCES_KEY, JSON.stringify({ version: 1, daemons }));
    } catch {
      // Private mode and an exhausted quota must not break the live store.
    }
  }
}
