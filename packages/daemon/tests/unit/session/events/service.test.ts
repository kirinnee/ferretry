import { describe, it } from 'bun:test';
import { FyEventStreamFrameSchema, type FyEventStreamFrame } from '@ferretry/protocol';
import should from 'should';
import type { SocketDownstream } from '../../../../src/lib/api/socket.ts';
import {
  EVENT_STREAM_IDLE_MS,
  EVENT_STREAM_MAX_BUFFER_BYTES,
  EVENT_STREAM_MAX_PENDING,
  FLEET_EVENT_BACKLOG_LIMIT,
  FleetEventStreamService,
  orderFleetBacklog,
  type EventStreamScheduler,
  type EventStreamTimer,
  type FleetEventBacklog,
  type FleetEventSource,
  type FleetEventStreamScope,
} from '../../../../src/lib/session/events/index.ts';
import type { StoredSessionEvent } from '../../../../src/lib/session/reads/index.ts';

/**
 * The live event feed, seen from the domain.
 *
 * WHAT THIS SURFACE HAS TO GET RIGHT. It is the only place in the daemon where durable history and a
 * live append edge are stitched into one ordered stream, and every failure mode of that stitch is
 * silent by nature:
 *
 * - A subscription taken AFTER the replay would drop every event written during it, and the reader
 *   would never know: the stream just resumes at the wrong place.
 * - A live append that arrives twice, or out of order, is indistinguishable from real history unless
 *   the handler refuses it.
 * - A quiet socket and a broken one look identical on the wire, which is what the idle proof exists
 *   to separate — and why the proof must never be shaped like a session event.
 * - A slow reader is unbounded daemon memory, in two separate places: the pending queue during
 *   replay, and the transport's own buffer afterwards.
 *
 * So every case here asserts a REFUSAL or a bound, not just a happy delivery, and the fixtures make
 * the replay window controllable so the overlap between durable and live can actually be driven.
 */

const ORIGIN = Date.parse('2026-08-01T00:00:00.000Z');

function at(seconds: number): string {
  return new Date(ORIGIN + seconds * 1_000).toISOString();
}

/** One journal record, timed by its own sequence unless a case needs the two to disagree. */
function stored(sessionId: string, sequence: number, seconds: number = sequence): StoredSessionEvent {
  return { sessionId, sequence, time: at(seconds), type: 'session.turn', data: { sequence } };
}

interface SourceScript {
  /** Successive per-session replay pages, in the order the handler will ask for them. */
  readonly pages?: readonly (readonly StoredSessionEvent[])[];
  readonly backlog?: FleetEventBacklog;
  readonly failure?: Error;
  /** Runs while the durable read is still in flight, so live appends land in the pending queue. */
  readonly duringReplay?: (emit: (event: StoredSessionEvent) => void) => void;
}

/**
 * Durable replay and the live edge, both under the test's control.
 *
 * The `duringReplay` hook is the point of this fake: the handler subscribes before it replays, and
 * the only way to prove that ordering matters is to append while the durable read has not returned.
 */
class ScriptedSource implements FleetEventSource {
  subscribed = 0;
  unsubscribed = 0;
  /** Every per-session replay ask, as the session, the cursor and the page bound. */
  readonly replayed: Array<readonly [string, number, number]> = [];
  /** Every fleet backfill bound the handler asked for. */
  readonly backfilled: number[] = [];
  /** Whether the durable read observed its own cancellation. */
  cancelled = false;
  private listener: ((event: StoredSessionEvent) => void) | undefined;
  private page = 0;

  constructor(private readonly script: SourceScript = {}) {}

  async replay(
    sessionId: string,
    afterSequence: number,
    limit: number,
    signal: AbortSignal,
  ): Promise<readonly StoredSessionEvent[]> {
    this.replayed.push([sessionId, afterSequence, limit]);
    return await this.durable(signal, () => {
      const page = this.script.pages?.[this.page] ?? [];
      this.page += 1;
      return page;
    });
  }

  async fleetBacklog(limit: number, signal: AbortSignal): Promise<FleetEventBacklog> {
    this.backfilled.push(limit);
    return await this.durable(signal, () => this.script.backlog ?? { sessionIds: [], events: [] });
  }

  subscribe(listener: (event: StoredSessionEvent) => void): () => void {
    this.subscribed += 1;
    this.listener = listener;
    return () => {
      this.unsubscribed += 1;
      this.listener = undefined;
    };
  }

