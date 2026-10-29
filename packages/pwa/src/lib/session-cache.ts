/**
 * WHAT THIS DEVICE LAST SAW OF EACH MACHINE'S SESSIONS, so a page can draw before the network answers.
 *
 * Opening the app, going Back, or reloading used to start every screen empty: the sessions list from
 * a skeleton and a chat from nothing, refilled a round trip later. This is a stale-while-revalidate
 * cache under the live stores, never instead of them: a screen renders what is here AT ONCE, says
 * "Updating…" while it is not yet confirmed, and the first live answer replaces it. The daemon stays
 * the only authority; nothing here is ever sent back to it or treated as a fact it made.
 *
 * WHAT IS KEPT, PER MACHINE (`DaemonId`) — the only key a browser paired to two machines can trust:
 *   - the session list, as the daemon's own protocol views (which carry no credential: tokens and
 *     capabilities are never part of a `SessionView`), re-validated by the protocol schema on read;
 *   - per session, the TAIL of its transcript log and its send ledger rows — the most recent
 *     {@link SESSION_CACHE_LIMITS.transcriptChars} characters, for the most recent
 *     {@link SESSION_CACHE_LIMITS.transcripts} sessions opened.
 * Nothing older than {@link SESSION_CACHE_LIMITS.maxAgeMs} is served. No device key, pairing token,
 * secret or session capability is ever written here — they are not in what is given to it.
 *
 * FORGOTTEN WITH THE PAIRING. Registered with the connection registry, so an unpair, an eviction or a
 * re-pair (a new credential) clears that machine; and every write carries the GENERATION it was read
 * under, so an answer still in flight when the reader unpaired cannot write the machine back in.
 * Settings › This device › Clear cached data empties all of it.
 *
 * MEMORY FIRST, STORAGE BEHIND. Everything read or written is kept in memory for the document's
 * lifetime, so Back into a chat draws in the same frame; the storage backend (IndexedDB in a browser)
 * is what survives a reload. A backend that fails or is missing only costs that survival.
 */

import { type SessionView, SessionViewSchema } from '@ferretry/protocol';
import type { DaemonConnection, DaemonId } from './daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionKey } from './daemon-scope.ts';

/** The storage this cache keeps its records in. Any failure is absorbed by the cache. */
export interface SessionCacheBackend {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<readonly string[]>;
  clear(): Promise<void>;
}

export interface SessionCacheLimits {
  /**
   * How many OPENED sessions' transcripts are kept, across every machine; the least recently opened go
   * first. Interactive sessions the background keeps fresh without ever being opened are kept besides
   * these, up to {@link SessionCacheLimits.background}.
   */
  readonly transcripts: number;
  /** The most transcripts kept for sessions that were never opened here: a backstop, not a target. */
  readonly background: number;
  /** How much of each transcript log is kept: its end, which is what a chat opens on. */
  readonly transcriptChars: number;
  /** How many send ledger rows are kept per session: the newest. */
  readonly sends: number;
  /** How old a record may be and still be shown. */
  readonly maxAgeMs: number;
}

export const SESSION_CACHE_LIMITS: SessionCacheLimits = {
  transcripts: 40,
  background: 40,
  transcriptChars: 200_000,
  sends: 200,
  maxAgeMs: 14 * 24 * 60 * 60 * 1_000,
};

/** One machine's session list as it was last read. */
export interface CachedSessions {
  readonly sessions: readonly SessionView[];
  readonly savedAt: number;
}

/** One session's transcript tail and send rows as they were last read. */
export interface CachedTranscript {
  readonly log: string;
  readonly sends: readonly unknown[];
  readonly savedAt: number;
  /**
   * When a reader last opened this chat on this device. Absent for a transcript only the background
   * kept fresh: it is what the "40 most recently opened" bound counts.
   */
  readonly openedAt?: number;
  /**
   * The session's `journalSequence` when `log` was read: the point the background freshener resumes from.
   * Absent when the log came from an open chat, which does not know it; the next pass then reads once.
   */
  readonly cursor?: number;
}

