/**
 * The browser's half of keeping existing Claude Code / Codex conversations as ferrets: the listing the daemon searches
 * over its metadata index, one conversation's last few exchanges, and the keep that makes one ferret per conversation,
 * read from the harness's own file (a link). Which runtime a kept conversation runs on is not read here: Runtimes is not
 * a need of Conversation, so the picker mounts the runtime slot Ferrets offers (`conversation-picker.tsx`).
 *
 * All are governed (`fleet` configure), so a surface shows a refusal's sentence. Every
 * answer is parsed: metadata and a short preview, never a whole transcript.
 */

import type { PluginClient } from '@ferretry/kernel/manifest';
import {
  type KeepRequest,
  KeepRequestSchema,
  type KeepResult,
  KeepResultSchema,
  type LinkListing,
  LinkListingSchema,
  type LinkPreview,
  LinkPreviewSchema,
  type LinkQuery,
} from '../../contract/index.ts';
import { listingQueryParams } from './conversation-picker-model.ts';

/** The conversations this machine's harnesses hold, newest first, narrowed by `query` on the daemon. */
export const readLinkableConversations = async (
  client: Pick<PluginClient, 'call'>,
  query: LinkQuery = {},
): Promise<LinkListing> =>
  LinkListingSchema.parse(await client.call('GET /v1/links/conversations', { query: listingQueryParams(query) }));

/** Keep the chosen conversations as ferrets: stopped unless `start`, never more than ten launched. */
export const keepConversations = async (
  client: Pick<PluginClient, 'call'>,
  request: KeepRequest,
): Promise<KeepResult> =>
  KeepResultSchema.parse(
    await client.call('POST /v1/links/conversations/keep', { body: KeepRequestSchema.parse(request) }),
  );

/** The last few exchanges of one conversation, cleaned of delivery wrappers, oldest first. */
export const readConversationPreview = async (
  client: Pick<PluginClient, 'call'>,
  harness: string,
  conversationId: string,
): Promise<LinkPreview> =>
  LinkPreviewSchema.parse(
    await client.call('GET /v1/links/conversations/:harness/:conversationId/preview', {
      params: { harness, conversationId },
    }),
  );
