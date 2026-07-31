import { describe, expect, it } from 'bun:test';
import type { AnalyticsResponse } from '@ferretry/protocol';

import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { fetchAnalytics } from '../../../src/features/analytics/analytics-api.ts';

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
