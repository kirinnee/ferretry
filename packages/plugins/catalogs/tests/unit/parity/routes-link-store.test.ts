/**
 * The Catalogs-owned R rows for the routes that talk to the link store: its status, making a download link, moving
 * it to another version, changing its end and cap, and turning it off.
 *
 * They run over the real daemon half on the kernel's test host with `options.fetch` standing in for the store (no
 * network). The manifest declares ONE outside host, the `link-store` resolver, so every request below is also a proof
 * that the kernel let that host through and no other. The store fake does not verify the request signature (the
 * kernel's signer is replaced by the fixture's own over a real key); it answers the five calls of the wire.
 */
import { describe, expect, test } from 'bun:test';
import type { SealedDocumentHandle, SealedDocumentsApi } from '@ferretry/core-vault/contract';
import { catalogsFixture, makeCatalog, mcpServer } from '../../support/daemon-host.ts';
import { LinkStoreHosts } from '../../../daemon/adapters/link-store-hosts.ts';

const ferret = { kind: 'ferret', id: 'F1936' } as const;
const SOURCE = { kind: 'mcp', mcp: 'pdf-tools' } as const;
const STORE = 'https://links.example.test';
const NONCE = Buffer.alloc(32, 5).toString('base64url');
const sealedKeys = new Map<string, string>();
const sealed: SealedDocumentsApi = {
  open: () =>
    ({
      names: async () => [...sealedKeys.keys()],
      put: async (name: string, value: string) => void sealedKeys.set(name, value),
      get: async (name: string) => sealedKeys.get(name),
      getBytes: async () => undefined,
      delete: async (name: string) => sealedKeys.delete(name),
    }) satisfies SealedDocumentHandle,
};

interface Call {
  readonly method: string;
  readonly url: string;
}

/** A store that takes links: each answer is the wire's, and every request is recorded. */
function store(options: { available?: boolean } = {}) {
  const calls: Call[] = [];
  const bundles = new Set<string>();
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = async (url: URL, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url: url.toString() });
    if (url.pathname === '/v1/link-store')
      return json({ version: 1, available: options.available ?? true, maxEnvelopeBytes: 1_000_000, maxLiveLinks: 50 });
    if (url.pathname === '/v1/link-store/challenge') return json({ version: 1, nonce: NONCE, deadlineSeconds: 60 });
    if (url.pathname === '/v1/link-store/status')
      return json({ version: 1, links: [...bundles].map(bundleId => ({ bundleId, state: 'live', kind: 'public' })) });
    const bundle = /^\/v1\/links\/(.+)$/u.exec(url.pathname)?.[1];
    if (bundle === undefined) return json({ error: { code: 'unknown' } }, 404);
    if (method === 'PUT') bundles.add(bundle);
    if (method === 'DELETE') bundles.delete(bundle);
    return new Response(null, { status: 204 });
  };
  return { fetch, calls, bundles };
}

/** A host with one catalog item (versions 1 and 2) and the link store configured. */
async function withStore(options: { available?: boolean; linkStore?: unknown } = {}) {
  sealedKeys.clear();
  const servers = [mcpServer('pdf-tools')];
  const remote = store(options);
  const fx = await catalogsFixture({
    mcp: servers,
    sealed,
    fetch: remote.fetch,
    config: { 'catalogs.yaml': { linkStore: options.linkStore ?? { url: STORE } } },
  });
  const catalog = await makeCatalog(fx);
  const preview = await fx.host.request('POST', `/v1/catalogs/${catalog}/items/preview`, { body: { source: SOURCE } });
  const added = await fx.host.request('POST', `/v1/catalogs/${catalog}/items`, {
    body: { source: SOURCE, digest: preview.json<{ digest: string }>().digest },
  });
  const { itemId } = added.json<{ itemId: string }>();
  servers[0] = mcpServer('pdf-tools', ['-y', 'pdf-tools@2']);
  const next = await fx.host.request('POST', `/v1/catalog-items/${itemId}/versions/preview`, { body: {} });
  const published = await fx.host.request('POST', `/v1/catalog-items/${itemId}/versions`, {
    body: { digest: next.json<{ digest: string }>().digest },
  });
  expect(published.status).toBe(201);
  const digestOf = async (version: number): Promise<string> =>
    (await fx.host.request('POST', '/v1/catalog-links/preview', { body: { itemId, version } })).json<{
      digest: string;
    }>().digest;
  return { fx, itemId, remote, digestOf };
}

type Setup = Awaited<ReturnType<typeof withStore>>;

async function mint(setup: Setup, version = 1, extra: Record<string, unknown> = {}) {
  const { fx, itemId, digestOf } = setup;
  return await fx.host.request('POST', '/v1/catalog-links', {
    body: { item: { itemId, version, digest: await digestOf(version) }, kind: 'public', expires: '7d', ...extra },
  });
}

