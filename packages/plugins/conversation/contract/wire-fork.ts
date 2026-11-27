/**
 * Forking a ferret into a new one from a message of its conversation (`POST /v1/ferrets/:ferretId/fork`, c58-37 PR11).
 *
 * The caller says WHERE with the `point` and `selectionBinding` of a row it read (`GET …/messages`), echoed byte for byte:
 * the binding is the daemon's own proof that the raw message at that point is still the one the caller saw, so a conversation
 * that was rewritten in between refuses (`selection_stale`) instead of forking different words. The harness is never named:
 * the new ferret runs the source's own harness and login.
 */
import { normalizeCallsign } from '@ferretry/core-ferrets/contract';
import { z } from 'zod';

/** A ferret's name is its callsign, and Ferrets refuses any other spelling after the fork has been cut: say so before. */
export const FORK_NAME_RULE = 'A name starts with a letter and has only letters, digits and hyphens, like fix-login.';

export const ForkRequestSchema = z.strictObject({
  /** The message the cut is made at, as a transcript page spelled it. */
  point: z.string().min(1),
  /** The binding that page issued for exactly that message; opaque, echoed unchanged. */
  selectionBinding: z.string().min(1),
  /** The new ferret's name (a callsign); absent, Ferrets gives it one as it does any start. */
  name: z
    .string()
    .trim()
    .refine(name => normalizeCallsign(name) !== null, FORK_NAME_RULE)
    .optional(),
  /** `new`: a new worktree cut from the source checkout's HEAD (uncommitted changes are not copied). `same`: the source's folder. */
  worktree: z.enum(['new', 'same']).default('same'),
});
export type ForkRequest = z.infer<typeof ForkRequestSchema>;

/**
 * What a fork made, as a phone on the far side of a relay may read it: no folder, path or conversation id of this host.
 * The new ferret's own page says where it works.
 */
export const ForkResultSchema = z.strictObject({
  /** The new ferret. */
  ferret: z.string().min(1),
  /** Present when a new worktree was made: the branch it stands on. */
  worktree: z.strictObject({ branch: z.string().min(1) }).optional(),
  /** How many of the source's attachments the new ferret can open. */
  attachments: z.number().int().nonnegative(),
  /** Something the person should read: the fork was made but one part was not carried. */
  notice: z.string().min(1).optional(),
});
export type ForkResult = z.infer<typeof ForkResultSchema>;
