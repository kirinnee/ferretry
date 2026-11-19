import { PostLedger } from './ledger.ts';
import type { PostRefusal, Posted } from './send.ts';

export { type PostServices, postRoutes } from './routes.ts';

/** The ledger a daemon holds: one per process, ten minutes of memory, bounded. */
export const newPostLedger = (nowMs: () => number): PostLedger<Posted, PostRefusal> => new PostLedger(nowMs);
