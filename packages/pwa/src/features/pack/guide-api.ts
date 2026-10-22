/**
 * THE MODELS-GUIDE GENERATOR OVER HTTP (docs/pack-mode.md § Suggesting a guide), as Settings › Pack needs it.
 *
 * Every call takes a client rather than building one, exactly as the configuration-file calls do: the app's
 * client pool carries a call to ONE machine, direct first with the relay as the fallback. A refusal comes
 * back as the daemon's usual `{error, code}` body with a non-2xx status, which the client throws; the hook
 * says it in words.
 */

import {
  PACK_GUIDE_ACCEPT_PATH,
  PACK_GUIDE_DESCRIBE_PATH,
  PACK_GUIDE_SUGGEST_PATH,
  PACK_GUIDE_UNDO_PATH,
  type PackGuideAcceptRequest,
  type PackGuideDescribeRequest,
  type PackGuideJobResult,
  PackGuideJobResultSchema,
  type PackGuideSuggestRequest,
  type PackGuideSuggestStart,
  PackGuideSuggestStartSchema,
  type PackGuideWriteResult,
  PackGuideWriteResultSchema,
  packGuideJobPath,
} from '@ferretry/protocol';
import type { ConfigFilesClient } from '../config-files/config-files-api.ts';

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

/** Start the builder ferret. Spends one model run on this machine, only because a person asked. */
export async function startGuideSuggestion(
  client: ConfigFilesClient,
  request: PackGuideSuggestRequest,
): Promise<PackGuideSuggestStart> {
  return await client.request(PACK_GUIDE_SUGGEST_PATH, PackGuideSuggestStartSchema, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(request),
  });
}

/** One builder run, and its checked suggestion once it has one. */
export async function readGuideJob(client: ConfigFilesClient, jobId: string): Promise<PackGuideJobResult> {
  return await client.request(packGuideJobPath(jobId), PackGuideJobResultSchema);
}

/** Write the reviewed guide, keeping the one it replaces. */
export async function acceptGuideSuggestion(
  client: ConfigFilesClient,
  request: PackGuideAcceptRequest,
): Promise<PackGuideWriteResult> {
  return await client.request(PACK_GUIDE_ACCEPT_PATH, PackGuideWriteResultSchema, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(request),
  });
}

/** Put the guide the last accept replaced back. */
export async function undoGuideSuggestion(client: ConfigFilesClient): Promise<PackGuideWriteResult> {
  return await client.request(PACK_GUIDE_UNDO_PATH, PackGuideWriteResultSchema, { method: 'POST' });
}

/** Set (or, with `null`, clear) the owner's description of one model. */
export async function describeGuideModel(
  client: ConfigFilesClient,
  request: PackGuideDescribeRequest,
): Promise<PackGuideWriteResult> {
  return await client.request(PACK_GUIDE_DESCRIBE_PATH, PackGuideWriteResultSchema, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(request),
  });
}
