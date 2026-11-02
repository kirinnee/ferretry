import { z } from 'zod';
import { CompactAtSchema } from './compact-at.ts';
import { SessionViewSchema } from './session.ts';

/**
 * `GET /v1/sessions/:sessionId/compact-at` reads it; `PATCH` of the same path sets it.
 *
 * `compactAt` absent on a PATCH is not allowed: send `auto` to go back to the harness's own trigger, or `inherit` to
 * drop this ferret's own value and follow its login's default again.
 */
export const SessionCompactAtPatchSchema = z.strictObject({
  compactAt: z.union([CompactAtSchema, z.literal('inherit')]),
});
export type SessionCompactAtPatch = z.infer<typeof SessionCompactAtPatchSchema>;

/** The setting as it reads now: what `GET` answers. */
export const SessionCompactAtSchema = z.strictObject({
  /** This ferret's own value, absent when it follows its login's default. */
  own: CompactAtSchema.optional(),
  /** The value a launch would use now: the own value, else the login's default, else `auto`. */
  effective: CompactAtSchema,
  /** The model's window the value is checked against, when known. */
  window: z.number().int().positive().optional(),
  /** A running ferret was launched with its value, so a change reaches it only at its next launch. */
  restartRequired: z.boolean(),
  note: z.string().min(1),
});
export type SessionCompactAt = z.infer<typeof SessionCompactAtSchema>;

/** What setting it did: the changed `SessionView`, whether a restart is needed, and that said in words. */
export const SessionCompactAtPatchResultSchema = z.strictObject({
  view: SessionViewSchema,
  effective: CompactAtSchema,
  restartRequired: z.boolean(),
  note: z.string().min(1),
});
export type SessionCompactAtPatchResult = z.infer<typeof SessionCompactAtPatchResultSchema>;
