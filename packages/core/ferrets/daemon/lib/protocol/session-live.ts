import { z } from 'zod';
import { InstantSchema, NonNegativeIntegerSchema } from './common.ts';

/**
 * WHAT A WORKING TURN IS DOING RIGHT NOW — the live readout under a conversation.
 *
 * Sent on a session's own `/v1/events` stream as a `live` frame, only to a reader that asked for it
 * (`?live=1`), at most a few times a second and only when something changed. It is NOT a journal
 * event: nothing durable is written, nothing replays it, and a reader that joins late simply gets the
 * next sample. The durable record of a turn is still the transcript.
 *
 * ONE TURN, ONE CLOCK. `turnStartedAt` is the daemon's own `turnStateAt` for the `working` turn the
 * sample belongs to — the same boundary the whose-turn watcher writes — so a reader starts its timer
 * there and attributes these counts to that turn only. Absent means no turn is working: the readout
 * stops.
 *
 * ABSENT IS UNKNOWN, NEVER ZERO. A count is present only when the daemon read one for this turn; a
 * reader shows "—" for a missing one rather than counting up from a zero nobody measured.
 */
export const SessionLiveTokensSourceSchema = z.enum(['pane', 'transcript']);
export type SessionLiveTokensSource = z.infer<typeof SessionLiveTokensSourceSchema>;

/**
 * A CONTEXT COMPACTION, running or just finished — the second thing a `live` frame can carry.
 *
 * CLAUDE CODE REPORTS HOW FAR IT HAS GOT; CODEX DOES NOT. Current Claude Code paints a progress bar with a
 * whole percentage under its `Compacting conversation…` line, and a `↓ 37.4k tokens` figure in the clock's
 * parenthetical. When the daemon read them they ride on the frame as `percent` (0–100, the harness's
 * own reading) and `tokensWritten`. Older Claude Code and Codex paint only a clock, so both are ABSENT
 * and a reader shows a spinner, the clock and the usual duration (`expectedMs`, with the `basis` it came
 * from) — it NEVER derives a percentage of its own, because a made-up bar is a lie about a measurement.
 *
 * Every running compaction also carries FACTS the daemon measured: when it began and the context size it
 * began from.
 *
 * `done` is read back off the transcript (the harness's own boundary record), so it survives a
 * reload and a reconnect for as long as the record is inside the tail the daemon reads. `tokensAfter`
 * is optional because a harness only states the post-compaction context on its NEXT model call.
 */
export const SessionCompactionBasisSchema = z.enum(['history', 'typical']);
export type SessionCompactionBasis = z.infer<typeof SessionCompactionBasisSchema>;

export const SessionCompactionRunningSchema = z.strictObject({
  phase: z.literal('running'),
  /** When the daemon first saw the harness compacting. */
  startedAt: InstantSchema,
  /** The context size the compaction began from, when the transcript stated one. */
  tokensBefore: NonNegativeIntegerSchema.optional(),
  /** How far along the harness itself says it is, whole percent 0–100. Absent when the harness paints no bar. */
  percent: z.number().int().min(0).max(100).optional(),
  /** Tokens the harness says the compaction has written so far (↓). Absent when it paints no counter. */
  tokensWritten: NonNegativeIntegerSchema.optional(),
  /** How long a compaction usually takes here, in milliseconds — shown only when no real percent exists. */
  expectedMs: z.number().int().positive(),
  /** `history`: this daemon's own past compactions. `typical`: no history yet; a fixed prior. */
  basis: SessionCompactionBasisSchema,
});
export type SessionCompactionRunning = z.infer<typeof SessionCompactionRunningSchema>;

export const SessionCompactionDoneSchema = z.strictObject({
  phase: z.literal('done'),
  /** Who asked: the harness's own record says; absent when it did not. */
  trigger: z.enum(['manual', 'auto']).optional(),
  /** When the daemon saw it begin; absent when it only ever saw the end. */
  startedAt: InstantSchema.optional(),
  endedAt: InstantSchema,
  tokensBefore: NonNegativeIntegerSchema.optional(),
  tokensAfter: NonNegativeIntegerSchema.optional(),
});
export type SessionCompactionDone = z.infer<typeof SessionCompactionDoneSchema>;

export const SessionCompactionSchema = z.discriminatedUnion('phase', [
  SessionCompactionRunningSchema,
  SessionCompactionDoneSchema,
]);
export type SessionCompactionState = z.infer<typeof SessionCompactionSchema>;

/** Tokens a finished compaction freed, when both ends are known and the context did shrink. */
export const compactionFreed = (done: SessionCompactionDone): number | undefined =>
  done.tokensBefore === undefined || done.tokensAfter === undefined || done.tokensAfter > done.tokensBefore
    ? undefined
    : done.tokensBefore - done.tokensAfter;

export const SessionLiveActivitySchema = z.strictObject({
  sessionId: z.string().min(1),
  /** When the daemon took this sample. */
  at: InstantSchema,
  /** The working turn's start (`state.turnStateAt`). Absent when no turn is working. */
  turnStartedAt: InstantSchema.optional(),
  /** The harness's own verb off its status line (`Pontificating…`), when the pane showed one. */
  verb: z.string().min(1).max(80).optional(),
  /** Tokens the model has written this turn (↓). Same definition as Analytics' output total. */
  outputTokens: NonNegativeIntegerSchema.optional(),
  /** Tokens sent to the model this turn (↑), cache reads and writes included, as Analytics counts input. */
  inputTokens: NonNegativeIntegerSchema.optional(),
  /** Where `outputTokens` came from: the harness's own live counter, or the transcript's usage records. */
  outputSource: SessionLiveTokensSourceSchema.optional(),
  /** A compaction in progress, or the latest finished one in the transcript tail. */
  compaction: SessionCompactionSchema.optional(),
});
export type SessionLiveActivity = z.infer<typeof SessionLiveActivitySchema>;

/** The query value that asks a per-session event stream for `live` frames. */
export const SESSION_LIVE_STREAM_FLAG = '1';

/**
 * The query value (`?transcript=1`) that asks a per-session event stream for `transcript` frames: one
 * each time the session's transcript file changes, so a reader re-reads it at once instead of on its
 * next poll. Nothing in the journal says a transcript grew — a reply's text and tool calls land there
 * with no turn change — so without this a Chat showed each block only when its poll came round.
 */
export const SESSION_TRANSCRIPT_STREAM_FLAG = '1';

/**
 * "This session's transcript just changed." It carries no content: the reader re-reads the transcript
 * through the ordinary conditional read, so this frame can never disagree with it.
 */
export const SessionTranscriptMovedSchema = z.strictObject({
  sessionId: z.string().min(1),
  /** When the daemon heard the change. */
  at: InstantSchema,
});
export type SessionTranscriptMoved = z.infer<typeof SessionTranscriptMovedSchema>;
