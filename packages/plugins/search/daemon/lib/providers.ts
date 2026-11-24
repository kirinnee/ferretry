import type { CredentialPlacement } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { SEARCH_PROVIDERS, type SearchHit, type SearchProviderId } from '../../contract/index.ts';

/**
 * How each of the six providers is asked and read. A table, one adapter per provider, nothing shared but the shape.
 *
 * Every request is built from the query and a count and carries NO credential: the kernel places the key
 * (`kernel.secrets.send`), as a header the adapter names. Every reply is read through a lenient schema and cut to
 * {@link SearchHit}: a provider that changes a field loses that field's text, never the whole answer.
 *
 * Shapes are from each vendor's own documentation (checked 2026-11-24). Serper publishes no readable reference, so its
 * shape is the community-documented one and is the first thing the owner's real test proves.
 */

/** One request as data: the part of an outbound request an adapter decides. */
interface ProviderRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  /** Where the key goes; absent means `authorization: Bearer <key>`. */
  readonly placement?: CredentialPlacement;
}

export interface ProviderAdapter {
  request(query: string, count: number): ProviderRequest;
  /** The results of a 2xx reply, or `undefined` when the reply is not the shape this provider documents. */
  read(payload: unknown): readonly SearchHit[] | undefined;
}

const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json' } as const;
const TITLE_CHARS = 200;
const URL_CHARS = 500;
export const SNIPPET_CHARS = 300;

const text = z.string().optional();
const clip = (value: string | undefined, chars: number): string => {
  const flat = (value ?? '').replace(/\s+/gu, ' ').trim();
  return flat.length <= chars ? flat : `${flat.slice(0, chars - 1).trimEnd()}…`;
};

/** A result with no address is not a result. */
function hitOf(title: string | undefined, url: string | undefined, snippet: string | undefined): SearchHit | undefined {
  const address = clip(url, URL_CHARS);
  if (address === '') return undefined;
  return { title: clip(title, TITLE_CHARS), url: address, snippet: clip(snippet, SNIPPET_CHARS) };
}

/**
 * Reads `payload` through `schema` and maps the list it names. A body that is an object with no list is "no results"
 * (providers omit the list when nothing matched); only a body that is not an object at all is `undefined`.
 */
function readList<Row>(
  schema: z.ZodType<readonly Row[]>,
  payload: unknown,
  toHit: (row: Row) => SearchHit | undefined,
): readonly SearchHit[] | undefined {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) return undefined;
  return parsed.data.map(toHit).filter((hit): hit is SearchHit => hit !== undefined);
}

const serperRows = z
  .looseObject({
    organic: z.array(z.looseObject({ title: text, link: text, snippet: text })).optional(),
  })
  .transform(body => body.organic ?? []);

const braveRows = z
  .looseObject({
    web: z
      .looseObject({ results: z.array(z.looseObject({ title: text, url: text, description: text })).optional() })
      .optional(),
  })
  .transform(body => body.web?.results ?? []);

const tavilyRows = z
  .looseObject({ results: z.array(z.looseObject({ title: text, url: text, content: text })).optional() })
  .transform(body => body.results ?? []);

const exaRows = z
  .looseObject({
    results: z
      .array(z.looseObject({ title: text, url: text, text, summary: text, highlights: z.array(z.string()).optional() }))
      .optional(),
  })
  .transform(body => body.results ?? []);

const perplexityRows = z
  .looseObject({ results: z.array(z.looseObject({ title: text, url: text, snippet: text })).optional() })
  .transform(body => body.results ?? []);

const firecrawlRow = z.looseObject({ title: text, url: text, description: text });
/** v2 answers `data.web[]`; v1 answered `data[]`. Both are read, so a plan still on either one works. */
const firecrawlRows = z
  .looseObject({
    data: z.union([z.array(firecrawlRow), z.looseObject({ web: z.array(firecrawlRow).optional() })]),
  })
  .transform(body => (Array.isArray(body.data) ? body.data : (body.data.web ?? [])));

export const SEARCH_ADAPTERS: Readonly<Record<SearchProviderId, ProviderAdapter>> = Object.freeze({
  // https://serper.dev: POST /search {q, num}, key in `X-API-KEY`, results in `organic[]`.
  serper: {
    request: (query, count) => ({
      method: 'POST',
      url: `https://${SEARCH_PROVIDERS.serper.host}/search`,
      headers: JSON_HEADERS,
      body: JSON.stringify({ q: query, num: count }),
      placement: { header: 'x-api-key' },
    }),
    read: payload => readList(serperRows, payload, row => hitOf(row.title, row.link, row.snippet)),
  },
  // https://docs.firecrawl.dev/api-reference/endpoint/search: POST /v2/search {query, limit}, Bearer.
  firecrawl: {
    request: (query, count) => ({
      method: 'POST',
      url: `https://${SEARCH_PROVIDERS.firecrawl.host}/v2/search`,
      headers: JSON_HEADERS,
      body: JSON.stringify({ query, limit: count }),
    }),
    read: payload => readList(firecrawlRows, payload, row => hitOf(row.title, row.url, row.description)),
  },
  // https://api-dashboard.search.brave.com/documentation/services/web-search: GET /res/v1/web/search?q&count,
  // key in `X-Subscription-Token`, results in `web.results[]`.
  brave: {
    request: (query, count) => ({
      method: 'GET',
      url: `https://${SEARCH_PROVIDERS.brave.host}/res/v1/web/search?${new URLSearchParams({ q: query, count: String(count) }).toString()}`,
      headers: { accept: 'application/json' },
      placement: { header: 'x-subscription-token' },
    }),
    read: payload => readList(braveRows, payload, row => hitOf(row.title, row.url, row.description)),
  },
  // https://docs.perplexity.ai/api-reference/search-post: POST /search {query, max_results}, Bearer (the Search API,
  // not chat completions).
  perplexity: {
    request: (query, count) => ({
      method: 'POST',
      url: `https://${SEARCH_PROVIDERS.perplexity.host}/search`,
      headers: JSON_HEADERS,
      body: JSON.stringify({ query, max_results: count }),
    }),
    read: payload => readList(perplexityRows, payload, row => hitOf(row.title, row.url, row.snippet)),
  },
  // https://docs.exa.ai/reference/search: POST /search {query, numResults}, key in `x-api-key`. No `contents` is asked
  // for, because page text is billed on top of the search: a hit is its title and link (a highlight, summary or text
  // only if the account's own defaults send one).
  exa: {
    request: (query, count) => ({
      method: 'POST',
      url: `https://${SEARCH_PROVIDERS.exa.host}/search`,
      headers: JSON_HEADERS,
      body: JSON.stringify({ query, numResults: count }),
      placement: { header: 'x-api-key' },
    }),
    read: payload =>
      readList(exaRows, payload, row =>
        hitOf(row.title, row.url, row.highlights?.join(' ') ?? row.summary ?? row.text),
      ),
  },
  // https://docs.tavily.com/documentation/api-reference/endpoint/search: POST /search {query, max_results}, Bearer.
  tavily: {
    request: (query, count) => ({
      method: 'POST',
      url: `https://${SEARCH_PROVIDERS.tavily.host}/search`,
      headers: JSON_HEADERS,
      body: JSON.stringify({ query, max_results: count }),
    }),
    read: payload => readList(tavilyRows, payload, row => hitOf(row.title, row.url, row.content)),
  },
});
