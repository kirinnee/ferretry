/**
 * SOLE OWNER of the `fy-transcription-log-v1` browser-storage key and of this device's transcription
 * log: one record per dictation, kept in this browser's IndexedDB and nowhere else.
 *
 * It exists so words the owner dictated are never lost to a mis-tap, a discard or a cleanup that
 * changed them: every dictation leaves its raw transcript, the cleaned text (when cleanup ran), which
 * prompt ran, how long it was, and whether the words were inserted or discarded. The owner can search
 * it, copy from it and put an entry back into the composer.
 *
 * - ON by default. A switch turns recording off (what is already kept stays until Clear); Clear drops
 *   every record. The switch is a device preference, shaped like `table-view-preference.ts`.
 * - Bounded: the newest `TRANSCRIPTION_LOG_MAX_ENTRIES`, none older than
 *   `TRANSCRIPTION_LOG_MAX_AGE_MS`. Both are enforced every time an entry lands.
 * - THIS DEVICE ONLY. Nothing here is synced, uploaded or handed to a daemon, and no audio is kept —
 *   only text the owner already saw in the review box.
 * - A refused or missing IndexedDB is an ordinary browser condition: the log keeps working in memory
 *   for the tab and says it is not saved (`saved: false`), rather than failing a dictation.
 *
 * `debugId` points at a record in the in-memory `DictationDebugLog`. That ring is emptied by a reload,
 * so a pointer can outlive its record; the reader checks before offering the link.
 */

import { z } from 'zod';
import { DictationTimelineSchema } from './dictation-timeline.ts';

/** The sole browser-storage key for the recording switch. */
export const TRANSCRIPTION_LOG_KEY = 'fy-transcription-log-v1';

export const TRANSCRIPTION_LOG_MAX_ENTRIES = 200;
export const TRANSCRIPTION_LOG_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

const TranscriptionEntrySchema = z.strictObject({
  id: z.string().min(1).max(64),
  /** When the dictation was made, epoch milliseconds. */
  at: z.number().int().nonnegative(),
  /** The conversation it was dictated for, so an entry can go back where it was meant to. */
  sessionId: z.string().min(1).max(256).optional(),
  sessionLabel: z.string().max(256).optional(),
  engine: z.enum(['parakeet', 'web-speech']),
  durationMs: z.number().finite().nonnegative().optional(),
  raw: z.string(),
  cleaned: z.string().optional(),
  /** What went into the draft, when the owner edited the words in the review box first. */
  inserted: z.string().optional(),
  prompt: z.enum(['fix', 'polish']).optional(),
  /** `pending` is a dictation still in the review box, or one the tab was closed on. */
  outcome: z.enum(['pending', 'inserted', 'discarded']),
  debugId: z.string().max(64).optional(),
  /** How long each stage took: numbers only, so it is safe to keep beside the text. */
  timeline: DictationTimelineSchema.optional(),
});
export type TranscriptionEntry = z.infer<typeof TranscriptionEntrySchema>;

/** What a caller supplies; the log adds the id. */
export type NewTranscriptionEntry = Omit<TranscriptionEntry, 'id'>;

/** The parts of an entry that change after it lands. */
export type TranscriptionEntryPatch = Partial<
  Pick<TranscriptionEntry, 'cleaned' | 'inserted' | 'prompt' | 'outcome' | 'debugId' | 'timeline'>
>;

/** Where entries rest. Every row is untrusted until the log has parsed it. */
export interface TranscriptionLogRecords {
  list(): Promise<readonly unknown[]>;
  put(entry: TranscriptionEntry): Promise<void>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}

export interface TranscriptionLogStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface TranscriptionLogSnapshot {
  readonly enabled: boolean;
  /** Newest first. */
  readonly entries: readonly TranscriptionEntry[];
  /** False once a write was refused, or when this browser has nowhere to keep entries. */
  readonly saved: boolean;
}

/** Anything but the one word `off` is on: recording is the default. */
export const parseTranscriptionLogEnabled = (raw: string | null | undefined): boolean => raw !== 'off';

