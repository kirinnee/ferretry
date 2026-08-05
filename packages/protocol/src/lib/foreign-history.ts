import { z } from 'zod';
import { HarnessSchema } from './session.ts';

/** A transcript discovered in a person's existing harness home, never a managed session. */
export const ImportedConversationSchema = z.object({
  id: z.string().min(1),
  harness: HarnessSchema,
  title: z.string().min(1),
  eventCount: z.number().int().nonnegative(),
  startedAt: z.string().datetime().optional(),
  readOnly: z.literal(true),
});
export type ImportedConversation = z.infer<typeof ImportedConversationSchema>;

export const ForeignHistorySkipSchema = z.object({
  harness: HarnessSchema,
  reason: z.string().min(1),
  count: z.number().int().positive(),
});
export type ForeignHistorySkip = z.infer<typeof ForeignHistorySkipSchema>;

/** The separate read-only import surface; source paths never leave the daemon. */
export const ForeignHistoryListingSchema = z.object({
  conversations: z.array(ImportedConversationSchema),
  skipped: z.array(ForeignHistorySkipSchema),
});
export type ForeignHistoryListing = z.infer<typeof ForeignHistoryListingSchema>;

/** The text-bearing projection of an imported transcript. Tool internals stay in the harness file. */
export const ImportedHistoryMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(['user', 'assistant', 'developer', 'system']),
  text: z.string(),
});
export type ImportedHistoryMessage = z.infer<typeof ImportedHistoryMessageSchema>;

export const ImportedConversationDetailSchema = z.object({
  conversation: ImportedConversationSchema,
  messages: z.array(ImportedHistoryMessageSchema),
});
export type ImportedConversationDetail = z.infer<typeof ImportedConversationDetailSchema>;
