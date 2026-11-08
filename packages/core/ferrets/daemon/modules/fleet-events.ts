/**
 * `GET /v1/events` (R520 / R537 / G161): the ferrets' journal stream. One socket, two forms: ONE ferret from its own
 * cursor (`?sessionId=…&after=N`, optionally `live` / `transcript`), or the fleet's recent tail then live (`?tail=N`).
 * The frames, the `idle` proof, the replay/live overlap and the slow-reader bound are `FleetEventStreamService`'s,
 * copied from today; this module is its source (each ferret's `history.jsonl` through the state port, and the append
 * edge Ferrets itself writes) and today's query rules.
 */
import { ApiError, queryValues, type CallContext, type SocketAccept, type StatePort } from '@ferretry/kernel/contract';
import { FerretHistoryFiles } from '../../contract/state.ts';
import {
  FLEET_EVENT_BACKLOG_LIMIT,
  FleetEventStreamService,
  type EventStreamScheduler,
  type FleetEventBacklog,
  type FleetEventSource,
  type FleetEventStreamScope,
  type LiveActivitySource,
  type TranscriptChangeSource,
} from '../lib/session/events/service.ts';
import { type FleetBacklogPasses, SharedFleetBacklog } from '../lib/session/events/shared-backlog.ts';
import { SESSION_LIVE_STREAM_FLAG, SESSION_TRANSCRIPT_STREAM_FLAG } from '../lib/protocol/session-live.ts';
import type { StoredSessionEvent } from '../lib/session/peers/reads.ts';

/** The most of one ferret's journal a fleet backlog pass reads from its end, however large the tail asked for. */
const BACKLOG_TAIL_MAX_BYTES = 4 * 1024 * 1024;
/** The least it reads, so one unusually long line of a small tail is still found. */
const BACKLOG_TAIL_MIN_BYTES = 64 * 1024;
/** What one journal line is taken to cost on average: a tail of N records reads about N times this from a ferret. */
const AVERAGE_JOURNAL_LINE_BYTES = 1024;

/** How much of one ferret's journal a backlog of `limit` records reads: about `limit` average lines, never the whole 4 MiB for a short tail. */
export const backlogTailBytes = (limit: number): number =>
  Math.min(BACKLOG_TAIL_MAX_BYTES, Math.max(BACKLOG_TAIL_MIN_BYTES, limit * AVERAGE_JOURNAL_LINE_BYTES));
const REPLAY_PAGE = 1_000;

/** The journals as a source: replay and backlog read the ferrets' files, `publish` is the live append edge. */
export class HistoryEventSource implements FleetEventSource {
  readonly #listeners = new Set<(event: StoredSessionEvent) => void>();
  /** One pass reads at a time: the next waits its turn, which is when later feeds can still join it. */
  #turn: Promise<unknown> = Promise.resolve();
  /** Feeds that open while a pass is still waiting for its turn share it (one pass per limit), as today's did. */
  readonly #shared = new SharedFleetBacklog({
    fleetBacklog: (limit, claim) => this.#pass(limit, claim),
  } satisfies FleetBacklogPasses);

  constructor(
    private readonly state: Pick<StatePort, 'lines' | 'tail'>,
    private readonly ferrets: () => readonly string[],
  ) {}

  /** Told by Ferrets after each append (the evidence is already on disk). */
  publish(event: StoredSessionEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // one reader's failure never reaches the writer or the other readers
      }
    }
  }

  subscribe(listener: (event: StoredSessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async replay(
    sessionId: string,
    afterSequence: number,
    limit: number,
    signal: AbortSignal,
  ): Promise<readonly StoredSessionEvent[]> {
    const page: StoredSessionEvent[] = [];
    for await (const line of this.state.lines(FerretHistoryFiles, sessionId)) {
      signal.throwIfAborted();
      if (line.sequence <= afterSequence) continue;
      page.push(stored(line));
      if (page.length >= Math.min(limit, REPLAY_PAGE)) break;
    }
    return page;
  }

  /** Every reader's backlog: shared while a pass is still queued, so N sockets opening together read the fleet once. */
  async fleetBacklog(limit: number, signal: AbortSignal): Promise<FleetEventBacklog> {
    return await this.#shared.backlog(limit, signal);
  }

  /** One pass: it waits for the pass before it, then asks `claim` whether any reader is still there; a pass nobody waits for reads nothing. */
  async #pass(limit: number, claim: () => boolean): Promise<FleetEventBacklog | undefined> {
    const pass = this.#turn.catch(() => undefined).then(async () => (claim() ? await this.#survey(limit) : undefined));
    this.#turn = pass.catch(() => undefined);
    return await pass;
  }

  async #survey(limit: number): Promise<FleetEventBacklog> {
    const sessionIds = this.ferrets();
    if (limit === 0) return { sessionIds, events: [] };
    const events: StoredSessionEvent[] = [];
    for (const id of sessionIds) {
      const tail = await this.state.tail(FerretHistoryFiles, { maxBytes: backlogTailBytes(limit), name: id });
      for (const record of tail.records.slice(-limit)) events.push(stored(record));
    }
    // Recent first by time (each ferret's own order is its sequence), then the last `limit`.
    events.sort(
      (a, b) =>
        Date.parse(a.time) - Date.parse(b.time) || a.sessionId.localeCompare(b.sessionId) || a.sequence - b.sequence,
    );
    return { sessionIds, events: events.slice(-limit) };
  }
}

