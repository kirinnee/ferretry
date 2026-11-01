import { describe, it } from 'bun:test';
import should from 'should';
import {
  type CatalogsDocument,
  CatalogsDocumentSchema,
  type StoredSharedItem,
  type StoredVersion,
  bindingOf,
  catalogsListing,
  currentVersion,
  documentProblem,
  EMPTY_CATALOGS_DOCUMENT,
  findCatalog,
  findEntry,
  itemOf,
  latestVersion,
  liveEntries,
  withCatalog,
  withCatalogPatch,
  withNewItem,
  withNewVersion,
  withoutCatalog,
  withWithdrawn,
} from '../../../src/lib/shared-catalogs/document.ts';
import { CatalogRefusal } from '../../../src/lib/shared-catalogs/refusal.ts';

const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-01-02T00:00:00.000Z';
const hex = (char: string) => `sha256:${char.repeat(64)}`;
const catalogId = (n: number) => `cat_${String(n).padStart(22, 'A')}`;
const itemId = (n: number) => `itm_${String(n).padStart(22, 'A')}`;
const version = (n: number, char = 'a', listedBy: readonly number[] = [1]): StoredVersion => ({
  version: n,
  contentDigest: hex(char),
  size: 10,
  publishedAt: T1,
  summary: 'a summary',
  source: { kind: 'mcp', id: 'x', name: 'x' },
  bindings: Object.fromEntries(listedBy.map(c => [catalogId(c), { digest: hex(String(c + n)), size: 11 }])),
});
const item = (n: number, name = `item${n}`, listedBy: readonly number[] = [1]): StoredSharedItem => ({
  itemId: itemId(n),
  kind: 'mcp',
  name,
  ownSummary: false,
  createdAt: T1,
  current: 1,
  versions: [version(1, 'a', listedBy)],
});
const refusalOf = (work: () => unknown): string => {
  try {
    work();
  } catch (error) {
    return (error as CatalogRefusal).refusal;
  }
  return 'none';
};
const problemOf = (document: unknown): string | null => documentProblem(CatalogsDocumentSchema.safeParse(document));

const one = withCatalog(EMPTY_CATALOGS_DOCUMENT, {
  id: catalogId(1),
  name: 'Team',
  description: '',
  publisherName: 'host',
  now: T1,
});
const two = withCatalog(one, { id: catalogId(2), name: 'Other', description: '', publisherName: 'host', now: T1 });

describe('the catalogs document', () => {
  it('should parse a round trip and name the first problem of a damaged one', () => {
    should(CatalogsDocumentSchema.safeParse(one).success).be.true();
    should(problemOf(one)).be.null();
    should(problemOf({ schemaVersion: 2, catalogs: [] })).match(/items/u);
    should(problemOf({ ...one, schemaVersion: 1 })).be.a.String();
    should(problemOf(7)).be.a.String();
    should(documentProblem({ success: false, error: { issues: [] } as never })).equal('it is malformed');
  });

  it('should refuse the rules a shape cannot say', () => {
    const catalog = findCatalog(one, catalogId(1));
    const added = withNewItem(one, catalogId(1), item(1), T2);
    const listed = findCatalog(added, catalogId(1));
    const entry = { itemId: itemId(1), addedAt: T1 };
    const base = (patch: Partial<CatalogsDocument>) => ({ ...added, ...patch });
    should(problemOf({ ...one, catalogs: [catalog, catalog] })).match(/listed twice/u);
    should(problemOf({ ...one, defaultCatalogId: catalogId(9) })).match(/default catalog/u);
    should(problemOf(base({ items: [item(1), item(1)] }))).match(/listed twice/u);
    should(problemOf(base({ items: [{ ...item(1), versions: [version(2)] }] }))).match(/in order/u);
    should(problemOf(base({ items: [{ ...item(1), current: 5 }] }))).match(/no version 5/u);
    should(problemOf(base({ items: [{ ...item(1), versions: [{ ...version(1), retiredAt: T1 }] }] }))).match(
      /retired/u,
    );
    should(problemOf(base({ items: [] }))).match(/not an item/u);
    should(problemOf(base({ catalogs: [{ ...listed, entries: [entry, entry] }] }))).match(/twice/u);
    should(
      problemOf(
        base({
          items: [item(1, 'same'), item(2, 'same')],
          catalogs: [{ ...listed, entries: [entry, { ...entry, itemId: itemId(2) }] }],
        }),
      ),
    ).match(/two live mcp items called same/u);
    should(
      problemOf(
        base({
          items: Array.from({ length: 201 }, (_, n) => item(n + 1)),
          catalogs: [
            { ...listed, entries: Array.from({ length: 201 }, (_, n) => ({ ...entry, itemId: itemId(n + 1) })) },
          ],
        }),
      ),
    ).match(/more than 200 live/u);
    should(
      problemOf(
        base({
          items: Array.from({ length: 1001 }, (_, n) => item(n + 1)),
          catalogs: [
            {
              ...listed,
              entries: Array.from({ length: 1001 }, (_, n) => ({ ...entry, itemId: itemId(n + 1), withdrawnAt: T1 })),
            },
          ],
        }),
      ),
    ).match(/more than 1000 withdrawn/u);
  });

  it('should require a digest for every catalog that lists an item, and for none that does not', () => {
    const added = withNewItem(one, catalogId(1), item(1), T2);
    should(problemOf({ ...added, items: [{ ...item(1), versions: [{ ...version(1), bindings: {} }] }] })).match(
      /has no digest for/u,
    );
    should(problemOf({ ...added, items: [item(1, 'item1', [1, 2])] })).match(/does not list it/u);
    should(problemOf({ ...added, items: [item(1, 'item1', [1, 2])], catalogs: added.catalogs })).be.a.String();
  });
});

