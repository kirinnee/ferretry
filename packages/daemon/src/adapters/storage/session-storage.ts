import { basename, join } from 'node:path';
import {
  type ClockPort,
  CURRENT_SESSION_VERSION,
  canonicalJsonValue,
  createJournalScanCursor,
  createSessionEvent,
  createSessionPaths,
  type DirectoryEntry,
  decideSessionMarker,
  type EventPointer,
  encodeSessionEvent,
  type FileSystemPort,
  type FoundationPaths,
  type HomeLockLease,
  type IndexedSession,
  type JournalFingerprint,
  type JournalProblem,
  type JsonValue,
  parseJsonDocument,
  parseSessionEvent,
  planIndexRebuild,
  planReconciliation,
  type RebuildResult,
  type ReplayPage,
  type SerialExecutor,
  type SessionEvent,
  type SessionId,
  type SessionIndex,
  type SessionPaths,
  type SessionSource,
  scanJournalChunk,
  serializeJsonDocument,
  sessionJournalRequired,
  sessionMarkerNeedsUpgrade,
  tryParseSessionId,
} from '../../lib/index.ts';

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

export class DaemonStorage {
  private closed = false;
  /** Live journal appends for sockets served by THIS opened daemon storage, never process-global. */
  private readonly eventListeners = new Set<(event: SessionEvent) => void>();

