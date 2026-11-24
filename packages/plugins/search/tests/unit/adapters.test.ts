import { describe, expect, test } from 'bun:test';
import { SEARCH_PROVIDER_IDS, SEARCH_PROVIDERS } from '../../contract/index.ts';
import { SEARCH_ADAPTERS, SNIPPET_CHARS } from '../../daemon/lib/providers.ts';

/** What each provider's own documentation says a reply looks like. */
const REPLIES = {
  serper: { organic: [{ title: 'T1', link: 'https://a.test/1', snippet: 'S1', position: 1 }], credits: 1 },
  firecrawl: { success: true, data: { web: [{ title: 'T1', url: 'https://a.test/1', description: 'S1' }] } },
  brave: { type: 'search', web: { results: [{ title: 'T1', url: 'https://a.test/1', description: 'S1' }] } },
  perplexity: { id: 'x', results: [{ title: 'T1', url: 'https://a.test/1', snippet: 'S1', date: '2026-01-01' }] },
  exa: { results: [{ title: 'T1', url: 'https://a.test/1' }] },
  tavily: { results: [{ title: 'T1', url: 'https://a.test/1', content: 'S1', score: 0.9 }] },
} as const;

describe('each adapter asks its own provider the documented way', () => {
  test.each(SEARCH_PROVIDER_IDS)('%s: its host, a placed key and no credential of its own', id => {
    const request = SEARCH_ADAPTERS[id].request('rust borrow checker', 3);
    expect(new URL(request.url).host).toBe(SEARCH_PROVIDERS[id].host);
    expect(new URL(request.url).protocol).toBe('https:');
    // the key is the kernel's to place: nothing here may carry one
    expect(Object.keys(request.headers).map(name => name.toLowerCase())).not.toContain('authorization');
    expect(Object.keys(request.headers).map(name => name.toLowerCase())).not.toContain('x-api-key');
    expect(JSON.stringify(request)).toContain('rust');
    expect(JSON.stringify(request)).toContain('3');
  });

  test('Serper: POST /search {q, num}, key in x-api-key', () => {
    const request = SEARCH_ADAPTERS.serper.request('hello', 4);
    expect([request.method, request.url]).toEqual(['POST', 'https://google.serper.dev/search']);
    expect(JSON.parse(request.body ?? '')).toEqual({ q: 'hello', num: 4 });
    expect(request.placement).toEqual({ header: 'x-api-key' });
  });

  test('Brave: GET with q and count in the query, key in x-subscription-token', () => {
    const request = SEARCH_ADAPTERS.brave.request('a b&c', 4);
    expect(request.method).toBe('GET');
    expect(request.body).toBeUndefined();
    const url = new URL(request.url);
    expect(url.pathname).toBe('/res/v1/web/search');
    expect(url.searchParams.get('q')).toBe('a b&c');
    expect(url.searchParams.get('count')).toBe('4');
    expect(request.placement).toEqual({ header: 'x-subscription-token' });
  });

  test('Tavily, Perplexity and Firecrawl use the default Bearer placement; Exa uses x-api-key', () => {
    expect(SEARCH_ADAPTERS.tavily.request('q', 2).placement).toBeUndefined();
    expect(SEARCH_ADAPTERS.perplexity.request('q', 2).placement).toBeUndefined();
    expect(SEARCH_ADAPTERS.firecrawl.request('q', 2).placement).toBeUndefined();
    expect(SEARCH_ADAPTERS.exa.request('q', 2).placement).toEqual({ header: 'x-api-key' });
    expect(JSON.parse(SEARCH_ADAPTERS.tavily.request('q', 2).body ?? '')).toEqual({ query: 'q', max_results: 2 });
    expect(JSON.parse(SEARCH_ADAPTERS.perplexity.request('q', 2).body ?? '')).toEqual({ query: 'q', max_results: 2 });
    expect(JSON.parse(SEARCH_ADAPTERS.firecrawl.request('q', 2).body ?? '')).toEqual({ query: 'q', limit: 2 });
    expect(JSON.parse(SEARCH_ADAPTERS.exa.request('q', 2).body ?? '')).toEqual({ query: 'q', numResults: 2 });
  });
});

describe('each adapter reads its provider’s reply', () => {
  test.each(SEARCH_PROVIDER_IDS)('%s: title, link and snippet', id => {
    const hits = SEARCH_ADAPTERS[id].read(REPLIES[id]);
    expect(hits).toEqual([{ title: 'T1', url: 'https://a.test/1', snippet: id === 'exa' ? '' : 'S1' }]);
  });

  test('Firecrawl reads the older flat `data` list too', () => {
    const old = { success: true, data: [{ title: 'T', url: 'https://a.test/2', description: 'D' }] };
    expect(SEARCH_ADAPTERS.firecrawl.read(old)).toEqual([{ title: 'T', url: 'https://a.test/2', snippet: 'D' }]);
  });

  test('Exa reads highlights, then a summary, then text when the account sends them', () => {
    const read = (row: object) =>
      SEARCH_ADAPTERS.exa.read({ results: [{ title: 'T', url: 'https://a.test', ...row }] });
    expect(read({ highlights: ['one', 'two'] })?.[0]?.snippet).toBe('one two');
    expect(read({ summary: 'sum' })?.[0]?.snippet).toBe('sum');
    expect(read({ text: 'body' })?.[0]?.snippet).toBe('body');
  });

  test.each(SEARCH_PROVIDER_IDS)('%s: an answer with no list is "no results"; a non-object is not an answer', id => {
    const empty = id === 'firecrawl' ? { data: [] } : id === 'brave' ? { type: 'search' } : {};
    expect(SEARCH_ADAPTERS[id].read(empty)).toEqual([]);
    expect(SEARCH_ADAPTERS[id].read('nope')).toBeUndefined();
    expect(SEARCH_ADAPTERS[id].read(null)).toBeUndefined();
    expect(SEARCH_ADAPTERS[id].read([1, 2])).toBeUndefined();
  });

  test('a result with no address is dropped, and long text is cut short on one line', () => {
    const long = `${'word '.repeat(200)}\n\nend`;
    const hits = SEARCH_ADAPTERS.tavily.read({
      results: [
        { title: 'no link', content: 'x' },
        { title: 'T', url: 'https://a.test/3', content: long },
      ],
    });
    expect(hits).toHaveLength(1);
    const snippet = hits?.[0]?.snippet ?? '';
    expect(snippet.length).toBeLessThanOrEqual(SNIPPET_CHARS);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet).not.toContain('\n');
  });
});