describe('reading the table', () => {
  it('should find a catalog, its line for an item, and the item itself', () => {
    const added = withNewItem(two, catalogId(1), item(1), T2);
    const catalog = findCatalog(added, catalogId(1));
    should(findEntry(catalog, itemId(1)).addedAt).equal(T2);
    should(itemOf(added, itemId(1)).name).equal('item1');
    should(latestVersion(itemOf(added, itemId(1))).version).equal(1);
    should(currentVersion(itemOf(added, itemId(1))).version).equal(1);
    should(bindingOf(currentVersion(itemOf(added, itemId(1))), catalogId(1)).size).equal(11);
    should(catalogsListing(added, itemId(1)).map(listing => listing.id)).deepEqual([catalogId(1)]);
    should(refusalOf(() => findEntry(findCatalog(one, catalogId(1)), itemId(1)))).equal('item_unknown');
  });
});

describe('the revision rule', () => {
  it('should start at 1 and rise by exactly one per visible change', () => {
    const added = withNewItem(one, catalogId(1), item(1), T2);
    should(findCatalog(added, catalogId(1)).revision).equal(2);
    const next = withNewVersion(added, catalogId(1), itemId(1), version(2, 'b'), T2);
    should(findCatalog(next, catalogId(1)).revision).equal(3);
    should(itemOf(next, itemId(1)).current).equal(2);
    const out = withWithdrawn(next, catalogId(1), itemId(1), T2);
    const catalog = findCatalog(out, catalogId(1));
    should(catalog.revision).equal(4);
    should(catalog.entries[0]?.withdrawnAt).equal(T2);
    should(liveEntries(catalog)).have.length(0);
  });

  it('should raise every catalog that lists the item live by one, in the one document it returns', () => {
    const shared = {
      ...two,
      items: [item(1, 'item1', [1, 2])],
      catalogs: two.catalogs.map(catalog => ({ ...catalog, entries: [{ itemId: itemId(1), addedAt: T1 }] })),
    };
    const next = withNewVersion(shared, catalogId(1), itemId(1), version(2, 'b', [1, 2]), T2);
    should(next.catalogs.map(catalog => catalog.revision)).deepEqual([2, 2]);
    should(CatalogsDocumentSchema.safeParse(next).success).be.true();
    const withdrawnHere = withWithdrawn(shared, catalogId(2), itemId(1), T2);
    const again = withNewVersion(withdrawnHere, catalogId(1), itemId(1), version(2, 'b', [1, 2]), T2);
    should(again.catalogs[0]?.revision).equal(2);
    should(again.catalogs[1]).equal(withdrawnHere.catalogs[1]);
  });

  it('should never move issuedAt backwards', () => {
    const later = withNewItem(one, catalogId(1), item(1), '2025-01-01T00:00:00.000Z');
    should(findCatalog(later, catalogId(1)).issuedAt).equal(T1);
  });

  it('should leave the document alone when a patch changes nothing, and bump on a rename or description', () => {
    should(withCatalogPatch(one, catalogId(1), { name: 'Team' }, T2)).equal(one);
    const renamed = withCatalogPatch(one, catalogId(1), { name: 'New' }, T2);
    should(findCatalog(renamed, catalogId(1)).revision).equal(2);
    const described = withCatalogPatch(one, catalogId(1), { description: 'hello' }, T2);
    should(findCatalog(described, catalogId(1)).description).equal('hello');
  });
});

