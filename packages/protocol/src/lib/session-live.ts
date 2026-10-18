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
});
export type SessionLiveActivity = z.infer<typeof SessionLiveActivitySchema>;

/** The query value that asks a per-session event stream for `live` frames. */
export const SESSION_LIVE_STREAM_FLAG = '1';
