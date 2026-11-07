import { describe, expect, it } from 'bun:test';
import type { AnalyticsResponse } from '../../../../contract/index.ts';
import { fetchAnalytics, fetchSessionAnalytics } from '../../../../app/features/analytics/analytics-api.ts';
import { fakeClient, type RecordedCall, refusingClient } from '../support/client.ts';
import { daemonConnection, daemonSessionScope } from '../support/shell.ts';

const ROUTE = 'GET /v1/usage/insights';
const daemon = daemonConnection({ daemonId: 'daemon-a' });
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

describe('insights transport', () => {
  it('reads the insights route of the supplied daemon client and canonicalises an optional query', async () => {
    const client = fakeClient({ [ROUTE]: (call: RecordedCall) => empty(call.query?.q ?? 'sum by (day)') });

    expect(await fetchAnalytics(client, '  ')).toEqual(empty());
    expect(await fetchAnalytics(client, ' count by (status) ')).toEqual(empty('count by (status)'));
    expect(client.calls.map(call => [call.route, call.query])).toEqual([
      [ROUTE, {}],
      [ROUTE, { q: 'count by (status)' }],
    ]);
  });

  it('asks the daemon to count days in the zone it is given, and in UTC when it is given none', async () => {
    const client = fakeClient({ [ROUTE]: empty() });

    await fetchAnalytics(client, 'sum by (day)', 'Asia/Singapore');
    await fetchAnalytics(client, 'sum by (day)');

    expect(client.calls.map(call => call.query)).toEqual([
      { q: 'sum by (day)', tz: 'Asia/Singapore' },
      { q: 'sum by (day)' },
    ]);
  });

  it('keeps daemon failures and malformed replies explicit', async () => {
    await expect(fetchAnalytics(refusingClient(503, 'gone', 'offline'))).rejects.toMatchObject({
      status: 503,
      code: 'gone',
      message: 'offline',
    });
    await expect(fetchAnalytics(fakeClient({ [ROUTE]: { nope: true } }))).rejects.toThrow();
  });
});

describe('session insights transport', () => {
  // A second daemon and two same-id scopes prove the request is fenced to the (connection, scope) pair, never to a
  // bare session id.
  const daemonB = daemonConnection({ daemonId: 'daemon-b' });
  const scopeA = daemonSessionScope(daemon, 'ms59');
  const scopeB = daemonSessionScope(daemonB, 'ms59');

  // The daemon echoes the enforced canonical query; a transport test supplies that result while asserting the
  // separate session scope request.
  const echoScoped = fakeClient({
    [ROUTE]: (call: RecordedCall) => empty(call.query?.q ?? `sum by (model) {id=${call.query?.session}}`),
  });

  it('throws before any request when the scope belongs to a different daemon', async () => {
    await expect(fetchSessionAnalytics(daemon, echoScoped, scopeB)).rejects.toThrow(
      'insights scope must belong to the requested daemon',
    );
    expect(echoScoped.calls).toHaveLength(0);
  });

  it('sends an exact session separately from editable query text', async () => {
    const client = fakeClient({ [ROUTE]: (call: RecordedCall) => empty(call.query?.q ?? 'sum by (model) {id=ms59}') });

    // A blank default, then a query whose visible id names a different session.
    await fetchSessionAnalytics(daemon, client, scopeA, undefined);
    await fetchSessionAnalytics(daemon, client, scopeA, 'sum by (model) {id=someone-else}');

    // The untrusted visible id is preserved as text, while every request independently names the exact session the
    // daemon must enforce.
    expect(client.calls.map(call => call.query?.q ?? null)).toEqual([null, 'sum by (model) {id=someone-else}']);
    expect(client.calls.map(call => call.query?.session)).toEqual(['ms59', 'ms59']);
  });

  it('leaves the server to select the canonical scoped default for a blank query', async () => {
    expect(await fetchSessionAnalytics(daemon, echoScoped, scopeA, '   ')).toMatchObject({
      query: 'sum by (model) {id=ms59}',
    });
  });

  it('keeps daemon failures explicit on the session path', async () => {
    await expect(
      fetchSessionAnalytics(daemon, refusingClient(503, 'gone', 'offline'), scopeA, undefined),
    ).rejects.toMatchObject({ status: 503, code: 'gone' });
  });
});