describe('refusals', () => {
  it('should refuse a taken name, an unknown catalog and an unknown item', () => {
    should(
      refusalOf(() =>
        withCatalog(one, { id: catalogId(2), name: 'Team', description: '', publisherName: 'host', now: T1 }),
      ),
    ).equal('name_taken');
    should(refusalOf(() => withCatalogPatch(two, catalogId(2), { name: 'Team' }, T2))).equal('name_taken');
    should(refusalOf(() => findCatalog(one, catalogId(9)))).equal('catalog_unknown');
    should(refusalOf(() => withoutCatalog(one, catalogId(9)))).equal('catalog_unknown');
    should(withoutCatalog(two, catalogId(2)).catalogs).have.length(1);
  });

  it('should refuse a live item name twice, but allow it after a withdrawal', () => {
    const added = withNewItem(one, catalogId(1), item(1, 'same'), T2);
    should(refusalOf(() => withNewItem(added, catalogId(1), item(2, 'same'), T2))).equal('name_taken');
    const out = withWithdrawn(added, catalogId(1), itemId(1), T2);
    should(refusalOf(() => withNewItem(out, catalogId(1), item(2, 'same'), T2))).equal('none');
    const skill: StoredSharedItem = { ...item(3, 'same'), kind: 'skill' };
    should(refusalOf(() => withNewItem(added, catalogId(1), skill, T2))).equal('none');
  });

  it('should refuse a version of, and a second withdrawal of, a withdrawn item', () => {
    const out = withWithdrawn(withNewItem(one, catalogId(1), item(1), T2), catalogId(1), itemId(1), T2);
    should(refusalOf(() => withNewVersion(out, catalogId(1), itemId(1), version(2, 'b'), T2))).equal('item_withdrawn');
    should(refusalOf(() => withWithdrawn(out, catalogId(1), itemId(1), T2))).equal('item_withdrawn');
  });

  it('should stop at 200 live items and 1000 withdrawn ones', () => {
    const catalog = findCatalog(one, catalogId(1));
    const entries = (count: number, withdrawnAt?: string) =>
      Array.from({ length: count }, (_, n) => ({
        itemId: itemId(n + 1),
        addedAt: T1,
        ...(withdrawnAt ? { withdrawnAt } : {}),
      }));
    const items = (count: number) => Array.from({ length: count }, (_, n) => item(n + 1));
    const full = { ...one, items: items(200), catalogs: [{ ...catalog, entries: entries(200) }] };
    should(refusalOf(() => withNewItem(full, catalogId(1), item(500), T2))).equal('catalog_full');
    const spent = {
      ...one,
      items: [...items(1000), item(2000)],
      catalogs: [{ ...catalog, entries: [...entries(1000, T1), { itemId: itemId(2000), addedAt: T1 }] }],
    };
    should(refusalOf(() => withWithdrawn(spent, catalogId(1), itemId(2000), T2))).equal('catalog_full');
  });
});

describe('deleting a catalog', () => {
  it('should keep its items and versions, take its digests and its default out, and leave the others alone', () => {
    const shared = {
      ...two,
      defaultCatalogId: catalogId(1),
      items: [item(1, 'item1', [1, 2])],
      catalogs: two.catalogs.map(catalog => ({ ...catalog, entries: [{ itemId: itemId(1), addedAt: T1 }] })),
    };
    const gone = withoutCatalog(shared, catalogId(1));
    should(gone.defaultCatalogId).be.undefined();
    should(gone.items).have.length(1);
    should(Object.keys(itemOf(gone, itemId(1)).versions[0]?.bindings ?? {})).deepEqual([catalogId(2)]);
    should(CatalogsDocumentSchema.safeParse(gone).success).be.true();
    const keeps = withoutCatalog(shared, catalogId(2));
    should(keeps.defaultCatalogId).equal(catalogId(1));
    should(withoutCatalog({ ...shared, defaultCatalogId: undefined }, catalogId(2))).not.have.property(
      'defaultCatalogId',
    );
  });
});
