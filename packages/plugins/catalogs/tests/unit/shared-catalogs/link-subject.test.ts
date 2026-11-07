import { describe, it } from 'bun:test';
import { SHARED_ITEMS_MAX } from '../../../daemon/lib/boundary.ts';
import should from 'should';
import type { CatalogsDocument } from '../../../daemon/lib/shared-catalogs/document.ts';
import { withUnlistedItem } from '../../../daemon/lib/shared-catalogs/document.ts';
import type { CatalogRefusal } from '../../../daemon/lib/shared-catalogs/refusal.ts';
import { LinkSourceChanged } from '../../../daemon/lib/shared-catalogs/service.ts';
import { rig, SKILL_MD, SKILL_PATH } from './support.ts';

const SOURCE = { kind: 'skill', skill: 'demo' } as const;
const MCP = { kind: 'mcp', mcp: 'files' } as const;

const refusalOf = async (work: () => Promise<unknown>): Promise<unknown> => {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error('expected a failure');
};

describe('SharedCatalogService.linkSubject', () => {
  it('should read a new source and write nothing until keep runs', async () => {
    const r = await rig();
    const writes = r.documents.writes;
    const subject = await r.service.linkSubject({ source: SOURCE });
    should(subject.newItem).equal(true);
    should(subject.version).equal(1);
    should(subject.kind).equal('skill');
    should(subject.name).equal('demo');
    should(r.documents.writes).equal(writes);
    should(await r.service.holdsLinkVersion(subject.itemId, 1)).equal(false);

    await subject.keep?.();
    await subject.keep?.();
    should(r.documents.writes).equal(writes + 1);
    should(await r.service.holdsLinkVersion(subject.itemId, 1)).equal(true);
    const kept = r.documents.document.items.find(item => item.itemId === subject.itemId);
    should(kept?.versions[0]?.contentDigest).equal(subject.contentDigest);
    should(r.documents.document.catalogs).deepEqual([]);
  });

  it('should carry the harness of an MCP component and an own summary', async () => {
    const r = await rig();
    const subject = await r.service.linkSubject({ source: MCP }, 'My server');
    should(subject.kind).equal('mcp');
    should(subject.summary).equal('My server');
    await subject.keep?.();
    should(r.documents.document.items[0]?.ownSummary).equal(true);
  });

  it('should resolve a source that is already kept to that item, with no keep', async () => {
    const r = await rig();
    const first = await r.service.linkSubject({ source: SOURCE });
    await first.keep?.();
    const again = await r.service.linkSubject({ source: SOURCE });
    should(again.newItem).equal(false);
    should(again.itemId).equal(first.itemId);
    should(again.keep).equal(undefined);
    should(again.problems).deepEqual([]);
  });

  it("should refuse a source that changed since it was kept, as the link side's own error", async () => {
    const r = await rig();
    await (await r.service.linkSubject({ source: SOURCE })).keep?.();
    r.tree.set(SKILL_PATH, { 'SKILL.md': SKILL_MD, 'notes.txt': 'notes', 'extra.txt': 'extra' });
    const error = await refusalOf(() => r.service.linkSubject({ source: SOURCE }));
    should(error).be.instanceOf(LinkSourceChanged);
    should((error as Error).message).containEql('Publish a new version');
    should((error as Error).name).equal('LinkSourceChanged');
  });

  it('should refuse a source two kept items share, asking for a version', async () => {
    const r = await rig();
    const one = await r.service.linkSubject({ source: SOURCE });
    await one.keep?.();
    const stored = r.documents.document.items[0];
    if (stored === undefined) throw new Error('no item');
    r.documents.document = {
      ...r.documents.document,
      items: [...r.documents.document.items, { ...stored, itemId: `itm_${'z'.repeat(22)}` }],
    } as CatalogsDocument;
    const error = await refusalOf(() => r.service.linkSubject({ source: SOURCE }));
    should((error as CatalogRefusal).refusal).equal('source_ambiguous');
  });

  it('should read a kept version by item id, and refuse an unknown or retired one', async () => {
    const r = await rig();
    const kept = await r.service.linkSubject({ source: SOURCE });
    await kept.keep?.();
    const byId = await r.service.linkSubject({ itemId: kept.itemId, version: 1 });
    should(byId.newItem).equal(false);
    should(byId.contentDigest).equal(kept.contentDigest);
    should(byId.location).equal(SKILL_PATH);
    should(await r.service.holdsLinkVersion(kept.itemId, 2)).equal(false);
    should(await r.service.holdsLinkVersion(`itm_${'q'.repeat(22)}`, 1)).equal(false);
    should(
      (
        (await refusalOf(() =>
          r.service.linkSubject({ itemId: `itm_${'q'.repeat(22)}`, version: 1 }),
        )) as CatalogRefusal
      ).refusal,
    ).equal('item_unknown');
    should(
      ((await refusalOf(() => r.service.linkSubject({ itemId: kept.itemId, version: 9 }))) as CatalogRefusal).refusal,
    ).equal('version_unknown');

    const item = r.documents.document.items[0];
    if (item === undefined) throw new Error('no item');
    r.documents.document = {
      ...r.documents.document,
      items: [{ ...item, versions: item.versions.map(v => ({ ...v, retiredAt: '2026-01-02T00:00:00.000Z' })) }],
    } as CatalogsDocument;
    should(await r.service.holdsLinkVersion(kept.itemId, 1)).equal(false);
    should(
      ((await refusalOf(() => r.service.linkSubject({ itemId: kept.itemId, version: 1 }))) as CatalogRefusal).refusal,
    ).equal('version_retired');
  });

  it('should report an MCP server location by its name', async () => {
    const r = await rig();
    const subject = await r.service.linkSubject({ source: MCP });
    should(subject.location).be.a.String();
    await subject.keep?.();
    const byId = await r.service.linkSubject({ itemId: subject.itemId, version: 1 });
    should(byId.location).equal('files');
  });
});

describe('withUnlistedItem', () => {
  it('should add an item to no catalog, and refuse past the most a machine keeps', async () => {
    const r = await rig();
    const subject = await r.service.linkSubject({ source: SOURCE });
    await subject.keep?.();
    const document = r.documents.document;
    const item = document.items[0];
    if (item === undefined) throw new Error('no item');
    should(withUnlistedItem(document, { ...item, itemId: `itm_${'y'.repeat(22)}` }).items).have.length(2);
    const full = { ...document, items: Array.from({ length: SHARED_ITEMS_MAX }, () => item) } as CatalogsDocument;
    let refused: unknown;
    try {
      withUnlistedItem(full, item);
    } catch (error) {
      refused = error;
    }
    should((refused as CatalogRefusal).refusal).equal('items_full');
  });
});
