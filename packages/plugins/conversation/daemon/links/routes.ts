import { ApiError, decodeParameter, jsonResponse, queryValue, type RouteHandler } from '@ferretry/kernel/contract';
import {
  type KeepRequest,
  KeepRequestSchema,
  KeepResultSchema,
  LinkIdSchema,
  LinkListingSchema,
  LinkPreviewSchema,
  LinkQuerySchema,
} from '../../contract/index.ts';
import { parseBody } from '../reader/lib/http.ts';
import type { LinkService } from './lib/service.ts';

type Call = Parameters<RouteHandler>[0];

const QUERY_KEYS = ['source', 'harness', 'q', 'since', 'limit'] as const;

/**
 * The links: `fleet.configure` on all (the manifest says so), because a listing reads the owner's own local CLI data (folders
 * and the first words of every conversation) and a keep creates ferrets that can launch an agent. No answer carries a whole
 * transcript or a file path. All `noStore`: a listing is a statement about now.
 */
export function linkRoutes(links: Pick<LinkService, 'list' | 'preview' | 'keep' | 'history' | 'historyEntry'>) {
  const param = (call: Call, name: string): string => {
    const decoded = decodeParameter(call.params.get(name) ?? '');
    if (decoded === undefined || decoded === '')
      throw new ApiError(400, `the ${name} in the path is not usable`, 'invalid_id');
    return decoded;
  };
  return {
    'GET /v1/links/conversations': (async call => {
      const raw: Record<string, string> = {};
      for (const key of QUERY_KEYS) {
        const value = queryValue(call.request, key);
        if (value !== undefined && value !== '') raw[key] = value;
      }
      const query = LinkQuerySchema.safeParse(raw);
      if (!query.success)
        throw new ApiError(
          400,
          'the conversation search must use source=ferretry|computer|synced, a harness, a q of at most 200 characters, an ISO since and a positive limit',
          'invalid_query',
        );
      return jsonResponse(LinkListingSchema.parse(await links.list(query.data)));
    }) satisfies RouteHandler,

    'GET /v1/links/conversations/:harness/:conversationId/preview': (async call => {
      const harness = param(call, 'harness');
      const id = LinkIdSchema.safeParse(param(call, 'conversationId'));
      if (!id.success) throw new ApiError(400, 'the conversation id is not usable', 'invalid_conversation_id');
      const preview = await links.preview(harness, id.data);
      if (preview === undefined) throw new ApiError(404, 'that conversation is not on this machine', 'not-found');
      return jsonResponse(LinkPreviewSchema.parse(preview));
    }) satisfies RouteHandler,

    'POST /v1/links/conversations/keep': (async call => {
      const request: KeepRequest = await parseBody(call.request, KeepRequestSchema);
      return jsonResponse(KeepResultSchema.parse(await links.keep(request)));
    }) satisfies RouteHandler,

    /** Read-only foreign history: a separate namespace, so no screen offers resume or send against it. */
    'GET /v1/links/history': (async call => {
      const harness = queryValue(call.request, 'harness');
      return jsonResponse(await links.history(harness === undefined || harness === '' ? undefined : harness));
    }) satisfies RouteHandler,

    'GET /v1/links/history/:entryId': (async call => {
      const entry = await links.historyEntry(param(call, 'entryId'));
      if (entry === undefined)
        throw new ApiError(404, 'the conversation is unavailable or could not be read', 'not-found');
      return jsonResponse(entry);
    }) satisfies RouteHandler,
  } as const;
}
