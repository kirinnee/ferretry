import {
  type FyEventStreamFrame,
  FyEventStreamFrameSchema,
  type FyEventStreamIdleScope,
  type SessionLiveActivity,
} from '@ferretry/protocol';
import type { SocketDownstream, SocketFrame, SocketHandler } from '../../api/socket.ts';
import { sameLiveReading } from '../live/policy.ts';
import { journalEventToFyEvent, type StoredSessionEvent } from '../reads/service.ts';

/**
 * The source-compatible fleet backfill bound: recent tail, then live. It is also the default and the
 * ceiling of `?tail=`, so a reader may ask for less history than an old reader got, never more.
 */
export const FLEET_EVENT_BACKLOG_LIMIT = 5_000;
/** A quiet socket proves it is live after the same window the polling port established. */
export const EVENT_STREAM_IDLE_MS = 30_000;
/** Live appends admitted while durable replay is still in flight. */
export const EVENT_STREAM_MAX_PENDING = 4_096;
/** A slow reader may hold at most one MiB in the host socket. */
export const EVENT_STREAM_MAX_BUFFER_BYTES = 1_024 * 1_024;
/**
 * How often a `?live=1` stream samples its working turn: twice a second. Fast enough that the
 * reader's count-up always has a fresh target, slow enough that a watched session costs one pane
 * capture per half second. A sample that says nothing new sends nothing.
 */
export const LIVE_SAMPLE_MS = 500;

export const FLEET_EVENT_STREAM_CLOSES = {
  clientFrame: { code: 1008, reason: 'event stream is server-only' },
  evidence: { code: 1011, reason: 'event evidence unavailable' },
  slowReader: { code: 1013, reason: 'event stream reader fell behind' },
} as const;

export type FleetEventStreamScope =
  | {
      readonly kind: 'session';
      readonly sessionId: string;
      readonly after: number;
      readonly live?: boolean;
      /** `?transcript=1`: send a `transcript` frame each time the session's transcript file changes. */
      readonly transcript?: boolean;
    }
  | {
      readonly kind: 'fleet';
      /**
       * How many recent events to replay before going live; {@link FLEET_EVENT_BACKLOG_LIMIT} when
       * absent. `0` starts at the instant the stream subscribed and replays nothing.
       */
      readonly tail?: number;
    };

export interface FleetEventBacklog {
  /** Every session this daemon currently holds, including sessions with no events in the tail. */
  readonly sessionIds: readonly string[];
  /** At most `limit` recent events across those sessions — none at all for a limit of `0`. */
  readonly events: readonly StoredSessionEvent[];
}

/** Durable replay plus the live append edge, all from one opened daemon storage. */
export interface FleetEventSource {
  replay(
    sessionId: string,
    afterSequence: number,
    limit: number,
    signal: AbortSignal,
  ): Promise<readonly StoredSessionEvent[]>;
  fleetBacklog(limit: number, signal: AbortSignal): Promise<FleetEventBacklog>;
  subscribe(listener: (event: StoredSessionEvent) => void): () => void;
}

/**
 * A working turn's live readout, read on demand. `undefined` when the session cannot be read right
 * now; a throw is treated the same, because a readout is a courtesy and never a reason to end a feed.
 */
export interface LiveActivitySource {
  sample(sessionId: string, signal: AbortSignal): Promise<SessionLiveActivity | undefined>;
}

/**
 * Where a session's transcript changes are heard: the file it has proved as its own, through the
 * daemon's file-event hub. `onChange` is handed the instant the change was heard.
 */
export interface TranscriptChangeSource {
  watch(sessionId: string, onChange: (at: string) => void): TranscriptChangeWatch;
}

export interface TranscriptChangeWatch {
  /**
   * The session's journal moved, so the file it owns may have too — a first message binds one, a
   * `/clear` or a resume moves to another. Re-resolved here rather than polled.
   */
  refresh(): void;
  close(): void;
}

export interface EventStreamTimer {
  cancel(): void;
}

export interface EventStreamScheduler {
  after(milliseconds: number, action: () => void): EventStreamTimer;
}

interface ReplayGroup {
  readonly events: readonly StoredSessionEvent[];
  readonly index: number;
}

function eventOrder(left: StoredSessionEvent, right: StoredSessionEvent): number {
  const time = Date.parse(left.time) - Date.parse(right.time);
  return time || left.sessionId.localeCompare(right.sessionId) || left.sequence - right.sequence;
}

