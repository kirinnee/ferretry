import { defineHook } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { FerretIdSchema, FerretRoleSchema } from '../ids.ts';

/**
 * A ferret was started (its record written, its launch under way): who it is, where it runs, who started it and the
 * brief it was given. Additive (lead decision D2 #12), for Board's session-start card path (today's `SessionCards.open`
 * and the `--card` handover). `card` is the existing card the start named (`StartOptions.card`).
 */
export const FerretStartedPayloadSchema = z.strictObject({
  ferret: FerretIdSchema,
  name: z.string().min(1),
  role: FerretRoleSchema,
  parent: FerretIdSchema.optional(),
  pack: z.string().optional(),
  folder: z.string().min(1),
  by: z.enum(['owner', 'ferret', 'pack', 'board', 'warden']),
  /** The prompt the ferret was started with: its brief. Absent for a start with none (an interactive terminal). */
  brief: z.string().min(1).optional(),
  /** The ownership label given to start (`start --label`). */
  label: z.string().min(1).optional(),
  card: z.string().min(1).optional(),
});
export type FerretStartedPayload = z.infer<typeof FerretStartedPayloadSchema>;

/** Board hears that a ferret started, after Ferrets wrote its record (observe; a taker never fails a start). */
export const FerretStarted = defineHook('ferret.started', { mode: 'observe', payload: FerretStartedPayloadSchema });
