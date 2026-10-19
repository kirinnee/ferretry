/**
 * The browser's half of keeping existing Claude Code / Codex conversations as ferrets: the listing the
 * daemon searches over its metadata index, and the adoption that makes one session per conversation.
 *
 * Both are governed (`fleet` configure), so a surface runs them through `useSetupAccess` and shows a
 * refusal's sentence. Every answer is parsed through the shared schema: metadata only, no transcript.
 */

import {
  CONVERSATION_ADOPT_PATH,
  type ConversationAdoptRequest,
  ConversationAdoptRequestSchema,
  type ConversationAdoptResult,
  ConversationAdoptResultSchema,
  type ConversationImportListing,
  ConversationImportListingSchema,
  type ConversationImportQuery,
} from '@ferretry/protocol';
import type { FleetClient } from '../fleet-client.ts';
import { listingPath } from './conversation-picker-model.ts';

/** The conversations this machine's CLIs hold, newest first, narrowed by `query` on the daemon. */
export const readImportableConversations = async (
  client: FleetClient,
  query: ConversationImportQuery = {},
): Promise<ConversationImportListing> => await client.request(listingPath(query), ConversationImportListingSchema);

/** Keep the chosen conversations as ferrets: stopped unless `start`, never more than ten launched. */
export const adoptConversations = async (
  client: FleetClient,
  request: ConversationAdoptRequest,
): Promise<ConversationAdoptResult> =>
  await client.request(CONVERSATION_ADOPT_PATH, ConversationAdoptResultSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ConversationAdoptRequestSchema.parse(request)),
  });
