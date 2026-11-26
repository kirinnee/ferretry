import { RecordedHarnessSchema, type RecordedFamily } from '@ferretry/core-ferrets/contract';

/**
 * Harness family shared by session records and transfer lineage leaves (today's `protocol/src/lib/session-base.ts`). It is
 * Ferrets' family table, not a copy of it: a family added there is a family here, and every screen parser that dispatches
 * on it through `byRecordedHarness` then has to name its case.
 */
export const HarnessSchema = RecordedHarnessSchema;
export type Harness = RecordedFamily;
