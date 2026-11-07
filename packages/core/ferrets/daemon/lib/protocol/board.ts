import { z } from 'zod';

/** Cut from today's `protocol/src/lib/board.ts` (Board's): the PR schemas a subtree row embeds. */

/** What GitHub said of a PR. `unknown` until the watcher has polled it once. */
export const PrStateSchema = z.enum(['unknown', 'open', 'closed', 'merged']);

/** The PR's CI checks, summarised: none run, some still running, all passing, or any failing. */
export const PrChecksSchema = z.enum(['none', 'pending', 'passing', 'failing']);
