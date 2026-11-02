import {
  type WorkRelatedRequest,
  WorkRelatedRequestSchema,
  type WorkRelatedResponse,
  type WorkSearchQuery,
  type WorkSearchQueryInput,
  WorkSearchQuerySchema,
  type WorkSearchResponse,
} from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { queryValue } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';

/** One search over cards and agenda items (docs/work-search.md). `WorkSearchService` satisfies this structurally. */
export interface WorkSearchSubsystem {
  search(query: WorkSearchQuery): Promise<WorkSearchResponse>;
  related(request: WorkRelatedRequest): Promise<WorkRelatedResponse>;
}

const TEXT_FIELDS = ['q', 'kind', 'project'] as const;

/** The search, from the URL's query string. A field given empty is a field not given. */
const searchQueryOf = (context: RouteContext): WorkSearchQuery => {
  const input: Record<string, unknown> = {};
  for (const field of TEXT_FIELDS) {
    const value = queryValue(context.request, field);
    if (value !== undefined && value !== '') input[field] = value;
  }
  const open = queryValue(context.request, 'open');
  if (open !== undefined && open !== '') input.open = open === 'true' ? true : open === 'false' ? false : open;
  const all = queryValue(context.request, 'all');
  if (all !== undefined && all !== '') input.all = all === 'true' ? true : all === 'false' ? false : all;
  const limit = queryValue(context.request, 'limit');
  if (limit !== undefined && limit !== '') input.limit = /^[0-9]+$/u.test(limit) ? Number(limit) : limit;
  const parsed = WorkSearchQuerySchema.safeParse(input as WorkSearchQueryInput);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ApiError(
      400,
      `the search is not usable: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim(),
      'invalid',
    );
  }
  return parsed.data;
};

/**
 * Exactly the grants of the board (`boardRoutes`): `operator`, plus the `fleet` capability, because an
 * answer names cards and agenda items and quotes a line of each — what the board and the agenda show.
 * A paired device the owner keeps off the fleet reaches neither, and a catalog member's session never
 * reaches this table at all (`docs/grants.md`).
 *
 * The related check is a POST only because a title and an ask do not fit a URL; it reads, never writes.
 */
export function workSearchRoutes(search: WorkSearchSubsystem): readonly ApiRoute[] {
  const fleet = { capability: 'fleet', axis: 'use' } as const;
  return [
    {
      method: 'GET',
      path: '/v1/search',
      minimum: 'operator',
      caller: 'any',
      capability: fleet,
      noStore: true,
      handle: async context => jsonResponse(await search.search(searchQueryOf(context))),
    },
    {
      method: 'POST',
      path: '/v1/search/related',
      minimum: 'operator',
      caller: 'any',
      capability: fleet,
      noStore: true,
      handle: async context =>
        jsonResponse(await search.related(await parseBody(context.request, WorkRelatedRequestSchema))),
    },
  ];
}
