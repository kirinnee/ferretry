import { z } from 'zod';

/** A board task's id as the asking ferret names it (`--task F12`): a letter for its kind, then a number. */
export const TASK_ID_PATTERN = /^[BFIC][1-9][0-9]{0,8}$/u;
export const CardIdSchema = z.string().regex(TASK_ID_PATTERN);
export type TaskId = z.infer<typeof CardIdSchema>;
