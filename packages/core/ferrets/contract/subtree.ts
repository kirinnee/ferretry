import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';
import { FerretIdSchema, FerretStateSchema } from './ids.ts';

/** G24: only the daemon builds this registry-backed, bounded and masked view. */
const SubtreeStateSchema = z.enum(['running', 'waiting', 'ended']);
export type SubtreeState = z.infer<typeof SubtreeStateSchema>;
const SubtreeRowSchema = z.strictObject({
  id: FerretIdSchema,
  name: z.string(),
  parent: FerretIdSchema.optional(),
  depth: z.number().int().min(1),
  /** The model it runs (what it was started with; `default` when it named none), as today's table showed. */
  model: z.string().min(1).optional(),
  state: SubtreeStateSchema,
  ferretState: FerretStateSchema,
  /** The card it works on (`&F767`) and that card's lane, as its card line says. */
  card: z.strictObject({ ref: z.string().min(1), lane: z.string().min(1).optional() }).optional(),
  /** The card's PR — the open one when there are several, else the newest — as the board's PR cache last read it. */
  pr: z
    .strictObject({
      number: z.number().int().min(1),
      url: z.string().min(1),
      state: z.enum(['unknown', 'open', 'closed', 'merged']),
      draft: z.boolean(),
      checks: z.enum(['none', 'pending', 'passing', 'failing']),
    })
    .optional(),
  last: z
    .strictObject({ at: z.string(), kind: z.enum(['doing', 'card', 'turn', 'note']), text: z.string() })
    .optional(),
  endedAt: z.string().optional(),
});
export type SubtreeRow = z.infer<typeof SubtreeRowSchema>;
export const SubtreeViewSchema = z.strictObject({
  root: z.strictObject({ id: FerretIdSchema, name: z.string() }),
  at: InstantSchema,
  endedWindowMs: z.number().nonnegative(),
  rows: SubtreeRowSchema.array(),
});
export type SubtreeView = z.infer<typeof SubtreeViewSchema>;
