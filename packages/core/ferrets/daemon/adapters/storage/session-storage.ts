import type { Log, StateFileDef, StatePort } from '@ferretry/kernel/contract';
import {
  canonicalJsonValue,
  deepFreezeJson,
  type FrozenJsonValue,
  type JsonValue,
  jsonObject,
  serializeJsonDocument,
} from '@ferretry/std';
import {
  ArchiveFile,
  FerretHistoryFiles,
  FerretIndexFile,
  FerretConfigFile,
  FerretStateFile,
} from '../../../contract/index.ts';
import type { ClockPort, SessionIndex, YieldingSerialExecutor } from '../../lib/ports.ts';
import type { ArchivedSession } from '../../lib/session/archive/registry.ts';
import { type SessionId, tryParseSessionId } from '../../lib/session-id.ts';
import { archiveRegistryValue, parseArchiveRegistryValue } from '../../lib/storage/archive-registry.ts';
import {
  createSessionEvent,
  encodeSessionEvent,
  type JournalLine,
  journalFingerprint,
  parseSessionEvent,
  scanJournal,
} from '../../lib/storage/journal.ts';
import { planIndexRebuild, type DocumentSource, type SessionSource } from '../../lib/storage/rebuild.ts';
import { planReconciliation } from '../../lib/storage/reconciliation.ts';
import type {
  EventPointer,
  IndexedSession,
  JournalFingerprint,
  JournalProblem,
  RebuildResult,
  ReplayPage,
  SessionEvent,
} from '../../lib/storage-types.ts';
import { KeyedSerialExecutor } from './keyed-serial-executor.ts';
import { ListedSessionIndex } from './listed-session-index.ts';
import { StateSqliteIndex } from './sqlite-index.ts';

/**
 * THE SESSION STORE, ON FERRETS' STATE PORT.
 *
 * Today's `DaemonStorage`, with the same public surface, moved off the confined filesystem onto the kernel's
 * `StatePort` (§9.2). A session is three declared files under `state/ferrets/<session>/`: `config.json` and
 * `state.json` (the contract's `FerretStateFile`) and the journal `history.jsonl` (the contract's `FerretHistoryFiles`). The index is
 * the contract's `FerretIndexFile` and the archive registry its `ArchiveFile`.
 *
 * WHAT WENT WITH THE FILESYSTEM. The session-version marker and every path that upgraded or refused an older
 * layout; the home lock (the kernel owns `state/ferrets/`); permission repair (the kernel sets each declared file's
 * mode); the document identity cache and its watches (the state port proves every read); journal byte offsets and
 * file fingerprints (the state port reads a JSONL file line by line — positions are now counted in lines, see
 * `lib/storage/journal.ts`).
 *
 * WHAT STAYED. The session lanes: a document write, its index sync and its state publication are one turn of the
 * session's lane, `holdSessions` holds several lanes at once, and the index sweeps hold all of them. The state
 * port's per-file chain serializes one file; these lanes order work across a session's three files, its index rows
 * and the archive registry, and a transform may be asynchronous (the exit observer's compare-and-set reads the pane
 * registration inside it), which `StatePort.update`'s synchronous function cannot host.
 */

export class InvalidStateDocumentError extends Error {
  constructor(
    readonly file: string,
    readonly reason: string,
  ) {
    super(`invalid JSON document ${file}: ${reason}`);
    this.name = 'InvalidStateDocumentError';
  }
}

