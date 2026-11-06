import { type SessionConfig, SessionConfigSchema, SessionStateSchema, type SessionView } from '@ferretry/protocol';
import { tryParseSessionId, type SessionId } from '../../session-id.ts';
import { SessionReadError, type SessionDirectorySubsystem } from '../../runtime/mounts/sessions.ts';
import type { IndexedSession } from '../../storage-types.ts';

/**
 * The session read, over the authoritative index and the documents in the state home.
 *
 * BOTH DOCUMENTS ARE PARSED, and a session whose pair does not parse is left out of the list rather
 * than reported with holes: a view assembled from a config the protocol schema rejected is a view
 * whose fields nobody can vouch for. The single read refuses that same session instead of omitting
 * it, so the gap in the list is answerable rather than silent.
 *
 * THE LIST IS PACED. Every background loop reads it — the Warden's liveness tick and sweep, a restart, the
 * roster — and a box keeps every session it ever ran: on the EC2 host that is ~500, all but ~30 of them
 * ended. Read as one `Promise.all`, that was ~2,000 `stat`s and 1,000 schema parses landing on the loop
 * together, and every such pass stalled it for a few hundred milliseconds. So the list reads
 * {@link SESSION_LIST_BATCH} sessions at a time — fewer when they are projected — and hands the loop back
 * between batches.
 *
 * A LISTED SESSION THAT HAS ENDED IS NOT PROJECTED. The projection brings what the transcript says into the
 * documents before they are read — a transcript tail parsed per session — and an ended session asks no
 * question anyone can answer: the observer's own question pass skips it for the same reason. Its single read
 * still projects it, so opening it shows everything its transcript says.
 */

/** Sessions read together before the loop is handed back. */
export const SESSION_LIST_BATCH = 25;
/** Projected sessions read together: a projection parses a transcript tail, so a batch closes early on them. */
export const SESSION_LIST_PROJECTIONS = 4;

/** The index in order, cut into batches of at most {@link SESSION_LIST_BATCH} reads and {@link SESSION_LIST_PROJECTIONS} projections. */
function batches(
  sessions: readonly IndexedSession[],
  ended: (session: IndexedSession) => boolean,
): readonly (readonly { readonly id: SessionId; readonly project: boolean }[])[] {
  const cut: { readonly id: SessionId; readonly project: boolean }[][] = [];
  let batch: { readonly id: SessionId; readonly project: boolean }[] = [];
  let projections = 0;
  for (const session of sessions) {
    const project = !ended(session);
    if (batch.length === SESSION_LIST_BATCH || (project && projections === SESSION_LIST_PROJECTIONS)) {
      cut.push(batch);
      batch = [];
      projections = 0;
    }
    batch.push({ id: session.id, project });
    if (project) projections += 1;
  }
  if (batch.length > 0) cut.push(batch);
  return cut;
}

/** What one read of a session produced, kept against the documents it parsed (see `createSessionDirectory`). */
interface KnownSession {
  readonly rawConfig: object;
  readonly rawState: object;
  readonly config: ReturnType<typeof SessionConfigSchema.safeParse>;
  readonly state: ReturnType<typeof SessionStateSchema.safeParse>;
  readonly journalSequence: number | undefined;
  readonly view: SessionView;
}

/** Only an object has an identity worth keeping a parse against. */
const isDocument = (value: unknown): value is object => typeof value === 'object' && value !== null;

/** Keep launch evidence in storage and in the projector, rather than in every public list/view. */
function viewConfig(config: SessionConfig): SessionView['config'] {
  if (config.transcript === undefined) return config;
  const { baseline: _baseline, ...transcript } = config.transcript;
  return { ...config, transcript };
}

export interface SessionDirectoryPorts {
  /** Every session the index holds. */
  readonly sessions: () => readonly IndexedSession[];
  readonly find: (id: SessionId) => IndexedSession | undefined;
  readonly readConfig: (id: SessionId) => Promise<unknown>;
  readonly readState: (id: SessionId) => Promise<unknown>;
  readonly directory: (id: SessionId) => string;
  /** Brings a session's documents up to date with its transcript before they are read. */
  readonly project?: ((id: SessionId, config: SessionConfig) => Promise<void>) | undefined;
  /** Whether the index says this session has ended: a list leaves an ended session unprojected. */
  readonly ended: (session: IndexedSession) => boolean;
  readonly yieldToLoop: () => Promise<void>;
}

/**
 * Whether a session is there, and nothing more: the question the agenda asks before it reads a board.
 *
 * IT NEVER PROJECTS. A board read asks it for every ferret on the board — some two hundred sessions — and
 * the single read's projection is a transcript tail parsed (or a worker barrier waited on) for each one,
 * which made one card's read take up to ten seconds. Whether a session exists is not something its
 * transcript can change, so the answer is the index and the two documents, with the single read's own
 * refusals: an unusable reference, or documents that do not satisfy the protocol.
 */
export interface SessionPresence {
  has(sessionId: string): Promise<boolean>;
}

