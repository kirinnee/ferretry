/** When a ferret squeezes its memory (today's `compact-at.ts`, `session-compact-at.ts`). */
import { z } from 'zod';

export const COMPACT_AT_MIN_TOKENS = 100_000;
export const COMPACT_AT_PRESETS = [200_000, 250_000, 400_000] as const;

export const CompactAtSchema = z.union([
  z.literal('auto'),
  z
    .number()
    .int()
    .min(COMPACT_AT_MIN_TOKENS, `Compact memory at ${COMPACT_AT_MIN_TOKENS / 1000}k tokens or more.`),
]);
export type CompactAt = z.infer<typeof CompactAtSchema>;

export const CompactAtPatchSchema = z.strictObject({ compactAt: z.union([CompactAtSchema, z.literal('inherit')]) });
export type CompactAtPatch = z.infer<typeof CompactAtPatchSchema>;

export const FerretCompactAtSchema = z.strictObject({
  own: CompactAtSchema.optional(),
  effective: CompactAtSchema,
  window: z.number().int().positive().optional(),
  restartRequired: z.boolean(),
  note: z.string().min(1),
});
export type FerretCompactAt = z.infer<typeof FerretCompactAtSchema>;

/** The patch answer; today also carries the ferret's whole view, which Ferrets owns (see `ConversationApi`). */
export const CompactAtPatchResultSchema = z.strictObject({
  effective: CompactAtSchema,
  restartRequired: z.boolean(),
  note: z.string().min(1),
});
export type CompactAtPatchResult = z.infer<typeof CompactAtPatchResultSchema>;
