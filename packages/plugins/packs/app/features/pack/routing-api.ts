/**
 * CLEAN UP OVER THE CLIENT (docs/pack-mode.md § Clean up), as Settings › Pack mode needs it: start the clean-up
 * ferret on the owner's rough prompt, read its run, accept the reviewed rewrite, undo the last accept.
 *
 * Every call takes a client rather than building one: the app's client pool carries a call to ONE machine, direct first
 * with the relay as the fallback. A refusal comes back as the daemon's usual `{error, code}` body with a non-2xx status,
 * which the client throws; the hook says it in words.
 */

import {
  type PackCleanUpJobResult,
  PackCleanUpJobResultSchema,
  type PackCleanUpRequest,
  type PackCleanUpStart,
  PackCleanUpStartSchema,
  type PackRoutingAcceptRequest,
  type PackRoutingWriteResult,
  PackRoutingWriteResultSchema,
} from '../../../contract/index.ts';
import type { PacksClient } from '../../lib/client.ts';

/** Start the clean-up ferret. Spends one model run on this machine, only because a person asked. */
export async function startCleanUp(client: PacksClient, request: PackCleanUpRequest): Promise<PackCleanUpStart> {
  return PackCleanUpStartSchema.parse(await client.call('POST /v1/pack/routing/clean-up', { body: request }));
}

/** One clean-up run, and its checked rewrite once it has one. */
export async function readCleanUpJob(client: PacksClient, jobId: string): Promise<PackCleanUpJobResult> {
  return PackCleanUpJobResultSchema.parse(await client.call('GET /v1/pack/routing/jobs/:jobId', { params: { jobId } }));
}

/** Write the reviewed rewrite, keeping the prompt it replaces for one undo. */
export async function acceptRouting(
  client: PacksClient,
  request: PackRoutingAcceptRequest,
): Promise<PackRoutingWriteResult> {
  return PackRoutingWriteResultSchema.parse(await client.call('POST /v1/pack/routing/accept', { body: request }));
}

/** Put the prompt the last accept replaced back. */
export async function undoRouting(client: PacksClient): Promise<PackRoutingWriteResult> {
  return PackRoutingWriteResultSchema.parse(await client.call('POST /v1/pack/routing/undo'));
}
