import { z } from 'zod';

import { RecordedHarnessSchema } from '../../../contract/records.ts';

/** Harness family shared by session records and transfer lineage leaves (the contract owns it). */
export const HarnessSchema = RecordedHarnessSchema;
export type Harness = z.infer<typeof HarnessSchema>;

export const SessionStatusSchema = z.enum([
  'created',
  'starting',
  'running',
  'thinking',
  'tool_running',
  'awaiting_question',
  'awaiting_user',
  'interrupted',
  'rate_limited',
  'retrying',
  'kill_failed',
  'waiting',
  'completed',
  'failed',
  'stalled',
  'stopped',
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;