describe('the download link routes that reach the link store', () => {
  test('R-0067 GET /v1/catalog-links/store asks the configured store whether it takes links; a ferret may read it', async () => {
    const { fx, remote } = await withStore();
    const on = await fx.host.request('GET', '/v1/catalog-links/store', { as: ferret });
    expect(on.status).toBe(200);
    expect(on.json()).toMatchObject({ available: true, origin: STORE });
    expect(remote.calls).toEqual([{ method: 'GET', url: `${STORE}/v1/link-store` }]);

    const down = await withStore({ available: false });
    const off = await down.fx.host.request('GET', '/v1/catalog-links/store');
    expect(off.json()).toMatchObject({ available: false });
    expect(off.json<{ origin?: string }>().origin).toBeUndefined();

    const disabled = await withStore({ linkStore: { enabled: false } });
    const turnedOff = await disabled.fx.host.request('GET', '/v1/catalog-links/store');
    expect(turnedOff.json()).toMatchObject({ available: false });
    // Turned off: the store is not even asked.
    expect(disabled.remote.calls).toEqual([]);
  });

  test('R-0265 POST /v1/catalog-links makes a public link: the bundle is uploaded to the store and only the owner may', async () => {
    const setup = await withStore();
    const made = await mint(setup);
    expect(made.status).toBe(201);
    const body = made.json<{ url: string; link: { state: string; kind: string; version: number } }>();
    expect(body.link).toMatchObject({ state: 'live', kind: 'public', version: 1 });
    expect(new URL(body.url).hash).toContain('k=');
    const put = setup.remote.calls.filter(call => call.method === 'PUT');
    expect(put).toHaveLength(1);
    expect(put[0]?.url.startsWith(`${STORE}/v1/links/`)).toBe(true);
    expect(setup.remote.bundles.size).toBe(1);
    // Every call the kernel let through went to the one configured store.
    expect(new Set(setup.remote.calls.map(call => new URL(call.url).origin))).toEqual(new Set([STORE]));

    const { fx, itemId, digestOf } = setup;
    const item = { itemId, version: 1, digest: await digestOf(1) };
    expect(
      (
        await fx.host.request('POST', '/v1/catalog-links', {
          body: { item, kind: 'public', expires: '7d' },
          as: ferret,
        })
      ).status,
    ).toBe(403);
    expect((await fx.host.request('POST', '/v1/catalog-links', { body: {} })).status).toBe(400);
    const stale = await fx.host.request('POST', '/v1/catalog-links', {
      body: { item: { ...item, digest: `sha256:${'0'.repeat(64)}` }, kind: 'public', expires: '7d' },
    });
    expect(stale.status).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'changed_since_preview' });
  });

  test('R-0265 a store that takes no links, or none configured, answers 503 and writes no link', async () => {
    const down = await withStore({ available: false });
    const refused = await mint(down);
    expect(refused.status).toBe(503);
    expect(refused.json()).toMatchObject({ code: 'link_store_unavailable' });
    expect(down.remote.calls.some(call => call.method === 'PUT')).toBe(false);
    expect((await down.fx.host.request('GET', '/v1/catalog-links')).json<{ links: unknown[] }>().links).toEqual([]);

    const off = await withStore({ linkStore: { enabled: false } });
    expect((await mint(off)).status).toBe(503);
    expect(off.remote.calls).toEqual([]);
  });

  test('R-0417 PUT /v1/catalog-links/:linkId/version moves a link to another version of its item; a stale screen is refused', async () => {
    const setup = await withStore();
    const { fx, digestOf, remote } = setup;
    const linkId = (await mint(setup)).json<{ link: { linkId: string } }>().link.linkId;
    const path = `/v1/catalog-links/${linkId}/version`;
    const digest = await digestOf(2);
    expect((await fx.host.request('PUT', path, { body: { version: 2, from: 1, digest }, as: ferret })).status).toBe(
      403,
    );
    const stale = await fx.host.request('PUT', path, { body: { version: 2, from: 5, digest } });
    expect(stale.status).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'current_changed' });
    const same = await fx.host.request('PUT', path, { body: { version: 1, from: 1, digest } });
    expect(same.status).toBe(409);
    expect(same.json()).toMatchObject({ code: 'nothing_to_publish' });

    const puts = remote.calls.filter(call => call.method === 'PUT').length;
    const moved = await fx.host.request('PUT', path, { body: { version: 2, from: 1, digest } });
    expect(moved.status).toBe(200);
    expect(moved.json()).toMatchObject({ linkId, version: 2, state: 'live' });
    expect(remote.calls.filter(call => call.method === 'PUT')).toHaveLength(puts + 1);
    expect((await fx.host.request('GET', `/v1/catalog-links/${linkId}`)).json()).toMatchObject({ version: 2 });
  });

  test('R-0217 PATCH /v1/catalog-links/:linkId changes a link’s end and cap; an empty change and a ferret are refused', async () => {
    const setup = await withStore();
    const { fx, remote } = setup;
    const linkId = (await mint(setup, 1, { installCap: 10 })).json<{ link: { linkId: string } }>().link.linkId;
    const path = `/v1/catalog-links/${linkId}`;
    expect((await fx.host.request('PATCH', path, { body: { installCap: 3 }, as: ferret })).status).toBe(403);
    expect((await fx.host.request('PATCH', path, { body: {} })).status).toBe(400);
    const puts = remote.calls.filter(call => call.method === 'PUT').length;
    const narrowed = await fx.host.request('PATCH', path, { body: { installCap: 3, expires: '1d' } });
    expect(narrowed.status).toBe(200);
    expect(narrowed.json()).toMatchObject({ linkId, installCap: 3 });
    expect(remote.calls.filter(call => call.method === 'PUT')).toHaveLength(puts + 1);
    const widened = await fx.host.request('PATCH', path, { body: { installCap: null, expires: 'never' } });
    expect(widened.status).toBe(200);
    expect(widened.json<{ installCap?: number }>().installCap).toBeUndefined();
    expect(
      (await fx.host.request('PATCH', `/v1/catalog-links/lnk_${'z'.repeat(22)}`, { body: { installCap: 1 } })).status,
    ).toBe(404);
  });

  test('R-0007 DELETE /v1/catalog-links/:linkId turns a link off at the store; a ferret cannot, and a second call changes nothing', async () => {
    const setup = await withStore();
    const { fx, remote } = setup;
    const linkId = (await mint(setup)).json<{ link: { linkId: string } }>().link.linkId;
    expect((await fx.host.request('DELETE', `/v1/catalog-links/${linkId}`, { as: ferret })).status).toBe(403);
    expect(remote.bundles.size).toBe(1);
    const off = await fx.host.request('DELETE', `/v1/catalog-links/${linkId}`);
    expect(off.status).toBe(200);
    expect(off.json()).toMatchObject({ linkId, state: 'ended' });
    expect(remote.bundles.size).toBe(0);
    expect(remote.calls.filter(call => call.method === 'DELETE')).toHaveLength(1);
    const again = await fx.host.request('DELETE', `/v1/catalog-links/${linkId}`);
    expect(again.json()).toMatchObject({ state: 'ended' });
    expect(remote.calls.filter(call => call.method === 'DELETE')).toHaveLength(1);
    expect((await fx.host.request('DELETE', `/v1/catalog-links/lnk_${'z'.repeat(22)}`)).status).toBe(404);
  });

  test('R-0007 a link made on one store is still turned off there after the setting names another', async () => {
    const setup = await withStore();
    const { fx, remote } = setup;
    const linkId = (await mint(setup)).json<{ link: { linkId: string } }>().link.linkId;
    fx.host.setConfig('catalogs.yaml', { linkStore: { url: 'https://other.example.test' } });
    const off = await fx.host.request('DELETE', `/v1/catalog-links/${linkId}`);
    expect(off.status).toBe(200);
    expect(remote.bundles.size).toBe(0);
    expect(remote.calls.every(call => new URL(call.url).origin === STORE)).toBe(true);
  });
});

