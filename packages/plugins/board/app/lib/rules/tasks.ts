import { z } from 'zod';

/** The card's kind (its id letter), workflow and a message, as the board's wire words them. */
export const CardKindSchema = z.enum(['bug', 'feature', 'infra', 'chore']);
export type CardKind = z.infer<typeof CardKindSchema>;

export const CardTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(value => value.split(/\s+/u).length <= 5, 'title must contain at most five words');

export const WorkflowSchema = z.enum(['quick', 'design-first', 'research-first', 'investigate']);
export type Workflow = z.infer<typeof WorkflowSchema>;

export const CardMessageSchema = z.object({
  text: z
    .string()
    .min(1)
    .max(64 * 1024),
  source: z
    .string()
    .min(1)
    .max(2 * 1024),
});
export type CardMessage = z.infer<typeof CardMessageSchema>;
