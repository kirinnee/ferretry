import { basename, join } from 'node:path';
import {
  type ArchivedSession,
  type ClockPort,
  CURRENT_SESSION_VERSION,
  canonicalJsonValue,
  createJournalScanCursor,
  createSessionEvent,
  createSessionPaths,
  type DirectoryEntry,
  decideSessionMarker,
  deepFreezeJson,
  type EventPointer,
  encodeSessionEvent,
  type FileSystemPort,
  type FoundationPaths,
  type FrozenJsonValue,
  type HomeLockLease,
  type IndexedSession,
  type JournalFingerprint,
  type JournalProblem,
  type JsonValue,
  parseArchiveRegistry,
  parseJsonDocument,
  parseSessionEvent,
  planIndexRebuild,
  planReconciliation,
  type RebuildResult,
  type ReplayPage,
  type SessionEvent,
  type SessionId,
  type SessionIndex,
  type SessionPaths,
  type SessionSource,
  scanJournalChunk,
  serializeArchiveRegistry,
  serializeJsonDocument,
  sessionJournalRequired,
  sessionMarkerNeedsUpgrade,
  tryParseSessionId,
  type YieldingSerialExecutor,
} from '../../lib/index.ts';
import { KeyedSerialExecutor } from '../system/keyed-serial-executor.ts';
import { jsonObject } from '../../lib/json.ts';

export class InvalidStateDocumentError extends Error {
  constructor(
    readonly file: string,
    readonly reason: string,
  ) {
    super(`invalid JSON document ${file}: ${reason}`);
    this.name = 'InvalidStateDocumentError';
  }
}

export class SessionLayoutError extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly marker: string | undefined,
  ) {
    super(
      marker === undefined
        ? `session ${sessionId} is non-empty but has no session-version marker`
        : `session ${sessionId} has unsupported session-version marker ${JSON.stringify(marker.trim())}`,
    );
    this.name = 'SessionLayoutError';
  }
}

export class MissingSessionJournalError extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly file: string,
  ) {
    // Not "indexed": under the current marker this is proved from disk, long after the index is gone.
    super(`session ${sessionId} has lost its durable journal ${file}; refusing to treat it as empty`);
    this.name = 'MissingSessionJournalError';
  }
}

export class JournalReplacedError extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly file: string,
  ) {
    super(`session ${sessionId} journal ${file} was replaced while appending; refusing to write into it`);
    this.name = 'JournalReplacedError';
  }
}

export class DurableEventIndexError extends Error {
  readonly durable = true;

  constructor(
    readonly sessionId: SessionId,
    options: ErrorOptions,
  ) {
    super(`event for ${sessionId} is durable in the journal but could not be indexed`, options);
    this.name = 'DurableEventIndexError';
  }
}

interface SourceCollection {
  readonly sources: readonly SessionSource[];
  readonly problems: readonly JournalProblem[];
  readonly failedSessionIds: readonly string[];
  readonly lostJournalSessionIds: readonly string[];
}

interface ObservationCollection {
  readonly observations: readonly SessionObservation[];
  readonly problems: readonly JournalProblem[];
  readonly failedSessionIds: readonly string[];
}

/** One session directory as a health tick sees it: cheap to obtain, enough to spot lost history. */
export interface SessionDirectorySurvey {
  readonly id: SessionId;
  /**
   * True when the journal file is gone from a session that owes one — either because its marker is
   * the current version, or because an unmigrated legacy session still has an index fingerprint
   * witnessing the journal it used to have.
   */
  readonly journalLost: boolean;
}

interface JournalObservation {
  readonly file: string;
  readonly fingerprint: JournalFingerprint;
}

interface SessionObservation {
  readonly id: SessionId;
  readonly marker: SessionSource['marker'];
  readonly config?: SessionSource['config'];
  readonly state?: SessionSource['state'];
  readonly journal?: JournalObservation;
}

/** The durable layout claim lifecycle creation makes before it publishes any session evidence. */
function isOnlySessionReservation(evidence: {
  readonly config?: unknown;
  readonly state?: unknown;
  readonly journal?: { readonly fingerprint: { readonly size: number } };
}): boolean {
  return evidence.config === undefined && evidence.state === undefined && evidence.journal?.fingerprint.size === 0;
}

type SessionInspection =
  | { readonly kind: 'current'; readonly session?: IndexedSession }
  | { readonly kind: 'repair'; readonly source: SessionSource | null; readonly session?: IndexedSession };

const JOURNAL_READ_CHUNK_BYTES = 64 * 1024;

function sameFingerprint(left: JournalFingerprint | null, right: JournalFingerprint | null): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.device === right.device &&
      left.inode === right.inode &&
      left.size === right.size &&
      left.modifiedAtMs === right.modifiedAtMs)
  );
}

function sameJournalFile(left: JournalFingerprint, right: JournalFingerprint): boolean {
  return left.device === right.device && left.inode === right.inode;
}

/**
 * The fewest session documents the identity cache holds, and the room it keeps per indexed session above it.
 *
 * A FIXED BOUND WAS A CLIFF, NOT A CEILING. Each session puts three documents in the cache — its marker, its
 * config and its state — and the background readers walk every session, so once a fleet passed
 * 4,096 / 3 ≈ 1,365 sessions every walk overflowed the bound: the cache emptied part-way through, and every
 * read after that was a walked open, read and JSON parse instead of one `stat`. A real host at 1,385
 * sessions, nearly all of them finished, read 135 MB/s of its own unchanged documents and stalled its loop
 * for seconds. So the bound follows the fleet the index holds, with a spare slot per session, and never
 * drops below the floor.
 *
 * ARCHIVED SESSIONS COUNT TOO. An archived session leaves the index but every reader can still name it — the
 * board reads the config and state of every card's owner and assignee, closed cards included — so the bound
 * follows every session a reader can name, live or archived. Counting only the live ones put a host with ~5,100
 * archived sessions at the floor, and each board read walked ~8,500 documents through a 4,096-document FIFO:
 * a miss for every one, a parse, a zod pass and a freeze, and the live fleet's documents evicted with them.
 */
const DOCUMENT_CACHE_FLOOR = 4_096;
const DOCUMENTS_PER_SESSION = 4;

/**
 * THE ENTRY BOUND IS NOT A BYTE BOUND, SO THE CACHE ALSO HAS A BYTE BUDGET.
 *
 * {@link DOCUMENTS_PER_SESSION} counts entries. With ~4,800 archived sessions it lets 19,200 + 4 × live entries in,
 * and nothing limited how large one was, so the memory the cache could pin had no finite bound. Every document now
 * costs an estimate of the memory it holds — {@link DOCUMENT_ENTRY_BYTES} for the entry, {@link TEXT_BYTES_PER_CHAR}
 * a character for its text (UTF-16 at worst), and {@link VALUE_BYTES_PER_CHAR} a character of text more once its
 * parsed, frozen value is held — and the oldest documents go once the total passes the budget. A document whose text
 * is over the per-document cap is never cached at all: it is read and parsed on every use, as it was before there was
 * a cache.
 *
 * THE NUMBERS. Measured on the host that froze: configs 14.4 MB of text for the 2,824 sessions a board walk reads
 * (8.4 KB on average, 58 KB at most) and ~1 KB per state, so a board walk's working set is ~8,500 documents,
 * ~17 MB of text, and about 17 MB × (2 + 3) + 8,500 × 512 B ≈ 90 MB by this estimate; the live fleet's documents
 * add ~20 MB. The budget is 192 MiB (≈ 201 MB), twice that working set, so a board walk still hits the cache on
 * its second pass and the freeze fix holds. The per-document cap is 1 Mi characters, 17 times the largest document
 * seen. Both are the defaults of {@link DocumentCacheBudget}; a test passes a small one.
 */
export interface DocumentCacheBudget {
  /** The most estimated memory the cached documents may hold together, in bytes. */
  readonly bytes: number;
  /** The longest text, in characters, a document may have and still be cached. */
  readonly documentChars: number;
}

export const DEFAULT_DOCUMENT_CACHE_BUDGET: DocumentCacheBudget = {
  bytes: 192 * 1_024 * 1_024,
  documentChars: 1_024 * 1_024,
};

/** What an entry costs beside its text: the path key, the map slot, the record and its identity. */
const DOCUMENT_ENTRY_BYTES = 512;
/** A character of cached text, at worst: V8 holds a string with any wide character as UTF-16. */
const TEXT_BYTES_PER_CHAR = 2;
/** A character of text, again, for the parsed and frozen value built from it: objects, keys and slots outweigh it. */
const VALUE_BYTES_PER_CHAR = 3;

/**
 * How much of a full cache is let go at once: the oldest eighth.
 *
 * A cache still full once its bound has followed the fleet holds documents of sessions that are gone. It
 * lets the oldest go rather than starting again from empty — emptying it is what made a walk over a
 * large fleet a walk of misses — and lets enough go that the fleet is not counted again on the next read.
 */
const DOCUMENT_EVICTION_SHARE = 8;

/**
 * What a document's watch had heard when its identity was taken: WHICH watch, and how many changes it had
 * reported.
 *
 * The count alone cannot vouch. A watch that was closed and opened again starts counting again, so a copy
 * read through the old watch could look quiet to the new one — across the very gap in which nothing was
 * listening. Giving each watch its own range of counts does not hold either: a watch that has heard enough
 * changes counts into the next watch's range. So the watch is named by a generation that never repeats
 * within a storage and is kept apart from the count, which may run as high as it likes. A copy is quiet
 * only to the very watch it was read through; to any other it is a mismatch, and a mismatch is a `stat`.
 */
interface Hearing {
  readonly watch: number;
  readonly changes: number;
}

function sameHearing(a: Hearing | undefined, b: Hearing | undefined): boolean {
  return a !== undefined && b !== undefined && a.watch === b.watch && a.changes === b.changes;
}

/** A document as last read: the identity of the file it came from, its text, and its parsed value. */
interface CachedDocument {
  readonly identity: string;
  readonly text: string;
  readonly value?: FrozenJsonValue;
  /**
   * What the document's watch had reported when its identity was last taken — counted BEFORE the `stat`
   * or the read, so a change that lands during either is still unseen. Absent while unwatched.
   */
  readonly heard?: Hearing;
}

/**
 * How fresh a read must be.
 *
 * - `proved` (every read's default): the file is proved by a `stat` on every read, so a change by ANY
 *   writer — this daemon, another process, a person with an editor — is seen by the very next read.
 * - `heard`: as fresh as the last file event. A watched document whose watch is live and quiet costs no
 *   system call; a change from outside the daemon is seen once the hub has heard it, within its settle.
 *   For background readers that ask about every session over and over, and act on nothing a person just
 *   did — the transcript resolver, the fleet reading.
 */