const browserStorage = (): TranscriptionLogStorage | undefined => {
  try {
    const candidate = (globalThis as { localStorage?: TranscriptionLogStorage }).localStorage;
    return candidate && typeof candidate.getItem === 'function' && typeof candidate.setItem === 'function'
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
};

export interface TranscriptionLogOptions {
  readonly storage?: TranscriptionLogStorage | undefined;
  readonly now?: () => number;
  readonly newId?: () => string;
}

/** The transcription log and its switch, shaped for `useSyncExternalStore`. */
export class TranscriptionLog {
  readonly #records: TranscriptionLogRecords | undefined;
  readonly #storage: TranscriptionLogStorage | undefined;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #listeners = new Set<() => void>();
  #entries: readonly TranscriptionEntry[] = [];
  #enabled: boolean | null = null;
  #saved: boolean;
  #snapshot: TranscriptionLogSnapshot | null = null;
  #hydrating: Promise<void> | undefined;
  #queue: Promise<void> = Promise.resolve();

  constructor(records: TranscriptionLogRecords | undefined, options: TranscriptionLogOptions = {}) {
    this.#records = records;
    this.#storage = 'storage' in options ? options.storage : browserStorage();
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? (() => globalThis.crypto.randomUUID());
    this.#saved = records !== undefined;
  }

  snapshot = (): TranscriptionLogSnapshot => {
    this.#snapshot ??= { enabled: this.#switch(), entries: this.#entries, saved: this.#saved };
    return this.#snapshot;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Read what this device kept. Idempotent: every caller shares the one read. */
  hydrate(): Promise<void> {
    this.#hydrating ??= this.#read();
    return this.#hydrating;
  }

  setEnabled(enabled: boolean): void {
    if (this.#switch() === enabled) return;
    this.#enabled = enabled;
    try {
      this.#storage?.setItem(TRANSCRIPTION_LOG_KEY, enabled ? 'on' : 'off');
    } catch {
      // Storage denied (private mode, quota): the in-memory choice still applies.
    }
    this.#publish();
  }

  /** Keep one dictation, or nothing when recording is off. Returns the entry's id. */
  add(input: NewTranscriptionEntry): string | undefined {
    if (!this.#switch()) return undefined;
    const entry: TranscriptionEntry = { ...input, id: this.#newId() };
    const kept = this.#bounded([entry, ...this.#entries]);
    const dropped = this.#entries.filter(old => !kept.includes(old));
    this.#entries = kept;
    this.#publish();
    this.#persist(async records => {
      await records.put(entry);
      for (const old of dropped) await records.delete(old.id);
    });
    return entry.id;
  }

  /** Change an entry that is still in the log; an entry already pruned or cleared is left gone. */
  update(id: string, patch: TranscriptionEntryPatch): void {
    const current = this.#entries.find(entry => entry.id === id);
    if (current === undefined) return;
    const next: TranscriptionEntry = { ...current, ...patch };
    this.#entries = this.#entries.map(entry => (entry === current ? next : entry));
    this.#publish();
    this.#persist(async records => await records.put(next));
  }

  /** Forget every entry. The switch stays where it is. */
  clear(): void {
    this.#entries = [];
    this.#publish();
    this.#persist(async records => await records.clear());
  }

  #switch(): boolean {
    if (this.#enabled === null) {
      try {
        this.#enabled = parseTranscriptionLogEnabled(this.#storage?.getItem(TRANSCRIPTION_LOG_KEY));
      } catch {
        this.#enabled = true;
      }
    }
    return this.#enabled;
  }

  #bounded(entries: readonly TranscriptionEntry[]): readonly TranscriptionEntry[] {
    const oldest = this.#now() - TRANSCRIPTION_LOG_MAX_AGE_MS;
    return [...entries]
      .filter(entry => entry.at >= oldest)
      .sort((a, b) => b.at - a.at)
      .slice(0, TRANSCRIPTION_LOG_MAX_ENTRIES);
  }

  async #read(): Promise<void> {
    const records = this.#records;
    if (records === undefined) return;
    let rows: readonly unknown[];
    try {
      rows = await records.list();
    } catch {
      this.#saved = false;
      this.#publish();
      return;
    }
    const stored = rows.flatMap(row => {
      const parsed = TranscriptionEntrySchema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    });
    const live = new Set(this.#entries.map(entry => entry.id));
    const merged = this.#bounded([...this.#entries, ...stored.filter(entry => !live.has(entry.id))]);
    const dropped = stored.filter(entry => !merged.some(kept => kept.id === entry.id));
    this.#entries = merged;
    this.#publish();
    this.#persist(async target => {
      for (const old of dropped) await target.delete(old.id);
    });
  }

  #persist(task: (records: TranscriptionLogRecords) => Promise<void>): void {
    const records = this.#records;
    if (records === undefined) return;
    this.#queue = this.#queue
      .then(async () => await task(records))
      .catch(() => {
        this.#saved = false;
        this.#publish();
      });
  }

  #publish(): void {
    this.#snapshot = { enabled: this.#switch(), entries: this.#entries, saved: this.#saved };
    for (const listener of this.#listeners) listener();
  }
}

/** The label a person reads for an engine. */
export const TRANSCRIPTION_ENGINE_LABELS: Readonly<Record<TranscriptionEntry['engine'], string>> = {
  parakeet: 'Parakeet in-browser',
  'web-speech': 'Web Speech',
};

/** Entries every word of the query appears in, across the words, the session, the engine and the prompt. */
export function searchTranscriptionLog(
  entries: readonly TranscriptionEntry[],
  query: string,
): readonly TranscriptionEntry[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/u)
    .filter(term => term.length > 0);
  if (terms.length === 0) return entries;
  return entries.filter(entry => {
    const haystack = [
      entry.raw,
      entry.cleaned,
      entry.sessionLabel,
      entry.sessionId,
      TRANSCRIPTION_ENGINE_LABELS[entry.engine],
      entry.prompt,
      entry.outcome,
    ]
      .join('\n')
      .toLowerCase();
    return terms.every(term => haystack.includes(term));
  });
}