interface SessionsRecord extends CachedSessions {
  readonly kind: 'sessions';
  readonly daemonId: string;
}

interface TranscriptRecord extends CachedTranscript {
  readonly kind: 'transcript';
  readonly daemonId: string;
  /**
   * Written by the background for a session never opened here. Records from before opening was kept have
   * neither this nor `openedAt`: they were all saved by an open chat, so they read as opened when saved.
   */
  readonly background?: true;
}

type CacheRecord = SessionsRecord | TranscriptRecord;

interface TranscriptStamp {
  readonly savedAt: number;
  readonly openedAt: number | undefined;
}

const stamp = (record: CachedTranscript): TranscriptStamp => ({ savedAt: record.savedAt, openedAt: record.openedAt });

const sessionsKey = (daemonId: DaemonId): string => JSON.stringify(['sessions', daemonId]);
const transcriptKey = (scope: DaemonSessionScope): string => JSON.stringify(['transcript', daemonSessionKey(scope)]);

/**
 * The end of a log, cut at a line so no record starts mid-line. Text before the first whole record
 * header is dropped by the transcript parser itself, so a cut never invents a message.
 */
export const logTail = (log: string, limit: number): string => {
  if (log.length <= limit) return log;
  const cut = log.slice(log.length - limit);
  const newline = cut.indexOf('\n');
  return newline === -1 ? '' : cut.slice(newline + 1);
};

const fresh = (savedAt: unknown, now: number, maxAgeMs: number): savedAt is number =>
  typeof savedAt === 'number' && Number.isFinite(savedAt) && savedAt <= now && now - savedAt <= maxAgeMs;

const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** A stored value read back, or `null` when it is not one this version wrote — never trusted as-is. */
export const parseCacheRecord = (value: unknown, now: number, maxAgeMs: number): CacheRecord | null => {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as {
    readonly kind?: unknown;
    readonly daemonId?: unknown;
    readonly savedAt?: unknown;
    readonly sessions?: unknown;
    readonly log?: unknown;
    readonly sends?: unknown;
    readonly openedAt?: unknown;
    readonly cursor?: unknown;
    readonly background?: unknown;
  };
  if (typeof record.daemonId !== 'string' || !fresh(record.savedAt, now, maxAgeMs)) return null;
  if (record.kind === 'sessions') {
    const sessions = SessionViewSchema.array().safeParse(record.sessions);
    return sessions.success
      ? { kind: 'sessions', daemonId: record.daemonId, savedAt: record.savedAt, sessions: sessions.data }
      : null;
  }
  if (record.kind === 'transcript' && typeof record.log === 'string' && Array.isArray(record.sends)) {
    const openedAt = isTime(record.openedAt)
      ? record.openedAt
      : record.background === true
        ? undefined
        : record.savedAt;
    return {
      kind: 'transcript',
      daemonId: record.daemonId,
      savedAt: record.savedAt,
      log: record.log,
      sends: record.sends,
      ...(openedAt === undefined ? { background: true as const } : { openedAt }),
      ...(typeof record.cursor === 'number' && Number.isSafeInteger(record.cursor) && record.cursor >= 0
        ? { cursor: record.cursor }
        : {}),
    };
  }
  return null;
};

export interface SessionCacheOptions {
  readonly now?: () => number;
  readonly limits?: SessionCacheLimits;
}

export class SessionCache {
  readonly #backend: SessionCacheBackend | null;
  readonly #now: () => number;
  readonly #limits: SessionCacheLimits;
  readonly #memory = new Map<string, CacheRecord>();
  /** Keys known to be absent from storage, so a miss is asked once per document, not per render. */
  readonly #absent = new Set<string>();
  readonly #generations = new Map<DaemonId, number>();
  /** When each transcript in this document was last opened, by storage key: the "recently opened" ranking. */
  readonly #opened = new Map<string, number>();
  /** Bumped by a whole clear: every machine's generation moves with it. */
  #epoch = 0;
  /** Every transcript key in storage with when it was saved and opened, read once, for the size bounds. */
  #transcripts: Promise<Map<string, TranscriptStamp>> | null = null;
  /** Writes in order, so a clear is never overtaken by a write issued before it. */
  #queue: Promise<void> = Promise.resolve();