export type DocumentFreshness = 'proved' | 'heard';

/** A watch on one file: whether a change is reported by an event right now, and how to stop it. */
export interface DocumentSubscription {
  live(): boolean;
  close(): void;
}

/**
 * Hears when a session document may have changed — written, replaced or deleted, by this daemon or by
 * anyone else. The file-event hub's `subscribe`.
 */
export interface DocumentChanges {
  subscribe(path: string, listener: () => void): DocumentSubscription;
}

/** A document's watch, the generation that names it, and how many changes it has reported. */
interface WatchedDocument {
  readonly generation: number;
  readonly subscription: DocumentSubscription;
  changes: number;
}

function assertFleetTailLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000)
    throw new Error('fleet event limit must be an integer between 1 and 10000');
}

/** What the archive records of a session it is about to take: the name it answered to and what that name's hold runs from. */
export interface ArchiveVerdict {
  readonly name?: string;
  /** The configuration's `createdAt` and `updatedAt`: what a callsign's hold on its name is measured from. */
  readonly configTimes?: { readonly createdAt: string; readonly updatedAt: string };
}

export class DaemonStorage {
  private closed = false;
  /**
   * Session documents — markers, configs, states — by path, each with the identity of the file it was
   * read from.
   *
   * WHY. Every background watcher reads every session's documents every few seconds. Each read walked
   * the state home component by component (an `lstat` per directory), opened and read the marker and
   * then the document, and parsed the JSON: on a 36-session Mac, about 350 file opens a second and a
   * parse on the event loop for every one — under endpoint security, which inspects every open, that
   * was most of what the daemon did. A document that has not changed is now answered by ONE `stat`,
   * compared with the identity of the file that was proved and read; anything else — our own atomic
   * write (a new inode), someone else's edit, a swap — is a different identity and a full, walked read.
   *
   * Values are handed out as copies, so no caller can change what another one is given.
   */
  private readonly documents = new Map<string, CachedDocument>();
  /**
   * The documents a background reader read more than once (`heard` freshness), each watched through
   * {@link DocumentChanges}.
   *
   * WHY. The identity cache made an unchanged document ONE `stat` per read — still about thirty a second
   * on an idle 36-session fleet, nearly all of them `session-version` and `config.json` asked for again
   * by the transcript resolver and the fleet reading. A watched document whose watch is live and has
   * reported nothing since its identity was taken is provably the file that was read, so those readers are
   * answered with no system call at all. Wherever the watch cannot vouch — the directory is polled, the
   * platform never reports the name, or no watch is wired — the `stat` stays, exactly as before. Every
   * other read still proves the file with a `stat`: a request acts on what a person may just have
   * written, and must see it.
   */
  private readonly watched = new Map<string, WatchedDocument>();
  /**
   * How many documents {@link documents} and {@link watched} may each hold: see {@link DOCUMENT_CACHE_FLOOR}.
   *
   * The watches share the bound because a document worth watching is one the cache holds. A fixed 1,024 was
   * outgrown by a fleet of ~600 sessions, and every document past it was `stat`ed on every pass of every
   * reader that asks about all of them. A watch costs an entry in the hub, whose OS watch is per session
   * DIRECTORY; where the OS refuses another the hub polls that directory, so a large bound degrades to the
   * old `stat`, never to a missed change.
   */
  private documentLimit = DOCUMENT_CACHE_FLOOR;
  /** The estimated memory the cached documents hold now: the sum of {@link costOfDocument} over {@link documents}. */
  private cachedBytes = 0;
  /** The generation of the last watch opened: every watch of this storage has one of its own ({@link Hearing}). */
  private watchGeneration = 0;
  /** Live journal appends for sockets served by THIS opened daemon storage, never process-global. */
  private readonly eventListeners = new Set<(event: SessionEvent) => void>();
  /**
   * Every state document THIS storage writes, as written — the `facts` hook.
   *
   * This storage is the only writer of `state.json`, so it knows every change the moment it lands.
   * The session observer is told here instead of re-reading every session's document on every tick
   * (`docs/design/session-workers.md` §2.2). Called inside the session's lane after the write and the
   * index sync, so a listener sees writes to one session in the order they committed.
   */
  private readonly stateListeners = new Set<(id: SessionId, state: JsonValue) => void>();
  /** How many session configs THIS storage has written: {@link configWrites}. */
  private configChanges = 0;
  /**
   * The sessions that have left the live set, by id (docs/session-archive.md). Their directories are untouched, and the
   * index holds no row for them: every walk of the index, the sessions directory or the survey passes them by, which is
   * the whole point. A WRITE to one revives it ({@link reviveIfArchived}); a read does not.
   */
  private archived: ReadonlyMap<SessionId, ArchivedSession> = new Map();
  /** Registry writes, one after another: an archive pass and a revive never interleave their documents. */
  private registryWrites: Promise<void> = Promise.resolve();
  /** Config writes and archive commits share root lanes, always taken before document lanes. */
  private readonly lineages = new KeyedSerialExecutor();
  /** A keep published during verification or registry IO cancels that finite archive commit. */
  private retentionChanges = 0;

  constructor(
    readonly paths: FoundationPaths,
    private readonly fileSystem: FileSystemPort,
    private readonly index: SessionIndex,
    private readonly clock: ClockPort,
    private readonly serial: YieldingSerialExecutor,
    private readonly homeLock: HomeLockLease,
    private readonly changes?: DocumentChanges,
    /** How much the identity cache may hold: see {@link DocumentCacheBudget}. */
    private readonly budget: DocumentCacheBudget = DEFAULT_DOCUMENT_CACHE_BUDGET,
  ) {}

  private assertOpen(): void {
    if (this.closed) throw new Error('daemon storage is closed');
  }

  /**
   * Refuses to read a session whose journal has vanished.
   *
   * The marker is the authoritative witness: it is on disk, written durably, and unlike the SQLite
   * index it is never dropped and rebuilt — so it still answers after the index has been deleted,
   * which is the case that used to fabricate an empty session. A version-1 directory predates the
   * contract, so there the disposable index is the only evidence left.
   */
  private assertExpectedJournal(
    id: SessionId,
    marker: string | undefined,
    indexed: IndexedSession | undefined,
    present: boolean,
  ): void {
    if (present) return;
    if (sessionJournalRequired(marker) || (indexed !== undefined && indexed.journal !== null)) {
      throw new MissingSessionJournalError(id, createSessionPaths(this.paths, id).events);
    }
  }

  /**
   * Whether an unmarked directory is a creation that was interrupted before its marker landed.
   *
   * Creation writes the marker LAST, so the only prefix it can leave behind is a zero-length
   * journal — provably lossless to complete. Marker-first would instead leave a marker without a
   * journal, which is a FALSE data-loss claim that quarantines a brand-new session forever.
   */
  private async recoverableCreation(paths: SessionPaths, entries: readonly DirectoryEntry[]): Promise<boolean> {
    if (entries.length === 0) return true;
    const only = entries[0];
    if (entries.length > 1 || only === undefined || only.directory || only.name !== basename(paths.events))
      return false;
    return (await this.fileSystem.information(paths.events))?.size === 0;
  }

  /**
   * The journal a session must have, creating an empty one only where that is provably lossless.
   *
   * Answers undefined when the file is absent but the index still holds a fingerprint for it: that
   * session demonstrably HAD a journal, and laying down an empty one would destroy the only evidence
   * left that its history is gone. Callers turn that into a refusal, never into a repair.
   */
  private async ensureJournalFile(id: SessionId, paths: SessionPaths): Promise<JournalFingerprint | undefined> {
    const existing = await this.fileSystem.information(paths.events);
    if (existing !== undefined) return existing;
    const indexed = this.index.findSession(id);
    if (indexed !== undefined && indexed.journal !== null) return undefined;
    return await this.fileSystem.createFileExclusive(paths.events, 0o600);
  }

  /** Gives the directory a journal and the current marker — marker LAST — or refuses to fabricate one. */
  private async completeSessionUpgrade(id: SessionId, paths: SessionPaths): Promise<JournalFingerprint> {
    const journal = await this.ensureJournalFile(id, paths);
    if (journal === undefined) throw new MissingSessionJournalError(id, paths.events);
    await this.writeDocument(paths.marker, `${CURRENT_SESSION_VERSION}\n`);
    return journal;
  }

  /**
   * Brings the session directory up to the current contract and answers with its journal.
   *
   * This is the ONLY place a journal is ever created. A version-2 directory whose journal is gone is
   * refused rather than repaired: recreating it here would reopen exactly the hole this contract
   * closes, one call before the append.
   */
  private async ensureSessionDirectory(id: SessionId): Promise<JournalFingerprint> {
    const paths = createSessionPaths(this.paths, id);
    const marker = await this.fileSystem.readText(paths.marker);
    if (marker === undefined) {
      const entries = await this.fileSystem.listDirectory(paths.directory);
      if (!(await this.recoverableCreation(paths, entries))) throw new SessionLayoutError(id, undefined);
      await this.fileSystem.ensureDirectory(paths.directory, 0o700);
      return await this.completeSessionUpgrade(id, paths);
    }
    if (decideSessionMarker(marker) === 'refuse') throw new SessionLayoutError(id, marker);
    await this.fileSystem.ensureDirectory(paths.directory, 0o700);
    if (sessionMarkerNeedsUpgrade(marker)) return await this.completeSessionUpgrade(id, paths);
    const journal = await this.fileSystem.information(paths.events);
    if (journal === undefined) throw new MissingSessionJournalError(id, paths.events);
    await this.fileSystem.setMode(paths.marker, 0o600);
    return journal;
  }

  /**
   * Reserves a current session LAYOUT without publishing config, state, or an event.
   *
   * WHAT IS DURABLE HERE, PRECISELY: the journal and the marker INSIDE the session directory. Each is
   * written through a primitive that syncs the file and then the directory holding it, so an
   * interrupted prefix is recoverable by `ensureSessionDirectory` and repeating a reservation is
   * safe. Readers still see no session document until a later write publishes one.
   *
   * WHAT IS NOT DURABLE HERE, AND WHOSE JOB IT IS: the entry NAMING `<sessions>/<id>`. An entry lives
   * in its immediate parent, and nothing on this path syncs `<sessions>` — so after this returns the
   * layout inside the directory is durable while the directory's own name may not be. That barrier is
   * the CALLER's: `StorageSessionLifecycleRepository.reserve` supplies it unconditionally, on every
   * call, immediately after this one. Giving storage that guarantee would put one fact in two owners
   * and widen a shared primitive every session write goes through; the broader storage-wide version
   * is a declared #F117 GAP rather than something this method quietly half-provides.
   */
  async reserveSessionDirectory(id: SessionId): Promise<void> {
    this.assertOpen();
    await this.serial.run(id, async () => {
      await this.ensureSessionDirectory(id);
    });
  }

