import { z } from 'zod';

/** Harness family shared by session records and transfer lineage leaves (today's `protocol/src/lib/session-base.ts`). */
export const HarnessSchema = z.enum(['claude', 'codex']);
export type Harness = z.infer<typeof HarnessSchema>;
