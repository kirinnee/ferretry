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
  state: SubtreeStateSchema,
  ferretState: FerretStateSchema,
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
