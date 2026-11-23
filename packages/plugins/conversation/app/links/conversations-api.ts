/**
 * The browser's half of continuing a past Claude Code / Codex conversation: the listing the daemon searches over its
 * metadata index, and one conversation's last few exchanges. Picking one is not a call here: the New ferret page starts
 * the ferret with the conversation named.
 *
 * Both are governed (`fleet`), so a surface shows a refusal's sentence. Every answer is parsed: metadata and a short
 * preview, never a whole transcript.
 */

import type { PluginClient } from '@ferretry/kernel/manifest';
import {
  type LinkListing,
  LinkListingSchema,
  type LinkPreview,
  LinkPreviewSchema,
  type LinkQuery,
} from '../../contract/index.ts';
import type { ReadPress } from '@ferretry/app/ui';
import { listingQueryParams } from './conversation-picker-model.ts';

/** The conversations this machine's harnesses hold, newest first, narrowed by `query` on the daemon. */
export const readLinkableConversations = async (
  client: Pick<PluginClient, 'call'>,
  query: LinkQuery = {},
  press: ReadPress = {},
): Promise<LinkListing> =>
  LinkListingSchema.parse(
    await client.call('GET /v1/links/conversations', { query: listingQueryParams(query), ...press }),
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
