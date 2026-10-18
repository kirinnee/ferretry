import { stat } from 'node:fs/promises';
import { type SessionLiveActivity, SessionStateSchema } from '@ferretry/protocol';
import {
  type ClockPort,
  type LiveActivitySource,
  liveActivitySample,
  type PaneState,
  paneLiveReading,
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

  constructor(
    private readonly reads: LiveActivityReads,
    private readonly tail: SessionTranscriptTail,
    private readonly clock: ClockPort,
  ) {}

  async sample(sessionId: string, signal: AbortSignal): Promise<SessionLiveActivity | undefined> {
    const id = tryParseSessionId(sessionId);
    if (id === undefined) return undefined;
    const state = SessionStateSchema.safeParse(await this.reads.readState(id).catch(() => undefined));
    if (!state.success) return undefined;
    const at = this.clock.now();
    const turnStartedAt = state.data.turnState === 'working' ? state.data.turnStateAt : undefined;
    const startedMs = turnStartedAt === undefined ? Number.NaN : Date.parse(turnStartedAt);
    if (turnStartedAt === undefined || !Number.isFinite(startedMs)) {
      this.tails.delete(id);
      return liveActivitySample({ sessionId, at, turnStartedAt: undefined, pane: undefined, transcript: undefined });
    }
    signal.throwIfAborted();
    const [pane, tail] = await Promise.all([this.reads.paneState(id).catch(() => undefined), this.transcript(id)]);
    signal.throwIfAborted();
    return liveActivitySample({
      sessionId,
      at,
      turnStartedAt,
      pane: pane === undefined ? undefined : paneLiveReading(pane.visible),
      transcript:
        tail === undefined ? undefined : turnTokensSince(tail.events, startedMs, tail.events.length < LIVE_TAIL_EVENTS),
    });
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
