import { ApiError, jsonResponse, queryValue, type RouteHandler } from '@ferretry/kernel/contract';
import {
  SearchWorkToolInputSchema,
  type WorkSearchQuery,
  WorkRelatedRequestSchema,
  WorkSearchQuerySchema,
  type WorkRelatedRequest,
  type WorkRelatedResponse,
  type WorkSearchResponse,
} from '../../contract/index.ts';
import { parseBody } from '../reader/lib/http.ts';
import { renderSearch } from './lib/render.ts';

/** One search over cards and asks (docs/work-search.md). `WorkSearchService` satisfies this structurally. */
export interface WorkSearchSubsystem {
  search(query: WorkSearchQuery): Promise<WorkSearchResponse>;
  related(request: WorkRelatedRequest): Promise<WorkRelatedResponse>;
}

const TEXT_FIELDS = ['q', 'kind', 'project'] as const;

/** The search, from the URL's query string. A field given empty is a field not given. */
const searchQueryOf = (call: Parameters<RouteHandler>[0]): WorkSearchQuery => {
  const input: Record<string, unknown> = {};
  for (const field of TEXT_FIELDS) {
    const value = queryValue(call.request, field);
    if (value !== undefined && value !== '') input[field] = value;
  }
  for (const flag of ['open', 'all'] as const) {
    const value = queryValue(call.request, flag);
    if (value !== undefined && value !== '') input[flag] = value === 'true' ? true : value === 'false' ? false : value;
  }
  const limit = queryValue(call.request, 'limit');
  if (limit !== undefined && limit !== '') input.limit = /^[0-9]+$/u.test(limit) ? Number(limit) : limit;
  const parsed = WorkSearchQuerySchema.safeParse(input);
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
 * Exactly the grants of the board: `operator`, plus the `fleet` capability (the manifest says so), because an answer
 * names cards and asks and quotes a line of each. The related check is a POST only because a title and an ask do not
 * fit a URL; it reads, never writes.
 */
export function searchRoute(search: WorkSearchSubsystem): RouteHandler {
  return async call => jsonResponse(await search.search(searchQueryOf(call)));
}

export function relatedRoute(search: WorkSearchSubsystem): RouteHandler {
  return async call => jsonResponse(await search.related(await parseBody(call.request, WorkRelatedRequestSchema)));
}

/** The `search_work` agent tool: the same search, answered as the lines a model reads, with the hits as data. */
export function searchWorkTool(search: WorkSearchSubsystem) {
  return async (_call: unknown, input: unknown) => {
    const parsed = SearchWorkToolInputSchema.safeParse(input);
    if (!parsed.success) return { text: 'search_work needs a query of 1 to 200 characters', isError: true };
    const { query, kind, open, all } = parsed.data;
    const answer = await search.search(
      WorkSearchQuerySchema.parse({
        q: query,
        ...(kind === undefined ? {} : { kind }),
        ...(open === true ? { open: true } : {}),
        ...(all === true ? { all: true } : {}),
      }),
    );
    return { text: renderSearch(query, kind, answer), data: JSON.parse(JSON.stringify(answer)) as never };
  };
}
