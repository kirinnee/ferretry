import type { z } from 'zod';
import type { TerminalHolderStandingSchema } from '../../../contract/index.ts';

/** Where a terminal holder stands: still running, finished, or no longer known (today's protocol type). */
export type TerminalHolderStanding = z.infer<typeof TerminalHolderStandingSchema>;
