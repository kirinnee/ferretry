/**
 * The Catalogs-owned R rows for the owner's side of a catalog: making, changing and deleting a catalog, freezing items
 * into it, publishing versions, one-tap Add, and the signed file. Every route is driven through the real daemon half
 * on the kernel's test host (`catalogsFixture`): the real services, state files and signatures, with only Gate's
 * admission, the passkey verifier and the MCP plugin's item provider as stand-ins. One test per row, named by its id.
 */
import { describe, expect, test } from 'bun:test';
import { catalogsFixture, type CatalogsFixture, makeCatalog, mcpServer } from '../../support/daemon-host.ts';

const ferret = { kind: 'ferret', id: 'F1936' } as const;
const SOURCE = { kind: 'mcp', mcp: 'pdf-tools' } as const;

interface Owned {
  readonly fx: CatalogsFixture;
  readonly servers: ReturnType<typeof mcpServer>[];
  readonly catalog: string;
  readonly itemId: string;
}

/** A host with one catalog that lists one frozen MCP item, version 1. */
async function withItem(): Promise<Owned> {
  const servers = [mcpServer('pdf-tools')];
  const fx = await catalogsFixture({ mcp: servers });
  const catalog = await makeCatalog(fx);
  const preview = await fx.host.request('POST', `/v1/catalogs/${catalog}/items/preview`, { body: { source: SOURCE } });
  const added = await fx.host.request('POST', `/v1/catalogs/${catalog}/items`, {
    body: { source: SOURCE, digest: preview.json<{ digest: string }>().digest },
  });
  return { fx, servers, catalog, itemId: added.json<{ itemId: string }>().itemId };
}

/** Moves the source on and publishes its next version through the item route. */
async function publishNext({ fx, servers, itemId }: Owned): Promise<void> {
  servers[0] = mcpServer('pdf-tools', ['-y', 'pdf-tools@2']);
  const next = await fx.host.request('POST', `/v1/catalog-items/${itemId}/versions/preview`, { body: {} });
  const published = await fx.host.request('POST', `/v1/catalog-items/${itemId}/versions`, {
    body: { digest: next.json<{ digest: string }>().digest },
  });
  expect(published.status).toBe(201);
}