function stored(record: {
  readonly sequence: number;
  readonly sessionId: string;
  readonly time: string;
  readonly type: string;
  readonly data: unknown;
}): StoredSessionEvent {
  return {
    sequence: record.sequence,
    sessionId: record.sessionId,
    time: record.time,
    type: record.type,
    data: record.data,
  };
}

function sole(call: CallContext, name: string): string | undefined {
  const values = queryValues(call.request, name);
  if (values.length > 1) throw new ApiError(400, `query parameter "${name}" may appear only once`, 'invalid_query');
  return values[0];
}

/**
 * Today's `scope()` (`mounts/fleet-events.ts`), word for word: which parameters exist, which pair with which, and the
 * sentence and code each refusal carries. A ferret that does not exist is a 404 before any frame.
 */
export function eventStreamScope(call: CallContext, exists: (id: string) => boolean): FleetEventStreamScope {
  for (const name of call.request.query.keys()) {
    // `ticket` is tolerated as a leftover. A `token` is not: no credential is read from a URL.
    if (!['after', 'sessionId', 'live', 'transcript', 'tail', 'ticket'].includes(name))
      throw new ApiError(400, `unknown event-stream query parameter "${name}"`, 'invalid_query');
  }
  const rawAfter = sole(call, 'after') ?? '0';
  const after = Number(rawAfter);
  if (!/^[0-9]+$/u.test(rawAfter) || !Number.isSafeInteger(after))
    throw new ApiError(400, 'after must be a non-negative integer', 'invalid_query');
  const rawLive = sole(call, 'live');
  if (rawLive !== undefined && rawLive !== SESSION_LIVE_STREAM_FLAG)
    throw new ApiError(400, `live must be "${SESSION_LIVE_STREAM_FLAG}" when given`, 'invalid_query');
  const rawTranscript = sole(call, 'transcript');
  if (rawTranscript !== undefined && rawTranscript !== SESSION_TRANSCRIPT_STREAM_FLAG)
    throw new ApiError(400, `transcript must be "${SESSION_TRANSCRIPT_STREAM_FLAG}" when given`, 'invalid_query');
  const rawTail = sole(call, 'tail');
  const sessionId = sole(call, 'sessionId');
  if (sessionId === undefined) {
    if (after !== 0)
      throw new ApiError(
        400,
        'a fleet stream has no global cursor; omit --after or follow one session',
        'fleet_cursor_unavailable',
      );
    if (rawLive !== undefined)
      throw new ApiError(400, 'a live readout follows one session; add sessionId', 'live_needs_session');
    if (rawTranscript !== undefined)
      throw new ApiError(400, 'a transcript signal follows one session; add sessionId', 'transcript_needs_session');
    if (rawTail === undefined) return { kind: 'fleet' };
    const tail = Number(rawTail);
    if (!/^[0-9]+$/u.test(rawTail) || tail > FLEET_EVENT_BACKLOG_LIMIT)
      throw new ApiError(400, `tail must be an integer from 0 to ${FLEET_EVENT_BACKLOG_LIMIT}`, 'invalid_query');
    return { kind: 'fleet', tail };
  }
  if (rawTail !== undefined)
    throw new ApiError(400, 'tail bounds a fleet stream; follow one session with after', 'tail_needs_fleet');
  if (sessionId === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(sessionId))
    throw new ApiError(400, 'sessionId is not a usable session id', 'invalid_session_id');
  if (!exists(sessionId)) throw new ApiError(404, `no session ${sessionId}`, 'not-found');
  return {
    kind: 'session',
    sessionId,
    after,
    ...(rawLive === undefined ? {} : { live: true }),
    ...(rawTranscript === undefined ? {} : { transcript: true }),
  };
}

/** What a stream can carry beyond the journal: the `?live=1` readout and the `?transcript=1` signal. Absent, those frames never appear. */
export interface FleetEventExtras {
  readonly live?: LiveActivitySource;
  readonly transcript?: TranscriptChangeSource;
}

/** The accept for `GET /v1/events`. */
export function fleetEventsAccept(
  source: FleetEventSource,
  scheduler: EventStreamScheduler,
  exists: (id: string) => boolean,
  extras: FleetEventExtras = {},
): SocketAccept {
  const service = new FleetEventStreamService(source, scheduler, extras.live, extras.transcript);
  return async call => {
    const scope = eventStreamScope(call, exists);
    return async downstream => service.handler(scope, downstream);
  };
}

/**
 * Whether a stream may follow `id`: the live registry, or a ferret the archive holds. Today's `findSession` found both,
 * and an archived ferret's journal is untouched (docs/session-archive.md), so its stream replays like any other.
 */
export const followableFerret =
  (known: { readonly live: (id: string) => boolean; readonly archived: (id: string) => boolean }) =>
  (id: string): boolean =>
    known.live(id) || known.archived(id);
