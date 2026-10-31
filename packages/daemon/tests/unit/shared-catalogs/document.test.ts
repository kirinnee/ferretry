import { describe, it } from 'bun:test';
import should from 'should';
import {
  CatalogsDocumentSchema,
  documentProblem,
  EMPTY_CATALOGS_DOCUMENT,
  findCatalog,
  findItem,
  latestVersion,
  liveItems,
  type StoredItem,
  type StoredVersion,
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
const version = (n: number, char = 'a'): StoredVersion => ({
  version: n,
  digest: hex(char),
  contentDigest: hex(char),
  size: 10,
  publishedAt: T1,
  summary: 'a summary',
  source: { kind: 'mcp', id: 'x', name: 'x' },
});
const item = (n: number, name = `item${n}`): StoredItem => ({
  itemId: itemId(n),
  kind: 'mcp',
  name,
  ownSummary: false,
  versions: [version(1)],
});
const refusalOf = (work: () => unknown): string => {
  try {
    work();
  } catch (error) {
    return (error as CatalogRefusal).refusal;
  }
  return 'none';
};

const one = withCatalog(EMPTY_CATALOGS_DOCUMENT, {
  id: catalogId(1),
  name: 'Team',
  description: '',
  publisherName: 'host',
  now: T1,
});

describe('the catalogs document', () => {
  it('should parse a round trip and name the first problem of a damaged one', () => {
    should(CatalogsDocumentSchema.safeParse(one).success).be.true();
    should(documentProblem(CatalogsDocumentSchema.safeParse(one))).be.null();
    const bad = CatalogsDocumentSchema.safeParse({ schemaVersion: 2, catalogs: [] });
    should(documentProblem(bad)).match(/schemaVersion/u);
    should(documentProblem(CatalogsDocumentSchema.safeParse(7))).be.a.String();
  });

  it('should refuse duplicate ids and versions out of order', () => {
    const twice = { ...one, catalogs: [...one.catalogs, ...one.catalogs] };
    should(documentProblem(CatalogsDocumentSchema.safeParse(twice))).match(/listed twice/u);
    const catalog = one.catalogs[0];
    const items = { ...one, catalogs: [{ ...catalog, items: [item(1), item(1, 'other')] }] };
    should(documentProblem(CatalogsDocumentSchema.safeParse(items))).match(/listed twice/u);
    const order = { ...one, catalogs: [{ ...catalog, items: [{ ...item(1), versions: [version(2)] }] }] };
    should(documentProblem(CatalogsDocumentSchema.safeParse(order))).match(/versions 1, 2, 3 in order/u);
    const clashing = {
      ...one,
      catalogs: [
        { ...catalog, items: [item(1)] },
        { ...catalog, id: catalogId(2), items: [item(1)] },
      ],
    };
    should(documentProblem(CatalogsDocumentSchema.safeParse(clashing))).match(/listed twice/u);
  });
});

describe('the revision rule', () => {
  it('should start at 1 and rise by exactly one per visible change', () => {
    const added = withNewItem(one, catalogId(1), item(1), T2);
    should(findCatalog(added, catalogId(1)).revision).equal(2);
    const next = withNewVersion(added, catalogId(1), itemId(1), version(2, 'b'), T2);
    should(findCatalog(next, catalogId(1)).revision).equal(3);
    should(latestVersion(findItem(findCatalog(next, catalogId(1)), itemId(1))).version).equal(2);
    const out = withWithdrawn(next, catalogId(1), itemId(1), T2);
    const catalog = findCatalog(out, catalogId(1));
    should(catalog.revision).equal(4);
    should(catalog.items[0]?.withdrawnAt).equal(T2);
    should(liveItems(catalog)).have.length(0);
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
    const two = withCatalog(one, { id: catalogId(2), name: 'Other', description: '', publisherName: 'host', now: T1 });
    should(refusalOf(() => withCatalogPatch(two, catalogId(2), { name: 'Team' }, T2))).equal('name_taken');
    should(refusalOf(() => findCatalog(one, catalogId(9)))).equal('catalog_unknown');
    should(refusalOf(() => withoutCatalog(one, catalogId(9)))).equal('catalog_unknown');
    should(withoutCatalog(two, catalogId(2)).catalogs).have.length(1);
    should(refusalOf(() => findItem(findCatalog(one, catalogId(1)), itemId(1)))).equal('item_unknown');
  });

  it('should refuse a live item name twice, but allow it after a withdrawal', () => {
    const added = withNewItem(one, catalogId(1), item(1, 'same'), T2);
    should(refusalOf(() => withNewItem(added, catalogId(1), item(2, 'same'), T2))).equal('name_taken');
    const out = withWithdrawn(added, catalogId(1), itemId(1), T2);
    should(refusalOf(() => withNewItem(out, catalogId(1), item(2, 'same'), T2))).equal('none');
    const skill: StoredItem = { ...item(3, 'same'), kind: 'skill' };
    should(refusalOf(() => withNewItem(added, catalogId(1), skill, T2))).equal('none');
  });

  it('should refuse a version of, and a second withdrawal of, a withdrawn item', () => {
    const out = withWithdrawn(withNewItem(one, catalogId(1), item(1), T2), catalogId(1), itemId(1), T2);
    should(refusalOf(() => withNewVersion(out, catalogId(1), itemId(1), version(2, 'b'), T2))).equal('item_withdrawn');
    should(refusalOf(() => withWithdrawn(out, catalogId(1), itemId(1), T2))).equal('item_withdrawn');
  });

  it('should stop at 200 live items and 1000 withdrawn ones', () => {
    const full = {
      ...one,
      catalogs: [{ ...findCatalog(one, catalogId(1)), items: Array.from({ length: 200 }, (_, n) => item(n + 1)) }],
    };
    should(refusalOf(() => withNewItem(full, catalogId(1), item(500), T2))).equal('catalog_full');
    const spent = {
      ...one,
      catalogs: [
        {
          ...findCatalog(one, catalogId(1)),
          items: [item(2000), ...Array.from({ length: 1000 }, (_, n) => ({ ...item(n + 1), withdrawnAt: T1 }))],
        },
      ],
    };
    should(refusalOf(() => withWithdrawn(spent, catalogId(1), itemId(2000), T2))).equal('catalog_full');
  });
});
