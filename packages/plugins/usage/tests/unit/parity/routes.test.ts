/**
 * Parity rows R-0037, R-0038, R-0045, R-0046, R-0080, R-0204, R-0213, R-0247, R-0248, R-0282
 * (docs/design/rebuild-parity.md, usage): each route keeps today's descriptor fields and answers over the composed
 * daemon. The paths that held the replaced word `analytics` moved under `/v1/usage/…`
 * (`scripts/validate/descriptor-parity-changes.tsv`).
 */
import { describe, expect, test } from 'bun:test';
import manifest from '../../../manifest.ts';
import { usageHost } from './host.ts';

/** The descriptor fields the parity table records for a route. */
function declared(key: string) {
  const found = manifest.actions?.routes.find(route => route.key === key);
  expect(found).toBeDefined();
  return found;
}

describe('the public feed routes, served only once the machine opts in', () => {
  test('R-0038 GET /usage is open to any caller and uncached, answers 404 until usage.yaml opts in, then the feed with one row per login', async () => {
    expect(declared('GET /usage')).toMatchObject({ minimum: 'none', caller: 'any', noStore: true });
    const { host } = await usageHost();
    expect((await host.request('GET', '/usage')).status).toBe(404);

    host.setConfig('usage.yaml', { publicFeed: true });
    await host.settle();
    const answer = await host.request('GET', '/usage');

    expect(answer.status).toBe(200);
    expect(answer.json<{ ready: boolean; accounts: { agent: string }[] }>()).toMatchObject({
      ready: true,
      accounts: [{ agent: 'work' }],
    });
    await host.stop();
  });

  test('R-0037 GET /metrics is open to any caller and uncached, answers 404 until usage.yaml opts in, then Prometheus text', async () => {
    expect(declared('GET /metrics')).toMatchObject({ minimum: 'none', caller: 'any', noStore: true });
    const { host } = await usageHost();
    expect((await host.request('GET', '/metrics')).status).toBe(404);

    host.setConfig('usage.yaml', { publicFeed: true });
    await host.settle();
    const answer = await host.request('GET', '/metrics');

    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(answer.body).toContain('# HELP');
    await host.stop();
  });
});

