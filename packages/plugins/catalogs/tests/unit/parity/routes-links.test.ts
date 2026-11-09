/**
 * The Catalogs-owned R rows for download links, over the real daemon half on the kernel's test host.
 *
 * What these prove is what a person can do with links that EXIST: read them, filter them, preview what one would
 * carry and Copy one. Making a link, moving it, changing its end and turning it off reach the link store; those
 * rows are proven in routes-link-store.test.ts over `options.fetch`. One test per row, named by its id.
 */
import { describe, expect, test } from 'bun:test';
import type { SealedDocumentHandle, SealedDocumentsApi } from '@ferretry/core-vault/contract';
import { catalogsFixture, makeCatalog, mcpServer } from '../../support/daemon-host.ts';
import { storedLink } from '../catalog-links/support.ts';

const ferret = { kind: 'ferret', id: 'F1936' } as const;
const SOURCE = { kind: 'mcp', mcp: 'pdf-tools' } as const;
const KEY = 'K'.repeat(43);
const sealed: SealedDocumentsApi = {
  open: () =>
    ({
      names: async () => [],
      put: async () => undefined,
      get: async () => KEY,
      getBytes: async () => undefined,
      delete: async () => true,
    }) satisfies SealedDocumentHandle,
};

/** A host with one catalog item and one public link on file for it. */
async function withLink() {
  const fx = await catalogsFixture({
    mcp: [mcpServer('pdf-tools')],
    sealed,
    config: { 'catalogs.yaml': { linkStore: { url: 'https://links.example.test' } } },
  });
  const catalog = await makeCatalog(fx);
  const preview = await fx.host.request('POST', `/v1/catalogs/${catalog}/items/preview`, { body: { source: SOURCE } });
  const added = await fx.host.request('POST', `/v1/catalogs/${catalog}/items`, {
    body: { source: SOURCE, digest: preview.json<{ digest: string }>().digest },
  });
  const { itemId } = added.json<{ itemId: string }>();
  const link = storedLink({ state: 'live', kind: 'public', publisher: fx.daemonId, itemId });
  fx.host.state('catalogs').files.set('links.json', JSON.stringify({ format: 1, schemaVersion: 1, links: [link] }));
  return { fx, itemId, linkId: link.linkId };
}

describe('the download link routes', () => {
  test('R-0267 POST /v1/catalog-links/preview shows what a link would carry, writing nothing; a ferret cannot', async () => {
    const { fx, itemId } = await withLink();
    const files = fx.host.state('catalogs').files;
    const before = new Map(files);
    const byItem = await fx.host.request('POST', '/v1/catalog-links/preview', { body: { itemId, version: 1 } });
    expect(byItem.status).toBe(200);
    expect(byItem.json()).toMatchObject({ itemId, version: 1, name: 'pdf-tools', itemKind: 'mcp', newItem: false });
    const bySource = await fx.host.request('POST', '/v1/catalog-links/preview', { body: { source: SOURCE } });
    expect(bySource.status).toBe(200);
    // A preview writes nothing: every state file is as it was.
    expect(new Map(files)).toEqual(before);
    expect(
      (await fx.host.request('POST', '/v1/catalog-links/preview', { body: { source: SOURCE }, as: ferret })).status,
    ).toBe(403);
    expect((await fx.host.request('POST', '/v1/catalog-links/preview', { body: {} })).status).toBe(400);
  });

  test('R-0065 R-0066 GET /v1/catalog-links lists links, filtered by item, and one link is read by its id', async () => {
    const { fx, linkId, itemId } = await withLink();
    const all = await fx.host.request('GET', '/v1/catalog-links', { as: ferret });
    expect(all.status).toBe(200);
    expect(all.json()).toMatchObject({ links: [{ linkId, itemId }] });
    expect(all.body).not.toContain(KEY);
    const byItem = await fx.host.request('GET', '/v1/catalog-links', { query: { itemId } });
    expect(byItem.json<{ links: unknown[] }>().links).toHaveLength(1);
    const other = await fx.host.request('GET', '/v1/catalog-links', { query: { itemId: `itm_${'Z'.repeat(22)}` } });
    expect(other.json<{ links: unknown[] }>().links).toEqual([]);
    expect((await fx.host.request('GET', '/v1/catalog-links', { query: { other: '1' } })).status).toBe(400);
    expect((await fx.host.request('GET', '/v1/catalog-links', { query: { itemId: 'x' } })).status).toBe(400);
    const one = await fx.host.request('GET', `/v1/catalog-links/${linkId}`);
    expect(one.status).toBe(200);
    expect(one.json()).toMatchObject({ linkId, itemId, state: 'live' });
    expect((await fx.host.request('GET', `/v1/catalog-links/lnk_${'z'.repeat(22)}`)).status).toBe(404);
    expect((await fx.host.request('GET', '/v1/catalog-links/nope')).status).toBe(404);
  });

  test('R-0266 POST /v1/catalog-links/:linkId/copy shows a public link’s URL with its key; a ferret cannot', async () => {
    const { fx, linkId } = await withLink();
    const copied = await fx.host.request('POST', `/v1/catalog-links/${linkId}/copy`);
    expect(copied.status).toBe(200);
    expect(new URL(copied.json<{ url: string }>().url).hash).toContain(`k=${KEY}`);
    expect((await fx.host.request('POST', `/v1/catalog-links/${linkId}/copy`, { as: ferret })).status).toBe(403);
    expect((await fx.host.request('POST', `/v1/catalog-links/lnk_${'z'.repeat(22)}/copy`)).status).toBe(404);
  });
});
