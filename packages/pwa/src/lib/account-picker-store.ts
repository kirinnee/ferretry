/**
 * THE PICKABLE ACCOUNT ROSTER, ONE SLICE PER PAIRED DAEMON.
 *
 * Account wrappers, quota and health all belong to the host that reported
 * them. A wrapper name is not globally meaningful, so this store has no
 * daemon-free read and fences every in-flight request across unpair/re-pair.
 *
 * The three endpoint reads settle inside `readAccountPickerCatalog`: an
 * unreadable manifest remains `accounts: null`, while an honest empty manifest
 * remains `accounts: []`. A failed refresh never replaces a previously proved
 * catalog with a fabricated empty one; the slice keeps its last answer and
 * reports the transport failure separately.
 */

import type { AccountPickerCatalog } from '../components/picker-catalog.ts';
import type { DaemonConnection, DaemonId } from './daemon-connection.ts';

export type AccountPickerLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface DaemonAccountPickerSlice {
  readonly catalog: AccountPickerCatalog | null;
  readonly status: AccountPickerLoadStatus;
  readonly error: string | null;
}

export interface AccountPickerSnapshot {
  readonly daemons: ReadonlyMap<DaemonId, DaemonAccountPickerSlice>;
}

export interface DaemonAccountPickerPort {
  catalog(daemon: DaemonConnection): Promise<AccountPickerCatalog>;
}

const IDLE_SLICE: DaemonAccountPickerSlice = Object.freeze({
  catalog: null,
  status: 'idle' as const,
  error: null,
});

const failureMessage = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

interface AccountPickerEntry {
  readonly daemonId: DaemonId;
  readonly baseUrl: string;
  readonly deviceToken: string;
  request: Promise<AccountPickerCatalog> | null;
}

export class DaemonAccountPickerStore {
  readonly #port: DaemonAccountPickerPort;
  readonly #entries = new Map<DaemonId, AccountPickerEntry>();
  readonly #listeners = new Set<() => void>();
  #snapshot: AccountPickerSnapshot = { daemons: new Map() };

  constructor(port: DaemonAccountPickerPort) {
    this.#port = port;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): AccountPickerSnapshot => this.#snapshot;

  /** One daemon's slice. An unknown daemon is unread, never empty. */
  slice(daemonId: DaemonId): DaemonAccountPickerSlice {
    return this.#snapshot.daemons.get(daemonId) ?? IDLE_SLICE;
  }

  /**
   * Refresh one daemon's roster. A burst for the same live connection shares
   * one request; another daemon or a re-paired connection never does.
   */
  hydrate(daemon: DaemonConnection): Promise<AccountPickerCatalog> {
    const entry = this.#entryFor(daemon);
    if (entry.request !== null) return entry.request;

    this.#patch(daemon.daemonId, { status: 'loading' });
    const request = this.#port
      .catalog(daemon)
      .then(
        catalog => {
          if (this.#isCurrent(entry)) this.#patch(entry.daemonId, { catalog, status: 'ready', error: null });
          return catalog;
        },
        (reason: unknown) => {
          if (this.#isCurrent(entry)) this.#patch(entry.daemonId, { status: 'error', error: failureMessage(reason) });
          throw reason;
        },
      )
      .finally(() => {
        entry.request = null;
      });
    entry.request = request;
    return request;
  }

  /** Drop one pairing generation without disturbing any other daemon. */
  clearDaemon(daemonId: DaemonId): boolean {
    this.#entries.delete(daemonId);
    const slices = new Map(this.#snapshot.daemons);
    const had = slices.delete(daemonId);
    if (had) {
      this.#snapshot = { daemons: slices };
      this.#publish();
    }
    return had;
  }

  #entryFor(daemon: DaemonConnection): AccountPickerEntry {
    const existing = this.#entries.get(daemon.daemonId);
    if (existing?.baseUrl === daemon.baseUrl && existing.deviceToken === daemon.deviceToken) return existing;

    const slices = new Map(this.#snapshot.daemons);
    if (slices.delete(daemon.daemonId)) this.#snapshot = { daemons: slices };
    const entry: AccountPickerEntry = {
      daemonId: daemon.daemonId,
      baseUrl: daemon.baseUrl,
      deviceToken: daemon.deviceToken,
      request: null,
    };
    this.#entries.set(daemon.daemonId, entry);
    return entry;
  }

  #isCurrent(entry: AccountPickerEntry): boolean {
    return this.#entries.get(entry.daemonId) === entry;
  }

  #patch(daemonId: DaemonId, patch: Partial<DaemonAccountPickerSlice>): void {
    const daemons = new Map(this.#snapshot.daemons);
    daemons.set(daemonId, { ...this.slice(daemonId), ...patch });
    this.#snapshot = { daemons };
    this.#publish();
  }

  #publish(): void {
    for (const listener of this.#listeners) listener();
  }
}