  /** Append as the storage would. A closed handler has unsubscribed, so this reaches nothing. */
  emit(event: StoredSessionEvent): void {
    this.listener?.(event);
  }

  /** Whether a live listener is currently registered at all. */
  get listening(): boolean {
    return this.listener !== undefined;
  }

  private async durable<T>(signal: AbortSignal, answer: () => T): Promise<T> {
    if (this.script.failure !== undefined) throw this.script.failure;
    this.script.duringReplay?.(event => this.emit(event));
    // A real read yields at least once, which is the window a live append can arrive in.
    await Promise.resolve();
    if (signal.aborted) {
      this.cancelled = true;
      signal.throwIfAborted();
    }
    return answer();
  }
}

/** A scheduler nothing fires by itself, so an idle proof is a decision the test makes. */
class ManualScheduler implements EventStreamScheduler {
  /** Every delay the handler armed, in order. */
  readonly armed: number[] = [];
  cancelled = 0;
  private action: (() => void) | undefined;

  after(milliseconds: number, action: () => void): EventStreamTimer {
    this.armed.push(milliseconds);
    this.action = action;
    return {
      cancel: () => {
        this.cancelled += 1;
        this.action = undefined;
      },
    };
  }

  get pending(): boolean {
    return this.action !== undefined;
  }

  /** Runs the armed action once, exactly as a real timer firing would. */
  fire(): void {
    const action = this.action;
    this.action = undefined;
    action?.();
  }
}

class RecordingDownstream implements SocketDownstream {
  readonly sent: string[] = [];
  readonly closes: Array<readonly [number, string]> = [];
  buffered = 0;
  /** What the transport reports for a write. Negative means the peer has gone away. */
  result: number | undefined = 1;
  throwOnSend = false;

  send(frame: string | Uint8Array): number | undefined {
    if (this.throwOnSend) throw new Error('the peer vanished mid-write');
    this.sent.push(typeof frame === 'string' ? frame : new TextDecoder().decode(frame));
    return this.result;
  }

  close(code: number, reason: string): void {
    this.closes.push([code, reason]);
  }

  bufferedBytes(): number {
    return this.buffered;
  }

  /** The frames as the protocol parses them, so a shape the wire would refuse cannot pass here. */
  frames(): readonly FyEventStreamFrame[] {
    return this.sent.map(text => FyEventStreamFrameSchema.parse(JSON.parse(text)));
  }

  /** Just the delivered events, as `sessionId/sequence`. */
  events(): readonly string[] {
    return this.frames()
      .filter(frame => frame.kind === 'event')
      .map(frame => `${frame.event.sessionId}/${frame.event.sequence}`);
  }
}

function subject(scope: FleetEventStreamScope, script: SourceScript = {}) {
  const source = new ScriptedSource(script);
  const scheduler = new ManualScheduler();
  const downstream = new RecordingDownstream();
  return {
    source,
    scheduler,
    downstream,
    handler: new FleetEventStreamService(source, scheduler).handler(scope, downstream),
  };
}

const SESSION = { kind: 'session', sessionId: 's1', after: 0 } as const;
const FLEET = { kind: 'fleet' } as const;

describe('orderFleetBacklog', () => {
  it('should merge sessions by time while keeping each session in its own sequence order', () => {
    // Arrange — s1's records are handed over out of order and its second event shares an instant
    // with s2's first, which is exactly the shape a global time sort would scramble.
    const events = [stored('s1', 2, 5), stored('s2', 1, 5), stored('s1', 1, 1)];

    // Act
    const ordered = orderFleetBacklog(events);

    // Assert — a session's own sequence is authoritative; ties across sessions break by session id.
    should(ordered.map(event => `${event.sessionId}/${event.sequence}`)).deepEqual(['s1/1', 's1/2', 's2/1']);
  });

  it('should never reorder one session against its own sequence, whatever its timestamps say', () => {
    // Arrange — a clock that went backwards between two appends. The journal's sequence is the only
    // ordering the daemon actually guarantees.
    const events = [stored('s1', 1, 90), stored('s1', 2, 10)];

    // Act
    const ordered = orderFleetBacklog(events);

    // Assert
    should(ordered.map(event => event.sequence)).deepEqual([1, 2]);
  });

  it('should answer nothing for nothing', () => {
    // Act / Assert — an empty fleet is an honest empty backfill, not a refusal.
    should(orderFleetBacklog([])).deepEqual([]);
  });
});