/** Merge a fleet tail while preserving each session's authoritative sequence order. */
export function orderFleetBacklog(events: readonly StoredSessionEvent[]): readonly StoredSessionEvent[] {
  const grouped = new Map<string, StoredSessionEvent[]>();
  for (const event of events) {
    const group = grouped.get(event.sessionId) ?? [];
    group.push(event);
    grouped.set(event.sessionId, group);
  }
  const pending: ReplayGroup[] = [...grouped.values()].map(group => ({
    events: group.sort((left, right) => left.sequence - right.sequence),
    index: 0,
  }));
  const ordered: StoredSessionEvent[] = [];
  while (pending.length > 0) {
    let selected = 0;
    for (let index = 1; index < pending.length; index += 1) {
      const candidate = pending[index]?.events[pending[index]?.index ?? 0];
      const current = pending[selected]?.events[pending[selected]?.index ?? 0];
      if (candidate !== undefined && current !== undefined && eventOrder(candidate, current) < 0) selected = index;
    }
    const group = pending[selected];
    const event = group?.events[group.index];
    if (group === undefined || event === undefined) throw new Error('fleet backlog merge lost its selected event');
    ordered.push(event);
    const next = group.index + 1;
    if (next === group.events.length) pending.splice(selected, 1);
    else pending[selected] = { events: group.events, index: next };
  }
  return ordered;
}

class FleetEventSocketHandler implements SocketHandler {
  private readonly abort = new AbortController();
  private readonly cursors = new Map<string, number>();
  private readonly knownSessions = new Set<string>();
  private pending: StoredSessionEvent[] = [];
  private unsubscribe: (() => void) | undefined;
  private idle: EventStreamTimer | undefined;
  private live: EventStreamTimer | undefined;
  private lastLive: SessionLiveActivity | undefined;
  private transcriptWatch: TranscriptChangeWatch | undefined;
  private replaying = true;
  private closed = false;

  constructor(
    private readonly scope: FleetEventStreamScope,
    private readonly source: FleetEventSource,
    private readonly scheduler: EventStreamScheduler,
    private readonly downstream: SocketDownstream,
    private readonly liveSource?: LiveActivitySource,
    private readonly transcriptSource?: TranscriptChangeSource,
  ) {
    if (scope.kind === 'session') {
      this.cursors.set(scope.sessionId, scope.after);
      this.knownSessions.add(scope.sessionId);
    }
  }

  async open(): Promise<void> {
    if (this.closed) return;
    const unsubscribe = this.source.subscribe(event => this.receive(event));
    if (this.closed) {
      unsubscribe();
      return;
    }
    this.unsubscribe = unsubscribe;
    try {
      if (this.scope.kind === 'session') await this.replaySession();
      else await this.replayFleet(this.scope.tail ?? FLEET_EVENT_BACKLOG_LIMIT);
      if (this.closed) return;
      this.replaying = false;
      const queued = this.pending;
      this.pending = [];
      for (const event of queued) {
        if (!this.deliver(event, true, false)) return;
      }
      if (!this.send(this.idleFrame())) return;
      this.armIdle();
      this.armLive(0);
      this.watchTranscript();
    } catch {
      if (!this.closed && !this.abort.signal.aborted) this.fail(FLEET_EVENT_STREAM_CLOSES.evidence);
    }
  }

  private async replaySession(): Promise<void> {
    if (this.scope.kind !== 'session') return;
    let cursor = this.scope.after;
    for (;;) {
      this.abort.signal.throwIfAborted();
      const page = await this.source.replay(this.scope.sessionId, cursor, 1_000, this.abort.signal);
      this.abort.signal.throwIfAborted();
      for (const event of page) {
        if (event.sessionId !== this.scope.sessionId || event.sequence <= cursor)
          throw new Error('per-session replay contradicted its requested cursor');
        if (!this.deliver(event, false, false)) return;
        cursor = event.sequence;
      }
      if (page.length < 1_000) return;
    }
  }

  private async replayFleet(tail: number): Promise<void> {
    const backlog = await this.source.fleetBacklog(tail, this.abort.signal);
    this.abort.signal.throwIfAborted();
    for (const sessionId of backlog.sessionIds) this.knownSessions.add(sessionId);
    for (const event of orderFleetBacklog(backlog.events)) {
      if (!this.deliver(event, false, false)) return;
    }
  }