export class MissingSessionJournalError extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly file: string,
  ) {
    super(`session ${sessionId} has lost its durable journal ${file}; refusing to treat it as empty`);
    this.name = 'MissingSessionJournalError';
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

/** One session as a health tick sees it: cheap to obtain, enough to spot lost history. */
export interface SessionDirectorySurvey {
  readonly id: SessionId;
  /**
   * True when the journal is gone from a session that owes one: the index witnesses a journal the session used to
   * have, and the state folder no longer holds it.
   */
  readonly journalLost: boolean;
}

type SessionInspection =
  | { readonly kind: 'current'; readonly session?: IndexedSession }
  | { readonly kind: 'repair'; readonly source: SessionSource | null; readonly session?: IndexedSession };

/** A session's journal as read: its lines, and whether the read reached the end of the file. */
interface JournalRead {
  readonly lines: readonly JournalLine[];
  readonly complete: boolean;
}

/** A session's three files as read in one pass. */
interface SessionRead {
  readonly source: SessionSource | undefined;
  readonly journal: JournalRead;
}

/** Which sessions hold which files, from the state port's listings. */
interface SessionNames {
  readonly all: readonly string[];
  readonly configs: ReadonlySet<string>;
  readonly states: ReadonlySet<string>;
  readonly histories: ReadonlySet<string>;
}

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

/** Where a collection file of `id` lives, for messages: the declared path with its `*` filled. */
function fileOf(file: StateFileDef, id: SessionId): string {
  return file.path.replace('*', id);
}

/**
 * How fresh a read must be. Kept so every caller is unchanged; the state port proves every read, so both answer the
 * file as it is now.
 */
export type DocumentFreshness = 'proved' | 'heard';

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

/** Opens the session store: the archive first, so every walk after it already knows which sessions have left. */
export async function openDaemonStorage(state: StatePort, clock: ClockPort, log: Log): Promise<DaemonStorage> {
  const storage = new DaemonStorage(state, clock, log);
  try {
    await storage.loadArchive();
    return storage;
  } catch (error) {
    await storage.close();
    throw error;
  }
}

export class DaemonStorage {
  private closed = false;
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
   * The sessions that have left the live set, by id (docs/session-archive.md). Their files are untouched, and the
   * index holds no row for them: every walk of the index, the sessions or the survey passes them by, which is
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
    private readonly state: StatePort,
    private readonly clock: ClockPort,
    private readonly log: Log,
    private readonly index: SessionIndex = new ListedSessionIndex(new StateSqliteIndex(state.sqlite(FerretIndexFile))),
    private readonly serial: YieldingSerialExecutor = new KeyedSerialExecutor(),
  ) {}

  private assertOpen(): void {
    if (this.closed) throw new Error('daemon storage is closed');
  }

  /**
   * Refuses to read a session whose journal has vanished.
   *
   * The index is the witness: a session it recorded a journal for, whose journal the state folder no longer holds,
   * has lost its history — never an empty session.
   */
  private assertExpectedJournal(id: SessionId, indexed: IndexedSession | undefined, present: boolean): void {
    if (present) return;
    if (indexed !== undefined && indexed.journal !== null) {
      throw new MissingSessionJournalError(id, fileOf(FerretHistoryFiles, id));
    }
  }

  /** Whether the session's journal has at least one line (the state port cannot tell an empty journal from none). */
  private async journalPresent(id: SessionId): Promise<boolean> {
    try {
      for await (const _ of this.state.lines(FerretHistoryFiles, id)) return true;
    } catch {
      return true;
    }
    return false;
  }

  /**
   * Settles the journal contract BEFORE a write: a session that has lost its journal keeps its documents exactly as
   * they were, and nothing is even computed to write.
   */
  private async assertJournalKept(id: SessionId): Promise<void> {
    const indexed = this.index.findSession(id);
    if (indexed === undefined || indexed.journal === null) return;
    if (!(await this.journalPresent(id))) throw new MissingSessionJournalError(id, fileOf(FerretHistoryFiles, id));
  }

  /**
   * Kept for the lifecycle's reservation step. The state port has no directory to reserve: a session exists once
   * its first document or event lands, and each of those is one atomic write of a declared file. So this only
   * waits its turn in the session's lane, which orders it after any write already queued.
   */
  async reserveSessionDirectory(id: SessionId): Promise<void> {
    this.assertOpen();
    await this.serial.run(id, async () => {});
  }

  private async readJournal(id: SessionId): Promise<JournalRead> {
    const lines: JournalLine[] = [];
    try {
      for await (const value of this.state.lines(FerretHistoryFiles, id)) lines.push({ value });
      return { lines, complete: true };
    } catch (error) {
      lines.push({
        damaged: `event record could not be read: ${error instanceof Error ? error.message : String(error)}`,
      });
      return { lines, complete: false };
    }
  }

  private async readDocumentSource(
    file: typeof FerretConfigFile | typeof FerretStateFile,
    id: SessionId,
  ): Promise<DocumentSource | undefined> {
    const read =
      file === FerretConfigFile
        ? await this.state.read(FerretConfigFile, id)
        : await this.state.read(FerretStateFile, id);
    if (!read.ok) return { file: fileOf(file, id), problem: read.error.sentence };
    if (read.value === undefined) return undefined;
    return { file: fileOf(file, id), value: canonicalJsonValue(read.value) };
  }

  private async readSession(id: SessionId): Promise<SessionRead> {
    const [config, state, journal] = await Promise.all([
      this.readDocumentSource(FerretConfigFile, id),
      this.readDocumentSource(FerretStateFile, id),
      this.readJournal(id),
    ]);
    if (config === undefined && state === undefined && journal.lines.length === 0)
      return { source: undefined, journal };
    const file = fileOf(FerretHistoryFiles, id);
    const scan = scanJournal(journal.lines, { file, sessionId: id });
    const fingerprint = journalFingerprint(journal.lines.length);
    return {
      source: {
        id,
        config,
        state,
        journal: fingerprint === null ? undefined : { file, scan, fingerprint },
      },
      journal,
    };
  }

  private async readSource(id: SessionId): Promise<SessionSource | undefined> {
    return (await this.readSession(id)).source;
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
    this.assertExpectedJournal(id, this.index.findSession(id), source.journal !== undefined);
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

  /** Every session the state folder holds a file for, and which files each holds. */
  private async sessionNames(): Promise<SessionNames> {
    const [configs, states, histories] = await Promise.all([
      this.state.list(FerretConfigFile),
      this.state.list(FerretStateFile),
      this.state.list(FerretHistoryFiles),
    ]);
    return {
      all: [...new Set([...configs, ...states, ...histories])].sort((left, right) => left.localeCompare(right)),
      configs: new Set(configs),
      states: new Set(states),
      histories: new Set(histories),
    };
  }

  private async collectSources(): Promise<SourceCollection> {
    const names = await this.sessionNames();
    const sources: SessionSource[] = [];
    const problems: JournalProblem[] = [];
    const failedSessionIds: string[] = [];
    const lostJournalSessionIds: string[] = [];
    for (const name of names.all) {
      const id = tryParseSessionId(name);
      if (id === undefined) {
        problems.push({
          file: name,
          line: 0,
          byteOffset: 0,
          message: `invalid session directory ${JSON.stringify(name)}`,
        });
        continue;
      }
      if (this.archived.has(id)) continue;
      try {
        const source = await this.readSource(id);
        if (source) {
          this.assertExpectedJournal(id, this.index.findSession(id), source.journal !== undefined);
          sources.push(source);
        }
      } catch (error) {
        // Quarantine, never abort: re-throwing here made one deleted journal unbuild the whole
        // index, so every other session in the home vanished from every listing.
        if (error instanceof MissingSessionJournalError) lostJournalSessionIds.push(id);
        failedSessionIds.push(id);
        problems.push({
          file: id,
          line: 0,
          byteOffset: 0,
          message: `session ${id} failed to read and was skipped: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    return { sources, problems, failedSessionIds, lostJournalSessionIds };
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

  /** Whether the index's last pointer for the session is still the event the journal holds at that position. */
  private pointerMatches(id: SessionId, indexed: IndexedSession, source: SessionSource): boolean {
    if (source.journal === undefined) return false;
    if (indexed.lastSequence === 0) return true;
    const pointer = this.index.eventPointers(id, indexed.lastSequence - 1, 1)[0];
    if (pointer === undefined || pointer.sequence !== indexed.lastSequence) return false;
    const found = source.journal.scan.pointers.find(candidate => candidate.sequence === pointer.sequence);
    return (
      found !== undefined &&
      found.time === pointer.time &&
      found.type === pointer.type &&
      found.byteOffset === pointer.byteOffset
    );
  }

  /** The session's index row brought up to date with its documents; its pointers kept as they are. */
  private applyMetadataRefresh(source: SessionSource): {
    readonly session?: IndexedSession;
    readonly problems: readonly JournalProblem[];
  } {
    const plan = planIndexRebuild([source]);
    // a source always plans exactly one session
    const session = plan.sessions[0] as IndexedSession;
    this.index.refreshSession(session);
    return { session, problems: plan.problems.filter(problem => problem.file !== source.journal?.file) };
  }

  /** The pointers past what the index has seen, added to the ones it has. */
  private applyTailScan(
    source: SessionSource,
    fromOffset: number,
  ): { readonly session?: IndexedSession; readonly problems: readonly JournalProblem[] } {
    const plan = planIndexRebuild([source]);
    const session = plan.sessions[0] as IndexedSession;
    this.index.appendEvents(
      session,
      plan.events.filter(pointer => pointer.byteOffset >= fromOffset),
    );
    return {
      session,
      problems: plan.problems.filter(
        problem => problem.file !== source.journal?.file || problem.byteOffset >= fromOffset,
      ),
    };
  }

  async reconcile(): Promise<RebuildResult> {
    this.assertOpen();
    return await this.indexSweep(async () => {
      const collected = await this.collectSources();
      const sourceById = new Map(collected.sources.map(source => [source.id, source]));
      const indexed = this.index.listSessions();
      const indexedById = new Map(indexed.map(session => [session.id, session]));
      const failedSessionIds = new Set(collected.failedSessionIds);
      const lostJournalSessionIds = new Set<string>(collected.lostJournalSessionIds);
      const problems: JournalProblem[] = [...collected.problems];
      const observations = collected.sources.map(source => {
        const current = indexedById.get(source.id);
        const journal = source.journal?.fingerprint ?? null;
        const lastIndexedEventMatches =
          current === undefined
            ? false
            : journal === null
              ? current.journal === null && current.lastSequence === 0
              : current.journal !== null && this.pointerMatches(source.id, current, source);
        return { id: source.id, journal, lastIndexedEventMatches };
      });
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
        const source = sourceById.get(action.id);
        if (source === undefined) continue;
        try {
          const result =
            action.kind === 'refresh-metadata'
              ? this.applyMetadataRefresh(source)
              : action.kind === 'scan-tail'
                ? this.applyTailScan(source, action.fromOffset)
                : this.applySource(source);
          problems.push(...result.problems);
          if (result.session) {
            sessionCount += 1;
            eventCount += this.index.countEvents(action.id);
          }
        } catch (error) {
          failedSessionIds.add(action.id);
          if (error instanceof MissingSessionJournalError) lostJournalSessionIds.add(action.id);
          problems.push({
            file: action.id,
            line: 0,
            byteOffset: 0,
            message: `session ${action.id} failed to reconcile and was skipped: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
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

  private inspectSource(id: SessionId, source: SessionSource | undefined): SessionInspection {
    const current = this.index.findSession(id);
    if (source === undefined) {
      return current === undefined ? { kind: 'current' } : { kind: 'repair', source: null };
    }
    this.assertExpectedJournal(id, current, source.journal !== undefined);
    const fingerprint = source.journal?.fingerprint ?? null;
    const currentPointerMatches =
      current === undefined
        ? false
        : fingerprint === null
          ? current.lastSequence === 0
          : this.pointerMatches(id, current, source);
    if (current && sameFingerprint(current.journal, fingerprint) && currentPointerMatches) {
      return { kind: 'current', session: current };
    }
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
    const inspection = this.inspectSource(id, await this.readSource(id));
    if (inspection.kind === 'repair' && inspection.source === null) this.index.removeSession(id);
    return this.applySessionInspection(inspection);
  }

  async writeConfig(id: SessionId, value: unknown): Promise<void> {
    this.assertOpen();
    const document = canonicalJsonValue(value);
    // Today's serializer refuses what JSON cannot carry before anything is written.
    serializeJsonDocument(value);
    await this.configWrite(
      id,
      async publishing =>
        await this.serial.run(id, async () => {
          await this.reviveIfArchived(id);
          await this.assertJournalKept(id);
          // The write is inside the try: a write that threw may still have landed, so the count moves either way.
          try {
            publishing();
            await this.writeDocument('config', id, document);
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
        // Validation, journal checks and transforms can refuse before the write starts.
        // Preserve their original error: no publication needs proving or repairing in that case.
        if (!publishing) return { error };
        outcome = { error };
      }
      // A rejected conditional update published nothing and must not retain archived ancestors either.
      if (!publishing) return outcome;
      // Even a failed write can have landed its document already.
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
   * roster): while it holds, nothing this daemon wrote changed a config.
   */
  configWrites(): number {
    return this.configChanges;
  }

  async writeState(id: SessionId, value: unknown): Promise<void> {
    this.assertOpen();
    const document = canonicalJsonValue(value);
    serializeJsonDocument(value);
    await this.serial.run(id, async () => {
      await this.reviveIfArchived(id);
      await this.assertJournalKept(id);
      await this.writeDocument('state', id, document);
      await this.syncSessionUnlocked(id);
      if (this.stateListeners.size > 0) this.publishState(id, document);
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

  /**
   * Writes one session document through the state port, which stamps its format and replaces it atomically. The
   * document is checked against its declared schema first, so a refusal is this storage's own error, not the port's.
   */
  private async writeDocument(kind: 'config' | 'state', id: SessionId, value: JsonValue): Promise<void> {
    const file = kind === 'config' ? FerretConfigFile : FerretStateFile;
    const checked = file.schema?.safeParse(value);
    if (checked !== undefined && !checked.success)
      throw new InvalidStateDocumentError(
        fileOf(file, id),
        checked.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '),
      );
    if (kind === 'config') await this.state.write(FerretConfigFile, value as never, id);
    else await this.state.write(FerretStateFile, value as never, id);
  }

  private async readDocument(id: SessionId, kind: 'config' | 'state'): Promise<FrozenJsonValue | undefined> {
    const file = kind === 'config' ? FerretConfigFile : FerretStateFile;
    const read =
      kind === 'config' ? await this.state.read(FerretConfigFile, id) : await this.state.read(FerretStateFile, id);
    if (!read.ok) throw new InvalidStateDocumentError(fileOf(file, id), read.error.sentence);
    if (read.value === undefined) return undefined;
    return deepFreezeJson(canonicalJsonValue(read.value));
  }

  /** A session's configuration, as the state folder holds it now. */
  async readConfig(id: SessionId, _freshness: DocumentFreshness = 'proved'): Promise<FrozenJsonValue | undefined> {
    this.assertOpen();
    return await this.readDocument(id, 'config');
  }

  /** A session's state, as the state folder holds it now. */
  async readState(id: SessionId, _freshness: DocumentFreshness = 'proved'): Promise<FrozenJsonValue | undefined> {
    this.assertOpen();
    return await this.readDocument(id, 'state');
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
        const file = kind === 'config' ? FerretConfigFile : FerretStateFile;
        const current = await this.readDocument(id, kind);
        const compute = current === undefined ? create : () => transform(current);
        if (compute === undefined) throw new InvalidStateDocumentError(fileOf(file, id), 'file is missing');
        // Checked under the same lineage gate and session lane as archive publication: maintenance
        // never revives a session that left the live set while its caller was reading the transcript.
        if (unlessArchived && this.archived.has(id)) return canonicalJsonValue(current);
        // The journal contract is settled BEFORE the transform runs and before any byte is written,
        // so a session that has lost its journal keeps its documents exactly as they were and nothing is
        // even computed to write.
        await this.assertJournalKept(id);
        const computed = await compute();
        // CAS losers and already-applied transforms have no publication or index side effects.
        if (current !== undefined && computed === current) return canonicalJsonValue(current);
        await this.reviveIfArchived(id);
        const next = canonicalJsonValue(computed);
        // The write is inside the try for the same reason as `writeConfig`: a write that threw may still have
        // changed the stored config.
        try {
          serializeJsonDocument(next);
          publishing();
          await this.writeDocument(kind, id, next);
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
      const read = await this.readSession(id);
      const file = fileOf(FerretHistoryFiles, id);
      // A journal read that stopped at a damaged line cannot say what sequence comes next: appending would risk
      // writing a sequence a later line already holds.
      if (!read.journal.complete)
        throw new Error(`session ${id} journal ${file} could not be read to its end; refusing to append`);
      const inspection = this.inspectSource(id, read.source);
      const event = createSessionEvent(
        id,
        inspection.session?.lastSequence ?? 0,
        validated.time,
        validated.type,
        validated.data,
      );
      const entry = encodeSessionEvent(event);
      if (inspection.kind === 'repair' && inspection.source === null) this.index.removeSession(id);
      const current = this.applySessionInspection(inspection);
      const position = read.journal.lines.length;
      await this.state.append(FerretHistoryFiles, entry, id);
      const session: IndexedSession = {
        id,
        status: current?.status,
        createdAt: current?.createdAt,
        updatedAt: current?.updatedAt,
        lastSequence: event.sequence,
        journalLine: position + 2,
        journal: journalFingerprint(position + 1),
      };
      const pointer: EventPointer = {
        sessionId: id,
        sequence: event.sequence,
        time: event.time,
        type: event.type,
        byteOffset: position,
        byteLength: 1,
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
   * A transcript by itself is not enough to restart a session: a session with no journal is lost coordination
   * history, never an empty session that may be restarted.
   */
  async assertJournalReadable(id: SessionId): Promise<void> {
    this.assertOpen();
    await this.serial.run(id, async () => {
      if (!(await this.journalPresent(id))) throw new MissingSessionJournalError(id, fileOf(FerretHistoryFiles, id));
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

  /** The events the pointers name, proved against the journal line each points at. */
  private async resolvePointers(
    id: SessionId,
    pointers: readonly EventPointer[],
    lines?: readonly JournalLine[],
  ): Promise<readonly SessionEvent[] | undefined> {
    if (pointers.length === 0) return [];
    const journal = lines ?? (await this.readJournal(id)).lines;
    const events: SessionEvent[] = [];
    for (const pointer of pointers) {
      const entry = journal[pointer.byteOffset];
      if (entry === undefined || 'damaged' in entry) return undefined;
      const event = parseSessionEvent(entry.value, id);
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

  /** Reconcile the disposable session index against every readable session. */
  private async synchronizeFleetSessionsUnlocked(): Promise<readonly SessionId[]> {
    const surveyed = await this.surveySessionDirectories();
    const evidenceById = new Map(surveyed.map(entry => [entry.id, entry]));
    for (const session of this.index.listSessions()) {
      if (!evidenceById.has(session.id))
        throw new Error(`session ${session.id} is indexed but has no readable durable directory evidence`);
    }
    // Survey both directions. Rebuilding only sessions SQLite already remembers would accept a
    // wholly lost index as an honestly empty fleet. Every readable session is therefore
    // synchronized into the disposable index before its id is claimed by an idle proof or tail.
    for (const evidence of surveyed) {
      if (evidence.journalLost)
        throw new MissingSessionJournalError(evidence.id, fileOf(FerretHistoryFiles, evidence.id));
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
   * Pointer selection is global and bounded in SQLite. Journal lines are then proved against those
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
   * An indexed session missing from the survey, or one whose owed journal vanished, makes
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

  /**
   * The live sessions the state folder holds and, for each, whether its journal has vanished.
   *
   * Three listings and no document or journal read, and nothing is reconciled, so a health tick can afford this on
   * every pass. Loss is decided exactly as the read paths decide it — a surviving index witness of a journal the
   * folder no longer holds.
   */
  async surveySessionDirectories(): Promise<readonly SessionDirectorySurvey[]> {
    this.assertOpen();
    const names = await this.sessionNames();
    const survey: SessionDirectorySurvey[] = [];
    for (const name of names.all) {
      const id = tryParseSessionId(name);
      if (id === undefined) continue;
      if (this.archived.has(id)) continue;
      const indexed = this.index.findSession(id);
      const owesJournal = indexed !== undefined && indexed.journal !== null;
      survey.push({ id, journalLost: owesJournal && !names.histories.has(name) });
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
   * walks the sessions. A damaged or absent registry is an empty one: every session is live again, which
   * is the safe direction, and the next archive pass writes a good document.
   */
  async loadArchive(): Promise<number> {
    this.assertOpen();
    const read = await this.state.read(ArchiveFile);
    const parsed = read.ok ? parseArchiveRegistryValue(read.value) : undefined;
    if (parsed === undefined)
      this.log.warn('the session archive registry is damaged; every session is live until the next archive pass', {
        file: ArchiveFile.path,
      });
    this.archived = parsed ?? new Map();
    // An archive that crashed between the registry write and the index removal leaves rows behind.
    for (const id of this.archived.keys()) if (this.index.findSession(id) !== undefined) this.index.removeSession(id);
    return this.archived.size;
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
      await this.state.write(ArchiveFile, archiveRegistryValue(next));
      if (!valid()) {
        // A keep landed while the write was pending. Restore the durable registry before publishing anything.
        await this.state.write(ArchiveFile, archiveRegistryValue(this.archived));
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
            for (const id of left) this.index.removeSession(id);
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
    const read = await this.readSession(id);
    if (read.source === undefined) throw new Error(`archived session ${id} has no readable journal`);
    const pointers = planIndexRebuild([read.source]).events.filter(pointer => pointer.sequence > afterSequence);
    const selected = pointers.slice(0, limit);
    const events = await this.resolvePointers(id, selected, read.journal.lines);
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
    await this.serial.runExclusive(async () => {
      await this.index.close();
    });
  }
}