describe('the per-session event stream', () => {
  it('should replay from the caller cursor and then follow the live edge', async () => {
    // Arrange
    const harness = subject(
      { kind: 'session', sessionId: 's1', after: 4 },
      { pages: [[stored('s1', 5), stored('s1', 6)]] },
    );

    // Act
    await harness.handler.open();
    harness.source.emit(stored('s1', 7));

    // Assert — every frame is a wrapped event, and the replay asked for exactly the caller's cursor.
    should(harness.downstream.events()).deepEqual(['s1/5', 's1/6', 's1/7']);
    should(harness.source.replayed).deepEqual([['s1', 4, 1_000]]);
    should(harness.downstream.frames().every(frame => frame.kind === 'event')).be.true();
  });

  it('should carry the journal record through the protocol envelope unchanged', async () => {
    // Arrange
    const harness = subject(SESSION, { pages: [[stored('s1', 1)]] });

    // Act
    await harness.handler.open();

    // Assert — the same envelope the paged replay and the history reader serve, so a follower and a
    // poller cannot disagree about what one event is.
    should(harness.downstream.frames()[0]).deepEqual({
      kind: 'event',
      event: {
        sequence: 1,
        time: at(1),
        sessionId: 's1',
        type: 'session.turn',
        source: 'daemon',
        data: { sequence: 1 },
      },
    });
  });

  it('should keep asking while a durable page is full', async () => {
    // Arrange — a full page means "there may be more", so a handler that stopped at one would leave
    // a follower permanently behind by everything after the first thousand records.
    const full = Array.from({ length: 1_000 }, (_, index) => stored('s1', index + 1));
    const harness = subject(SESSION, { pages: [full, [stored('s1', 1_001)]] });

    // Act
    await harness.handler.open();

    // Assert
    should(harness.source.replayed).deepEqual([
      ['s1', 0, 1_000],
      ['s1', 1_000, 1_000],
    ]);
    should(harness.downstream.sent).have.length(1_001);
  });

  it('should ignore live appends belonging to another session', async () => {
    // Arrange
    const harness = subject(SESSION, { pages: [[stored('s1', 1)]] });

    // Act
    await harness.handler.open();
    harness.source.emit(stored('s2', 1));
    harness.source.emit(stored('s1', 2));

    // Assert — a caller following one session must not be shown the rest of the fleet.
    should(harness.downstream.events()).deepEqual(['s1/1', 's1/2']);
  });

  it('should subscribe before it replays, and deduplicate the overlap', async () => {
    // Arrange — the append lands while the durable read is still in flight and is ALSO in the page
    // that read returns, which is the exact overlap a live-then-replay ordering would either lose or
    // deliver twice.
    const harness = subject(SESSION, {
      pages: [[stored('s1', 1), stored('s1', 2)]],
      duringReplay: emit => {
        emit(stored('s1', 2));
        emit(stored('s1', 3));
      },
    });

    // Act
    await harness.handler.open();

    // Assert — nothing was lost and nothing arrived twice.
    should(harness.downstream.events()).deepEqual(['s1/1', 's1/2', 's1/3']);
    should(harness.source.subscribed).equal(1);
  });

  it('should fail closed when a durable page contradicts the cursor it was asked for', async () => {
    // Arrange
    const wrongSession = subject(SESSION, { pages: [[stored('s2', 1)]] });
    const wrongCursor = subject({ kind: 'session', sessionId: 's1', after: 5 }, { pages: [[stored('s1', 3)]] });

    // Act
    await wrongSession.handler.open();
    await wrongCursor.handler.open();

    // Assert — evidence that disagrees with the question is not a shorter answer, it is no answer.
    should(wrongSession.downstream.closes).deepEqual([[1011, 'event evidence unavailable']]);
    should(wrongCursor.downstream.closes).deepEqual([[1011, 'event evidence unavailable']]);
    should(wrongSession.downstream.sent).be.empty();
  });

  it('should drop a live append the reader has already been given', async () => {
    // Arrange
    const harness = subject(SESSION, { pages: [[stored('s1', 4)]] });

    // Act
    await harness.handler.open();
    harness.source.emit(stored('s1', 4));
    harness.source.emit(stored('s1', 5));

    // Assert — the live edge is deduplicated against the cursor rather than refused: a replay that
    // raced an append is the ordinary case, and delivering sequence four twice would corrupt every
    // reader's history. The stream stays open and keeps advancing.
    should(harness.downstream.events()).deepEqual(['s1/4', 's1/5']);
    should(harness.downstream.closes).be.empty();
  });

  it('should fail closed on a live record with no usable durable identity', async () => {
    // Arrange
    const harness = subject(SESSION, { pages: [[stored('s1', 1)]] });

    // Act
    await harness.handler.open();
    harness.source.emit({ ...stored('s1', 2), sequence: -1 });

    // Assert — a negative sequence is not a late duplicate, it is evidence the journal cannot produce.
    should(harness.downstream.closes).deepEqual([[1011, 'event evidence unavailable']]);
    should(harness.downstream.events()).deepEqual(['s1/1']);
  });

  it('should fail closed on a record with no usable durable identity', async () => {
    // Arrange — a zero sequence, a fractional one and a nameless session are all states the journal
    // cannot produce, so seeing one means the evidence is not the journal's.
    const sequences = subject(SESSION, { pages: [[{ ...stored('s1', 1), sequence: 0 }]] });
    const fractional = subject(SESSION, { pages: [[{ ...stored('s1', 1), sequence: 1.5 }]] });
    const nameless = subject(SESSION, { pages: [[{ ...stored('s1', 1), sessionId: '' }]] });

    // Act
    for (const harness of [sequences, fractional, nameless]) await harness.handler.open();

    // Assert
    for (const harness of [sequences, fractional, nameless])
      should(harness.downstream.closes).deepEqual([[1011, 'event evidence unavailable']]);
  });

  it('should fail closed when the durable read itself refuses', async () => {
    // Arrange
    const harness = subject(SESSION, { failure: new Error('the journal is unreadable') });

    // Act
    await harness.handler.open();

    // Assert — a socket that opened and then went quiet would read as a healthy, idle session.
    should(harness.downstream.closes).deepEqual([[1011, 'event evidence unavailable']]);
    should(harness.source.unsubscribed).equal(1);
  });

  it('should keep proving it is quiet rather than broken, every silent window', async () => {
    // Arrange
    const harness = subject(SESSION, { pages: [[stored('s1', 9)]] });

    // Act — two consecutive silent windows with nothing at all between them, then a real event, then
    // a third window. One frame per quiet STRETCH would have produced only the first and the last.
    await harness.handler.open();
    harness.scheduler.fire();
    const afterFirstProof = harness.scheduler.pending;
    harness.scheduler.fire();
    harness.source.emit(stored('s1', 10));
    harness.scheduler.fire();

    // Assert — the proof names this session's OWN last delivered sequence, so a reader can tell a
    // stream that is caught up from one that silently stalled at an older cursor.
    should(harness.downstream.frames().filter(frame => frame.kind === 'idle')).deepEqual([
      { kind: 'idle', idleSeconds: 30, scope: { kind: 'session', sessionId: 's1', after: 9 } },
      { kind: 'idle', idleSeconds: 30, scope: { kind: 'session', sessionId: 's1', after: 9 } },
      { kind: 'idle', idleSeconds: 30, scope: { kind: 'session', sessionId: 's1', after: 10 } },
    ]);
    // A SECOND SILENT WINDOW IS STILL ARMED. One proof per quiet stretch told a reader what it wanted
    // to know and then let the connection itself fall completely silent, which is how a path dies
    // with no close frame at either end — and a close is the only thing the browser can react to.
    should(afterFirstProof).be.true();
    // Five arms on one socket: the open, one after each of the three proofs, and the one the real
    // event replaced the pending window with — the window is measured from the last thing actually
    // sent, of either kind, so an active stream never carries an idle frame.
    should(harness.scheduler.armed).deepEqual(Array.from({ length: 5 }, () => EVENT_STREAM_IDLE_MS));
  });

  it('should stop the idle schedule the moment the stream closes', async () => {
    // Arrange
    const harness = subject(SESSION, { pages: [[stored('s1', 1)]] });

    // Act
    await harness.handler.open();
    harness.scheduler.fire();
    harness.handler.close();
    harness.scheduler.fire();

    // Assert — a recurring proof must not outlive the socket it is proving.
    should(harness.scheduler.pending).be.false();
    should(harness.downstream.frames().filter(frame => frame.kind === 'idle')).have.length(1);
  });

  it('should stop re-arming once the transport refuses the proof', async () => {
    // Arrange — the peer went away between windows, which the transport reports as a failed write.
    const harness = subject(SESSION, { pages: [[stored('s1', 1)]] });

    // Act
    await harness.handler.open();
    harness.downstream.result = -1;
    harness.scheduler.fire();

    // Assert — a refused write closes the handler, and scheduling another window after that would be
    // a timer on a socket nobody holds. This is the loop's only exit that is not a close.
    should(harness.scheduler.pending).be.false();
    should(harness.source.listening).be.false();
  });

  it('should report the caller cursor in an idle proof before anything has been delivered', async () => {
    // Arrange — a follower that asked to resume after sequence 12 and found nothing newer.
    const harness = subject({ kind: 'session', sessionId: 's1', after: 12 });

    // Act
    await harness.handler.open();
    harness.scheduler.fire();

    // Assert — reporting zero here would tell the reader to replay the whole session.
    should(harness.downstream.frames()).deepEqual([
      { kind: 'idle', idleSeconds: 30, scope: { kind: 'session', sessionId: 's1', after: 12 } },
    ]);
  });
});

