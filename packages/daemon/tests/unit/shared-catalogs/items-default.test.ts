import { describe, it } from 'bun:test';
import { CATALOGS_MAX_PER_PUBLISHER, SHARED_ITEMS_MAX } from '@ferretry/protocol';
import should from 'should';
import {
  type CatalogsDocument,
  type StoredSharedItem,
  withCatalog,
  withDefault,
  withListedItem,
  withNewItem,
} from '../../../src/lib/shared-catalogs/document.ts';
import { CatalogRefusal } from '../../../src/lib/shared-catalogs/refusal.ts';
import { rig, SKILL_MD, SKILL_PATH, stdio } from './support.ts';

const refusal = async (work: () => Promise<unknown>): Promise<CatalogRefusal> => {
  try {
    await work();
  } catch (error) {
    if (error instanceof CatalogRefusal) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

const refusalOf = (work: () => unknown): string => {
  try {
    work();
  } catch (error) {
    if (error instanceof CatalogRefusal) return error.refusal;
    throw error;
  }
  throw new Error('expected a refusal');
};

/** One skill, listed live by the first of two catalogs. */
async function twoCatalogs() {
  const r = await rig();
  const first = await r.service.create({ name: 'First' });
  const second = await r.service.create({ name: 'Second' });
  const preview = await r.service.previewItem(first.id, { source: { kind: 'skill', skill: 'demo' } });
  const added = await r.service.addItem(first.id, { source: { kind: 'skill', skill: 'demo' }, digest: preview.digest });
  return { r, first, second, added };
}

describe('the default catalog', () => {
  it('should become the default without a revision, once, and be named in both lists', async () => {
    const { r, first, second } = await twoCatalogs();
    const writes = r.documents.writes;
    const made = await r.service.update(second.id, { role: 'default' });
    should(made.role).equal('default');
    should(made.revision).equal(second.revision);
    should(made.issuedAt).equal(second.issuedAt);
    should(r.documents.writes).equal(writes + 1);
    await r.service.update(second.id, { role: 'default' });
    should(r.documents.writes).equal(writes + 1);
    const listed = await r.service.list();
    should(listed.defaultCatalogId).equal(second.id);
    should(listed.catalogs.map(catalog => catalog.role)).eql(['collection', 'default']);
    should((await r.service.listItems()).defaultCatalogId).equal(second.id);
    await r.service.update(first.id, { role: 'default' });
    should((await r.service.list()).defaultCatalogId).equal(first.id);
  });

  it('should be renamed and made the default in one request', async () => {
    const { r, second } = await twoCatalogs();
    const both = await r.service.update(second.id, { name: 'Renamed', role: 'default' });
    should([both.name, both.role, both.revision]).eql(['Renamed', 'default', second.revision + 1]);
  });

  it('should be forgotten when it is deleted, with its items kept', async () => {
    const { r, first, added } = await twoCatalogs();
    await r.service.update(first.id, { role: 'default' });
    await r.service.remove(first.id);
    const listed = await r.service.list();
    should(listed.defaultCatalogId).equal(undefined);
    const items = await r.service.listItems();
    should(items.items.map(item => item.itemId)).eql([added.itemId]);
    should(items.items[0]?.catalogs).eql([]);
  });

  it('should be refused for an unknown catalog', async () => {
    const { r } = await twoCatalogs();
    should(
      (await refusal(async () => await r.service.update('cat_unknown00000000000000', { role: 'default' }))).refusal,
    ).equal('catalog_unknown');
  });
});

describe('one item in many catalogs', () => {
  it('should list an item the machine keeps in a second catalog, bumping only that one', async () => {
    const { r, first, second, added } = await twoCatalogs();
    const other = await r.service.previewItem(first.id, { source: { kind: 'mcp', mcp: 'files' } });
    await r.service.addItem(first.id, { source: { kind: 'mcp', mcp: 'files' }, digest: other.digest });
    const listed = await r.service.addItem(second.id, { itemId: added.itemId, version: 1 });
    should(listed.revision).equal(second.revision + 1);
    should(listed.itemVersion).equal(1);
    should(listed.digest).not.equal(added.digest);
    const catalogs = (await r.service.list()).catalogs;
    should(catalogs.find(catalog => catalog.id === first.id)?.revision).equal(added.revision + 1);
    should(catalogs.find(catalog => catalog.id === second.id)?.items.map(item => item.itemId)).eql([added.itemId]);
    const file = await r.service.exportCatalog(second.id, {});
    should(file.items.map(item => item.itemId)).eql([added.itemId]);
    should(file.signedManifest.manifest.items[0]?.digest).equal(listed.digest);
    should((await r.service.frozenItem(first.id, added.itemId, 1)).catalogId).equal(first.id);
    should((await r.service.frozenItem(second.id, added.itemId, 1)).catalogId).equal(second.id);
  });

  it('should bump every catalog that lists it live when a new version is published', async () => {
    const { r, first, second, added } = await twoCatalogs();
    await r.service.addItem(second.id, { itemId: added.itemId, version: 1 });
    r.clock.ms += 1000;
    r.tree.set(SKILL_PATH, { 'SKILL.md': SKILL_MD, 'notes.txt': 'new notes' });
    const preview = await r.service.previewItem(first.id, { itemId: added.itemId });
    await r.service.publishVersion(first.id, added.itemId, { digest: preview.digest });
    const catalogs = (await r.service.list()).catalogs;
    should(catalogs.map(catalog => catalog.revision)).eql([added.revision + 1, 3]);
    for (const catalog of catalogs) should(catalog.items[0]?.current).equal(2);
    should((await r.service.frozenItem(second.id, added.itemId, 2)).itemVersion).equal(2);
    should((await r.service.exportCatalog(second.id, {})).items[0]?.itemVersion).equal(2);
  });

  it('should refuse an item already live, a stale version, an unknown item and a taken name', async () => {
    const { r, first, second, added } = await twoCatalogs();
    should(
      (await refusal(async () => await r.service.addItem(first.id, { itemId: added.itemId, version: 1 }))).refusal,
    ).equal('item_listed');
    should(
      (await refusal(async () => await r.service.addItem(second.id, { itemId: added.itemId, version: 2 }))).refusal,
    ).equal('current_changed');
    should(
      (
        await refusal(
          async () => await r.service.addItem(second.id, { itemId: 'itm_unknown000000000000000', version: 1 }),
        )
      ).refusal,
    ).equal('item_unknown');
    should(
      (
        await refusal(
          async () => await r.service.addItem('cat_unknown00000000000000', { itemId: added.itemId, version: 1 }),
        )
      ).refusal,
    ).equal('catalog_unknown');
    const lookalike = await r.service.previewItem(second.id, { source: { kind: 'skill', skill: 'demo' } });
    await r.service.addItem(second.id, { source: { kind: 'skill', skill: 'demo' }, digest: lookalike.digest });
    r.skills = [...r.skills];
    const third = await r.service.create({ name: 'Third' });
    r.servers = [stdio('files')];
    should(third.items).eql([]);
    should(
      (await refusal(async () => await r.service.addItem(second.id, { itemId: added.itemId, version: 1 }))).refusal,
    ).equal('name_taken');
  });

  it('should list a withdrawn entry again in place, with its order kept', async () => {
    const { r, first, added } = await twoCatalogs();
    const mcp = await r.service.previewItem(first.id, { source: { kind: 'mcp', mcp: 'files' } });
    const second = await r.service.addItem(first.id, { source: { kind: 'mcp', mcp: 'files' }, digest: mcp.digest });
    await r.service.withdraw(first.id, added.itemId);
    const again = await r.service.addItem(first.id, { itemId: added.itemId, version: 1 });
    should(again.digest).equal(added.digest);
    const items = (await r.service.list()).catalogs[0]?.items ?? [];
    should(items.map(item => item.itemId)).eql([added.itemId, second.itemId]);
    should(items.every(item => item.withdrawnAt === undefined)).equal(true);
  });

  it('should show the frozen current version of an item the catalog does not list, and read no source', async () => {
    const { r, second, added } = await twoCatalogs();
    r.tree.set(SKILL_PATH, { 'SKILL.md': 'changed after the freeze' });
    r.skills = [];
    const preview = await r.service.previewItem(second.id, { itemId: added.itemId });
    should([preview.catalogId, preview.itemId, preview.version, preview.name]).eql([
      second.id,
      added.itemId,
      1,
      'demo',
    ]);
    should(preview.problems).eql([]);
    should(preview.review.some(entry => entry.text.includes('Body'))).equal(true);
    should(preview.location).equal(SKILL_PATH);
    await r.service.addItem(second.id, { itemId: added.itemId, version: preview.version });
    await r.service.withdraw(second.id, added.itemId);
    const withdrawn = await r.service.previewItem(second.id, { itemId: added.itemId });
    should(withdrawn.digest).equal(preview.digest);
  });

  it('should name an MCP setup by its name in the frozen review', async () => {
    const r = await rig();
    const first = await r.service.create({ name: 'First' });
    const second = await r.service.create({ name: 'Second' });
    const preview = await r.service.previewItem(first.id, { source: { kind: 'mcp', mcp: 'files' } });
    const added = await r.service.addItem(first.id, { source: { kind: 'mcp', mcp: 'files' }, digest: preview.digest });
    const frozen = await r.service.previewItem(second.id, { itemId: added.itemId });
    should(frozen.location).equal('files');
    should(frozen.kind).equal('mcp');
  });

  it('should refuse a preview of an unknown item, and report a damaged copy as store_damaged', async () => {
    const { r, second, added } = await twoCatalogs();
    should(
      (await refusal(async () => await r.service.previewItem(second.id, { itemId: 'itm_unknown000000000000000' })))
        .refusal,
    ).equal('item_unknown');
    r.blobs.blobs.clear();
    should((await refusal(async () => await r.service.previewItem(second.id, { itemId: added.itemId }))).refusal).equal(
      'store_damaged',
    );
    should(
      (await refusal(async () => await r.service.addItem(second.id, { itemId: added.itemId, version: 1 }))).refusal,
    ).equal('store_damaged');
  });
});

describe('every item this machine keeps', () => {
  it('should list each item once, with the catalogs that list it and where each version is used', async () => {
    const { r, first, second, added } = await twoCatalogs();
    await r.service.addItem(second.id, { itemId: added.itemId, version: 1 });
    await r.service.withdraw(first.id, added.itemId);
    const list = await r.service.listItems();
    should(list.items).have.length(1);
    const item = list.items[0];
    should(item?.current).equal(1);
    should(item?.catalogs.map(catalog => [catalog.catalogId, catalog.state])).eql([
      [first.id, 'withdrawn'],
      [second.id, 'live'],
    ]);
    should(item?.catalogs[0]?.withdrawnAt).be.a.String();
    should(item?.versions[0]?.usedBy.catalogIds).eql([second.id]);
    should(item?.versions[0]?.fileCount).be.a.Number();
    should(item?.sourceState).equal(undefined);
  });

  it('should say whether the source changed only when asked, and for an MCP setup too', async () => {
    const { r, added } = await twoCatalogs();
    const mcp = await r.service.previewItem((await r.service.list()).catalogs[0]?.id ?? '', {
      source: { kind: 'mcp', mcp: 'files' },
    });
    await r.service.addItem((await r.service.list()).catalogs[0]?.id ?? '', {
      source: { kind: 'mcp', mcp: 'files' },
      digest: mcp.digest,
    });
    const same = await r.service.listItems({ sourceState: true });
    should(same.items.map(item => item.sourceState)).eql(['unchanged', 'unchanged']);
    r.tree.set(SKILL_PATH, { 'SKILL.md': SKILL_MD, 'a.txt': 'a' });
    r.servers = [];
    const moved = await r.service.listItems({ sourceState: true });
    should(moved.items.map(item => item.sourceState)).eql(['changed', 'unavailable']);
    should(moved.items[1]?.sourceNote).be.a.String();
    should(moved.items[0]?.itemId).equal(added.itemId);
  });

  it('should be empty on a fresh machine', async () => {
    const r = await rig();
    const list = await r.service.listItems();
    should(list.items).eql([]);
    should(list.defaultCatalogId).equal(undefined);
  });
});

describe('the caps and the document rules', () => {
  const emptyCatalog = (id: string, name: string) => ({
    id,
    name,
    description: '',
    publisherName: 'studio',
    visibility: 'members' as const,
    revision: 1,
    issuedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    entries: [],
  });
  const filler = (index: number): StoredSharedItem =>
    ({
      itemId: `itm_${String(index).padStart(22, '0')}`,
      kind: 'skill',
      name: `s${index}`,
      versions: [],
    }) as unknown as StoredSharedItem;

  it('should refuse a catalog past the cap and an item past the cap', () => {
    const catalogs = Array.from({ length: CATALOGS_MAX_PER_PUBLISHER }, (_, index) =>
      emptyCatalog(`cat_${String(index).padStart(22, '0')}`, `c${index}`),
    );
    const full: CatalogsDocument = { schemaVersion: 2, items: [], catalogs };
    should(
      refusalOf(() =>
        withCatalog(full, {
          id: 'cat_new',
          name: 'one more',
          description: '',
          publisherName: 'x',
          now: '2026-01-02T00:00:00.000Z',
        }),
      ),
    ).equal('catalogs_full');
    const items = Array.from({ length: SHARED_ITEMS_MAX }, (_, index) => filler(index));
    const stocked: CatalogsDocument = { schemaVersion: 2, items, catalogs: [emptyCatalog('cat_one', 'one')] };
    should(
      refusalOf(() => withNewItem(stocked, 'cat_one', filler(SHARED_ITEMS_MAX), '2026-01-02T00:00:00.000Z')),
    ).equal('items_full');
  });

  it('should keep the default when listing, and say the same default changes nothing', () => {
    const document: CatalogsDocument = { schemaVersion: 2, items: [], catalogs: [emptyCatalog('cat_one', 'one')] };
    const made = withDefault(document, 'cat_one');
    should(made.defaultCatalogId).equal('cat_one');
    should(withDefault(made, 'cat_one')).equal(made);
    should(refusalOf(() => withDefault(document, 'cat_two'))).equal('catalog_unknown');
  });

  it('should refuse to list an item in a catalog that is full', () => {
    const catalog = emptyCatalog('cat_one', 'one');
    const item = { ...filler(1), current: 1 };
    const document: CatalogsDocument = {
      schemaVersion: 2,
      items: [item],
      catalogs: [
        catalog,
        {
          ...emptyCatalog('cat_two', 'two'),
          entries: Array.from({ length: 256 }, (_, index) => ({
            itemId: filler(index + 10).itemId,
            addedAt: catalog.createdAt,
          })),
        },
      ],
    };
    document.items.push(...Array.from({ length: 256 }, (_, index) => filler(index + 10)));
    should(refusalOf(() => withListedItem(document, 'cat_two', item.itemId, 1, {}, '2026-01-02T00:00:00.000Z'))).equal(
      'catalog_full',
    );
  });
});