  /**
   * Gives every version-1 session directory a journal and the current marker, in place.
   *
   * Only version 1 is touched, and only where a journal can be created without destroying evidence.
   * Nothing here refuses: a session whose journal is already lost must still let the home open, and
   * quarantining it is the job of rebuild and the health pass, not of boot.
   */
  async upgradeLegacySessions(): Promise<readonly SessionId[]> {
    this.assertOpen();
    return await this.serial.runExclusive(async () => {
      const upgraded: SessionId[] = [];
      for (const entry of await this.fileSystem.listDirectory(this.paths.sessions)) {
        if (!entry.directory) continue;
        const id = tryParseSessionId(entry.name);
        if (id === undefined) continue;
        if (this.archived.has(id)) continue;
        const paths = createSessionPaths(this.paths, id);
        if (!sessionMarkerNeedsUpgrade(await this.fileSystem.readText(paths.marker))) continue;
        if ((await this.ensureJournalFile(id, paths)) === undefined) continue;
        await this.writeDocument(paths.marker, `${CURRENT_SESSION_VERSION}\n`);
        upgraded.push(id);
      }
      return upgraded;
    });
  }

  /** Refuses every unmarked directory except the exact lossless prefix reservation can leave. */
  private async refuseUnrecoverableUnmarkedSession(id: SessionId): Promise<void> {
    const paths = createSessionPaths(this.paths, id);
    const entries = await this.fileSystem.listDirectory(paths.directory);
    if (!(await this.recoverableCreation(paths, entries))) throw new SessionLayoutError(id, undefined);
  }