  constructor(
    readonly paths: FoundationPaths,
    private readonly fileSystem: FileSystemPort,
    private readonly index: SessionIndex,
    private readonly clock: ClockPort,
    private readonly serial: SerialExecutor,
    private readonly homeLock: HomeLockLease,
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
    await this.fileSystem.writeTextAtomic(paths.marker, `${CURRENT_SESSION_VERSION}\n`);
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
        const paths = createSessionPaths(this.paths, id);
        if (!sessionMarkerNeedsUpgrade(await this.fileSystem.readText(paths.marker))) continue;
        if ((await this.ensureJournalFile(id, paths)) === undefined) continue;
        await this.fileSystem.writeTextAtomic(paths.marker, `${CURRENT_SESSION_VERSION}\n`);
        upgraded.push(id);
      }
      return upgraded;
    });
  }

  private async refuseNonEmptyUnmarkedSession(id: SessionId): Promise<void> {
    const entries = await this.fileSystem.listDirectory(createSessionPaths(this.paths, id).directory);
    if (entries.length > 0) throw new SessionLayoutError(id, undefined);
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
      await this.refuseNonEmptyUnmarkedSession(id);
      return undefined;
    }
    return {
      id,
      marker: { file: paths.marker, text: marker ?? '' },
      config: config === undefined ? undefined : { file: paths.config, text: config },
      state: state === undefined ? undefined : { file: paths.state, text: state },
      journal,
    };
  }

  private async readObservation(id: SessionId, includeMissingMarker = false): Promise<SessionObservation | undefined> {
    const paths = createSessionPaths(this.paths, id);
    const [marker, config, state, journal] = await Promise.all([
      this.fileSystem.readText(paths.marker),
      this.fileSystem.readText(paths.config),
      this.fileSystem.readText(paths.state),
      this.fileSystem.information(paths.events),
    ]);
    if (marker === undefined && !includeMissingMarker) {
      await this.refuseNonEmptyUnmarkedSession(id);
      return undefined;
    }
    return {
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
    return await this.serial.runExclusive(async () => {
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
    const session = plan.sessions[0];
    if (session === undefined) {
      this.index.removeSession(observation.id);
      return { problems: plan.problems };
    }
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
    const session = plan.sessions[0];
    if (session === undefined) {
      this.index.removeSession(observation.id);
      return { problems: plan.problems };
    }
    this.index.appendEvents(session, plan.events);
    return { session, problems: plan.problems };
  }

  async reconcile(): Promise<RebuildResult> {
    this.assertOpen();
    return await this.serial.runExclusive(async () => {
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
    await this.serial.run(id, async () => {
      await this.ensureSessionDirectory(id);
      await this.fileSystem.writeTextAtomic(createSessionPaths(this.paths, id).config, document);
      await this.syncSessionUnlocked(id);
    });
  }

  async writeState(id: SessionId, value: unknown): Promise<void> {
    this.assertOpen();
    const document = serializeJsonDocument(value);
    await this.serial.run(id, async () => {
      await this.ensureSessionDirectory(id);
      await this.fileSystem.writeTextAtomic(createSessionPaths(this.paths, id).state, document);
      await this.syncSessionUnlocked(id);
    });
  }

  private async readDocument(id: SessionId, kind: 'config' | 'state'): Promise<JsonValue | undefined> {
    const paths = createSessionPaths(this.paths, id);
    const marker = await this.fileSystem.readText(paths.marker);
    if (marker === undefined) {
      await this.refuseNonEmptyUnmarkedSession(id);
      return undefined;
    }
    if (decideSessionMarker(marker) === 'refuse') throw new SessionLayoutError(id, marker);
    const file = paths[kind];
    const text = await this.fileSystem.readText(file);
    if (text === undefined) return undefined;
    const parsed = parseJsonDocument(text);
    if (!parsed.ok) throw new InvalidStateDocumentError(file, parsed.message);
    return parsed.value;
  }

  async readConfig(id: SessionId): Promise<JsonValue | undefined> {
    this.assertOpen();
    return await this.readDocument(id, 'config');
  }

  async readState(id: SessionId): Promise<JsonValue | undefined> {
    this.assertOpen();
    return await this.readDocument(id, 'state');
  }

  private async updateDocument(
    id: SessionId,
    kind: 'config' | 'state',
    transform: (current: JsonValue) => JsonValue | Promise<JsonValue>,
  ): Promise<JsonValue> {
    this.assertOpen();
    return await this.serial.run(id, async () => {
      const paths = createSessionPaths(this.paths, id);
      const current = await this.readDocument(id, kind);
      if (current === undefined) throw new InvalidStateDocumentError(paths[kind], 'file is missing');
      // The journal contract is settled BEFORE the transform runs and before any byte is written,
      // so a session that has lost its journal keeps its documents exactly as they were. The write
      // paths get the same gate from their own ensureSessionDirectory call.
      await this.ensureSessionDirectory(id);
      const next = canonicalJsonValue(await transform(current));
      await this.fileSystem.writeTextAtomic(paths[kind], serializeJsonDocument(next));
      await this.syncSessionUnlocked(id);
      return next;
    });
  }

  async updateConfig(
    id: SessionId,
    transform: (current: JsonValue) => JsonValue | Promise<JsonValue>,
  ): Promise<JsonValue> {
    return await this.updateDocument(id, 'config', transform);
  }

  async updateState(
    id: SessionId,
    transform: (current: JsonValue) => JsonValue | Promise<JsonValue>,
  ): Promise<JsonValue> {
    return await this.updateDocument(id, 'state', transform);
  }

  async append(id: SessionId, type: string, data: unknown): Promise<SessionEvent> {
    this.assertOpen();
    const validated = createSessionEvent(id, 0, this.clock.now(), type, data);
    return await this.serial.run(id, async () => {
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
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000)
      throw new Error('fleet event limit must be an integer between 1 and 10000');
    return await this.serial.runExclusive(async () => {
      const sessionIds = await this.synchronizeFleetSessionsUnlocked();
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
    });
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

  findSession(id: SessionId): IndexedSession | undefined {
    this.assertOpen();
    return this.index.findSession(id);
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
   * One `readText` per directory plus one `stat` for each directory that owes a journal. No journal
   * bytes are read and nothing is reconciled, so a health tick can afford this on every pass. Loss
   * is decided exactly as the read paths decide it — current marker OR a surviving index witness —
   * so a legacy session that has not been migrated is not silently reported as healthy.
   */
  async surveySessionDirectories(): Promise<readonly SessionDirectorySurvey[]> {
    this.assertOpen();
    const entries = await this.fileSystem.listDirectory(this.paths.sessions);
    const survey: SessionDirectorySurvey[] = [];
    for (const entry of entries) {
      if (!entry.directory) continue;
      const id = tryParseSessionId(entry.name);
      if (id === undefined) continue;
      const paths = createSessionPaths(this.paths, id);
      const marker = await this.fileSystem.readText(paths.marker);
      if (decideSessionMarker(marker) === 'refuse') continue;
      const indexed = this.index.findSession(id);
      const owesJournal = sessionJournalRequired(marker) || (indexed !== undefined && indexed.journal !== null);
      const journalLost = owesJournal && (await this.fileSystem.information(paths.events)) === undefined;
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

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.eventListeners.clear();
    await this.serial.runExclusive(async () => {
      try {
        this.index.close();
      } finally {
        await this.homeLock.release();
      }
    });
  }
}
