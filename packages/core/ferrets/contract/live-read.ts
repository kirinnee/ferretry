/**
 * `GET /v1/ferrets/:ferretId/live`: what the ferret's own state document says RIGHT NOW about its turns and its
 * context, for the readers (Usage's Info › Usage) that otherwise read the analytics end-of-turn row and so show the
 * previous turn's numbers during a long one.
 *
 * Only these four readings are served, and a reading the document does not state is `null`, never zero (the same
 * rule as {@link FerretIngestEvidence}, which is the daemon-only form of the same facts). The answer is no wider than
 * the ferret read: whose turn it is rides Claude Code's prompt route, and a compaction rides the live frame.
 */
import { z } from 'zod';

export const FerretLiveReadSchema = z.strictObject({
  /** The send counter (`state.turn`). */
  turns: z.number().int().nonnegative().nullable(),
  /** How full the context window is, 0–100, as the harness last reported it. */
  contextPercent: z.number().finite().min(0).max(100).nullable(),
  /** The model's window in tokens, when the document states one. */
  contextWindow: z.number().int().positive().nullable(),
  /** How many tokens the context holds, as the harness last reported it (`state.contextTokens`), for "124K of 200K". */
  contextTokens: z.number().int().nonnegative().nullable(),
});
export type FerretLiveRead = z.infer<typeof FerretLiveReadSchema>;