export function createSessionDirectory(ports: SessionDirectoryPorts): SessionDirectorySubsystem & SessionPresence {
  /**
   * What the last read of each session produced, by the documents the reader handed out.
   *
   * THE STORAGE HANDS OUT THE SAME FROZEN VALUE UNTIL ITS FILE CHANGES, so a document seen again is a document
   * already parsed: the parse is kept per session and reused while the reader's value is the very object it
   * parsed. On a box that keeps every session it ever ran — ~1,400, nearly all finished — a list that parsed
   * both documents of every one on every call spent seconds of loop on answers that had not moved. A changed
   * file is a new value, so that session — and only that session — is parsed again; a document that was not an
   * object is never kept, so a broken pair is judged afresh each time.
   *
   * The assembled view is kept too, and handed out as the same object while its documents and its journal
   * sequence are unchanged. That identity is what lets the layers above (and the route's own body cache)
   * recognise an unchanged session without comparing it. A view is therefore SHARED between calls: nothing
   * that reads a list may write to one.
   */
  const known = new Map<SessionId, KnownSession>();
  /** The pair of documents for one indexed session, parsed, or `undefined` when either is unusable. */
  const view = async (id: SessionId, project: boolean): Promise<SessionView | undefined> => {
    // Read BEFORE the documents: a reader starting its live feed after this sequence is replayed every
    // event the documents might not reflect yet, and misses none they do not.
    const journalSequence = ports.find(id)?.lastSequence;
    const previous = known.get(id);
    const rawConfig = await ports.readConfig(id);
    const config =
      previous !== undefined && previous.rawConfig === rawConfig
        ? previous.config
        : SessionConfigSchema.safeParse(rawConfig);
    if (config.success && project) await ports.project?.(id, config.data);
    const rawState = await ports.readState(id);
    const state =
      previous !== undefined && previous.rawState === rawState
        ? previous.state
        : SessionStateSchema.safeParse(rawState);
    if (!config.success || !state.success) {
      known.delete(id);
      return undefined;
    }
    const unchanged =
      previous !== undefined &&
      previous.config === config &&
      previous.state === state &&
      previous.journalSequence === journalSequence;
    const assembled: SessionView = unchanged
      ? previous.view
      : {
          config: viewConfig(config.data),
          state: state.data,
          directory: ports.directory(id),
          ...(journalSequence === undefined ? {} : { journalSequence }),
        };
    // Both schemas are objects, so a pair that parsed is a pair of objects; a pair that did not has already
    // been forgotten above. The check narrows the types for the entry, it does not choose between outcomes.
    if (isDocument(rawConfig) && isDocument(rawState))
      known.set(id, { rawConfig, rawState, config, state, journalSequence, view: assembled });
    return assembled;
  };
  /**
   * Lets go of the sessions the index no longer holds, so what is kept is bounded by the fleet.
   *
   * By membership, never by size: an index that swaps one session for another holds as many as before, and a
   * count comparison would keep the one that left — a session that came back later with the same documents
   * would be handed its stale view.
   */
  const forget = (listed: readonly IndexedSession[]): void => {
    const held = new Set<string>(listed.map(session => session.id));
    for (const id of known.keys()) if (!held.has(id)) known.delete(id);
  };
  /** The indexed id a reference names, `undefined` for one the index does not hold. */
  const indexed = (reference: string): SessionId | undefined => {
    const id = tryParseSessionId(reference);
    if (id === undefined)
      throw new SessionReadError('invalid', `${JSON.stringify(reference)} is not a usable session id`);
    return ports.find(id) === undefined ? undefined : id;
  };
  const unusable = (reference: string) =>
    new SessionReadError('unusable', `the documents for session ${reference} do not satisfy the protocol`);
  /**
   * The pairs of documents already known to satisfy the protocol, by the values the reader handed out. The
   * storage hands out the same frozen value until its file changes, so a pair seen once is not parsed again,
   * and a changed file is a new value that is.
   */
  const usable = new WeakMap<object, WeakSet<object>>();
  return {
    list: async () => {
      const views: SessionView[] = [];
      const listed = ports.sessions();
      let first = true;
      for (const batch of batches(listed, ports.ended)) {
        if (!first) await ports.yieldToLoop();
        first = false;
        const found = await Promise.all(batch.map(async ({ id, project }) => await view(id, project)));
        for (const each of found) if (each !== undefined) views.push(each);
      }
      forget(listed);
      return views;
    },
    get: async reference => {
      const id = indexed(reference);
      if (id === undefined) return undefined;
      const found = await view(id, true);
      if (found === undefined) throw unusable(reference);
      return found;
    },
    has: async reference => {
      const id = indexed(reference);
      if (id === undefined) return false;
      const [config, state] = [await ports.readConfig(id), await ports.readState(id)];
      const pairs = typeof config === 'object' && config !== null ? usable.get(config) : undefined;
      if (typeof state === 'object' && state !== null && pairs?.has(state) === true) return true;
      if (!SessionConfigSchema.safeParse(config).success || !SessionStateSchema.safeParse(state).success)
        throw unusable(reference);
      if (typeof config === 'object' && config !== null && typeof state === 'object' && state !== null)
        usable.set(config, (pairs ?? new WeakSet()).add(state));
      return true;
    },
  };
}
