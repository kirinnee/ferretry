import { defineHook } from '@ferretry/kernel/contract';
import { z } from 'zod';
import type { JobKeeperSource } from '../job-keeping.ts';

/** Terminals contributes the job keeper; the moves and the completion backstop ask it (docs/jobs.md). */
export const JobKeeper = defineHook('jobs.keeper', { mode: 'contribute', item: z.custom<JobKeeperSource>() });