describe('the feed, insights and pricing routes', () => {
  test('R-0204 GET /v1/usage needs a signed-in reader and answers one row per login', async () => {
    expect(declared('GET /v1/usage')).toMatchObject({ minimum: 'authenticated', caller: 'any', noStore: true });
    const { host } = await usageHost();

    const answer = await host.request('GET', '/v1/usage');

    expect(answer.status).toBe(200);
    expect(answer.json<{ accounts: { agent: string }[] }>().accounts.map(row => row.agent)).toEqual(['work']);
    await host.stop();
  });

  test('R-0045 GET /v1/usage/insights is the owner’s read of the index: a bounded query answers, a bad one is refused', async () => {
    expect(declared('GET /v1/usage/insights')).toMatchObject({ minimum: 'operator', caller: 'any', noStore: true });
    const { host, ferrets } = await usageHost();
    ferrets.add({ id: 'done' as never, state: 'stopped', login: 'work', cause: { kind: 'completed' } });
    await host.runJob('usage-ingest');

    const counted = await host.request('GET', '/v1/usage/insights', { query: { q: 'count by (agent)' } });
    const refused = await host.request('GET', '/v1/usage/insights', { query: { q: 'this is (not a query' } });

    expect(counted.status).toBe(200);
    expect(JSON.stringify(counted.json())).toContain('work');
    expect(refused.status).toBe(400);
    await host.stop();
  });

  test('R-0046 GET /v1/usage/pricing is the owner’s read of the rate catalog, with the fingerprints an edit must quote', async () => {
    expect(declared('GET /v1/usage/pricing')).toMatchObject({ minimum: 'operator', caller: 'any', noStore: true });
    const { host } = await usageHost();

    const answer = await host.request('GET', '/v1/usage/pricing');

    expect(answer.status).toBe(200);
    expect(answer.json()).toMatchObject({
      catalog: [],
      sources: [],
      catalogFingerprint: expect.any(String),
      sourcesFingerprint: expect.any(String),
    });
    await host.stop();
  });

  test('R-0213 PATCH /v1/usage/pricing is the owner’s edit: a malformed body is refused, and an edit made against a stale catalog is kept out', async () => {
    expect(declared('PATCH /v1/usage/pricing')).toMatchObject({ minimum: 'operator', caller: 'any', noStore: true });
    const { host } = await usageHost();

    const malformed = await host.request('PATCH', '/v1/usage/pricing', { body: {} });
    const stale = await host.request('PATCH', '/v1/usage/pricing', {
      body: { expectedCatalogFingerprint: 'not-the-fingerprint', operations: [{ op: 'remove', pricingKey: 'k' }] },
    });

    expect(malformed.status).toBe(400);
    expect(malformed.json()).toMatchObject({ code: 'invalid_request' });
    expect(stale.status).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'pricing_stale_catalog' });
    await host.stop();
  });

  test('R-0248 POST /v1/usage/pricing/sync/preview names a configured source only: a stale catalog is refused, and so is a source the daemon was not given', async () => {
    expect(declared('POST /v1/usage/pricing/sync/preview')).toMatchObject({
      minimum: 'operator',
      caller: 'any',
      noStore: true,
    });
    const { host } = await usageHost();
    const { catalogFingerprint } = (await host.request('GET', '/v1/usage/pricing')).json<{
      catalogFingerprint: string;
    }>();

    const stale = await host.request('POST', '/v1/usage/pricing/sync/preview', {
      body: { sourceId: 'any', expectedCatalogFingerprint: 'stale' },
    });
    const unknown = await host.request('POST', '/v1/usage/pricing/sync/preview', {
      body: { sourceId: 'not-configured', expectedCatalogFingerprint: catalogFingerprint },
    });

    expect(stale.status).toBe(409);
    expect(unknown.status).toBe(404);
    expect(unknown.json()).toMatchObject({ code: 'pricing_unknown_source' });
    await host.stop();
  });

  test('R-0247 POST /v1/usage/pricing/sync/apply reaches only a preview this process issued', async () => {
    expect(declared('POST /v1/usage/pricing/sync/apply')).toMatchObject({
      minimum: 'operator',
      caller: 'any',
      noStore: true,
    });
    const { host } = await usageHost();

    const answer = await host.request('POST', '/v1/usage/pricing/sync/apply', {
      body: {
        previewId: 'never-issued',
        expectedCatalogFingerprint: 'a',
        expectedResultFingerprint: 'b',
        selectedPricingKeys: ['k'],
      },
    });

    expect(answer.status).toBe(404);
    expect(answer.json()).toMatchObject({ code: 'pricing_unknown_preview' });
    await host.stop();
  });
});

describe('the performance profile routes', () => {
  test('R-0282 POST /v1/diagnostics/profile starts a window and answers 202 with its id, still running; an invalid window is refused', async () => {
    expect(declared('POST /v1/diagnostics/profile')).toMatchObject({
      minimum: 'operator',
      caller: 'any',
      noStore: true,
    });
    const { host } = await usageHost();

    const started = await host.request('POST', '/v1/diagnostics/profile', { body: { seconds: 5 } });
    const refused = await host.request('POST', '/v1/diagnostics/profile', { body: { seconds: -1 } });

    expect(started.status).toBe(202);
    expect(started.json()).toMatchObject({ state: 'running', id: expect.any(String) });
    expect(refused.status).toBe(400);
    await host.stop();
  });

  test('R-0080 GET /v1/diagnostics/profile/:id reads the window by id and answers 404 for one this daemon never started', async () => {
    expect(declared('GET /v1/diagnostics/profile/:id')).toMatchObject({
      minimum: 'operator',
      caller: 'any',
      noStore: true,
    });
    const { host } = await usageHost();
    const started = (await host.request('POST', '/v1/diagnostics/profile', { body: { seconds: 5 } })).json<{
      id: string;
    }>();

    const read = await host.request('GET', `/v1/diagnostics/profile/${started.id}`);
    const missing = await host.request('GET', '/v1/diagnostics/profile/never-started');

    expect(read.status).toBe(200);
    expect(read.json()).toMatchObject({ id: started.id });
    expect(missing.status).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'profile_not_found' });
    await host.stop();
  });
});
