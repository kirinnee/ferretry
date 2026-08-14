import { z } from 'zod';

/** Harness family shared by session records and transfer lineage leaves. */
export const HarnessSchema = z.enum(['claude', 'codex']);
export type Harness = z.infer<typeof HarnessSchema>;
