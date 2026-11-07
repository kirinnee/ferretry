import type { z } from 'zod';

import { RecordedHarnessSchema } from '../../../contract/records.ts';

/** Harness family shared by session records and transfer lineage leaves (the contract owns it). */
export const HarnessSchema = RecordedHarnessSchema;
export type Harness = z.infer<typeof HarnessSchema>;

/** Where a session stands (the contract owns it: the fork's summary names one). */
export { type SessionStatus, SessionStatusSchema } from '../../../contract/records.ts';