describe('the fleet event stream', () => {
  it('should backfill a bounded ordered tail and then follow every session', async () => {
    // Arrange
    const harness = subject(FLEET, {
      backlog: { sessionIds: ['s1', 's2', 's3'], events: [stored('s2', 1, 1), stored('s1', 1, 2)] },
    });

    // Act
    await harness.handler.open();
    harness.source.emit(stored('s3', 1, 3));

    // Assert — the bound is asked for in the source, before a journal byte is read.
    should(harness.source.backfilled).deepEqual([FLEET_EVENT_BACKLOG_LIMIT]);
    should(harness.downstream.events()).deepEqual(['s2/1', 's1/1', 's3/1']);
  });

  it('should count every session the daemon holds, not only the ones in the tail', async () => {
    // Arrange — a fleet whose third session has written nothing recent enough to reach the tail.
    const harness = subject(FLEET, { backlog: { sessionIds: ['s1', 's2', 's3'], events: [stored('s1', 1)] } });

    // Act
    await harness.handler.open();
    harness.scheduler.fire();

    // Assert — a proof counting only sessions with recent events would report a shrinking fleet
    // every time the daemon went quiet.
    should(harness.downstream.frames().at(-1)).deepEqual({
      kind: 'idle',
      idleSeconds: 30,
      scope: { kind: 'fleet', followedSessions: 3 },
    });
  });

  it('should follow a session that first appears on the live edge', async () => {
    // Arrange
    const harness = subject(FLEET, { backlog: { sessionIds: ['s1'], events: [] } });

    // Act
    await harness.handler.open();
    harness.source.emit(stored('s2', 1));
    harness.scheduler.fire();

    // Assert — a session started after the socket opened is part of the fleet it is following.
    should(harness.downstream.events()).deepEqual(['s2/1']);
    should(harness.downstream.frames().at(-1)).deepEqual({
      kind: 'idle',
      idleSeconds: 30,
      scope: { kind: 'fleet', followedSessions: 2 },
    });
  });

  it('should track each session cursor independently', async () => {
    // Arrange — two sessions whose sequences overlap, which is normal: sequence is per session.
    const harness = subject(FLEET, { backlog: { sessionIds: ['s1', 's2'], events: [stored('s1', 3, 1)] } });

    // Act
    await harness.handler.open();
    harness.source.emit(stored('s2', 1, 2));
    harness.source.emit(stored('s1', 4, 3));

    // Assert — s2's first event is not judged against s1's cursor.
    should(harness.downstream.events()).deepEqual(['s1/3', 's2/1', 's1/4']);
    should(harness.downstream.closes).be.empty();
  });

  it('should fail closed when the fleet backfill refuses', async () => {
    // Arrange — the backfill refuses when an indexed session has lost the journal its marker owes.
    const harness = subject(FLEET, { failure: new Error('fleet event index is inconsistent after re-indexing') });

    // Act
    await harness.handler.open();

    // Assert
    should(harness.downstream.closes).deepEqual([[1011, 'event evidence unavailable']]);
  });
});

