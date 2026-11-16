import { describe, it } from 'bun:test';
import should from 'should';
import { CatalogRefusal } from '../../../daemon/lib/shared-catalogs/refusal.ts';
import { crypto, rig } from './support.ts';

const SKILL = { kind: 'skill', skill: 'demo' } as const;

describe('SharedCatalogService: ids and frozen copies', () => {
  it('gives up when the random source keeps spelling the placeholder id', async () => {
    const placeholderSource = Object.assign(Object.create(crypto), { randomBytes: () => new Uint8Array(16) });
    const r = await rig({ crypto: placeholderSource });
    await r.service.create({ name: 'Team' }).should.be.rejectedWith(/placeholder id three times/u);
  });

  it('refuses a frozen version whose digest no longer matches the one the catalog lists', async () => {
    const r = await rig();
    const catalog = await r.service.create({ name: 'Team' });
    const preview = await r.service.previewItem(catalog.id, { source: SKILL });
    const added = await r.service.addItem(catalog.id, { source: SKILL, digest: preview.digest });
    const document = r.documents.document;
    r.documents.document = {
      ...document,
      items: document.items.map(item => ({
        ...item,
        versions: item.versions.map(version => ({
          ...version,
          bindings: Object.fromEntries(
            Object.entries(version.bindings).map(([id, binding]) => [
              id,
              { ...binding, digest: `sha256:${'0'.repeat(64)}` },
            ]),
          ),
        })),
      })),
    };
    const failure = await r.service.frozenItem(catalog.id, added.itemId, 1).then(
      () => undefined,
      (error: unknown) => error,
    );
    should(failure).be.instanceOf(CatalogRefusal);
    should((failure as CatalogRefusal).refusal).equal('store_damaged');
    should((failure as CatalogRefusal).message).match(/no longer matches its digest/u);
  });
});
