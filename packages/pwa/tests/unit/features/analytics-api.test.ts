import { describe, expect, it } from 'bun:test';
import type { AnalyticsResponse } from '@ferretry/protocol';

import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import { fetchAnalytics, fetchSessionAnalytics } from '../../../src/features/analytics/analytics-api.ts';

const daemon = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceToken: 'token-a' });
const index = {
  schemaVersion: 6,
  sessions: 0,
  tokenSessions: 0,
  transcriptSources: 0,
  indexedTranscriptSources: 0,
  pendingTranscriptSources: 0,
  sourceErrors: 0,
  refreshing: false,
};
const empty = (query = 'sum by (day)'): AnalyticsResponse =>
  ({
    kind: 'aggregate',
    aggregation: 'sum',
    query,
    parsed: { aggregation: 'sum', groupBy: ['day'], matchers: [] },
    scope: { allSessions: true, indexed: 0, matched: 0 },
    index,
    results: [],
  }) as AnalyticsResponse;

describe('analytics transport', () => {
  it('uses only the supplied paired daemon and canonicalises an optional query', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(empty(calls.length === 1 ? 'sum by (day)' : 'count by (status)')));
    };

    expect(await fetchAnalytics(daemon, '  ', fetcher)).toEqual(empty());
    expect(await fetchAnalytics(daemon, ' count by (status) ', fetcher)).toEqual(empty('count by (status)'));
    expect(calls.map(call => call.url)).toEqual([
      'https://a.example.test/v1/analytics',
      'https://a.example.test/v1/analytics?q=count+by+%28status%29',
    ]);
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer token-a');
  });

  it('keeps daemon failures and malformed replies explicit', async () => {
    await expect(
      fetchAnalytics(
        daemon,
        undefined,
        async () => new Response(JSON.stringify({ error: 'offline', code: 'gone' }), { status: 503 }),
      ),
    ).rejects.toMatchObject({ status: 503, code: 'gone' });
    await expect(
      fetchAnalytics(daemon, undefined, async () => new Response(JSON.stringify({ nope: true }))),
    ).rejects.toThrow();
    await expect(
      fetchAnalytics(daemon, undefined, async () => new Response('', { status: 500 })),
    ).rejects.toMatchObject({
      status: 500,
      message: 'HTTP 500',
    });
  });
});

describe('session analytics transport', () => {
  // A second paired daemon and two same-id scopes prove the request is fenced to
  // the (connection, scope) pair, never to a bare session id.
  const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.example.test', deviceToken: 'token-b' });
  const scopeA = daemonSessionScope(daemon, 'ms59');
  const scopeB = daemonSessionScope(daemonB, 'ms59');

  // Echo the enforced canonical `q` straight back as the response query, so the
  // "the box shows what actually ran" property is observable from the return value.
  const echoScoped = async (url: string | URL | Request): Promise<Response> => {
    const q = new URL(String(url), 'https://x.test').searchParams.get('q') ?? '';
    return new Response(JSON.stringify(empty(q)));
  };

  it('throws before any request when the scope belongs to a different daemon', async () => {
    await expect(fetchSessionAnalytics(daemon, scopeB)).rejects.toThrow(
      'analytics scope must belong to the requested daemon',
    );
  });

  it('replaces any caller-supplied id with the scope id and never sends session=', async () => {
    // Arrange — capture every URL so both the enforced `q` and the absence of a
    // `session` parameter are observable.
    const urls: string[] = [];
    const fetcher = async (url: string | URL | Request): Promise<Response> => {
      const href = String(url);
      urls.push(href);
      return echoScoped(href);
    };

    // Act — a blank default, then a query whose id names a different session.
    await fetchSessionAnalytics(daemon, scopeA, undefined, fetcher);
    await fetchSessionAnalytics(daemon, scopeA, 'sum by (model) {id=someone-else}', fetcher);

    // Assert — both requests carry ONLY the scope's exact id, unquoted as the
    // canonical bareword; the caller's id is gone, and no `session` parameter is
    // sent (the daemon would reject it with 400 `unknown_parameter`).
    const qs = urls.map(href => new URL(href, 'https://x.test').searchParams.get('q'));
    expect(qs).toEqual(['sum by (model) {id=ms59}', 'sum by (model) {id=ms59}']);
    for (const href of urls) expect(new URL(href, 'https://x.test').searchParams.has('session')).toBe(false);
  });

  it('defaults a blank query to the scoped sum-by-model default', async () => {
    // Act + Assert — whitespace-only collapses to the language default, scoped.
    expect(await fetchSessionAnalytics(daemon, scopeA, '   ', echoScoped)).toMatchObject({
      query: 'sum by (model) {id=ms59}',
    });
  });

  it('keeps daemon failures explicit on the session path', async () => {
    await expect(
      fetchSessionAnalytics(
        daemon,
        scopeA,
        undefined,
        async () => new Response(JSON.stringify({ error: 'offline', code: 'gone' }), { status: 503 }),
      ),
    ).rejects.toMatchObject({ status: 503, code: 'gone' });
  });
});