describe('an event stream under pressure', () => {
  it('should refuse a reader whose transport backlog passed the ceiling', async () => {
    // Arrange
    const harness = subject(SESSION, { pages: [[stored('s1', 1)]] });

    // Act
    await harness.handler.open();
    harness.downstream.buffered = EVENT_STREAM_MAX_BUFFER_BYTES + 1;
    harness.source.emit(stored('s1', 2));

    // Assert — the only alternative is queueing without limit inside the daemon.
    should(harness.downstream.closes).deepEqual([[1013, 'event stream reader fell behind']]);
    should(harness.downstream.events()).deepEqual(['s1/1']);
    should(harness.source.unsubscribed).equal(1);
  });

  it('should bound what it holds while the durable replay is still in flight', async () => {
    // Arrange — a session appending faster than its own history can be read.
    const harness = subject(SESSION, {
      duringReplay: emit => {
        for (let sequence = 1; sequence <= EVENT_STREAM_MAX_PENDING + 1; sequence += 1) emit(stored('s1', sequence, 1));
      },
    });

    // Act
    await harness.handler.open();

    // Assert — the queue is the one place a flood cannot be pushed back on, so it is capped rather
    // than grown, and nothing is delivered from a socket that was refused.
    should(harness.downstream.closes).deepEqual([[1013, 'event stream reader fell behind']]);
    should(harness.downstream.sent).be.empty();
    should(harness.source.unsubscribed).equal(1);
  });

  it('should stop writing to a peer the transport reports as gone', async () => {
    // Arrange
    const harness = subject(SESSION, { pages: [[stored('s1', 1), stored('s1', 2)]] });
    harness.downstream.result = -1;

    // Act
    await harness.handler.open();
    harness.source.emit(stored('s1', 3));

    // Assert — a departed peer is not a refusal to report: there is nobody left to send a close to.
    should(harness.downstream.sent).have.length(1);
    should(harness.downstream.closes).be.empty();
    should(harness.source.unsubscribed).equal(1);
    should(harness.scheduler.pending).be.false();
  });

  it('should release the socket when a write throws', async () => {
    // Arrange
    const harness = subject(SESSION, { pages: [[stored('s1', 1)]] });
    harness.downstream.throwOnSend = true;

    // Act
    await harness.handler.open();

    // Assert
    should(harness.downstream.closes).be.empty();
    should(harness.source.unsubscribed).equal(1);
    should(harness.source.listening).be.false();
  });
});

