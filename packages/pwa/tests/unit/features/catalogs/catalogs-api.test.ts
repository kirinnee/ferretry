import { describe, it } from 'bun:test';
import should from 'should';
import {
  addCatalogItem,
  createCatalog,
  deleteCatalog,
  exportCatalog,
  listCatalogs,
  previewCatalogItem,
  publishCatalogVersion,
  updateCatalog,
  withdrawCatalogItem,
  type CatalogClient,
} from '../../../../src/features/catalogs/catalogs-api.ts';
import {
  applyCatalogInstall,
  listCatalogInstalls,
  previewCatalogInstall,
  removeCatalogInstall,
} from '../../../../src/features/catalogs/catalog-installs-api.ts';
import { newIdentity, signedFile, skillItem } from '../../../support/catalog-files.ts';
import {
  CATALOG,
  DIGEST,
  INSTALL_ID,
  installPreview,
  installRecord,
  ITEM,
  ownedCatalog,
  PREVIEW_ID,
} from '../../../support/catalog-views.ts';

interface Call {
  readonly path: string;
  readonly init: RequestInit | undefined;
}

/** A client that records the call and answers with `answer` after the schema has parsed it. */
function recorder(answer: unknown): { client: CatalogClient; calls: Call[] } {
  const calls: Call[] = [];
  const client: CatalogClient = {
    request: async (path, schema, init) => {
      calls.push({ path, init });
      return schema.parse(answer);
    },
  } as CatalogClient;
  return { client, calls };
}

const body = (call: Call | undefined): unknown => JSON.parse(String(call?.init?.body));

describe('owner routes', () => {
  it('lists, asking for source state only when told', async () => {
    const { client, calls } = recorder({ publisher: `fy_daemon_${'a'.repeat(43)}`, catalogs: [] });
    await listCatalogs(client);
    await listCatalogs(client, { sourceState: true });
    await listCatalogs(client, { sourceState: false });
    should(calls.map(call => call.path)).eql(['/v1/catalogs', '/v1/catalogs?sourceState=1', '/v1/catalogs']);
  });
  it('creates, renames and deletes', async () => {
    const created = recorder(ownedCatalog());
    await createCatalog(created.client, 'Team');
    should(created.calls[0]?.init?.method).equal('POST');
    should(body(created.calls[0])).eql({ name: 'Team' });
    const renamed = recorder(ownedCatalog());
    await updateCatalog(renamed.client, CATALOG, { description: 'x' });
    should(renamed.calls[0]).containEql({ path: `/v1/catalogs/${CATALOG}` });
    should(renamed.calls[0]?.init?.method).equal('PATCH');
    const deleted = recorder({ catalogId: CATALOG });
    await deleteCatalog(deleted.client, CATALOG);
    should(deleted.calls[0]?.init?.method).equal('DELETE');
    should(deleted.calls[0]?.init?.body).be.undefined();
  });
  it('previews, adds, publishes and withdraws', async () => {
    const preview = recorder({
      catalogId: CATALOG,
      kind: 'skill',
      name: 'pdf-tools',
      summary: 's',
      location: '/x',
      version: 1,
      digest: DIGEST,
      size: 1,
      review: [],
      warnings: [],
      problems: [],
    });
    await previewCatalogItem(preview.client, CATALOG, { source: { kind: 'skill', skill: '/x' } });
    should(preview.calls[0]?.path).equal(`/v1/catalogs/${CATALOG}/items/preview`);
    const published = recorder({
      catalogId: CATALOG,
      itemId: ITEM,
      itemVersion: 1,
      digest: DIGEST,
      revision: 2,
      item: ownedCatalog().items[0],
    });
    await addCatalogItem(published.client, CATALOG, { source: { kind: 'skill', skill: '/x' }, digest: DIGEST });
    await publishCatalogVersion(published.client, CATALOG, ITEM, DIGEST);
    should(published.calls.map(call => call.path)).eql([
      `/v1/catalogs/${CATALOG}/items`,
      `/v1/catalogs/${CATALOG}/items/${ITEM}/versions`,
    ]);
    should(body(published.calls[1])).eql({ digest: DIGEST });
    const withdrawn = recorder({
      catalogId: CATALOG,
      itemId: ITEM,
      revision: 3,
      withdrawnAt: '2026-10-31T09:00:00.000Z',
    });
    await withdrawCatalogItem(withdrawn.client, CATALOG, ITEM);
    should(withdrawn.calls[0]?.init?.method).equal('DELETE');
  });
  it('exports the signed file', async () => {
    const identity = await newIdentity();
    const file = await signedFile(identity, [skillItem(identity.daemonId)]);
    const { client, calls } = recorder(file);
    const exported = await exportCatalog(client, CATALOG);
    should(exported.format).equal('ferretry-catalog-file');
    should(calls[0]?.path).equal(`/v1/catalogs/${CATALOG}/export`);
  });
});

describe('install routes', () => {
  it('previews and applies on the scope’s own route', async () => {
    const identity = await newIdentity();
    const file = await signedFile(identity, [skillItem(identity.daemonId)]);
    const preview = recorder(installPreview());
    await previewCatalogInstall(preview.client, 'runtime', {
      signedManifest: file.signedManifest,
      item: file.items[0]!,
      target: { scope: 'runtime', runtime: 'box', profile: 'default' },
    });
    should(preview.calls[0]?.path).equal('/v1/catalog-installs/runtime/preview');
    const applied = recorder({ install: installRecord(), notes: ['n'] });
    await applyCatalogInstall(applied.client, 'project', { previewId: PREVIEW_ID, secretBindings: {} });
    should(applied.calls[0]?.path).equal('/v1/catalog-installs/project');
    should(body(applied.calls[0])).eql({ previewId: PREVIEW_ID, secretBindings: {} });
  });
  it('lists and removes', async () => {
    const list = recorder({ installs: [installRecord()] });
    should((await listCatalogInstalls(list.client)).installs).have.length(1);
    should(list.calls[0]?.path).equal('/v1/catalog-installs');
    const removed = recorder({ installId: INSTALL_ID, provenance: installRecord().provenance, destination: 'd' });
    await removeCatalogInstall(removed.client, 'project', INSTALL_ID);
    should(removed.calls[0]?.path).equal(`/v1/catalog-installs/project/${INSTALL_ID}`);
    should(removed.calls[0]?.init?.method).equal('DELETE');
  });
});