  private receive(event: StoredSessionEvent): void {
    if (this.closed) return;
    if (this.scope.kind === 'session' && event.sessionId !== this.scope.sessionId) return;
    if (this.replaying) {
      if (this.pending.length >= EVENT_STREAM_MAX_PENDING) {
        this.fail(FLEET_EVENT_STREAM_CLOSES.slowReader);
        return;
      }
      this.pending.push(event);
      return;
    }
    try {
      this.deliver(event, true, true);
    } catch {
      this.fail(FLEET_EVENT_STREAM_CLOSES.evidence);
      return;
    }
    this.transcriptWatch?.refresh();
  }

  /** Deliver one event. `dedupe` is used only for the replay/live overlap queue. */
  private deliver(event: StoredSessionEvent, dedupe: boolean, resetIdle: boolean): boolean {
    if (this.closed) return false;
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 1 || event.sessionId === '')
      throw new Error('event source returned an invalid durable identity');
    const previous = this.cursors.get(event.sessionId) ?? 0;
    if (event.sequence <= previous) {
      if (dedupe) return true;
      throw new Error('event source returned non-advancing evidence');
    }
    const frame: FyEventStreamFrame = { kind: 'event', event: journalEventToFyEvent(event) };
    if (!this.send(frame)) return false;
    this.cursors.set(event.sessionId, event.sequence);
    this.knownSessions.add(event.sessionId);
    if (resetIdle) this.armIdle();
    return true;
  }

  private send(frame: FyEventStreamFrame): boolean {
    if (this.closed) return false;
    if (this.downstream.bufferedBytes() > EVENT_STREAM_MAX_BUFFER_BYTES) {
      this.fail(FLEET_EVENT_STREAM_CLOSES.slowReader);
      return false;
    }
    const encoded = JSON.stringify(FyEventStreamFrameSchema.parse(frame));
    let sent: number | undefined;
    try {
      sent = this.downstream.send(encoded);
    } catch {
      this.close();
      return false;
    }
    if (sent === undefined || sent < 0) {
      this.close();
      return false;
    }
    return true;
  }

  private idleScope(): FyEventStreamIdleScope {
    return this.scope.kind === 'session'
      ? {
          kind: 'session',
          sessionId: this.scope.sessionId,
          after: this.cursors.get(this.scope.sessionId) ?? this.scope.after,
        }
      : { kind: 'fleet', followedSessions: this.knownSessions.size };
  }

  /**
   * The proof that this socket is live, and where it stands.
   *
   * IT IS SENT ONCE AS SOON AS THE REPLAY IS DONE, and then once per quiet window ({@link armIdle}).
   * A reader counts a feed as live only once it has heard from it, and a quiet session used to say
   * nothing for the first thirty seconds — so every reader ran its fast fallback polls for those
   * thirty seconds on every open, which on a phone is most of the reason for having a feed at all.
   * The opening proof also marks the edge a reader needs: everything before it was replay, everything
   * after it is live, and `after` is the session's sequence at that edge.
   *
   * IT IS THE OLD FRAME, NOT A NEW KIND, because the frame schema is strict: a reader that predates
   * this would refuse an unknown kind or key, and with it the whole stream. `idleSeconds` keeps its
   * meaning — the window this daemon promises a proof within — which is what a reader's watchdog reads
   * it as. A reader that also prints it as "nothing for N seconds" says so once too early, on stderr.
   */
  private idleFrame(): FyEventStreamFrame {
    return { kind: 'idle', idleSeconds: EVENT_STREAM_IDLE_MS / 1_000, scope: this.idleScope() };
  }

  /**
   * Keep proving this socket is alive for as long as it is quiet.
   *
   * EVERY QUIET WINDOW, NOT ONCE PER QUIET STRETCH. A single frame per silence was enough to tell a
   * reader "nothing has happened yet" and is not enough to keep the connection itself alive: a
   * session nobody is typing into emitted one frame at thirty seconds and then nothing at all,
   * forever, and every stateful hop between the two ends — a home router's NAT table, a corporate
   * proxy's idle list — stops being refreshed from that moment. What dies then dies silently, with
   * no close frame either end can observe, which is the one failure a reader cannot be told about.
   * Recurring traffic is what turns a dead path into a close the other end can actually see, which
   * is the whole precondition for the browser deciding to reconnect.
   *
   * A REAL EVENT RE-ARMS THIS FROM `deliver`, so an active stream never carries an idle frame: the
   * window is measured from the last thing actually sent, whichever kind it was.
   *
   * A REFUSED WRITE STOPS THE SCHEDULE. `send` answers false once it has closed or failed the
   * handler, and re-arming past that would leave a timer holding a socket nobody owns.
   */
  private armIdle(): void {
    if (this.closed) return;
    this.idle?.cancel();
    this.idle = this.scheduler.after(EVENT_STREAM_IDLE_MS, () => {
      this.idle = undefined;
      try {
        if (!this.send(this.idleFrame())) return;
        this.armIdle();
      } catch {
        this.fail(FLEET_EVENT_STREAM_CLOSES.evidence);
      }
    });
  }

  /**
   * Sample the working turn, send what changed, and come back in {@link LIVE_SAMPLE_MS}.
   *
   * Only a per-session stream that asked (`?live=1`) runs this, and only after its replay: a reader is
   * told the durable history before the present. One sample is in flight at a time — the next is
   * scheduled when this one settles — so a slow read slows the readout rather than stacking reads.
   * A failed or unparseable sample is skipped, never fatal: the feed is the record, the readout is not.
   */
  private armLive(delayMs: number): void {
    const source = this.liveSource;
    if (this.closed || source === undefined || this.scope.kind !== 'session' || this.scope.live !== true) return;
    const sessionId = this.scope.sessionId;
    this.live = this.scheduler.after(delayMs, () => {
      this.live = undefined;
      void this.sampleLive(source, sessionId);
    });
  }

  private async sampleLive(source: LiveActivitySource, sessionId: string): Promise<void> {
    const sample = await source.sample(sessionId, this.abort.signal).catch(() => undefined);
    if (this.closed) return;
    if (sample !== undefined && !sameLiveReading(this.lastLive, sample)) {
      // `send` parses the frame first; a sample the schema refuses is dropped, not sent and not remembered.
      let sent: boolean | undefined;
      try {
        sent = this.send({ kind: 'live', live: sample });
      } catch {
        sent = undefined;
      }
      if (sent === false) return;
      if (sent === true) {
        this.lastLive = sample;
        this.armIdle();
      }
    }
    this.armLive(LIVE_SAMPLE_MS);
  }

  /**
   * Say when the transcript changes, for a per-session stream that asked (`?transcript=1`).
   *
   * THE JOURNAL CANNOT SAY IT. A reply's text, its tool calls and their results reach the transcript with
   * no turn change, so a reader that re-read only on events showed each block when its poll came round —
   * seconds after the agent wrote it. The hub hears the file within its settle; this frame carries no
   * content, so the reader re-reads through its ordinary conditional read and the two can never disagree.
   *
   * Started after the replay, like the live readout: a reader is told the history before the present.
   */
  private watchTranscript(): void {
    const source = this.transcriptSource;
    if (this.closed || source === undefined || this.scope.kind !== 'session' || this.scope.transcript !== true) return;
    const sessionId = this.scope.sessionId;
    this.transcriptWatch = source.watch(sessionId, at => this.transcriptMoved(sessionId, at));
  }

  private transcriptMoved(sessionId: string, at: string): void {
    if (this.closed) return;
    try {
      if (this.send({ kind: 'transcript', transcript: { sessionId, at } })) this.armIdle();
    } catch {
      this.fail(FLEET_EVENT_STREAM_CLOSES.evidence);
    }
  }

  private fail(close: { readonly code: number; readonly reason: string }): void {
    if (this.closed) return;
    this.close();
    this.downstream.close(close.code, close.reason);
  }

  fromClient(_frame: SocketFrame): void {
    this.fail(FLEET_EVENT_STREAM_CLOSES.clientFrame);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort(new Error('event stream closed'));
    this.idle?.cancel();
    this.idle = undefined;
    this.live?.cancel();
    this.live = undefined;
    this.transcriptWatch?.close();
    this.transcriptWatch = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.pending = [];
  }
}

/** Builds one handler per accepted socket; no listener exists before the transport actually opens. */
export class FleetEventStreamService {
  constructor(
    private readonly source: FleetEventSource,
    private readonly scheduler: EventStreamScheduler,
    /** The live readout behind `?live=1`. Absent, such a stream simply carries no `live` frames. */
    private readonly liveSource?: LiveActivitySource,
    /** The transcript signal behind `?transcript=1`. Absent, such a stream carries no `transcript` frames. */
    private readonly transcriptSource?: TranscriptChangeSource,
  ) {}

  handler(scope: FleetEventStreamScope, downstream: SocketDownstream): SocketHandler {
    return new FleetEventSocketHandler(
      scope,
      this.source,
      this.scheduler,
      downstream,
      this.liveSource,
      this.transcriptSource,
    );
  }
}
