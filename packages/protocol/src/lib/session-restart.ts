import { z } from 'zod';
import { InstantSchema, NonNegativeIntegerSchema } from './common.ts';
import { LaunchInstructionSectionIdSchema } from './session.ts';

/**
 * Restarting ferrets that run on out-of-date instructions (docs/launch-settings.md, "Restarting ferrets
 * whose instructions are out of date").
 *
 * A restart is the same-login migrate with the conversation resumed — never a fresh conversation, never
 * past the in-flight inventory. A ferret that is busy is QUEUED and restarted at its next idle moment, so
 * every answer here is a split between what happened now and what is waiting.
 */

/** Who a restart is for: the ferrets that are outdated, every running ferret, or the ones named. */
export const RestartScopeSchema = z.enum(['outdated', 'all', 'ids']);
export type RestartScope = z.infer<typeof RestartScopeSchema>;

/**
 * `POST /v1/restarts`. `ids` is required for `ids` and refused for the other scopes. `caller` is the
 * ferret that typed the command, when it was a ferret: that ferret is queued rather than restarted in the
 * middle of its own turn.
 */
export const RestartRequestSchema = z
  .strictObject({
    scope: RestartScopeSchema,
    ids: z.array(z.string().min(1)).min(1).max(500).optional(),
    caller: z.string().min(1).optional(),
  })
  .superRefine((request, context) => {
    if (request.scope === 'ids' && request.ids === undefined)
      context.addIssue({ code: 'custom', path: ['ids'], message: 'scope "ids" needs the ids to restart' });
    if (request.scope !== 'ids' && request.ids !== undefined)
      context.addIssue({ code: 'custom', path: ['ids'], message: `scope "${request.scope}" takes no ids` });
  });
export type RestartRequest = z.infer<typeof RestartRequestSchema>;

/**
 * Why a restart waits.
 *
 *   mid-turn     the ferret is working, or its turn waits on someone — it is not at a your-turn or a declared wait
 *   in-flight    it is idle, but the migrate inventory found work a restart would lose (a tool, a process)
 *   own-session  the ferret that asked is the one to restart; it goes when its own turn ends
 */
export const RestartQueueReasonSchema = z.enum(['mid-turn', 'in-flight', 'own-session']);
export type RestartQueueReason = z.infer<typeof RestartQueueReasonSchema>;

/** Why a ferret was left alone by a restart that named it or matched it. */
export const RestartSkipReasonSchema = z.enum(['not-running', 'not-outdated', 'not-found']);
export type RestartSkipReason = z.infer<typeof RestartSkipReasonSchema>;

const NamedSchema = { id: z.string().min(1), name: z.string().min(1).optional() };

export const RestartQueuedSchema = z.strictObject({
  ...NamedSchema,
  reason: RestartQueueReasonSchema,
  /** The sentence behind `in-flight`: what the inventory found. */
  detail: z.string().optional(),
});
export type RestartQueued = z.infer<typeof RestartQueuedSchema>;

/** The answer to a restart: which ferrets restarted now, which wait, which were left alone, which failed. */
export const RestartResultSchema = z.strictObject({
  restarted: z.array(z.strictObject(NamedSchema)),
  queued: z.array(RestartQueuedSchema),
  skipped: z.array(z.strictObject({ ...NamedSchema, reason: RestartSkipReasonSchema })),
  failed: z.array(z.strictObject({ ...NamedSchema, reason: z.string().min(1) })),
});
export type RestartResult = z.infer<typeof RestartResultSchema>;

/** One waiting restart. `onlyIfOutdated` drops it when the ferret stops being outdated first. */
export const RestartQueueEntrySchema = z.strictObject({
  ...NamedSchema,
  since: InstantSchema,
  reason: RestartQueueReasonSchema,
  onlyIfOutdated: z.boolean(),
});
export type RestartQueueEntry = z.infer<typeof RestartQueueEntrySchema>;

/** `GET /v1/restarts`: every outdated ferret and every waiting restart, for the button and the CLI. */
export const RestartStatusSchema = z.strictObject({
  outdated: z.array(z.strictObject({ ...NamedSchema, sections: z.array(LaunchInstructionSectionIdSchema).min(1) })),
  queued: z.array(RestartQueueEntrySchema),
});
export type RestartStatus = z.infer<typeof RestartStatusSchema>;

/** `DELETE /v1/restarts`: how many waiting restarts were cleared. */
export const RestartCancelResultSchema = z.strictObject({ cancelled: NonNegativeIntegerSchema });
export type RestartCancelResult = z.infer<typeof RestartCancelResultSchema>;
