import { z } from 'zod';

const MAX_TASK_TITLE_LENGTH = 200;
const MAX_TASK_DESCRIPTION_LENGTH = 64 * 1024;
const MAX_TASK_SOURCE_LENGTH = 2 * 1024;

export const TaskKindSchema = z.enum(['bug', 'feature', 'infra', 'chore']);
export type TaskKind = z.infer<typeof TaskKindSchema>;

export const TaskIdSchema = z.string().regex(/^[BFIC][1-9][0-9]{0,8}$/u);
export type TaskId = z.infer<typeof TaskIdSchema>;

export const TaskTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_TASK_TITLE_LENGTH)
  .refine(value => value.split(/\s+/u).length <= 5, 'title must contain at most five words');
export type TaskTitle = z.infer<typeof TaskTitleSchema>;

export const TaskWorkflowSchema = z.enum(['quick', 'design-first', 'research-first', 'investigate']);
export type TaskWorkflow = z.infer<typeof TaskWorkflowSchema>;

export const TaskMessageSchema = z.object({
  text: z.string().min(1).max(MAX_TASK_DESCRIPTION_LENGTH),
  source: z.string().min(1).max(MAX_TASK_SOURCE_LENGTH),
});
export type TaskMessage = z.infer<typeof TaskMessageSchema>;
