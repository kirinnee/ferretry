import { describe, it } from 'bun:test';
import should from 'should';
import type { z } from 'zod';
import {
  catalogExportPath,
  catalogItemPath,
  catalogItemPreviewPath,
  catalogItemsPath,
  catalogItemVersionsPath,
  catalogPath,
  ProtocolCatalogGateway,
} from '../../../src/lib/catalog/gateway';
import type { CatalogApiClient } from '../../../src/lib/catalog/ports';
import {
  CATALOG_ID,
  catalog,
  catalogFile,
  catalogList,
  DIGEST,
  NEW_DIGEST,
  preview,
  published,
  SKILL_ID,
  withdrawn,
} from './fixtures';

interface Call {
  path: string;
  init: RequestInit | undefined;
}

function fakeClient(payload: unknown, calls: Call[]): CatalogApiClient {
  return {
    request: <T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
      calls.push({ path, init });
      return Promise.resolve(schema.parse(payload));
    },
  };
}

const bodyOf = (call: Call | undefined): unknown => JSON.parse(String(call?.init?.body));

describe('catalog routes', () => {
  it('should name each route under /v1/catalogs with the ids encoded', () => {
    should(catalogPath(CATALOG_ID)).equal(`/v1/catalogs/${CATALOG_ID}`);
    should(catalogItemsPath(CATALOG_ID)).equal(`/v1/catalogs/${CATALOG_ID}/items`);
    should(catalogItemPreviewPath(CATALOG_ID)).equal(`/v1/catalogs/${CATALOG_ID}/items/preview`);
    should(catalogItemPath(CATALOG_ID, SKILL_ID)).equal(`/v1/catalogs/${CATALOG_ID}/items/${SKILL_ID}`);
    should(catalogItemVersionsPath(CATALOG_ID, SKILL_ID)).equal(
      `/v1/catalogs/${CATALOG_ID}/items/${SKILL_ID}/versions`,
    );
    should(catalogExportPath(CATALOG_ID)).equal(`/v1/catalogs/${CATALOG_ID}/export`);
    should(catalogPath('a/b')).equal('/v1/catalogs/a%2Fb');
  });
});

describe('protocol catalog gateway', () => {
  it('should read the list with a plain GET', async () => {
    const calls: Call[] = [];
    const actual = await new ProtocolCatalogGateway(fakeClient(catalogList(), calls)).list();
    should(calls[0]).match({ path: '/v1/catalogs', init: undefined });
    should(actual.catalogs).have.length(1);
  });

  it('should POST a new catalog', async () => {
    const calls: Call[] = [];
    await new ProtocolCatalogGateway(fakeClient(catalog(), calls)).create({ name: 'Team tools' });
    should(calls[0]?.path).equal('/v1/catalogs');
    should(calls[0]?.init?.method).equal('POST');
    should(bodyOf(calls[0])).eql({ name: 'Team tools' });
  });

  it('should PATCH a change to one catalog', async () => {
    const calls: Call[] = [];
    await new ProtocolCatalogGateway(fakeClient(catalog(), calls)).update(CATALOG_ID, { description: 'x' });
    should(calls[0]).match({ path: `/v1/catalogs/${CATALOG_ID}` });
    should(calls[0]?.init?.method).equal('PATCH');
    should(bodyOf(calls[0])).eql({ description: 'x' });
  });

  it('should refuse a change that names nothing before sending it', async () => {
    const calls: Call[] = [];
    const gateway = new ProtocolCatalogGateway(fakeClient(catalog(), calls));
    await gateway.update(CATALOG_ID, {}).then(
      () => should.fail(undefined, undefined, 'expected a refusal'),
      () => undefined,
    );
    should(calls).have.length(0);
  });

  it('should DELETE a catalog', async () => {
    const calls: Call[] = [];
    const actual = await new ProtocolCatalogGateway(fakeClient({ catalogId: CATALOG_ID }, calls)).remove(CATALOG_ID);
    should(calls[0]?.init).eql({ method: 'DELETE' });
    should(actual.catalogId).equal(CATALOG_ID);
  });

  it('should POST a preview for a source, and for the next version of an item', async () => {
    const calls: Call[] = [];
    const gateway = new ProtocolCatalogGateway(fakeClient(preview(), calls));
    await gateway.preview(CATALOG_ID, { source: { kind: 'mcp', mcp: 'github' } });
    await gateway.preview(CATALOG_ID, { itemId: SKILL_ID });
    should(calls[0]?.path).equal(`/v1/catalogs/${CATALOG_ID}/items/preview`);
    should(bodyOf(calls[0])).eql({ source: { kind: 'mcp', mcp: 'github' } });
    should(bodyOf(calls[1])).eql({ itemId: SKILL_ID });
  });

  it('should POST an add with the preview digest', async () => {
    const calls: Call[] = [];
    await new ProtocolCatalogGateway(fakeClient(published(), calls)).add(CATALOG_ID, {
      source: { kind: 'skill', skill: 'pdf-tools' },
      digest: NEW_DIGEST,
      summary: 'mine',
    });
    should(calls[0]?.path).equal(`/v1/catalogs/${CATALOG_ID}/items`);
    should(bodyOf(calls[0])).eql({
      source: { kind: 'skill', skill: 'pdf-tools' },
      digest: NEW_DIGEST,
      summary: 'mine',
    });
  });

  it('should refuse an add with a malformed digest before sending it', async () => {
    const calls: Call[] = [];
    const gateway = new ProtocolCatalogGateway(fakeClient(published(), calls));
    await gateway.add(CATALOG_ID, { source: { kind: 'mcp', mcp: 'x' }, digest: 'nope' as typeof DIGEST }).then(
      () => should.fail(undefined, undefined, 'expected a refusal'),
      () => undefined,
    );
    should(calls).have.length(0);
  });

  it('should POST the next version of an item', async () => {
    const calls: Call[] = [];
    await new ProtocolCatalogGateway(fakeClient(published(), calls)).publishVersion(CATALOG_ID, SKILL_ID, {
      digest: NEW_DIGEST,
    });
    should(calls[0]?.path).equal(`/v1/catalogs/${CATALOG_ID}/items/${SKILL_ID}/versions`);
    should(bodyOf(calls[0])).eql({ digest: NEW_DIGEST });
  });

  it('should DELETE an item to withdraw it', async () => {
    const calls: Call[] = [];
    const actual = await new ProtocolCatalogGateway(fakeClient(withdrawn(), calls)).withdraw(CATALOG_ID, SKILL_ID);
    should(calls[0]?.path).equal(`/v1/catalogs/${CATALOG_ID}/items/${SKILL_ID}`);
    should(calls[0]?.init).eql({ method: 'DELETE' });
    should(actual.revision).equal(5);
  });

  it('should POST an export and parse the signed file', async () => {
    const calls: Call[] = [];
    const actual = await new ProtocolCatalogGateway(fakeClient(catalogFile(), calls)).export(CATALOG_ID, {
      itemIds: [SKILL_ID],
    });
    should(calls[0]?.path).equal(`/v1/catalogs/${CATALOG_ID}/export`);
    should(bodyOf(calls[0])).eql({ itemIds: [SKILL_ID] });
    should(actual.format).equal('ferretry-catalog-file');
  });
});
