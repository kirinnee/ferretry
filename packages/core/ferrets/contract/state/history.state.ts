import { defineState } from '@ferretry/kernel/contract';
import { JsonValueSchema } from '@ferretry/std';
import { z } from 'zod';
import { IsoInstantSchema, StoredSessionIdSchema } from '../records.ts';

// ─── history.jsonl (today's `lib/journal.ts` event record) ──────────────────────────────────────────────────────

/**
 * One line of a ferret's `history.jsonl`: today's stored journal event. The sequence is strictly increasing within one
 * journal; the record cap and the canonical `data` are the daemon's journal module's (`daemon/lib/storage/journal.ts`).
 */
export const FerretHistoryEventSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sequence: z.number().int().safe().positive(),
  sessionId: StoredSessionIdSchema,
  time: IsoInstantSchema,
  type: z
    .string()
    .min(1)
    .refine(value => value.trim() === value, 'event type must not have surrounding whitespace'),
  data: JsonValueSchema,
});
export type FerretHistoryEvent = z.infer<typeof FerretHistoryEventSchema>;

export const FerretHistoryFiles = defineState({
  name: 'history',
  path: '*/history.jsonl',
  store: 'jsonl',
  format: 1,
  schema: FerretHistoryEventSchema,
});
