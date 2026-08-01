import { type FyEventStreamFrame, FyEventStreamFrameSchema, type FyEventStreamIdleScope } from '@ferretry/protocol';
import type { SocketDownstream, SocketFrame, SocketHandler } from '../../api/socket.ts';
import { journalEventToFyEvent, type StoredSessionEvent } from '../reads/service.ts';

/** The source-compatible fleet backfill bound: recent tail, then live. */
export const FLEET_EVENT_BACKLOG_LIMIT = 5_000;
/** A quiet socket proves it is live after the same window the polling port established. */
export const EVENT_STREAM_IDLE_MS = 30_000;
/** Live appends admitted while durable replay is still in flight. */
export const EVENT_STREAM_MAX_PENDING = 4_096;
/** A slow reader may hold at most one MiB in the host socket. */
export const EVENT_STREAM_MAX_BUFFER_BYTES = 1_024 * 1_024;

export const FLEET_EVENT_STREAM_CLOSES = {
  clientFrame: { code: 1008, reason: 'event stream is server-only' },
  evidence: { code: 1011, reason: 'event evidence unavailable' },
  slowReader: { code: 1013, reason: 'event stream reader fell behind' },
} as const;

export type FleetEventStreamScope =
  | { readonly kind: 'session'; readonly sessionId: string; readonly after: number }
  | { readonly kind: 'fleet' };

export interface FleetEventBacklog {
  /** Every session this daemon currently holds, including sessions with no events in the tail. */
  readonly sessionIds: readonly string[];
  /** At most {@link FLEET_EVENT_BACKLOG_LIMIT} recent events across those sessions. */
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
  private replaying = true;
  private closed = false;

  constructor(
    private readonly scope: FleetEventStreamScope,
    private readonly source: FleetEventSource,
    private readonly scheduler: EventStreamScheduler,
    private readonly downstream: SocketDownstream,
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
      else await this.replayFleet();
      if (this.closed) return;
      this.replaying = false;
      const queued = this.pending;
      this.pending = [];
      for (const event of queued) {
        if (!this.deliver(event, true, false)) return;
      }
      this.armIdle();
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

  private async replayFleet(): Promise<void> {
    const backlog = await this.source.fleetBacklog(FLEET_EVENT_BACKLOG_LIMIT, this.abort.signal);
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
    }
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

  private armIdle(): void {
    if (this.closed) return;
    this.idle?.cancel();
    this.idle = this.scheduler.after(EVENT_STREAM_IDLE_MS, () => {
      this.idle = undefined;
      try {
        // Once per quiet stretch, matching the poller's precedent. A later event re-arms it.
        this.send({ kind: 'idle', idleSeconds: EVENT_STREAM_IDLE_MS / 1_000, scope: this.idleScope() });
      } catch {
        this.fail(FLEET_EVENT_STREAM_CLOSES.evidence);
      }
    });
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
  ) {}

  handler(scope: FleetEventStreamScope, downstream: SocketDownstream): SocketHandler {
    return new FleetEventSocketHandler(scope, this.source, this.scheduler, downstream);
  }
}