describe('an event stream being torn down', () => {
  it('should refuse a client that speaks on a server-only feed', async () => {
    // Arrange
    const harness = subject(SESSION, { pages: [[stored('s1', 1)]] });

    // Act
    await harness.handler.open();
    harness.handler.fromClient('{"type":"resize"}');

    // Assert — there is no client vocabulary here at all, so accepting a frame would be inventing one.
    should(harness.downstream.closes).deepEqual([[1008, 'event stream is server-only']]);
    should(harness.source.unsubscribed).equal(1);
  });

  it('should release the subscription, the timer and the queue on close', async () => {
    // Arrange
    const harness = subject(SESSION, { pages: [[stored('s1', 1)]] });

    // Act
    await harness.handler.open();
    harness.handler.close();
    harness.source.emit(stored('s1', 2));

    // Assert — a listener or a redraw timer outliving its socket is the leak that makes a long-lived
    // daemon slowly stop serving anything else.
    should(harness.source.unsubscribed).equal(1);
    should(harness.scheduler.cancelled).be.aboveOrEqual(1);
    should(harness.scheduler.pending).be.false();
    should(harness.downstream.events()).deepEqual(['s1/1']);
  });

  it('should be safe to close twice', async () => {
    // Arrange — the transport closes an already-failed socket, which is ordinary.
    const harness = subject(SESSION, { pages: [[stored('s1', 1)]] });

    // Act
    await harness.handler.open();
    harness.handler.close();
    harness.handler.close();

    // Assert
    should(harness.source.unsubscribed).equal(1);
  });

  it('should cancel a durable read that is still in flight', async () => {
    // Arrange
    const harness = subject(SESSION, {
      pages: [[stored('s1', 1)]],
      duringReplay: () => harness.handler.close(),
    });

    // Act
    await harness.handler.open();

    // Assert — the read observed its own cancellation rather than running to completion and writing
    // into a socket nobody is holding.
    should(harness.source.cancelled).be.true();
    should(harness.downstream.sent).be.empty();
    // Cancellation is not an evidence failure, so the peer is not told the daemon broke.
    should(harness.downstream.closes).be.empty();
  });

  it('should never subscribe for a socket that was closed before it opened', async () => {
    // Arrange
    const harness = subject(SESSION, { pages: [[stored('s1', 1)]] });

    // Act
    harness.handler.close();
    await harness.handler.open();

    // Assert
    should(harness.source.subscribed).equal(0);
    should(harness.downstream.sent).be.empty();
  });
});
