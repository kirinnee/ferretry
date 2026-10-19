/**
 * Keeping existing Claude Code / Codex conversations as ferrets (`lib/imports/conversations.ts`).
 *
 * ## Both are `fleet.configure`
 *
 * The listing reads the owner's own local CLI data — folders and the first words of every
 * conversation they had — so it is not a `fleet.use` read even though it writes nothing, and an
 * adoption creates sessions that can launch an agent. A caller off this host does either only behind
 * the passkey step-up. Neither answer carries a transcript or a file path.
 *
 * ## `noStore` on both
 *
 * A listing is a statement about now: the owner may have continued a conversation a minute ago.
 */
import {
  ConversationAdoptRequestSchema,
  ConversationAdoptResultSchema,
  ConversationImportListingSchema,
  ConversationImportQuerySchema,
} from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute } from '../../api/route.ts';
import type { ConversationImportService } from '../../imports/index.ts';

export type ConversationImportSubsystem = Pick<ConversationImportService, 'list' | 'adopt'>;

const CONFIGURE = { capability: 'fleet', axis: 'configure' } as const;
const QUERY_KEYS = ['harness', 'q', 'since', 'limit'] as const;

export function conversationImportRoutes(subsystem: ConversationImportSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/imports/conversations',
      minimum: 'operator',
      capability: CONFIGURE,
      noStore: true,
      handle: async context => {
        const raw: Record<string, string> = {};
        for (const key of QUERY_KEYS) {
          const value = context.request.query.get(key)?.[0];
          if (value !== undefined && value !== '') raw[key] = value;
        }
        const query = ConversationImportQuerySchema.safeParse(raw);
        if (!query.success)
          throw new ApiError(
            400,
            'the conversation search must use harness=claude|codex, a q of at most 200 characters, an ISO since and a positive limit',
            'invalid_query',
          );
        return jsonResponse(ConversationImportListingSchema.parse(await subsystem.list(query.data)));
      },
    },
    {
      method: 'POST',
      path: '/v1/imports/conversations/adopt',
      minimum: 'operator',
      capability: CONFIGURE,
      noStore: true,
      handle: async context => {
        const request = await parseBody(context.request, ConversationAdoptRequestSchema);
        return jsonResponse(ConversationAdoptResultSchema.parse(await subsystem.adopt(request)));
      },
    },
  ];
}
