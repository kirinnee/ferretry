/**
 * SOLE OWNER of the `fy-dictation-debug-v1` browser-storage key and of every dictation debug record
 * this tab holds.
 *
 * "Dictation debug" is an opt-in switch for the owner who wants to see exactly what a cleanup call
 * sent and got back. While it is on, each cleanup call leaves ONE record (`CleanupTrace`, built by
 * `@ferretry/protocol`) here. The records are held only in this tab's memory:
 *
 * - a ring of the last `DICTATION_DEBUG_LIMIT`, the oldest dropped as a new one lands;
 * - emptied when the switch goes off and by a reload — nothing is written anywhere, so a record can
 *   never outlive the tab that made it;
 * - never sent to a daemon, never synced, never logged. A record holds dictated text and the
 *   conversation that went along with it.
 *
 * Only the SWITCH is remembered, as a device preference. It defaults to off, and a stale or
 * hand-edited value reads as off. Its shape follows `table-view-preference.ts`: an injected storage,
 * a defensive parse, a denied storage treated as an ordinary browser condition.
 *
 * No credential can be in a record: `CleanupTrace` carries request headers with every secret-bearing
 * value already redacted, and the key never reaches this file (`speedup-keys.ts` "use, never read").
 */

import type { CleanupTrace } from '@ferretry/protocol';
import type { DictationTimeline } from './dictation-timeline.ts';

/** The sole browser-storage key for the debug switch. */
export const DICTATION_DEBUG_KEY = 'fy-dictation-debug-v1';

/** How many calls are kept. A fixed ring: the point is the last few calls, not a history. */
export const DICTATION_DEBUG_LIMIT = 10;

/** One kept call. `id` is what the review box and the transcription log point at. */
export interface DictationDebugRecord {
  readonly id: string;
  /** Wall-clock start of the call, epoch milliseconds. */
  readonly at: number;
  readonly trace: CleanupTrace;
  /** How long each stage of the dictation took: numbers only, no text. */
  readonly timeline?: DictationTimeline;
}

export interface DictationDebugSnapshot {
  readonly enabled: boolean;
  /** Newest first. */
  readonly records: readonly DictationDebugRecord[];
}

export interface DictationDebugStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Anything but the one word `on` is off. */
export const parseDictationDebug = (raw: string | null | undefined): boolean => raw === 'on';

const browserStorage = (): DictationDebugStorage | undefined => {
  try {
    const candidate = (globalThis as { localStorage?: DictationDebugStorage }).localStorage;
    return candidate && typeof candidate.getItem === 'function' && typeof candidate.setItem === 'function'
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
};

/** The debug switch and the ring of records, shaped for `useSyncExternalStore`. */
export class DictationDebugLog {
  readonly #storage: DictationDebugStorage | undefined;
  readonly #listeners = new Set<() => void>();
  #snapshot: DictationDebugSnapshot | null = null;
  #issued = 0;

  constructor(storage: DictationDebugStorage | undefined = browserStorage()) {
    this.#storage = storage;
  }

  /** The switch and the records in force; identity-stable until something changes. */
  snapshot = (): DictationDebugSnapshot => {
    this.#snapshot ??= { enabled: this.#load(), records: [] };
    return this.#snapshot;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Turning the switch off drops every record: what was kept for debugging does not outlive the wish. */
  setEnabled(enabled: boolean): void {
    if (this.snapshot().enabled === enabled) return;
    this.#snapshot = { enabled, records: [] };
    try {
      this.#storage?.setItem(DICTATION_DEBUG_KEY, enabled ? 'on' : 'off');
    } catch {
      // Storage denied (private mode, quota): the in-memory choice still applies.
    }
    this.#publish();
  }

  /**
   * Keep one call's record, or nothing at all when the switch is off. Returns the record's id so the
   * dictation it belongs to can point at it.
   */
  record(trace: CleanupTrace, at: number, timeline?: DictationTimeline): string | undefined {
    const { enabled, records } = this.snapshot();
    if (!enabled) return undefined;
    this.#issued += 1;
    const id = `debug-${String(this.#issued)}`;
    this.#snapshot = {
      enabled,
      records: [{ id, at, trace, ...(timeline === undefined ? {} : { timeline }) }, ...records].slice(
        0,
        DICTATION_DEBUG_LIMIT,
      ),
    };
    this.#publish();
    return id;
  }

  /** Replace a kept record's timeline once the stages after the call are known. A record that has rolled off is simply not there. */
  annotate(id: string, timeline: DictationTimeline): void {
    const { enabled, records } = this.snapshot();
    if (!records.some(record => record.id === id)) return;
    this.#snapshot = { enabled, records: records.map(record => (record.id === id ? { ...record, timeline } : record)) };
    this.#publish();
  }

  /** Forget every record, keeping the switch where it is. */
  clear(): void {
    const { enabled, records } = this.snapshot();
    if (records.length === 0) return;
    this.#snapshot = { enabled, records: [] };
    this.#publish();
  }

  #publish(): void {
    for (const listener of this.#listeners) listener();
  }

  #load(): boolean {
    try {
      return parseDictationDebug(this.#storage?.getItem(DICTATION_DEBUG_KEY));
    } catch {
      return false;
    }
  }
}
