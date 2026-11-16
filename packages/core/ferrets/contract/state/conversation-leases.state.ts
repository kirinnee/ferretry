import { defineState } from '@ferretry/kernel/contract';
import { z } from 'zod';

/**
 * `conversation-leases/<harness>/<conversation>.lease`, one small JSON lease per harness conversation that has a live
 * writer, and `conversation-leases/<harness>/pool.lock`, the file a claim's read-decide-write is held under (§9.3).
 * An opaque named tree that `fy history claim` (no daemon needed) and the daemon's launches both reach through the one
 * lease store (`./conversation-lease.ts`): it is under the state home, never in a pool an agent writes, and no path in
 * it is ever named by a caller.
 */
export const ConversationLeaseFiles = defineState({
  name: 'conversation-leases',
  path: 'conversation-leases/*',
  store: 'opaque',
  format: 1,
  schema: z.instanceof(Uint8Array),
  mode: 0o600,
});