describe('the link-store hosts the kernel may reach', () => {
  const none = () => undefined;
  test('R-0265 the configured store, or the directory’s when none is named, and nothing else', () => {
    expect(new LinkStoreHosts(() => ({ url: 'https://links.example.test:8443/x' }), none).resolve()).toEqual([
      'links.example.test:8443',
    ]);
    expect(
      new LinkStoreHosts(
        () => ({ source: 'discovery' }),
        () => 'https://dir.example.test/',
      ).resolve(),
    ).toEqual(['dir.example.test']);
    expect(new LinkStoreHosts(() => ({ source: 'discovery' }), none).resolve()).toEqual([]);
    expect(new LinkStoreHosts(() => ({ url: 'not an address' }), none).resolve()).toEqual([]);
  });

  test('R-0007 turned off grants no new store; a store an existing link names stays, and a dropped link takes its store with it', () => {
    const hosts = new LinkStoreHosts(
      () => ({ enabled: false }),
      () => 'https://dir.example.test',
    );
    expect(hosts.resolve()).toEqual([]);
    hosts.remember(['https://old.example.test', 'https://old.example.test', 'nonsense']);
    expect(hosts.resolve()).toEqual(['old.example.test']);
    const configured = new LinkStoreHosts(() => ({ url: 'https://new.example.test' }), none);
    configured.remember(['https://old.example.test']);
    expect(configured.resolve()).toEqual(['new.example.test', 'old.example.test']);
    configured.remember([]);
    expect(configured.resolve()).toEqual(['new.example.test']);
  });
});
