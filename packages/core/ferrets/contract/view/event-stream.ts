import { z } from 'zod';
import { InstantSchema, NonNegativeIntegerSchema, PositiveIntegerSchema } from './common.ts';
import { FerretLiveActivitySchema as SessionLiveActivitySchema, SessionTranscriptMovedSchema } from './session-live.ts';

/**
 * The shapes on the journal event socket (`GET /v1/events`): the daemon writes them, the `fy stream` verb and the app
 * parse the same ones. They moved here from the daemon's protocol file unchanged, so a reader never forks the frame.
 */

export const FyEventSourceSchema = z.string().min(1);

/**
 * Generic event envelope. Event-specific payload schemas parse `data` after dispatch.
 *
 * WHY `turn` IS OPTIONAL. The daemon's durable session journal records exactly four things about an
 * event — its sequence, its time, its type and its data — and nothing about the turn it happened
 * during. A required `turn` therefore forced the only mounted producer to invent one, and `turn: 0`
 * on every replayed event is not a missing number, it is a WRONG one: a reader grouping by turn
 * would render a session's whole history as a single opening turn. Absent says "the daemon does not
 * record this", which is the truth, and it is the shape every consumer can act on honestly.
 */
export const FyEventSchema = z.object({
  sequence: NonNegativeIntegerSchema,
  time: InstantSchema,
  sessionId: z.string().min(1),
  turn: NonNegativeIntegerSchema.optional(),
  type: z.string().min(1),
  source: FyEventSourceSchema,
  data: z.unknown(),
  recordUuid: z.string().optional(),
  blockIndex: NonNegativeIntegerSchema.optional(),
});
export type FyEvent = z.infer<typeof FyEventSchema>;

export const FyEventListSchema = z.array(FyEventSchema);

/** Proof that a live event socket is quiet rather than broken. */
export const FyEventStreamIdleScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('session'),
    sessionId: z.string().min(1),
    /** This session's own last delivered sequence. */
    after: NonNegativeIntegerSchema,
  }),
  z.strictObject({
    kind: z.literal('fleet'),
    /** Sessions in the daemon-local fleet at the instant the proof was emitted. */
    followedSessions: NonNegativeIntegerSchema,
  }),
]);
export type FyEventStreamIdleScope = z.infer<typeof FyEventStreamIdleScopeSchema>;

/**
 * One frame on `/v1/events`.
 *
 * The wrapper keeps a heartbeat from masquerading as a session event: an idle proof has no invented
 * session id, sequence, or lifecycle type, while an event still passes through the exact envelope
 * every replay and history reader uses.
 */
export const FyEventStreamFrameSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('event'), event: FyEventSchema }),
  z.strictObject({
    kind: z.literal('idle'),
    idleSeconds: PositiveIntegerSchema,
    scope: FyEventStreamIdleScopeSchema,
  }),
  /**
   * A working turn's live readout (`session-live.ts`). Only a per-session stream opened with
   * `?live=1` ever carries one, so a reader that never asked never has to recognise it.
   */
  z.strictObject({ kind: z.literal('live'), live: SessionLiveActivitySchema }),
  /**
   * The session's transcript changed (`session-live.ts`). Only a per-session stream opened with
   * `?transcript=1` ever carries one, for the same reason as `live`.
   */
  z.strictObject({ kind: z.literal('transcript'), transcript: SessionTranscriptMovedSchema }),
]);
export type FyEventStreamFrame = z.infer<typeof FyEventStreamFrameSchema>;
