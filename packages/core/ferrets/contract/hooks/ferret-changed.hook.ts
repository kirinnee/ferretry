import { defineHook } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { FerretIdSchema, FerretStateSchema } from '../ids.ts';

export const FerretChangedPayloadSchema = z.strictObject({
  ferret: FerretIdSchema,
  state: FerretStateSchema,
  previous: FerretStateSchema.optional(),
  /** What changed besides the state. */
  change: z.enum(['started', 'state', 'stopped', 'renamed', 'moved', 'archived', 'removed']),
});
export type FerretChangedPayload = z.infer<typeof FerretChangedPayloadSchema>;

/** Updates, Warden, Tidy hear that a ferret changed, after Ferrets' write. */
export const FerretChanged = defineHook('ferret.changed', { mode: 'observe', payload: FerretChangedPayloadSchema });