describe('the catalog routes', () => {
  test('R-0269 R-0070 POST /v1/catalogs makes an empty catalog and GET /v1/catalogs lists it with its items', async () => {
    const fx = await catalogsFixture();
    const made = await fx.host.request('POST', '/v1/catalogs', { body: { name: 'Team skills', description: 'Ours' } });
    expect(made.status).toBe(201);
    expect(made.json()).toMatchObject({ name: 'Team skills', description: 'Ours', revision: 1 });
    const listed = await fx.host.request('GET', '/v1/catalogs');
    expect(listed.status).toBe(200);
    expect(listed.json<{ catalogs: unknown[] }>().catalogs).toHaveLength(1);
    expect(listed.json()).toMatchObject({ catalogs: [{ name: 'Team skills', items: [] }] });
    const unnamed = await fx.host.request('POST', '/v1/catalogs', { body: {} });
    expect(unnamed.status).toBe(400);
  });

  test('R-0219 PATCH /v1/catalogs/:id renames, describes and makes the default; an empty change is refused', async () => {
    const fx = await catalogsFixture();
    const id = await makeCatalog(fx, 'Team');
    const renamed = await fx.host.request('PATCH', `/v1/catalogs/${id}`, {
      body: { name: 'Crew', description: 'The crew', role: 'default' },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.json()).toMatchObject({ name: 'Crew', description: 'The crew' });
    expect((await fx.host.request('PATCH', `/v1/catalogs/${id}`, { body: {} })).status).toBe(400);
    expect((await fx.host.request('PATCH', `/v1/catalogs/cat_${'z'.repeat(22)}`, { body: { name: 'x' } })).status).toBe(
      404,
    );
  });

  test('R-0013 DELETE /v1/catalogs/:id deletes a catalog and every version in it; a ferret cannot', async () => {
    const fx = await catalogsFixture();
    const id = await makeCatalog(fx);
    expect((await fx.host.request('DELETE', `/v1/catalogs/${id}`, { as: ferret })).status).toBe(403);
    const deleted = await fx.host.request('DELETE', `/v1/catalogs/${id}`);
    expect(deleted.status).toBe(200);
    expect(deleted.json()).toEqual({ catalogId: id });
    expect((await fx.host.request('GET', '/v1/catalogs')).json<{ catalogs: unknown[] }>().catalogs).toEqual([]);
    expect((await fx.host.request('DELETE', `/v1/catalogs/${id}`)).status).toBe(404);
  });

  test('R-0273 R-0271 R-0061 R-0062 an item is previewed (its digest), added only at that digest, then listed and read', async () => {
    const servers = [mcpServer('pdf-tools')];
    const fx = await catalogsFixture({ mcp: servers });
    const catalog = await makeCatalog(fx);
    const preview = await fx.host.request('POST', `/v1/catalogs/${catalog}/items/preview`, {
      body: { source: SOURCE },
    });
    expect(preview.status).toBe(200);
    expect(preview.json()).toMatchObject({ catalogId: catalog, kind: 'mcp', name: 'pdf-tools', version: 1 });
    const digest = preview.json<{ digest: string }>().digest;
    const stale = await fx.host.request('POST', `/v1/catalogs/${catalog}/items`, {
      body: { source: SOURCE, digest: `sha256:${'0'.repeat(64)}` },
    });
    expect(stale.status).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'changed_since_preview' });
    const added = await fx.host.request('POST', `/v1/catalogs/${catalog}/items`, { body: { source: SOURCE, digest } });
    expect(added.status).toBe(201);
    const { itemId } = added.json<{ itemId: string }>();
    expect(added.json()).toMatchObject({ catalogId: catalog, itemVersion: 1 });
    const items = await fx.host.request('GET', '/v1/catalog-items');
    expect(items.status).toBe(200);
    expect(items.json()).toMatchObject({ items: [{ itemId, name: 'pdf-tools' }] });
    const one = await fx.host.request('GET', `/v1/catalog-items/${itemId}`);
    expect(one.status).toBe(200);
    expect(one.json()).toMatchObject({ itemId, kind: 'mcp', name: 'pdf-tools' });
    expect((await fx.host.request('GET', '/v1/catalog-items/itm_nope')).status).toBe(404);
  });

  test('R-0262 R-0261 an item previews its next version and publishes it only at that digest', async () => {
    const owned = await withItem();
    const { fx, servers, itemId } = owned;
    servers[0] = mcpServer('pdf-tools', ['-y', 'pdf-tools@2']);
    const preview = await fx.host.request('POST', `/v1/catalog-items/${itemId}/versions/preview`, { body: {} });
    expect(preview.status).toBe(200);
    expect(preview.json()).toMatchObject({ itemId, version: 2 });
    const stale = await fx.host.request('POST', `/v1/catalog-items/${itemId}/versions`, {
      body: { digest: `sha256:${'0'.repeat(64)}` },
    });
    expect(stale.status).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'changed_since_preview' });
    const published = await fx.host.request('POST', `/v1/catalog-items/${itemId}/versions`, {
      body: { digest: preview.json<{ digest: string }>().digest },
    });
    expect(published.status).toBe(201);
    expect(published.json()).toMatchObject({ itemId, itemVersion: 2, current: 2 });
  });

  test('R-0272 POST /v1/catalogs/:id/items/:itemId/versions publishes the next version into that catalog', async () => {
    const { fx, servers, catalog, itemId } = await withItem();
    servers[0] = mcpServer('pdf-tools', ['-y', 'pdf-tools@3']);
    const preview = await fx.host.request('POST', `/v1/catalogs/${catalog}/items/preview`, { body: { itemId } });
    expect(preview.status).toBe(200);
    const published = await fx.host.request('POST', `/v1/catalogs/${catalog}/items/${itemId}/versions`, {
      body: { digest: preview.json<{ digest: string }>().digest },
    });
    expect(published.status).toBe(201);
    expect(published.json()).toMatchObject({ catalogId: catalog, itemId, itemVersion: 2 });
  });

  test('R-0064 R-0063 a frozen version is read in full and two versions are compared; a ferret reads only the current one', async () => {
    const owned = await withItem();
    await publishNext(owned);
    const { fx, itemId } = owned;
    const first = await fx.host.request('GET', `/v1/catalog-items/${itemId}/versions/1`);
    expect(first.status).toBe(200);
    expect(first.json()).toMatchObject({ itemId, version: 1, kind: 'mcp', name: 'pdf-tools' });
    const changes = await fx.host.request('GET', `/v1/catalog-items/${itemId}/changes`, {
      query: { from: '1', to: '2' },
    });
    expect(changes.status).toBe(200);
    expect(changes.json()).toEqual({
      entries: [
        {
          label: 'Starts',
          change: 'changed',
          document: false,
          before: 'npx -y pdf-tools',
          after: 'npx -y pdf-tools@2',
          flag: 'command',
        },
      ],
      unchanged: 0,
      newWarnings: [],
      goneWarnings: [],
    });
    expect(
      (await fx.host.request('GET', `/v1/catalog-items/${itemId}/changes`, { query: { from: '2', to: '1' } })).json(),
    ).toMatchObject({ entries: [{ before: 'npx -y pdf-tools@2', after: 'npx -y pdf-tools' }] });
    expect((await fx.host.request('GET', `/v1/catalog-items/${itemId}/versions/9`)).status).toBe(404);
    expect((await fx.host.request('GET', `/v1/catalog-items/${itemId}/versions/1`, { as: ferret })).status).toBe(403);
    expect((await fx.host.request('GET', `/v1/catalog-items/${itemId}/versions/2`, { as: ferret })).status).toBe(200);
    expect(
      (
        await fx.host.request('GET', `/v1/catalog-items/${itemId}/changes`, {
          as: ferret,
          query: { from: '1', to: '2' },
        })
      ).status,
    ).toBe(403);
  });

  test('R-0416 R-0216 PUT /v1/catalog-items/:itemId/current picks the served version; PATCH …/versions/:version ends one', async () => {
    const owned = await withItem();
    await publishNext(owned);
    const { fx, itemId } = owned;
    const back = await fx.host.request('PUT', `/v1/catalog-items/${itemId}/current`, { body: { version: 1, from: 2 } });
    expect(back.status).toBe(200);
    const stale = await fx.host.request('PUT', `/v1/catalog-items/${itemId}/current`, {
      body: { version: 2, from: 2 },
    });
    expect(stale.status).toBe(409);
    const ended = await fx.host.request('PATCH', `/v1/catalog-items/${itemId}/versions/2`, {
      body: { retired: true },
    });
    expect(ended.status).toBe(200);
    const still = await fx.host.request('GET', `/v1/catalog-items/${itemId}/versions/2`);
    expect(still.json()).toMatchObject({ version: 2, retiredAt: expect.any(String) });
    expect(
      (await fx.host.request('PATCH', `/v1/catalog-items/${itemId}/versions/x`, { body: { retired: true } })).status,
    ).toBe(404);
  });

  test('R-0014 DELETE /v1/catalogs/:id/items/:itemId withdraws the item and bumps the catalog revision', async () => {
    const { fx, catalog, itemId } = await withItem();
    expect((await fx.host.request('DELETE', `/v1/catalogs/${catalog}/items/${itemId}`, { as: ferret })).status).toBe(
      403,
    );
    const withdrawn = await fx.host.request('DELETE', `/v1/catalogs/${catalog}/items/${itemId}`);
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.json()).toMatchObject({ catalogId: catalog, itemId, withdrawnAt: expect.any(String) });
  });

  test('R-0270 POST /v1/catalogs/:id/export writes the catalog as a signed file', async () => {
    const { fx, servers, catalog, itemId } = await withItem();
    const other = { kind: 'mcp', mcp: 'docs-tool' } as const;
    servers.push(mcpServer('docs-tool'));
    const otherPreview = await fx.host.request('POST', `/v1/catalogs/${catalog}/items/preview`, {
      body: { source: other },
    });
    await fx.host.request('POST', `/v1/catalogs/${catalog}/items`, {
      body: { source: other, digest: otherPreview.json<{ digest: string }>().digest },
    });
    const exported = await fx.host.request('POST', `/v1/catalogs/${catalog}/export`, { body: {} });
    expect(exported.status).toBe(200);
    const file = exported.json<{ signedManifest?: unknown; items?: unknown[] }>();
    expect(file.signedManifest).toBeDefined();
    expect(file.items).toHaveLength(2);
    const chosen = await fx.host.request('POST', `/v1/catalogs/${catalog}/export`, { body: { itemIds: [itemId] } });
    expect(chosen.status).toBe(200);
    const only = chosen.json<{ items: unknown[] }>().items;
    expect(only).toHaveLength(1);
    expect(JSON.stringify(only)).toContain(itemId);
    expect(JSON.stringify(only)).not.toContain('docs-tool');
    expect((await fx.host.request('POST', `/v1/catalogs/${catalog}/export`, { body: {}, as: ferret })).status).toBe(
      403,
    );
  });

  test('R-0263 R-0264 one-tap Add reviews what carries a command, lists nothing until a person has; Undo needs its token', async () => {
    const servers = [mcpServer('pdf-tools')];
    const fx = await catalogsFixture({ mcp: servers });
    const answer = await fx.host.request('POST', '/v1/catalog-items/quick-add', { body: { source: SOURCE } });
    expect(answer.status).toBe(200);
    expect(answer.json()).toMatchObject({ outcome: 'review' });
    expect((await fx.host.request('GET', '/v1/catalog-items')).json<{ items: unknown[] }>().items).toEqual([]);
    expect(
      (await fx.host.request('POST', '/v1/catalog-items/quick-add', { body: { source: SOURCE }, as: ferret })).status,
    ).toBe(403);
    const undone = await fx.host.request('POST', '/v1/catalog-items/quick-add/undo', {
      body: { token: `cqu_${'u'.repeat(22)}` },
    });
    expect(undone.status).toBe(410);
    expect(undone.json()).toMatchObject({ code: 'undo_expired' });
    expect((await fx.host.request('POST', '/v1/catalog-items/quick-add/undo', { body: { token: 'x' } })).status).toBe(
      400,
    );
  });
});
