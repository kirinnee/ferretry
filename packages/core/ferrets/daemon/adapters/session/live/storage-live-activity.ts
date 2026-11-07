import { stat } from 'node:fs/promises';
import { type SessionCompactionState, type SessionLiveActivity, SessionStateSchema } from '@ferretry/protocol';
import {
  type ClockPort,
  type CompactionHistory,
  type CompactionTracker,
  type LiveActivitySource,
  liveActivitySample,
  type PaneState,
  paneLiveReading,
  type PaneCompaction,
  paneCompaction,
  expectedCompaction,
  resolveCompaction,
  type SessionId,
  type SessionTranscriptTail,
  type TranscriptEvent,
  tryParseSessionId,
  turnTokensSince,
} from '../../../lib/index.ts';

/**
 * How much of a transcript's end one sample reads. A working turn's usage records are near the end,
 * but a long turn has many tool calls: this reaches back far enough for nearly every turn, and a turn
 * longer than this reports its counts as unknown rather than as a partial sum.
 */
const LIVE_TAIL_EVENTS = 400;

/** How often an IDLE session's pane is read to notice a compaction that began without a working turn. */
const IDLE_PANE_READ_MS = 2_000;

/** The session reads one sample needs, each owned elsewhere and passed in. */
export interface LiveActivityReads {
  /** The session's state document, unparsed. */
  readState(id: SessionId): Promise<unknown>;
  /** The session's live pane as captured now (the turn watcher's own read). */
  paneState(id: SessionId): Promise<PaneState | undefined>;
  /** The transcript file proved to be this session's, or `undefined` before one is. */
  transcriptFile(id: SessionId): Promise<string | undefined>;
}

interface CachedTail {
  readonly file: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly events: readonly TranscriptEvent[];
}

/**
 * The `?live=1` readout over this daemon's own storage, transcripts and tmux server.
 *
 * Only a WORKING turn is read: the whose-turn watcher's `turnState` decides, and its `turnStateAt` is
 * the turn's start, so the reader's clock and these counts share the one boundary every other surface
 * uses. For any other turn the sample carries no turn at all and costs one state read.
 *
 * The transcript is re-parsed only when its file changed — a half-second sample over a quiet turn is
 * a `stat`. The pane is the same capture the turn watcher and the send path make.
 */
export class StorageLiveActivitySource implements LiveActivitySource {
  private readonly tails = new Map<SessionId, CachedTail>();
  private readonly trackers = new Map<SessionId, CompactionTracker>();
  private readonly idlePaneReads = new Map<
    SessionId,
    { readonly at: number; readonly compaction: PaneCompaction | false | undefined }
  >();

  constructor(
    private readonly reads: LiveActivityReads,
    private readonly tail: SessionTranscriptTail,
    private readonly clock: ClockPort,
    private readonly history?: CompactionHistory,
  ) {}

  async sample(sessionId: string, signal: AbortSignal): Promise<SessionLiveActivity | undefined> {
    const id = tryParseSessionId(sessionId);
    if (id === undefined) return undefined;
    const state = SessionStateSchema.safeParse(await this.reads.readState(id).catch(() => undefined));
    if (!state.success) return undefined;
    const at = this.clock.now();
    const nowMs = Date.parse(at);
    const turnStartedAt = state.data.turnState === 'working' ? state.data.turnStateAt : undefined;
    const startedMs = turnStartedAt === undefined ? Number.NaN : Date.parse(turnStartedAt);
    const working = turnStartedAt !== undefined && Number.isFinite(startedMs);
    signal.throwIfAborted();
    const [pane, tail] = await Promise.all([this.paneFor(id, working, nowMs), this.transcript(id)]);
    signal.throwIfAborted();
    const compaction = await this.compactionFor(id, state.data.observedModel, pane, tail, nowMs);
    if (!working)
      return liveActivitySample({
        sessionId,
        at,
        turnStartedAt: undefined,
        pane: undefined,
        transcript: undefined,
        compaction,
      });
    return liveActivitySample({
      sessionId,
      at,
      turnStartedAt,
      pane: pane === undefined ? undefined : paneLiveReading(pane.visible),
      transcript:
        tail === undefined ? undefined : turnTokensSince(tail.events, startedMs, tail.events.length < LIVE_TAIL_EVENTS),
      compaction,
    });
  }

  /**
   * The pane, read every sample while a turn works and at most every {@link IDLE_PANE_READ_MS} while it
   * does not — except while a compaction is being tracked, which needs every sample to see it end.
   */
  private async paneFor(id: SessionId, working: boolean, nowMs: number): Promise<PaneState | undefined> {
    const tracking = this.trackers.has(id) && this.trackers.get(id)?.recorded !== true;
    const last = this.idlePaneReads.get(id);
    if (!working && !tracking && last !== undefined && nowMs - last.at < IDLE_PANE_READ_MS) return undefined;
    const pane = await this.reads.paneState(id).catch(() => undefined);
    this.idlePaneReads.set(id, {
      at: nowMs,
      compaction: pane === undefined ? undefined : (paneCompaction(pane.visible) ?? false),
    });
    return pane;
  }

  private async compactionFor(
    id: SessionId,
    model: string | undefined,
    pane: PaneState | undefined,
    tail: CachedTail | undefined,
    nowMs: number,
  ): Promise<SessionCompactionState | undefined> {
    const events = tail?.events ?? [];
    const harness = events[0]?.harness ?? 'claude';
    const tracker = this.trackers.get(id);
    // A skipped idle read repeats what the last read said, so a quiet session neither forgets nor invents one.
    const reading =
      pane === undefined
        ? tracker === undefined
          ? undefined
          : this.idlePaneReads.get(id)?.compaction
        : (paneCompaction(pane.visible) ?? false);
    const paneCompacting = reading === undefined ? undefined : reading !== false;
    const estimate = expectedCompaction(harness, (await this.history?.durations(harness, model).catch(() => [])) ?? []);
    const verdict = resolveCompaction({
      nowMs,
      paneCompacting,
      ...(reading === undefined || reading === false ? {} : { progress: reading }),
      events,
      tracker,
      estimate,
    });
    if (verdict.tracker === undefined) this.trackers.delete(id);
    else this.trackers.set(id, verdict.tracker);
    if (verdict.finished !== undefined) {
      await this.history
        ?.record({
          harness,
          ...(model === undefined ? {} : { model }),
          durationMs: verdict.finished.durationMs,
          ...(verdict.finished.tokensBefore === undefined ? {} : { tokensBefore: verdict.finished.tokensBefore }),
          at: new Date(nowMs).toISOString(),
        })
        .catch(() => undefined);
    }
    return verdict.compaction;
  }

  private async transcript(id: SessionId): Promise<CachedTail | undefined> {
    const file = await this.reads.transcriptFile(id).catch(() => undefined);
    if (file === undefined) return undefined;
    const stats = await stat(file).catch(() => undefined);
    if (stats === undefined) return undefined;
    const cached = this.tails.get(id);
    if (cached?.file === file && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) return cached;
    const read = await this.tail.tail(id, LIVE_TAIL_EVENTS).catch(() => undefined);
    if (read?.kind !== 'read') return undefined;
    const fresh = { file, size: stats.size, mtimeMs: stats.mtimeMs, events: read.events };
    this.tails.set(id, fresh);
    return fresh;
  }
}
