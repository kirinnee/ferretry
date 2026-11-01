/**
 * Keeping existing Claude Code / Codex conversations as ferrets (`lib/imports/conversations.ts`).
 *
 * ## All are `fleet.configure`
 *
 * The listing reads the owner's own local CLI data — folders and the first words of every
 * conversation they had — so it is not a `fleet.use` read even though it writes nothing; a preview
 * reads the last few exchanges of one; and an adoption creates sessions that can launch an agent. A
 * caller off this host does any of them only behind the passkey step-up. No answer carries a whole
 * transcript or a file path.
 *
 * ## `noStore` on all
 *
 * A listing is a statement about now: the owner may have continued a conversation a minute ago.
 */
import {
  ConversationAdoptRequestSchema,
  ConversationAdoptResultSchema,
  ConversationImportListingSchema,
  ConversationImportQuerySchema,
  ConversationPreviewSchema,
  HarnessSchema,
  ImportConversationIdSchema,
} from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute } from '../../api/route.ts';
import type { ConversationImportService } from '../../imports/index.ts';

export type ConversationImportSubsystem = Pick<ConversationImportService, 'list' | 'preview' | 'adopt'>;

const CONFIGURE = { capability: 'fleet', axis: 'configure' } as const;
const QUERY_KEYS = ['source', 'harness', 'q', 'since', 'limit'] as const;

export function conversationImportRoutes(subsystem: ConversationImportSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/imports/conversations',
      minimum: 'operator',
      caller: 'any',
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
            'the conversation search must use source=ferretry|computer, harness=claude|codex, a q of at most 200 characters, an ISO since and a positive limit',
            'invalid_query',
          );
        return jsonResponse(ConversationImportListingSchema.parse(await subsystem.list(query.data)));
      },
    },
    {
      method: 'GET',
      path: '/v1/imports/conversations/:harness/:conversationId/preview',
      minimum: 'operator',
      caller: 'any',
      capability: CONFIGURE,
      noStore: true,
      handle: async context => {
        const harness = HarnessSchema.safeParse(context.params.get('harness'));
        const id = ImportConversationIdSchema.safeParse(context.params.get('conversationId'));
        if (!harness.success || !id.success)
          throw new ApiError(400, 'name a claude or codex conversation by its id', 'invalid_conversation');
        const preview = await subsystem.preview(harness.data, id.data);
        if (preview === undefined) throw new ApiError(404, 'no such conversation on this machine', 'not-found');
        return jsonResponse(ConversationPreviewSchema.parse(preview));
      },
    },
    // A PERSON'S ACT: an adopted conversation is a new top-level ferret, and it is the owner's own earlier work. A
    // ferret starts sessions only as its own children, so it may list and preview here but never adopt.
    {
      method: 'POST',
      path: '/v1/imports/conversations/adopt',
      minimum: 'operator',
      caller: 'person',
      capability: CONFIGURE,
      noStore: true,
      handle: async context => {
        const request = await parseBody(context.request, ConversationAdoptRequestSchema);
        return jsonResponse(ConversationAdoptResultSchema.parse(await subsystem.adopt(request)));
      },
    },
  ];
}