  private async readStableJournal(
    file: string,
    sessionId: SessionId,
    fromOffset = 0,
    fromSequence = 0,
    fromLine = 1,
  ): Promise<NonNullable<SessionSource['journal']> | undefined> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await this.fileSystem.information(file);
      let cursor = createJournalScanCursor({
        baseOffset: fromOffset,
        firstLine: fromLine,
        previousSequence: fromSequence,
      });
      const pointers: EventPointer[] = [];
      const problems: JournalProblem[] = [];
      for await (const chunk of this.fileSystem.readChunks(file, JOURNAL_READ_CHUNK_BYTES, fromOffset)) {
        const result = scanJournalChunk(cursor, chunk, { file, sessionId });
        cursor = result.cursor;
        pointers.push(...result.scan.pointers);
        problems.push(...result.scan.problems);
      }
      const final = scanJournalChunk(cursor, new Uint8Array(), { file, sessionId, final: true });
      cursor = final.cursor;
      pointers.push(...final.scan.pointers);
      problems.push(...final.scan.problems);
      const after = await this.fileSystem.information(file);
      if (before === undefined && after === undefined && fromOffset === 0) return undefined;
      if (
        before !== undefined &&
        after !== undefined &&
        before.size >= fromOffset &&
        cursor.byteOffset === after.size &&
        sameFingerprint(before, after)
      ) {
        return {
          file,
          scan: {
            pointers,
            problems,
            scannedTo: cursor.byteOffset,
            lastSequence: cursor.lastSequence,
            lineAtOffset: cursor.line,
          },
          fingerprint: {
            device: after.device,
            inode: after.inode,
            size: after.size,
            modifiedAtMs: after.modifiedAtMs,
          },
        };
      }
    }
    throw new Error(`journal changed repeatedly while reading ${file}`);
  }

  private async readSource(id: SessionId, includeMissingMarker = false): Promise<SessionSource | undefined> {
    const paths = createSessionPaths(this.paths, id);
    const [marker, config, state, journal] = await Promise.all([
      this.fileSystem.readText(paths.marker),
      this.fileSystem.readText(paths.config),
      this.fileSystem.readText(paths.state),
      this.readStableJournal(paths.events, id),
    ]);
    if (marker === undefined && !includeMissingMarker) {
      await this.refuseUnrecoverableUnmarkedSession(id);
      return undefined;
    }
    const source = {
      id,
      marker: { file: paths.marker, text: marker ?? '' },
      config: config === undefined ? undefined : { file: paths.config, text: config },
      state: state === undefined ? undefined : { file: paths.state, text: state },
      journal,
    };
    return (marker === undefined || decideSessionMarker(marker) === 'proceed') && isOnlySessionReservation(source)
      ? undefined
      : source;
  }

  private async readObservation(id: SessionId, includeMissingMarker = false): Promise<SessionObservation | undefined> {
    const paths = createSessionPaths(this.paths, id);
    // Through the identity cache: every journal append and every self-check observes the session, and
    // re-reading three unchanged documents each time was most of what either of them cost.
    const [marker, config, state, journal] = await Promise.all([
      this.readCachedText(paths.marker).then(document => document?.text),
      this.readCachedText(paths.config).then(document => document?.text),
      this.readCachedText(paths.state).then(document => document?.text),
      this.fileSystem.information(paths.events),
    ]);
    if (marker === undefined && !includeMissingMarker) {
      await this.refuseUnrecoverableUnmarkedSession(id);
      return undefined;
    }
    const observation = {
      id,
      marker: { file: paths.marker, text: marker ?? '' },
      config: config === undefined ? undefined : { file: paths.config, text: config },
      state: state === undefined ? undefined : { file: paths.state, text: state },
      journal:
        journal === undefined
          ? undefined
          : {
              file: paths.events,
              fingerprint: {
                device: journal.device,
                inode: journal.inode,
                size: journal.size,
                modifiedAtMs: journal.modifiedAtMs,
              },
            },
    };
    return (marker === undefined || decideSessionMarker(marker) === 'proceed') && isOnlySessionReservation(observation)
      ? undefined
      : observation;
  }

  private applySource(source: SessionSource): {
    readonly session?: IndexedSession;
    readonly eventCount: number;
    readonly problems: readonly JournalProblem[];
  } {
    const plan = planIndexRebuild([source]);
    const session = plan.sessions[0];
    if (session === undefined) {
      this.index.removeSession(source.id);
      return { eventCount: 0, problems: plan.problems };
    }
    this.index.replaceSession(session, plan.events);
    return { session, eventCount: plan.events.length, problems: plan.problems };
  }

  private async syncSessionUnlocked(id: SessionId): Promise<{
    readonly session?: IndexedSession;
    readonly eventCount: number;
    readonly problems: readonly JournalProblem[];
  }> {
    const source = await this.readSource(id);
    if (source === undefined) {
      this.index.removeSession(id);
      return { eventCount: 0, problems: [] };
    }
    this.assertExpectedJournal(id, source.marker.text, this.index.findSession(id), source.journal !== undefined);
    return this.applySource(source);
  }

  async syncSession(id: SessionId): Promise<RebuildResult> {
    this.assertOpen();
    return await this.serial.run(id, async () => {
      const result = await this.syncSessionUnlocked(id);
      return {
        sessionCount: result.session ? 1 : 0,
        eventCount: result.eventCount,
        problems: result.problems,
      };
    });
  }

  private async collectSources(): Promise<SourceCollection> {
    const entries = await this.fileSystem.listDirectory(this.paths.sessions);
    const sources: SessionSource[] = [];
    const problems: JournalProblem[] = [];
    const failedSessionIds: string[] = [];
    const lostJournalSessionIds: string[] = [];
    for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.directory) continue;
      const id = tryParseSessionId(entry.name);
      if (id === undefined) {
        problems.push({
          file: join(this.paths.sessions, entry.name),
          line: 0,
          byteOffset: 0,
          message: `invalid session directory ${JSON.stringify(entry.name)}`,
        });
        continue;
      }
      if (this.archived.has(id)) continue;
      try {
        const source = await this.readSource(id, true);
        if (source) {
          this.assertExpectedJournal(id, source.marker.text, this.index.findSession(id), source.journal !== undefined);
          sources.push(source);
        }
      } catch (error) {
        // Quarantine, never abort: re-throwing here made one deleted journal unbuild the whole
        // index, so every other session in the home vanished from every listing.
        if (error instanceof MissingSessionJournalError) lostJournalSessionIds.push(id);
        failedSessionIds.push(id);
        problems.push({
          file: createSessionPaths(this.paths, id).directory,
          line: 0,
          byteOffset: 0,
          message: `session ${id} failed to read and was skipped: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    return { sources, problems, failedSessionIds, lostJournalSessionIds };
  }

  private async collectObservations(): Promise<ObservationCollection> {
    const entries = await this.fileSystem.listDirectory(this.paths.sessions);
    const observations: SessionObservation[] = [];
    const problems: JournalProblem[] = [];
    const failedSessionIds: string[] = [];
    for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.directory) continue;
      const id = tryParseSessionId(entry.name);
      if (id === undefined) {
        problems.push({
          file: join(this.paths.sessions, entry.name),
          line: 0,
          byteOffset: 0,
          message: `invalid session directory ${JSON.stringify(entry.name)}`,
        });
        continue;
      }
      if (this.archived.has(id)) continue;
      try {
        const observation = await this.readObservation(id, true);
        if (observation) observations.push(observation);
      } catch (error) {
        failedSessionIds.push(id);
        problems.push({
          file: createSessionPaths(this.paths, id).directory,
          line: 0,
          byteOffset: 0,
          message: `session ${id} failed to read and was skipped: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    return { observations, problems, failedSessionIds };
  }

  async rebuildIndex(): Promise<RebuildResult> {
    this.assertOpen();
    return await this.indexSweep(async () => {
      const collected = await this.collectSources();
      const plan = planIndexRebuild(collected.sources);
      this.index.replaceAll(plan);
      const problems = [...collected.problems, ...plan.problems];
      return {
        sessionCount: plan.sessions.length,
        eventCount: plan.events.length,
        problems,
        ...(collected.failedSessionIds.length ? { failedSessionIds: collected.failedSessionIds } : {}),
        ...(collected.lostJournalSessionIds.length ? { lostJournalSessionIds: collected.lostJournalSessionIds } : {}),
      };
    });
  }

  private async pointerMatches(
    id: SessionId,
    indexed: IndexedSession,
    source: { readonly journal?: JournalObservation },
  ): Promise<boolean> {
    if (source.journal === undefined) return false;
    if (indexed.lastSequence === 0) {
      const after = await this.fileSystem.information(source.journal.file);
      return after !== undefined && sameFingerprint(source.journal.fingerprint, after);
    }
    const pointer = this.index.eventPointers(id, indexed.lastSequence - 1, 1)[0];
    if (pointer === undefined || pointer.sequence !== indexed.lastSequence) return false;
    const bytes = await this.fileSystem.readSlice(source.journal.file, pointer.byteOffset, pointer.byteLength);
    if (bytes === undefined) return false;
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      return false;
    }
    const event = parseSessionEvent(decoded, id);
    if (event?.sequence !== pointer.sequence || event.time !== pointer.time || event.type !== pointer.type)
      return false;
    const after = await this.fileSystem.information(source.journal.file);
    return after !== undefined && sameFingerprint(source.journal.fingerprint, after);
  }

  private sourceFromObservation(observation: SessionObservation, journal: SessionSource['journal']): SessionSource {
    return {
      id: observation.id,
      marker: observation.marker,
      config: observation.config,
      state: observation.state,
      journal,
    };
  }

  private metadataSource(observation: SessionObservation, current: IndexedSession): SessionSource {
    return this.sourceFromObservation(
      observation,
      observation.journal === undefined
        ? undefined
        : {
            file: observation.journal.file,
            fingerprint: observation.journal.fingerprint,
            scan: {
              pointers: [],
              problems: [],
              scannedTo: observation.journal.fingerprint.size,
              lastSequence: current.lastSequence,
              lineAtOffset: current.journalLine,
            },
          },
    );
  }

  private async observationJournalIsCurrent(observation: SessionObservation): Promise<boolean> {
    const current = await this.fileSystem.information(createSessionPaths(this.paths, observation.id).events);
    return sameFingerprint(observation.journal?.fingerprint ?? null, current ?? null);
  }

  private async tailStartsAtRecordBoundary(file: string, fromOffset: number): Promise<boolean> {
    if (fromOffset === 0) return true;
    const previous = await this.fileSystem.readSlice(file, fromOffset - 1, 1);
    if (previous?.[0] === 0x0a) return true;
    const next = await this.fileSystem.readSlice(file, fromOffset, 1);
    return next?.[0] === 0x0a;
  }

  private async applyRescan(id: SessionId): Promise<{
    readonly session?: IndexedSession;
    readonly problems: readonly JournalProblem[];
  }> {
    const source = await this.readSource(id);
    if (source === undefined) {
      this.index.removeSession(id);
      return { problems: [] };
    }
    this.assertExpectedJournal(id, source.marker.text, this.index.findSession(id), source.journal !== undefined);
    const result = this.applySource(source);
    return { session: result.session, problems: result.problems };
  }

  private async applyMetadataRefresh(
    observation: SessionObservation,
    current: IndexedSession,
  ): Promise<{ readonly session?: IndexedSession; readonly problems: readonly JournalProblem[] }> {
    if (!(await this.observationJournalIsCurrent(observation))) return await this.applyRescan(observation.id);
    const source = this.metadataSource(observation, current);
    const plan = planIndexRebuild([source]);
    // reconcile hands over only observations whose marker it proved supported, so the plan always holds the session
    const session = plan.sessions[0] as IndexedSession;
    this.index.refreshSession(session);
    return { session, problems: plan.problems };
  }

  private async applyTailScan(
    observation: SessionObservation,
    fromOffset: number,
    fromSequence: number,
    fromLine: number,
  ): Promise<{ readonly session?: IndexedSession; readonly problems: readonly JournalProblem[] }> {
    const current = this.index.findSession(observation.id);
    if (
      current?.journal === null ||
      current === undefined ||
      observation.journal === undefined ||
      current.journal.size !== fromOffset ||
      current.lastSequence !== fromSequence ||
      current.journalLine !== fromLine ||
      !sameJournalFile(current.journal, observation.journal.fingerprint) ||
      !(await this.observationJournalIsCurrent(observation)) ||
      !(await this.tailStartsAtRecordBoundary(observation.journal.file, fromOffset))
    ) {
      return await this.applyRescan(observation.id);
    }
    const journal = await this.readStableJournal(
      observation.journal.file,
      observation.id,
      fromOffset,
      fromSequence,
      fromLine,
    );
    if (
      journal === undefined ||
      !sameJournalFile(current.journal, journal.fingerprint) ||
      !sameFingerprint(observation.journal.fingerprint, journal.fingerprint)
    ) {
      return await this.applyRescan(observation.id);
    }
    const plan = planIndexRebuild([this.sourceFromObservation(observation, journal)]);
    const session = plan.sessions[0] as IndexedSession;
    this.index.appendEvents(session, plan.events);
    return { session, problems: plan.problems };
  }

  async reconcile(): Promise<RebuildResult> {
    this.assertOpen();
    return await this.indexSweep(async () => {
      const collected = await this.collectObservations();
      const observationById = new Map(
        collected.observations
          .filter(observation => decideSessionMarker(observation.marker.text) === 'proceed')
          .map(observation => [observation.id, observation]),
      );
      const indexed = this.index.listSessions();
      const indexedById = new Map(indexed.map(session => [session.id, session]));
      const failedSessionIds = new Set(collected.failedSessionIds);
      const lostJournalSessionIds = new Set<string>();
      const problems: JournalProblem[] = [...collected.problems];
      const observations = [];
      for (const observation of observationById.values()) {
        const current = indexedById.get(observation.id);
        try {
          this.assertExpectedJournal(
            observation.id,
            observation.marker.text,
            current,
            observation.journal !== undefined,
          );
          const journal = observation.journal?.fingerprint ?? null;
          const lastIndexedEventMatches =
            current === undefined
              ? false
              : journal === null
                ? current.journal === null && current.lastSequence === 0
                : current.journal !== null &&
                    (sameFingerprint(current.journal, journal) ||
                      (sameJournalFile(current.journal, journal) && journal.size > current.journal.size))
                  ? await this.pointerMatches(observation.id, current, observation)
                  : false;
          observations.push({ id: observation.id, journal, lastIndexedEventMatches });
        } catch (error) {
          failedSessionIds.add(observation.id);
          if (error instanceof MissingSessionJournalError) lostJournalSessionIds.add(observation.id);
          problems.push({
            file: createSessionPaths(this.paths, observation.id).directory,
            line: 0,
            byteOffset: 0,
            message: `session ${observation.id} failed to read and was skipped: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      const actions = planReconciliation(
        observations,
        indexed.filter(session => !failedSessionIds.has(session.id)),
      );
      let sessionCount = 0;
      let eventCount = 0;
      for (const action of actions) {
        if (action.kind === 'forget') {
          this.index.removeSession(action.id);
          continue;
        }
        const observation = observationById.get(action.id);
        const current = indexedById.get(action.id);
        if (observation === undefined) continue;
        try {
          const result =
            action.kind === 'refresh-metadata' && current !== undefined
              ? await this.applyMetadataRefresh(observation, current)
              : action.kind === 'scan-tail'
                ? await this.applyTailScan(observation, action.fromOffset, action.fromSequence, action.fromLine)
                : await this.applyRescan(action.id);
          problems.push(...result.problems);
          if (result.session) {
            sessionCount += 1;
            eventCount += this.index.countEvents(action.id);
          }
        } catch (error) {
          failedSessionIds.add(action.id);
          if (error instanceof MissingSessionJournalError) lostJournalSessionIds.add(action.id);
          problems.push({
            file: createSessionPaths(this.paths, action.id).directory,
            line: 0,
            byteOffset: 0,
            message: `session ${action.id} failed to reconcile and was skipped: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      for (const observation of collected.observations) {
        if (decideSessionMarker(observation.marker.text) === 'proceed') continue;
        this.index.removeSession(observation.id);
        problems.push(...planIndexRebuild([this.sourceFromObservation(observation, undefined)]).problems);
      }
      return {
        sessionCount,
        eventCount,
        problems,
        ...(failedSessionIds.size ? { failedSessionIds: [...failedSessionIds] } : {}),
        ...(lostJournalSessionIds.size ? { lostJournalSessionIds: [...lostJournalSessionIds] } : {}),
      };
    });
  }

  private async inspectSession(id: SessionId): Promise<SessionInspection> {
    const observation = await this.readObservation(id);
    const current = this.index.findSession(id);
    if (observation === undefined) {
      return current === undefined ? { kind: 'current' } : { kind: 'repair', source: null };
    }
    if (decideSessionMarker(observation.marker.text) === 'refuse')
      throw new SessionLayoutError(id, observation.marker.text);
    this.assertExpectedJournal(id, observation.marker.text, current, observation.journal !== undefined);
    const fingerprint = observation.journal?.fingerprint ?? null;
    const currentPointerMatches =
      current === undefined
        ? false
        : fingerprint === null
          ? current.lastSequence === 0 &&
            (await this.fileSystem.information(createSessionPaths(this.paths, id).events)) === undefined
          : await this.pointerMatches(id, current, observation);
    if (current && sameFingerprint(current.journal, fingerprint) && currentPointerMatches) {
      return { kind: 'current', session: current };
    }
    const source = await this.readSource(id);
    if (source === undefined) return { kind: 'repair', source: null };
    return { kind: 'repair', source, session: planIndexRebuild([source]).sessions[0] };
  }

  private applySessionInspection(inspection: SessionInspection): IndexedSession | undefined {
    if (inspection.kind === 'current') return inspection.session;
    if (inspection.source === null) {
      return undefined;
    }
    return this.applySource(inspection.source).session;
  }

  private async synchronizedSession(id: SessionId): Promise<IndexedSession | undefined> {
    const inspection = await this.inspectSession(id);
    if (inspection.kind === 'repair' && inspection.source === null) this.index.removeSession(id);
    return this.applySessionInspection(inspection);
  }

  async writeConfig(id: SessionId, value: unknown): Promise<void> {
    this.assertOpen();
    const document = serializeJsonDocument(value);
    await this.configWrite(
      id,
      async publishing =>
        await this.serial.run(id, async () => {
          await this.reviveIfArchived(id);
          await this.ensureSessionDirectory(id);
          // The write is inside the try: `writeTextAtomic` renames first and may throw afterwards (the chmod or
          // the directory fsync), so a failed write can still have replaced the stored config.
          try {
            publishing();
            await this.writeDocument(createSessionPaths(this.paths, id).config, document);
            await this.syncSessionUnlocked(id);
          } finally {
            this.configChanges += 1;
          }
        }),
    );
  }

  /**
   * A config write holds its current lineage's root gate for its entire publication, just like an archive commit.
   * A changed parent is retained AFTER releasing that gate: only one root is held at a time, so moving between
   * lineages cannot invert their lock order. A new parent archived in that window is restored by the same keep path.
   */
  private async configWrite<T>(id: SessionId, work: (publishing: () => void) => Promise<T>, rootMoves = 0): Promise<T> {
    const lineage = await this.ancestors(id);
    const root = lineage.at(-1) ?? id;
    let retain: SessionId | undefined;
    let committed = false;
    let publishing = false;
    const result = await this.lineages.run(root, async (): Promise<{ value: T } | { error: unknown } | undefined> => {
      // A writer ahead of us may have reparented this session while we waited. Release the obsolete gate and
      // queue on the current root before entering the document lane; never nest two lineage gates.
      if (((await this.ancestors(id)).at(-1) ?? id) !== root) return undefined;
      const previous = jsonObject(await this.readConfig(id, 'proved').catch(() => undefined))?.parent;
      let outcome: { value: T } | { error: unknown };
      try {
        const value = await work(() => {
          publishing = true;
        });
        committed = true;
        outcome = { value };
      } catch (error) {
        // Validation, directory/journal checks and transforms can refuse before the atomic write starts.
        // Preserve their original error: no publication needs proving or repairing in that case.
        if (!publishing) return { error };
        outcome = { error };
      }
      // A rejected conditional update published nothing and must not retain archived ancestors either.
      if (!publishing) return outcome;
      // Even a failed atomic write can have renamed its document already.
      try {
        const parent = jsonObject(await this.readConfig(id, 'proved'))?.parent;
        const parentId = typeof parent === 'string' ? tryParseSessionId(parent) : undefined;
        if (
          parentId !== undefined &&
          (parent !== previous || (await this.ancestors(parentId, true)).some(session => this.archived.has(session)))
        )
          retain = parentId;
      } catch (error) {
        outcome = {
          error: new Error(
            `session ${id} config write ${committed ? 'is already' : 'may already be'} committed; parent proof failed: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          ),
        };
      }
      return outcome;
    });
    if (result === undefined) {
      if (rootMoves >= 3) throw new Error(`session ${id} changed lineage repeatedly; retry the config write`);
      return await this.configWrite(id, work, rootMoves + 1);
    }
    if (retain !== undefined) {
      try {
        await this.retainSession(retain);
      } catch (error) {
        throw new Error(
          `session ${id} config write ${committed ? 'is already' : 'may already be'} committed; parent retention failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
    if ('error' in result) throw result.error;
    return result.value;
  }

  /**
   * How many session configs this storage has written — counted once each write has landed AND the session
   * index has published it (success or failure), so a reader that sees the count move and reads again sees
   * the new document and the session's membership. The count moving AFTER the index publication is what
   * lets a reader that read the stamp before a scan trust that scan: a write that was half-published while
   * the scan ran moves the stamp when it finishes, so the scan's result is discarded, never kept.
   *
   * A stamp for a reader that derives something from EVERY session's config (the fleet reading's session
   * roster): while it holds, nothing this daemon wrote changed a config. It cannot see an edit made outside
   * the daemon, so such a reader also re-reads on a time bound of its own.
   */
  configWrites(): number {
    return this.configChanges;
  }

  async writeState(id: SessionId, value: unknown): Promise<void> {
    this.assertOpen();
    const document = serializeJsonDocument(value);
    await this.serial.run(id, async () => {
      await this.reviveIfArchived(id);
      await this.ensureSessionDirectory(id);
      await this.writeDocument(createSessionPaths(this.paths, id).state, document);
      await this.syncSessionUnlocked(id);
      if (this.stateListeners.size > 0) this.publishState(id, canonicalJsonValue(value));
    });
  }

  /**
   * Runs `work` while no document of these sessions can be written: every write to a session's config or state goes
   * through its serial lane, and this holds the lanes of all of them at once. A write already queued lands first and
   * is seen by a `proved` read inside `work`; one that arrives after waits until `work` is done. It is how a decision
   * about whether a session is alive is committed without that answer changing underneath it. Reads take no lane, so
   * `work` may read these sessions freely, but it must not write them (it would wait on itself).
   */
  async holdSessions<T>(ids: readonly SessionId[], work: () => Promise<T>): Promise<T> {
    this.assertOpen();
    return await this.serial.runAcross(ids, work);
  }

  /** A document's text, from the identity cache when the file is still the one it holds. */
  private async readCachedText(
    path: string,
    freshness: DocumentFreshness = 'proved',
  ): Promise<CachedDocument | undefined> {
    const { identity, readTextIdentified } = this.fileSystem;
    if (identity === undefined || readTextIdentified === undefined) {
      const text = await this.fileSystem.readText(path);
      return text === undefined ? undefined : { identity: '', text };
    }
    const cached = this.documents.get(path);
    // A document a background reader asks for again is watched from now on — before its `stat`, so a change
    // between the two is caught by the `stat`, and any change after it is heard.
    const watch = cached !== undefined && freshness === 'heard' ? this.watch(path) : this.watched.get(path);
    const heard: Hearing | undefined =
      watch === undefined ? undefined : { watch: watch.generation, changes: watch.changes };
    const quiet = cached !== undefined && sameHearing(cached.heard, heard);
    if (quiet && freshness === 'heard' && watch?.subscription.live() === true) return cached;
    if (cached !== undefined && (await identity.call(this.fileSystem, path)) === cached.identity) {
      if (heard === undefined || sameHearing(cached.heard, heard)) return cached;
      const proved: CachedDocument = { ...cached, heard };
      this.retainDocument(path, proved);
      return proved;
    }
    const read = await readTextIdentified.call(this.fileSystem, path);
    if (read === undefined) {
      this.releaseDocument(path);
      return undefined;
    }
    if (this.documents.size >= this.documentBound(this.documents.size)) this.evictOldestDocuments();
    const fresh: CachedDocument = {
      identity: read.identity,
      text: read.text,
      ...(heard === undefined ? {} : { heard }),
    };
    this.retainDocument(path, fresh);
    return fresh;
  }

  /** The memory a cached document is estimated to hold: its entry, its text, and its value once it has one. */
  private costOfDocument(document: CachedDocument): number {
    const perChar = TEXT_BYTES_PER_CHAR + (document.value === undefined ? 0 : VALUE_BYTES_PER_CHAR);
    return DOCUMENT_ENTRY_BYTES + perChar * document.text.length;
  }

  /**
   * Caches `document` for `path` in place of what it held, as the newest entry, unless its text is over the
   * per-document cap — then `path` holds nothing, and its watch goes with it. Lets the oldest go once the total
   * passes the byte budget.
   */
  private retainDocument(path: string, document: CachedDocument): void {
    this.releaseDocument(path);
    if (document.text.length > this.budget.documentChars) {
      this.dropWatch(path);
      return;
    }
    this.documents.set(path, document);
    this.cachedBytes += this.costOfDocument(document);
    if (this.cachedBytes > this.budget.bytes) this.evictOldestDocuments();
  }

  /** Lets go of what is cached for `path` and takes its cost off the total. Its watch is the caller's to drop. */
  private releaseDocument(path: string): void {
    const held = this.documents.get(path);
    if (held === undefined) return;
    this.documents.delete(path);
    this.cachedBytes -= this.costOfDocument(held);
  }

  /**
   * The bound for a cache now holding `size` documents. The fleet is counted only when `size` has reached the
   * bound it last set, so a walk counts it once per growth of the fleet, never once per read.
   */
  private documentBound(size: number): number {
    if (size >= this.documentLimit) this.recountDocumentBound();
    return this.documentLimit;
  }

  /**
   * Lets the oldest of the cached documents go — a map iterates in the order its keys were first set — and
   * their watches with them, since a watch only exists to vouch for a cached document. A fleet that shrank
   * leaves the bound below the cache, so it lets go of enough to get back under it, not just an eighth.
   */
  private evictOldestDocuments(): void {
    let surplus =
      this.documents.size >= this.documentLimit
        ? Math.max(
            Math.ceil(this.documents.size / DOCUMENT_EVICTION_SHARE),
            this.documents.size - this.documentLimit + 1,
          )
        : 0;
    // Over the byte budget it lets go of the oldest eighth of the budget, for the same reason as the count: room
    // for the next documents without counting again on the next read.
    const bytesWanted =
      this.cachedBytes > this.budget.bytes
        ? this.budget.bytes - Math.ceil(this.budget.bytes / DOCUMENT_EVICTION_SHARE)
        : Infinity;
    for (const path of this.documents.keys()) {
      if (surplus <= 0 && this.cachedBytes <= bytesWanted) return;
      this.releaseDocument(path);
      this.dropWatch(path);
      surplus -= 1;
    }
  }

  /**
   * Closes the oldest watches until the bound has room for another eighth, once a shrinking fleet has left
   * it below the watches already open.
   *
   * WHY. Nothing but the documents' eviction ever closed a watch, and a cache that stays under a lowered bound
   * never evicts: the old watches stayed open for good, the bound counted them as full, and a new live session
   * could not be watched until restart. A watch is dropped together with its cached document: the document
   * remembers what its watch had heard, and without the watch nothing is hearing any.
   */
  private trimWatches(): void {
    if (this.watched.size <= this.documentLimit) return;
    let surplus = this.watched.size - this.documentLimit + Math.ceil(this.documentLimit / DOCUMENT_EVICTION_SHARE);
    for (const path of this.watched.keys()) {
      if (surplus === 0) return;
      this.releaseDocument(path);
      this.dropWatch(path);
      surplus -= 1;
    }
  }

  /**
   * Sets the cache and watch bound from the fleet that is live now, and lets go of the watches that no longer fit.
   * An archive pass shrinks the live set by hundreds at once; without this the bound stays at the old fleet's size.
   */
  private recountDocumentBound(): void {
    this.documentLimit = Math.max(
      DOCUMENT_CACHE_FLOOR,
      DOCUMENTS_PER_SESSION * (this.index.listSessions().length + this.archived.size),
    );
    this.trimWatches();
  }

  /** Stops watching `path`. */
  private dropWatch(path: string): void {
    const watched = this.watched.get(path);
    if (watched === undefined) return;
    watched.subscription.close();
    this.watched.delete(path);
  }

  /** This document's watch, opened now if there is room for it. */
  private watch(path: string): WatchedDocument | undefined {
    const known = this.watched.get(path);
    // The bound the cache last set, not a fresh count: a document is watched only once it is cached, so the
    // cache reaches the bound — and grows it with the fleet — first.
    if (known !== undefined || this.changes === undefined || this.watched.size >= this.documentLimit) return known;
    this.watchGeneration += 1;
    const watched: WatchedDocument = {
      generation: this.watchGeneration,
      changes: 0,
      subscription: this.changes.subscribe(path, () => {
        watched.changes += 1;
      }),
    };
    this.watched.set(path, watched);
    return watched;
  }

  /** Whether `path` names something: one `stat` where the filesystem offers it, the walked read otherwise. */
  private async presence(path: string): Promise<true | undefined> {
    const present =
      this.fileSystem.identity === undefined
        ? await this.fileSystem.information(path)
        : await this.fileSystem.identity(path);
    return present === undefined ? undefined : true;
  }

  /**
   * Writes a session document, forgetting what the cache holds for it before AND after.
   *
   * After, because a read running alongside may cache the old file between the first forget and the
   * rename, and its watch hears the rename only a settle later: counting this write as a change of its
   * own makes that copy's `heard` stale at once, so the next read `stat`s and sees the new file —
   * read-your-own-write, as it was before the watch.
   */
  private async writeDocument(path: string, text: string): Promise<void> {
    this.forgetDocument(path);
    try {
      await this.fileSystem.writeTextAtomic(path, text);
    } finally {
      this.forgetDocument(path);
    }
  }

  /** Forgets what the cache holds for `path`, and counts a change on its watch. */
  private forgetDocument(path: string): void {
    this.releaseDocument(path);
    const watched = this.watched.get(path);
    if (watched !== undefined) watched.changes += 1;
  }

  private async readDocument(
    id: SessionId,
    kind: 'config' | 'state',
    freshness: DocumentFreshness = 'proved',
  ): Promise<FrozenJsonValue | undefined> {
    const paths = createSessionPaths(this.paths, id);
    const marker = (await this.readCachedText(paths.marker, freshness))?.text;
    if (marker === undefined) {
      await this.refuseUnrecoverableUnmarkedSession(id);
      return undefined;
    }
    if (decideSessionMarker(marker) === 'refuse') throw new SessionLayoutError(id, marker);
    const file = paths[kind];
    const document = await this.readCachedText(file, freshness);
    if (document === undefined) return undefined;
    if (document.value !== undefined) return document.value;
    const parsed = parseJsonDocument(document.text);
    if (!parsed.ok) throw new InvalidStateDocumentError(file, parsed.message);
    const value = deepFreezeJson(parsed.value);
    if (document.identity !== '') this.retainDocument(file, { ...document, value });
    return value;
  }

  /** A session's configuration, proved on every read unless a background reader asks for `heard`. */
  async readConfig(id: SessionId, freshness: DocumentFreshness = 'proved'): Promise<FrozenJsonValue | undefined> {
    this.assertOpen();
    return await this.readDocument(id, 'config', freshness);
  }

  /** A session's state, proved on every read unless a whole-fleet reader asks for `heard`. */
  async readState(id: SessionId, freshness: DocumentFreshness = 'proved'): Promise<FrozenJsonValue | undefined> {
    this.assertOpen();
    return await this.readDocument(id, 'state', freshness);
  }

  /**
   * One locked read-modify-write of one session document.
   *
   * The read, the transform and the write all happen in the session's serial lane, so a writer queued
   * behind this one reads what it wrote and a writer queued ahead of it is what it reads — neither can
   * put back a copy the other has already replaced. A missing document is refused unless the caller
   * says how to `create` it.
   */
  private async updateDocument(
    id: SessionId,
    kind: 'config' | 'state',
    transform: (current: FrozenJsonValue) => unknown,
    create?: () => unknown,
    unlessArchived = false,
  ): Promise<JsonValue> {
    this.assertOpen();
    const write = async (publishing: () => void = () => {}): Promise<JsonValue> =>
      await this.serial.run(id, async () => {
        const paths = createSessionPaths(this.paths, id);
        const current = await this.readDocument(id, kind);
        const compute = current === undefined ? create : () => transform(current);
        if (compute === undefined) throw new InvalidStateDocumentError(paths[kind], 'file is missing');
        // Checked under the same lineage gate and session lane as archive publication: maintenance
        // never revives a session that left the live set while its caller was reading the transcript.
        if (unlessArchived && this.archived.has(id)) return canonicalJsonValue(current);
        // The journal contract is settled BEFORE the transform runs and before any byte is written,
        // so a session that has lost its journal keeps its documents exactly as they were and nothing is
        // even computed to write. The write paths get the same gate from their own ensureSessionDirectory call.
        await this.ensureSessionDirectory(id);
        const computed = await compute();
        // CAS losers and already-applied transforms have no publication or index/cache side effects.
        if (current !== undefined && computed === current) return canonicalJsonValue(current);
        await this.reviveIfArchived(id);
        const next = canonicalJsonValue(computed);
        // The write is inside the try for the same reason as `writeConfig`: a write that threw after its rename
        // has still changed the stored config.
        try {
          const document = serializeJsonDocument(next);
          publishing();
          await this.writeDocument(paths[kind], document);
          await this.syncSessionUnlocked(id);
        } finally {
          if (kind === 'config') this.configChanges += 1;
        }
        if (kind === 'state') this.publishState(id, next);
        return next;
      });
    return kind === 'config' ? await this.configWrite(id, write) : await write();
  }

  async updateConfig(
    id: SessionId,
    transform: (current: FrozenJsonValue) => unknown,
    options?: { readonly unlessArchived?: boolean },
  ): Promise<JsonValue> {
    return await this.updateDocument(id, 'config', transform, undefined, options?.unlessArchived);
  }

  async updateState(id: SessionId, transform: (current: FrozenJsonValue) => unknown): Promise<JsonValue> {
    return await this.updateDocument(id, 'state', transform);
  }

  /**
   * `updateConfig` for a document that may not exist yet: a missing one reaches the transform as
   * `undefined` and its answer is written all the same. Only for the writer that CREATES the
   * document — every other writer keeps `updateConfig`, which refuses to bring one back from nothing.
   */
  async upsertConfig(id: SessionId, transform: (current: FrozenJsonValue | undefined) => unknown): Promise<JsonValue> {
    return await this.updateDocument(id, 'config', transform, () => transform(undefined));
  }

  /** `upsertConfig`, for the state document. */
  async upsertState(id: SessionId, transform: (current: FrozenJsonValue | undefined) => unknown): Promise<JsonValue> {
    return await this.updateDocument(id, 'state', transform, () => transform(undefined));
  }

  async append(id: SessionId, type: string, data: unknown): Promise<SessionEvent> {
    this.assertOpen();
    const validated = createSessionEvent(id, 0, this.clock.now(), type, data);
    return await this.serial.run(id, async () => {
      await this.reviveIfArchived(id);
      const inspection = await this.inspectSession(id);
      const event = createSessionEvent(
        id,
        inspection.session?.lastSequence ?? 0,
        validated.time,
        validated.type,
        validated.data,
      );
      const encoded = encodeSessionEvent(event);
      const paths = createSessionPaths(this.paths, id);
      const ensured = await this.ensureSessionDirectory(id);
      if (inspection.kind === 'repair' && inspection.source === null) this.index.removeSession(id);
      const current = this.applySessionInspection(inspection);
      const outcome = await this.fileSystem.appendLineToExisting(paths.events, encoded, current?.journal ?? ensured);
      // Both refusals are terminal on purpose. Retrying would mean deciding, without evidence,
      // which of two files is the real journal — and getting that wrong writes history into an
      // impostor and reports success.
      if (outcome.kind === 'absent') throw new MissingSessionJournalError(id, paths.events);
      if (outcome.kind === 'replaced') throw new JournalReplacedError(id, paths.events);
      const appended = outcome.append;
      const insertedSeparator =
        current?.journal !== null && current?.journal !== undefined && appended.byteOffset === current.journal.size + 1;
      const session: IndexedSession = {
        id,
        status: current?.status,
        createdAt: current?.createdAt,
        updatedAt: current?.updatedAt,
        lastSequence: event.sequence,
        journalLine: (current?.journalLine ?? 1) + (insertedSeparator ? 2 : 1),
        journal: appended.fingerprint,
      };
      const pointer: EventPointer = {
        sessionId: id,
        sequence: event.sequence,
        time: event.time,
        type: event.type,
        byteOffset: appended.byteOffset,
        byteLength: appended.byteLength,
      };
      try {
        this.index.appendEvent(session, pointer);
      } catch (error) {
        try {
          await this.syncSessionUnlocked(id);
        } catch {
          throw new DurableEventIndexError(id, { cause: error });
        }
      }
      // Publication happens only after both durable bytes and their disposable index pointer agree.
      // A listener cannot make the journal mutation fail: sockets are observers, never part of the
      // commit, and one broken peer must not prevent every other subsystem from recording history.
      for (const listener of this.eventListeners) {
        try {
          listener(event);
        } catch {}
      }
      return event;
    });
  }

  /**
   * Prove that this daemon's own durable journal remains available for a transcript digest.
   *
   * A transcript by itself is not enough to restart a session: the daemon's marker is the durable
   * witness that this state directory owes a journal.  In particular, a version-2 marker with no
   * `events.jsonl` is lost coordination history, never an empty session that may be restarted.
   */
  async assertJournalReadable(id: SessionId): Promise<void> {
    this.assertOpen();
    await this.serial.run(id, async () => {
      const paths = createSessionPaths(this.paths, id);
      const marker = await this.fileSystem.readText(paths.marker);
      const journal = await this.fileSystem.information(paths.events);
      this.assertExpectedJournal(id, marker, this.index.findSession(id), journal !== undefined);
      if (!sessionJournalRequired(marker)) throw new MissingSessionJournalError(id, paths.events);
    });
  }

  /** Subscribe to this daemon instance's successful durable appends. */
  subscribeEvents(listener: (event: SessionEvent) => void): () => void {
    this.assertOpen();
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Tells every state listener what was just written. A listener cannot make the write fail. */
  private publishState(id: SessionId, state: JsonValue): void {
    for (const listener of this.stateListeners) {
      try {
        listener(id, state);
      } catch {}
    }
  }

  /**
   * Subscribe to every state document this opened storage writes, with the value written. The value is
   * shared with the writer and the other listeners: read it, never change it.
   */
  subscribeStates(listener: (id: SessionId, state: JsonValue) => void): () => void {
    this.assertOpen();
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private async resolvePointers(
    id: SessionId,
    pointers: readonly EventPointer[],
  ): Promise<readonly SessionEvent[] | undefined> {
    const file = createSessionPaths(this.paths, id).events;
    const events: SessionEvent[] = [];
    for (const pointer of pointers) {
      const bytes = await this.fileSystem.readSlice(file, pointer.byteOffset, pointer.byteLength);
      if (bytes === undefined) return undefined;
      let decoded: unknown;
      try {
        decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        return undefined;
      }
      const event = parseSessionEvent(decoded, id);
      if (
        event === undefined ||
        event.sequence !== pointer.sequence ||
        event.time !== pointer.time ||
        event.type !== pointer.type
      ) {
        return undefined;
      }
      events.push(event);
    }
    return events;
  }

  async replay(id: SessionId, afterSequence = 0, limit = 1000): Promise<ReplayPage> {
    this.assertOpen();
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new Error('afterSequence must be a non-negative integer');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new Error('limit must be an integer between 1 and 10000');
    }
    return await this.serial.run(id, async () => {
      if (this.archived.has(id)) return await this.replayArchived(id, afterSequence, limit);
      await this.synchronizedSession(id);
      let pointers = this.index.eventPointers(id, afterSequence, limit + 1);
      let selected = pointers.slice(0, limit);
      let events = await this.resolvePointers(id, selected);
      if (events === undefined) {
        await this.syncSessionUnlocked(id);
        pointers = this.index.eventPointers(id, afterSequence, limit + 1);
        selected = pointers.slice(0, limit);
        events = await this.resolvePointers(id, selected);
      }
      if (events === undefined) throw new Error(`event index for ${id} is inconsistent after re-indexing`);
      const last = selected.at(-1);
      return {
        events,
        rows: selected.length,
        afterSequence,
        nextSequence: last?.sequence,
        hasMore: pointers.length > limit,
      };
    });
  }

  private async resolveFleetPointers(pointers: readonly EventPointer[]): Promise<readonly SessionEvent[] | undefined> {
    const bySession = new Map<SessionId, EventPointer[]>();
    for (const pointer of pointers) {
      const group = bySession.get(pointer.sessionId) ?? [];
      group.push(pointer);
      bySession.set(pointer.sessionId, group);
    }
    const events = new Map<string, SessionEvent>();
    for (const [id, group] of bySession) {
      const resolved = await this.resolvePointers(id, group);
      if (resolved === undefined) return undefined;
      for (const event of resolved) events.set(`${event.sessionId}\n${event.sequence}`, event);
    }
    const ordered = pointers.map(pointer => events.get(`${pointer.sessionId}\n${pointer.sequence}`));
    return ordered.every((event): event is SessionEvent => event !== undefined) ? ordered : undefined;
  }

  /** Reconcile the disposable session index against every readable durable directory. */
  private async synchronizeFleetSessionsUnlocked(): Promise<readonly SessionId[]> {
    const surveyed = await this.surveySessionDirectories();
    const evidenceById = new Map(surveyed.map(entry => [entry.id, entry]));
    for (const session of this.index.listSessions()) {
      if (!evidenceById.has(session.id))
        throw new Error(`session ${session.id} is indexed but has no readable durable directory evidence`);
    }
    // Survey both directions. Rebuilding only sessions SQLite already remembers would accept a
    // wholly lost index as an honestly empty fleet. Every readable durable directory is therefore
    // synchronized into the disposable index before its id is claimed by an idle proof or tail.
    for (const evidence of surveyed) {
      if (evidence.journalLost)
        throw new MissingSessionJournalError(evidence.id, createSessionPaths(this.paths, evidence.id).events);
      const synchronized = await this.synchronizedSession(evidence.id);
      if (synchronized === undefined)
        throw new Error(`session ${evidence.id} has durable directory evidence but could not be indexed`);
    }
    const indexed = this.index.listSessions();
    if (indexed.length !== surveyed.length)
      throw new Error('the fleet index does not exactly match its durable session directories');
    return indexed.map(session => session.id);
  }

  /**
   * The bounded recent fleet tail.
   *
   * Pointer selection is global and bounded in SQLite. Journal bytes are then proved against those
   * pointers; one mismatch triggers a re-index of only the sessions represented in the tail, and a
   * second mismatch refuses rather than reporting a shorter, falsely healthy fleet.
   */
  async tailEvents(limit = 5_000): Promise<readonly SessionEvent[]> {
    this.assertOpen();
    assertFleetTailLimit(limit);
    return await this.serial.runExclusive(
      async () => await this.tailEventsUnlocked(await this.synchronizeFleetSessionsUnlocked(), limit),
    );
  }

  private async tailEventsUnlocked(sessionIds: readonly SessionId[], limit: number): Promise<readonly SessionEvent[]> {
    // A tail query cannot prove that rows are complete merely by resolving the rows SQLite did
    // return: a damaged disposable index may omit every pointer and make a non-empty fleet look
    // empty. Reconcile each indexed journal first, then require the contiguous event-count
    // invariant the append path establishes before selecting the bounded global tail.
    for (const id of sessionIds) {
      const synchronized = this.index.findSession(id);
      if (synchronized === undefined || this.index.countEvents(id) !== synchronized.lastSequence)
        throw new Error(`event index for ${id} does not completely represent its durable journal`);
    }
    let pointers = this.index.fleetEventPointers(limit);
    let events = await this.resolveFleetPointers(pointers);
    if (events !== undefined) return events;
    for (const id of new Set(pointers.map(pointer => pointer.sessionId))) await this.syncSessionUnlocked(id);
    pointers = this.index.fleetEventPointers(limit);
    events = await this.resolveFleetPointers(pointers);
    if (events === undefined) throw new Error('fleet event index is inconsistent after re-indexing');
    return events;
  }

  /**
   * The sessions whose journals a fleet idle proof claims to be following.
   *
   * An indexed session missing from the on-disk survey, or one whose owed journal vanished, makes
   * the whole answer unavailable. Counting only the readable survivors would turn damaged state into
   * a smaller, apparently healthy fleet.
   */
  async fleetSessionIds(): Promise<readonly SessionId[]> {
    this.assertOpen();
    return await this.serial.runExclusive(async () => await this.synchronizeFleetSessionsUnlocked());
  }

  /**
   * A live feed's whole backlog — every session and the bounded tail — proved in ONE pass.
   *
   * It is {@link fleetSessionIds} and {@link tailEvents} under one survey instead of two, and it YIELDS
   * to session writes while it waits (`runExclusiveYielding`): a feed reconnect must never make a
   * launch, a resume or a signal wait for a pass that has not started. `claim` is asked once the pass
   * holds the lock; answering false skips the survey entirely, which is how a pass whose every reader
   * has already gone costs nothing. A limit of `0` proves the sessions and reads no tail.
   */
  async fleetBacklog(
    limit: number,
    claim: () => boolean,
  ): Promise<{ readonly sessionIds: readonly SessionId[]; readonly events: readonly SessionEvent[] } | undefined> {
    this.assertOpen();
    if (limit !== 0) assertFleetTailLimit(limit);
    return await this.serial.runExclusiveYielding(async () => {
      if (!claim()) return undefined;
      const sessionIds = await this.synchronizeFleetSessionsUnlocked();
      return { sessionIds, events: limit === 0 ? [] : await this.tailEventsUnlocked(sessionIds, limit) };
    });
  }

  /** A live session's index row, or the one an archived session had when it left: both are sessions that exist. */
  findSession(id: SessionId): IndexedSession | undefined {
    this.assertOpen();
    return this.index.findSession(id) ?? this.archived.get(id)?.indexed;
  }

  listSessions(): readonly IndexedSession[] {
    this.assertOpen();
    return this.index.listSessions();
  }

  async repairSessionPermissions(): Promise<void> {
    this.assertOpen();
    await this.serial.runExclusive(async () => {
      const entries = await this.fileSystem.listDirectory(this.paths.sessions);
      for (const entry of entries) {
        if (!entry.directory) continue;
        const id = tryParseSessionId(entry.name);
        if (id === undefined) continue;
        if (this.archived.has(id)) continue;
        const paths = createSessionPaths(this.paths, id);
        await this.fileSystem.setMode(paths.directory, 0o700);
        for (const file of [paths.marker, paths.config, paths.state, paths.events]) {
          if ((await this.fileSystem.information(file)) !== undefined) await this.fileSystem.setMode(file, 0o600);
        }
      }
    });
  }

  /**
   * The readable session directories and, for each, whether its journal has vanished.
   *
   * One marker read and three metadata probes per directory; no document or journal bytes are read
   * and nothing is reconciled, so a health tick can afford this on every pass. A reservation with no
   * config, state, or event is deliberately absent: it is storage for an in-flight create, not a
   * published session. Loss is otherwise decided exactly as the read paths decide it — current
   * marker OR a surviving index witness — so an unmigrated legacy session is not silently healthy.
   */
  async surveySessionDirectories(): Promise<readonly SessionDirectorySurvey[]> {
    this.assertOpen();
    const entries = await this.fileSystem.listDirectory(this.paths.sessions);
    const survey: SessionDirectorySurvey[] = [];
    for (const entry of entries) {
      if (!entry.directory) continue;
      const id = tryParseSessionId(entry.name);
      if (id === undefined) continue;
      if (this.archived.has(id)) continue;
      const paths = createSessionPaths(this.paths, id);
      // Only PRESENCE is asked of the two documents here, so where the filesystem can answer it with one
      // `stat` it does; every read of their bytes still walks the home. The reaper surveys every session
      // twice a sweep, which made this the costliest loop on a large, mostly finished fleet.
      const [marker, config, state, journalPresent] = await Promise.all([
        this.readCachedText(paths.marker).then(document => document?.text),
        this.presence(paths.config),
        this.presence(paths.state),
        this.presence(paths.events),
      ]);
      if (decideSessionMarker(marker) === 'refuse') continue;
      // The journal's SIZE matters only to tell a bare reservation — no documents, an empty journal —
      // from a session, so it is read only for a directory that has neither document.
      if (
        config === undefined &&
        state === undefined &&
        journalPresent !== undefined &&
        isOnlySessionReservation({
          journal: { fingerprint: (await this.fileSystem.information(paths.events)) ?? { size: -1 } },
        })
      )
        continue;
      const indexed = this.index.findSession(id);
      const owesJournal = sessionJournalRequired(marker) || (indexed !== undefined && indexed.journal !== null);
      const journalLost = owesJournal && journalPresent === undefined;
      survey.push({ id, journalLost });
    }
    return survey.sort((left, right) => left.id.localeCompare(right.id));
  }

  async sessionIdsOnDisk(): Promise<readonly SessionId[]> {
    return (await this.surveySessionDirectories()).map(session => session.id);
  }

  forgetFromIndex(id: SessionId): void {
    this.assertOpen();
    this.index.removeSession(id);
  }

  // ---------------------------------------------------------------------------------------------------
  // The archive (docs/session-archive.md)
  // ---------------------------------------------------------------------------------------------------

  /**
   * Reads the archive registry and takes its sessions out of the index. Called once, at open, before anything
   * walks the sessions directory. A damaged or absent registry is an empty one: every session is live again, which
   * is the safe direction, and the next archive pass writes a good document.
   */
  async loadArchive(): Promise<number> {
    this.assertOpen();
    const parsed = parseArchiveRegistry(await this.fileSystem.readText(this.paths.archivedSessions));
    this.archived = parsed ?? new Map();
    // An archive that crashed between the registry write and the index removal leaves rows behind.
    for (const id of this.archived.keys()) if (this.index.findSession(id) !== undefined) this.index.removeSession(id);
    this.recountDocumentBound();
    return this.archived.size;
  }

  /** The memory the identity cache is estimated to hold now, in bytes: never above its budget (a gauge, and a test's proof). */
  cachedDocumentBytes(): number {
    return this.cachedBytes;
  }

  /** How many sessions have left the live set. */
  archivedCount(): number {
    return this.archived.size;
  }

  /** The archived sessions, oldest archived first, as they were indexed when they left. */
  listArchivedSessions(): readonly (IndexedSession & {
    readonly archivedAt: string;
    readonly name?: string;
    readonly configTimes?: { readonly createdAt: string; readonly updatedAt: string };
  })[] {
    return [...this.archived.values()]
      .map(entry => ({
        ...entry.indexed,
        archivedAt: entry.archivedAt,
        ...(entry.name === undefined ? {} : { name: entry.name }),
        ...(entry.configTimes === undefined ? {} : { configTimes: entry.configTimes }),
      }))
      .sort((left, right) => left.archivedAt.localeCompare(right.archivedAt) || left.id.localeCompare(right.id));
  }

  isArchived(id: SessionId): boolean {
    return this.archived.has(id);
  }

  /**
   * One change to the archive registry, as a READ-MODIFY-WRITE inside the registry's own queue.
   *
   * `change` is handed the registry as it is WHEN THIS TURN COMES, not as it was when the caller decided to change it,
   * and answers the map to keep (or `undefined` for no change). The new map is written durably and only then
   * published in memory, all inside the turn. Deriving the map before queueing would let two writers on different
   * session lanes each clone the same registry and the later write lose the earlier one — a revived session archived
   * again, or an archived one let back by an unrelated pass.
   */
  private async changeRegistry(
    change: (
      current: ReadonlyMap<SessionId, ArchivedSession>,
    ) =>
      | ReadonlyMap<SessionId, ArchivedSession>
      | undefined
      | Promise<ReadonlyMap<SessionId, ArchivedSession> | undefined>,
    published?: () => Promise<void> | void,
    valid: () => boolean = () => true,
  ): Promise<void> {
    await this.registryTurn(async () => {
      if (!valid()) return;
      const next = await change(this.archived);
      if (next === undefined) return;
      await this.fileSystem.writeTextAtomic(this.paths.archivedSessions, serializeArchiveRegistry(next));
      if (!valid()) {
        // A keep landed while the rename/fsync was pending. Restore the durable registry before publishing anything.
        await this.fileSystem.writeTextAtomic(this.paths.archivedSessions, serializeArchiveRegistry(this.archived));
        return;
      }
      this.archived = next;
      await published?.();
    });
  }

  /** Shared publication lane: an index sweep must not erase a row rebuilt before registry removal.
   * Document barriers are acquired before this lane; retention never takes document lanes here.
   */
  private async indexSweep<T>(work: () => Promise<T>): Promise<T> {
    return await this.serial.runExclusive(() => this.registryTurn(work));
  }

  private async registryTurn<T>(work: () => Promise<T>): Promise<T> {
    const turn = this.registryWrites.then(work);
    this.registryWrites = turn.then(
      () => undefined,
      () => undefined,
    );
    return await turn;
  }

  /**
   * Takes sessions out of the live set, but only those `verify` still vouches for.
   *
   * HELD, THEN CHECKED: the sessions' lanes are held, so a revive or a write that was already queued has landed and
   * none can start until this is done, and `verify` re-reads each session as it is NOW. The registry is written FIRST
   * and durably; the index rows go after it, so a crash between them leaves rows `loadArchive` removes at the next
   * open and never a session that is in neither place. Nothing on disk moves.
   */
  async archiveSessions(
    ids: readonly SessionId[],
    verify: (id: SessionId) => Promise<ArchiveVerdict | undefined>,
  ): Promise<readonly SessionId[]> {
    this.assertOpen();
    return await this.archiveAtCurrentRoots(ids, verify, 0);
  }

  private async archiveAtCurrentRoots(
    ids: readonly SessionId[],
    verify: (id: SessionId) => Promise<ArchiveVerdict | undefined>,
    rootMoves: number,
  ): Promise<readonly SessionId[]> {
    const roots = await Promise.all(ids.map(async id => (await this.ancestors(id)).at(-1) ?? id));
    const result = await this.lineages.runAcross(roots, async () => {
      const currentRoots = await Promise.all(ids.map(async id => (await this.ancestors(id)).at(-1) ?? id));
      if (currentRoots.some((root, at) => root !== roots[at])) return undefined;
      return await this.holdSessions(ids, async () => {
        const retention = this.retentionChanges;
        const entries = new Map<SessionId, ArchivedSession>();
        const archivedAt = this.clock.now();
        for (const id of ids) {
          const indexed = this.index.findSession(id);
          if (indexed === undefined || this.archived.has(id)) continue;
          const verdict = await verify(id);
          if (verdict === undefined) continue;
          entries.set(id, {
            archivedAt,
            ...(verdict.name === undefined ? {} : { name: verdict.name }),
            ...(verdict.configTimes === undefined ? {} : { configTimes: verdict.configTimes }),
            indexed,
          });
        }
        if (entries.size === 0) return [];
        // The delta joins the registry as it is when this turn comes: another session's revival may have landed meanwhile.
        const left: SessionId[] = [];
        await this.changeRegistry(
          current => new Map([...current, ...entries]),
          () => {
            left.push(...entries.keys());
            for (const id of left) {
              this.index.removeSession(id);
              const paths = createSessionPaths(this.paths, id);
              for (const file of [paths.marker, paths.config, paths.state]) {
                this.forgetDocument(file);
                // A watch only vouches for a cached document; the archived session's documents are no longer cached.
                this.dropWatch(file);
              }
            }
            this.recountDocumentBound();
          },
          () => this.retentionChanges === retention,
        );
        return left;
      });
    });
    // Like a config writer, a commit queued behind a reparent must release the obsolete gates before retrying.
    if (result !== undefined) return result;
    if (rootMoves >= 3) throw new Error('session archive lineage changed repeatedly; retry on the next pass');
    return await this.archiveAtCurrentRoots(ids, verify, rootMoves + 1);
  }

  /** The lineage as stored now, including the named session; loops settle on a stable root key. */
  private async ancestors(id: SessionId, strict = false): Promise<readonly SessionId[]> {
    const seen = new Set<SessionId>();
    let current: SessionId | undefined = id;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const config: ReturnType<typeof jsonObject> = jsonObject(
        await this.readConfig(current, 'proved').catch(error => {
          // Root discovery tolerates a reserved session with no config; retention must prove the whole chain.
          if (strict) throw error;
          return undefined;
        }),
      );
      current = typeof config?.parent === 'string' ? tryParseSessionId(config.parent) : undefined;
    }
    const chain = [...seen];
    if (current !== undefined) chain.push(chain.slice(chain.indexOf(current)).sort()[0] ?? current);
    return chain;
  }

  /**
   * A published pin, card or agenda item restores live membership, including its ancestors. Registry ordering makes
   * this safe during an archive commit without taking document lanes (a board writer may already hold those lanes).
   * Rebuild the journal index too: removing just the registry entry would leave the session absent from the live list.
   */
  async retainSession(id: SessionId): Promise<void> {
    this.assertOpen();
    this.retentionChanges += 1;
    const lineage = await this.ancestors(id, true);
    await this.changeRegistry(async current => {
      const restore = lineage.filter(session => current.has(session) || this.index.findSession(session) === undefined);
      if (restore.length === 0) return undefined;
      // Publish live rows before forgetting archive membership. A failed rebuild leaves every archived entry
      // available for retry; also repair a missing live row even when no registry entry remains.
      for (const session of restore) {
        await this.syncSessionUnlocked(session);
        if (current.has(session) && this.index.findSession(session) === undefined)
          throw new Error(`session ${session} could not be restored to the live index; archive membership retained`);
      }
      const next = new Map(current);
      for (const session of lineage) next.delete(session);
      return next;
    });
  }

  /** Retain the lead before a child's first write; config publication owns the root gate and retains a new parent too. */
  async publishChild<T>(parent: SessionId, work: () => Promise<T>): Promise<T> {
    await this.retainSession(parent);
    return await work();
  }

  /**
   * Brings an archived session back into the live set. Called with the session's lane held, as the first step of every
   * write to it; the write that follows indexes it. A read never calls this.
   */
  private async reviveIfArchived(id: SessionId): Promise<void> {
    if (!this.archived.has(id)) return;
    await this.retainSession(id);
  }

  /** An archived session's events, read straight from its journal: its index rows were let go when it left. */
  private async replayArchived(id: SessionId, afterSequence: number, limit: number): Promise<ReplayPage> {
    const source = await this.readSource(id);
    if (source === undefined) throw new Error(`archived session ${id} has no readable journal`);
    const pointers = planIndexRebuild([source]).events.filter(pointer => pointer.sequence > afterSequence);
    const selected = pointers.slice(0, limit);
    const events = await this.resolvePointers(id, selected);
    if (events === undefined) throw new Error(`journal of archived session ${id} is inconsistent`);
    return {
      events,
      rows: selected.length,
      afterSequence,
      nextSequence: selected.at(-1)?.sequence,
      hasMore: pointers.length > limit,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.eventListeners.clear();
    this.stateListeners.clear();
    for (const watched of this.watched.values()) watched.subscription.close();
    this.watched.clear();
    await this.serial.runExclusive(async () => {
      try {
        await this.index.close();
      } finally {
        await this.homeLock.release();
      }
    });
  }
}
