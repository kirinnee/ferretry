/**
 * CLEAN UP OVER HTTP (docs/pack-mode.md § Clean up), as Settings › Pack needs it: start the clean-up
 * ferret on the owner's rough prompt, read its run, accept the reviewed rewrite, undo the last accept.
 *
 * Every call takes a client rather than building one, exactly as the configuration-file calls do: the app's
 * client pool carries a call to ONE machine, direct first with the relay as the fallback. A refusal comes
 * back as the daemon's usual `{error, code}` body with a non-2xx status, which the client throws; the hook
 * says it in words.
 */

import {
  PACK_CLEAN_UP_JOBS_PATH,
  PACK_CLEAN_UP_PATH,
  PACK_ROUTING_ACCEPT_PATH,
  PACK_ROUTING_UNDO_PATH,
  type PackCleanUpJobResult,
  PackCleanUpJobResultSchema,
  type PackCleanUpRequest,
  type PackCleanUpStart,
  PackCleanUpStartSchema,
  type PackRoutingAcceptRequest,
  type PackRoutingWriteResult,
  PackRoutingWriteResultSchema,
} from '@ferretry/protocol';
import type { ConfigFilesClient } from '../config-files/config-files-api.ts';

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

/** Start the clean-up ferret. Spends one model run on this machine, only because a person asked. */
export async function startCleanUp(client: ConfigFilesClient, request: PackCleanUpRequest): Promise<PackCleanUpStart> {
  return await client.request(PACK_CLEAN_UP_PATH, PackCleanUpStartSchema, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(request),
  });
}

/** One clean-up run, and its checked rewrite once it has one. */
export async function readCleanUpJob(client: ConfigFilesClient, jobId: string): Promise<PackCleanUpJobResult> {
  return await client.request(`${PACK_CLEAN_UP_JOBS_PATH}/${encodeURIComponent(jobId)}`, PackCleanUpJobResultSchema);
}

/** Write the reviewed rewrite, keeping the prompt it replaces for one undo. */
export async function acceptRouting(
  client: ConfigFilesClient,
  request: PackRoutingAcceptRequest,
): Promise<PackRoutingWriteResult> {
  return await client.request(PACK_ROUTING_ACCEPT_PATH, PackRoutingWriteResultSchema, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(request),
  });
}

/** Put the prompt the last accept replaced back. */
export async function undoRouting(client: ConfigFilesClient): Promise<PackRoutingWriteResult> {
  return await client.request(PACK_ROUTING_UNDO_PATH, PackRoutingWriteResultSchema, { method: 'POST' });
}