  constructor(backend: SessionCacheBackend | null, options: SessionCacheOptions = {}) {
    this.#backend = backend;
    this.#now = options.now ?? Date.now;
    this.#limits = options.limits ?? SESSION_CACHE_LIMITS;
  }

  /** The token a read is issued under; a save carrying an older one is from before a clear, and is dropped. */
  generation(daemonId: DaemonId): number {
    return (this.#generations.get(daemonId) ?? 0) + this.#epoch;
  }

  async sessions(daemonId: DaemonId): Promise<CachedSessions | null> {
    const record = await this.#read(sessionsKey(daemonId), daemonId);
    return record?.kind === 'sessions' ? { sessions: record.sessions, savedAt: record.savedAt } : null;
  }

  saveSessions(daemonId: DaemonId, sessions: readonly SessionView[], generation: number): void {
    if (generation !== this.generation(daemonId)) return;
    this.#store(sessionsKey(daemonId), { kind: 'sessions', daemonId, savedAt: this.#now(), sessions });
  }

  /** The transcript already in memory, for a render that cannot wait: Back into a chat. */
  peekTranscript(scope: DaemonSessionScope): CachedTranscript | undefined {
    const record = this.#memory.get(transcriptKey(scope));
    return record?.kind === 'transcript' && fresh(record.savedAt, this.#now(), this.#limits.maxAgeMs)
      ? record
      : undefined;
  }

  async transcript(scope: DaemonSessionScope): Promise<CachedTranscript | null> {
    const record = await this.#read(transcriptKey(scope), scope.daemonId);
    return record?.kind === 'transcript' ? record : null;
  }

  /**
   * Keeps the tail of a session's log and its newest send rows, for a chat the reader has open: that
   * counts as opening it. An unchanged log writes nothing. The cursor is dropped, because an open chat
   * cannot say which journal position its log was read at.
   */
  saveTranscript(
    scope: DaemonSessionScope,
    read: { readonly log?: string; readonly sends?: readonly unknown[] },
    generation: number,
  ): void {
    this.#saveTranscript(scope, read, generation, { opened: true, cursor: undefined });
  }

  /**
   * Keeps what the background read for a session nobody has open. It never counts as opening: a session
   * the reader never visited cannot push one they did visit out of the opened set. `cursor` is the
   * journal position captured BEFORE the read started, so a log newer than its cursor only costs one
   * more read, never a stale "current".
   */
  saveBackgroundTranscript(
    scope: DaemonSessionScope,
    read: { readonly log: string; readonly sends?: readonly unknown[] },
    cursor: number | undefined,
    generation: number,
  ): void {
    this.#saveTranscript(scope, read, generation, { opened: false, cursor });
  }

  /** Marks a chat opened now, so it ranks among the most recently opened. A session never saved is not made. */
  markOpened(scope: DaemonSessionScope): void {
    const key = transcriptKey(scope);
    const before = this.#memory.get(key);
    if (before?.kind !== 'transcript') return;
    const { background: _background, ...kept } = before;
    const openedAt = this.#now();
    const record: TranscriptRecord = { ...kept, openedAt };
    this.#opened.set(key, openedAt);
    this.#store(key, record);
    this.#enqueue(async backend => {
      (await this.#transcriptIndex(backend)).set(key, stamp(record));
    });
  }

  /**
   * Whether this session is among the {@link SessionCacheLimits.transcripts} most recently opened. Answered
   * from memory, so it is only as complete as what this document has read: `warm` loads the rest.
   */
  isRecentlyOpened(scope: DaemonSessionScope): boolean {
    const mine = this.#opened.get(transcriptKey(scope));
    if (mine === undefined) return false;
    let newer = 0;
    for (const openedAt of this.#opened.values()) if (openedAt > mine) newer += 1;
    return newer < this.#limits.transcripts;
  }

  /** Reads which sessions were opened, once, from storage — so `isRecentlyOpened` is right after a reload. */
  async warm(): Promise<void> {
    const backend = this.#backend;
    if (backend === null) return;
    const generation = this.#epoch;
    const known = await this.#queue.then(async () => await this.#transcriptIndex(backend)).catch(() => undefined);
    if (known === undefined || generation !== this.#epoch) return;
    for (const [key, { openedAt }] of known)
      if (openedAt !== undefined && !this.#opened.has(key)) this.#opened.set(key, openedAt);
  }

  /**
   * Drops transcripts the background kept for sessions no longer wanted, so the background class tracks
   * what is interactive now and not what once was.
   */
  retainBackground(wanted: ReadonlySet<string>): void {
    this.#enqueue(async backend => {
      const known = await this.#transcriptIndex(backend);
      for (const [key, { openedAt }] of [...known]) {
        if (openedAt !== undefined || wanted.has(key)) continue;
        known.delete(key);
        this.#memory.delete(key);
        await backend.delete(key);
      }
    });
  }

  /** The storage key a scope's transcript is kept under: what `retainBackground` is given. */
  keyOf(scope: DaemonSessionScope): string {
    return transcriptKey(scope);
  }

  #saveTranscript(
    scope: DaemonSessionScope,
    read: { readonly log?: string; readonly sends?: readonly unknown[] },
    generation: number,
    how: { readonly opened: boolean; readonly cursor: number | undefined },
  ): void {
    if (generation !== this.generation(scope.daemonId)) return;
    const key = transcriptKey(scope);
    const previous = this.#memory.get(key);
    const before = previous?.kind === 'transcript' ? previous : undefined;
    const log = read.log === undefined ? (before?.log ?? '') : logTail(read.log, this.#limits.transcriptChars);
    const sends = read.sends === undefined ? (before?.sends ?? []) : read.sends.slice(-this.#limits.sends);
    const cursor = read.log === undefined && how.opened ? before?.cursor : how.cursor;
    if (
      before !== undefined &&
      before.log === log &&
      before.cursor === cursor &&
      JSON.stringify(before.sends) === JSON.stringify(sends) &&
      (!how.opened || before.openedAt !== undefined)
    ) {
      if (how.opened) this.#opened.set(key, before.openedAt ?? this.#now());
      return;
    }
    const savedAt = this.#now();
    const openedAt = how.opened ? savedAt : before?.openedAt;
    const record: TranscriptRecord = {
      kind: 'transcript',
      daemonId: scope.daemonId,
      savedAt,
      log,
      sends,
      ...(openedAt === undefined ? { background: true as const } : { openedAt }),
      ...(cursor === undefined ? {} : { cursor }),
    };
    if (openedAt !== undefined) this.#opened.set(key, openedAt);
    this.#store(key, record);
    this.#enqueue(async backend => {
      const known = await this.#transcriptIndex(backend);
      known.set(key, stamp(record));
      for (const gone of this.#excess(known)) {
        known.delete(gone);
        this.#memory.delete(gone);
        this.#opened.delete(gone);
        await backend.delete(gone);
      }
    });
  }

  /** Keys over either bound: the least recently opened past `transcripts`, the oldest background past `background`. */
  #excess(known: ReadonlyMap<string, TranscriptStamp>): readonly string[] {
    const opened = [...known].filter(([, entry]) => entry.openedAt !== undefined);
    const background = [...known].filter(([, entry]) => entry.openedAt === undefined);
    const dropOldest = (entries: typeof opened, keep: number, time: (entry: TranscriptStamp) => number): string[] =>
      entries
        .sort((a, b) => time(a[1]) - time(b[1]))
        .slice(0, Math.max(0, entries.length - keep))
        .map(([key]) => key);
    return [
      ...dropOldest(opened, this.#limits.transcripts, entry => entry.openedAt ?? 0),
      ...dropOldest(background, this.#limits.background, entry => entry.savedAt),
    ];
  }

  /** Forgets one machine: its list and every transcript, in memory and in storage. */
  clearDaemon(daemonId: DaemonId): boolean {
    this.#generations.set(daemonId, (this.#generations.get(daemonId) ?? 0) + 1);
    let had = false;
    for (const [key, record] of this.#memory) {
      if (record.daemonId !== daemonId) continue;
      this.#memory.delete(key);
      this.#opened.delete(key);
      had = true;
    }
    this.#absent.clear();
    this.#enqueue(async backend => {
      const known = await this.#transcriptIndex(backend);
      for (const key of await backend.keys()) {
        const record = parseCacheRecord(await backend.get(key), Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
        if (record !== null && record.daemonId !== daemonId) continue;
        known.delete(key);
        await backend.delete(key);
      }
    });
    return had;
  }

  /** Empties everything this device has cached, for every machine. Settles when storage has. */
  async clearAll(): Promise<void> {
    this.#epoch += 1;
    this.#memory.clear();
    this.#opened.clear();
    this.#absent.clear();
    this.#transcripts = Promise.resolve(new Map());
    this.#enqueue(async backend => await backend.clear());
    await this.#queue;
  }

  async #read(key: string, daemonId: DaemonId): Promise<CacheRecord | null> {
    const now = this.#now();
    const cached = this.#memory.get(key);
    if (cached !== undefined) return fresh(cached.savedAt, now, this.#limits.maxAgeMs) ? cached : null;
    if (this.#backend === null || this.#absent.has(key)) return null;
    const generation = this.generation(daemonId);
    const value = await this.#queue.then(async () => await this.#backend?.get(key)).catch(() => undefined);
    const record = parseCacheRecord(value, now, this.#limits.maxAgeMs);
    // A clear while this was being read means what it found is no longer this machine's to show.
    if (generation !== this.generation(daemonId) || record === null || record.daemonId !== daemonId) {
      if (generation === this.generation(daemonId)) this.#absent.add(key);
      return null;
    }
    // A live answer that landed while storage was read is newer: it wins.
    const raced = this.#memory.get(key);
    if (raced !== undefined) return raced;
    this.#memory.set(key, record);
    return record;
  }

  #store(key: string, record: CacheRecord): void {
    this.#memory.set(key, record);
    this.#absent.delete(key);
    this.#enqueue(async backend => await backend.put(key, record));
  }

  #enqueue(write: (backend: SessionCacheBackend) => Promise<void>): void {
    const backend = this.#backend;
    if (backend === null) return;
    this.#queue = this.#queue.then(async () => await write(backend)).catch(() => undefined);
  }

  #transcriptIndex(backend: SessionCacheBackend): Promise<Map<string, TranscriptStamp>> {
    this.#transcripts ??= (async () => {
      const known = new Map<string, TranscriptStamp>();
      for (const key of await backend.keys()) {
        const record = parseCacheRecord(await backend.get(key), this.#now(), this.#limits.maxAgeMs);
        if (record === null) await backend.delete(key);
        else if (record.kind === 'transcript') known.set(key, stamp(record));
      }
      return known;
    })().catch(() => new Map<string, TranscriptStamp>());
    return this.#transcripts;
  }
}

/**
 * Draws one machine's cached list into the live fleet store, if it has one and the store has not read
 * that machine yet. A list cleared while it was being read is not drawn (`sessions` checks).
 */
export const seedFleetFromCache = async (
  fleet: { seed(daemon: DaemonConnection, sessions: readonly SessionView[], savedAt: number): boolean },
  cache: SessionCache,
  daemon: DaemonConnection,
): Promise<boolean> => {
  const cached = await cache.sessions(daemon.daemonId);
  return cached !== null && fleet.seed(daemon, cached.sessions, cached.savedAt);
};
