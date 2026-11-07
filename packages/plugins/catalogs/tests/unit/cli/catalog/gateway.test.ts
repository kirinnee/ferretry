import { describe, it } from 'bun:test';
import should from 'should';
import { ClientCatalogGateway } from '../../../../cli/lib/catalog/gateway';
import type { CatalogApiClient } from '../../../../cli/lib/catalog/ports';
import {
  CATALOG_ID,
  catalog,
  catalogFile,
  catalogList,
  type DIGEST,
  NEW_DIGEST,
  preview,
  published,
  SKILL_ID,
  sharedItem,
  withdrawn,
} from './fixtures';

interface Call {
  route: string;
  init: { params?: unknown; query?: unknown; body?: unknown } | undefined;
}

function fakeClient(payload: unknown, calls: Call[]): CatalogApiClient {
  return {
    call: async <T>(route: string, init?: Call['init']): Promise<T> => {
      calls.push({ route, init });
      return payload as T;
    },
  };
}

const bodyOf = (call: Call | undefined): unknown => call?.init?.body;

describe('client catalog gateway', () => {
  it('should call only routes this plugin declares', async () => {
    const { default: manifest } = await import('../../../../manifest.ts');
    const keys = new Set<string>(manifest.actions.routes.map(route => route.key));
    const source = await Bun.file(new URL('../../../../cli/lib/catalog/gateway.ts', import.meta.url)).text();
    for (const [, key] of source.matchAll(/call\('([A-Z]+ [^']+)'/gu)) should(keys.has(key ?? '')).be.true();
  });

  it('should read the list with a plain GET', async () => {
    const calls: Call[] = [];
    const actual = await new ClientCatalogGateway(fakeClient(catalogList(), calls)).list();
    should(calls[0]).match({ route: 'GET /v1/catalogs' });
    should(actual.catalogs).have.length(1);
  });

  it('should read every shared item with a plain GET', async () => {
    const calls: Call[] = [];
    const actual = await new ClientCatalogGateway(
      fakeClient({ publisher: catalogList().publisher, items: [] }, calls),
    ).listItems();
    should(calls[0]).match({ route: 'GET /v1/catalog-items' });
    should(actual.items).eql([]);
  });

  it('should ask for the source check only when told to', async () => {
    const calls: Call[] = [];
    await new ClientCatalogGateway(fakeClient(catalogList(), calls)).list({ sourceState: true });
    should(calls[0]?.init?.query).eql({ sourceState: '1' });
  });

  it('should POST a new catalog', async () => {
    const calls: Call[] = [];
    await new ClientCatalogGateway(fakeClient(catalog(), calls)).create({ name: 'Team tools' });
    should(calls[0]?.route).equal('POST /v1/catalogs');
    should(bodyOf(calls[0])).eql({ name: 'Team tools' });
  });

  it('should PATCH a change to one catalog', async () => {
    const calls: Call[] = [];
    await new ClientCatalogGateway(fakeClient(catalog(), calls)).update(CATALOG_ID, { description: 'x' });
    should(calls[0]).match({ route: 'PATCH /v1/catalogs/:id', init: { params: { id: CATALOG_ID } } });
    should(bodyOf(calls[0])).eql({ description: 'x' });
  });

  it('should refuse a change that names nothing before sending it', async () => {
    const calls: Call[] = [];
    const gateway = new ClientCatalogGateway(fakeClient(catalog(), calls));
    await gateway.update(CATALOG_ID, {}).then(
      () => should.fail(undefined, undefined, 'expected a refusal'),
      () => undefined,
    );
    should(calls).have.length(0);
  });

  it('should DELETE a catalog', async () => {
    const calls: Call[] = [];
    const actual = await new ClientCatalogGateway(fakeClient({ catalogId: CATALOG_ID }, calls)).remove(CATALOG_ID);
    should(calls[0]).match({ route: 'DELETE /v1/catalogs/:id', init: { params: { id: CATALOG_ID } } });
    should(actual.catalogId).equal(CATALOG_ID);
  });

  it('should POST a preview for a source, and for the next version of an item', async () => {
    const calls: Call[] = [];
    const gateway = new ClientCatalogGateway(fakeClient(preview(), calls));
    await gateway.preview(CATALOG_ID, { source: { kind: 'mcp', mcp: 'github' } });
    await gateway.preview(CATALOG_ID, { itemId: SKILL_ID });
    should(calls[0]).match({ route: 'POST /v1/catalogs/:id/items/preview', init: { params: { id: CATALOG_ID } } });
    should(bodyOf(calls[0])).eql({ source: { kind: 'mcp', mcp: 'github' } });
    should(bodyOf(calls[1])).eql({ itemId: SKILL_ID });
  });

  it('should POST an add with the preview digest', async () => {
    const calls: Call[] = [];
    await new ClientCatalogGateway(fakeClient(published(), calls)).add(CATALOG_ID, {
      source: { kind: 'skill', skill: 'pdf-tools' },
      digest: NEW_DIGEST,
      summary: 'mine',
    });
    should(calls[0]).match({ route: 'POST /v1/catalogs/:id/items', init: { params: { id: CATALOG_ID } } });
    should(bodyOf(calls[0])).eql({
      source: { kind: 'skill', skill: 'pdf-tools' },
      digest: NEW_DIGEST,
      summary: 'mine',
    });
  });

  it('should refuse an add with a malformed digest before sending it', async () => {
    const calls: Call[] = [];
    const gateway = new ClientCatalogGateway(fakeClient(published(), calls));
    await gateway.add(CATALOG_ID, { source: { kind: 'mcp', mcp: 'x' }, digest: 'nope' as typeof DIGEST }).then(
      () => should.fail(undefined, undefined, 'expected a refusal'),
      () => undefined,
    );
    should(calls).have.length(0);
  });

  it('should POST the next version of an item', async () => {
    const calls: Call[] = [];
    await new ClientCatalogGateway(fakeClient(published(), calls)).publishVersion(CATALOG_ID, SKILL_ID, {
      digest: NEW_DIGEST,
    });
    should(calls[0]).match({
      route: 'POST /v1/catalogs/:id/items/:itemId/versions',
      init: { params: { id: CATALOG_ID, itemId: SKILL_ID } },
    });
    should(bodyOf(calls[0])).eql({ digest: NEW_DIGEST });
  });

  it('should GET one kept item, by its encoded id', async () => {
    const calls: Call[] = [];
    const item = await new ClientCatalogGateway(fakeClient(sharedItem(), calls)).getItem(SKILL_ID);
    should(item.itemId).equal(SKILL_ID);
    should(calls[0]).match({ route: 'GET /v1/catalog-items/:itemId', init: { params: { itemId: SKILL_ID } } });
  });

  it('should DELETE an item to withdraw it', async () => {
    const calls: Call[] = [];
    const actual = await new ClientCatalogGateway(fakeClient(withdrawn(), calls)).withdraw(CATALOG_ID, SKILL_ID);
    should(calls[0]).match({
      route: 'DELETE /v1/catalogs/:id/items/:itemId',
      init: { params: { id: CATALOG_ID, itemId: SKILL_ID } },
    });
    should(actual.revision).equal(5);
  });

  it('should POST an export and parse the signed file', async () => {
    const calls: Call[] = [];
    const actual = await new ClientCatalogGateway(fakeClient(catalogFile(), calls)).export(CATALOG_ID, {
      itemIds: [SKILL_ID],
    });
    should(calls[0]).match({ route: 'POST /v1/catalogs/:id/export', init: { params: { id: CATALOG_ID } } });
    should(bodyOf(calls[0])).eql({ itemIds: [SKILL_ID] });
    should(actual.format).equal('ferretry-catalog-file');
  });
});
