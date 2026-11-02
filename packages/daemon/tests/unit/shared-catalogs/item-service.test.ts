import { describe, it } from 'bun:test';
import should from 'should';
import { CatalogRefusal } from '../../../src/lib/shared-catalogs/refusal.ts';
import { rig, SKILL_MD, SKILL_PATH } from './support.ts';

const refusal = async (work: () => Promise<unknown>): Promise<CatalogRefusal> => {
  try {
    await work();
  } catch (error) {
    if (error instanceof CatalogRefusal) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

const SOURCE = { kind: 'skill', skill: 'demo' } as const;
const CHANGED = { 'SKILL.md': SKILL_MD, 'notes.txt': 'notes', 'extra.txt': 'extra' };
const ORIGINAL = { 'SKILL.md': SKILL_MD, 'notes.txt': 'notes' };

/** One skill, shared by two catalogs. */
async function sharedTwice() {
  const r = await rig();
  const first = await r.service.create({ name: 'First' });
  const second = await r.service.create({ name: 'Second' });
  const preview = await r.service.previewItem(first.id, { source: SOURCE });
  const added = await r.service.addItem(first.id, { source: SOURCE, digest: preview.digest });
  await r.service.addItem(second.id, { itemId: added.itemId, version: 1 });
  return { r, first, second, itemId: added.itemId };
}

const entryOf = (r: Awaited<ReturnType<typeof rig>>, catalogId: string, itemId: string) =>
  r.documents.document.catalogs.find(catalog => catalog.id === catalogId)?.entries.find(e => e.itemId === itemId);
const revisionOf = (r: Awaited<ReturnType<typeof rig>>, catalogId: string) =>
  r.documents.document.catalogs.find(catalog => catalog.id === catalogId)?.revision;

describe('SharedCatalogService at the item', () => {
  it('should publish once for every catalog that lists the item live, in one write', async () => {
    const { r, first, second, itemId } = await sharedTwice();
    const firstBefore = revisionOf(r, first.id) as number;
    const secondBefore = revisionOf(r, second.id) as number;
    const sinceBefore = entryOf(r, second.id, itemId)?.sinceVersion;
    r.tree.set(SKILL_PATH, CHANGED);
    const preview = await r.service.previewItemVersion(itemId);
    should(preview.changes?.entries.map(entry => entry.label)).containEql('Skill file extra.txt');
    const writes = r.documents.writes;
    const published = await r.service.publishItemVersion(itemId, { digest: preview.digest });
    should(r.documents.writes).equal(writes + 1);
    should(published.itemVersion).equal(2);
    should(published.current).equal(2);
    should(published.catalogs.map(catalog => catalog.catalogId).toSorted()).deepEqual([first.id, second.id].toSorted());
    should(revisionOf(r, first.id)).equal(firstBefore + 1);
    should(revisionOf(r, second.id)).equal(secondBefore + 1);
    should(entryOf(r, second.id, itemId)?.sinceVersion).equal(sinceBefore);
    should(published.item.itemId).equal(itemId);
    for (const catalog of published.catalogs) should(catalog.digest).match(/^sha256:/u);
  });

  it('should leave a catalog that withdrew the item where it was', async () => {
    const { r, first, second, itemId } = await sharedTwice();
    await r.service.withdraw(second.id, itemId);
    const secondRevision = revisionOf(r, second.id);
    r.tree.set(SKILL_PATH, CHANGED);
    const preview = await r.service.previewItemVersion(itemId);
    const published = await r.service.publishItemVersion(itemId, { digest: preview.digest });
    should(published.catalogs.map(catalog => catalog.catalogId)).deepEqual([first.id]);
    should(revisionOf(r, second.id)).equal(secondRevision);
  });

  it('should publish, and preview, an item no catalog lists any more', async () => {
    const { r, first, second, itemId } = await sharedTwice();
    await r.service.withdraw(first.id, itemId);
    await r.service.withdraw(second.id, itemId);
    r.tree.set(SKILL_PATH, CHANGED);
    const preview = await r.service.previewItemVersion(itemId);
    should(preview.itemId).equal(itemId);
    const published = await r.service.publishItemVersion(itemId, { digest: preview.digest });
    should(published.catalogs).deepEqual([]);
    should(published.current).equal(2);
  });

  it('should bind a publish to its preview, and refuse nothing new or something old again', async () => {
    const { r, itemId } = await sharedTwice();
    const same = await r.service.previewItemVersion(itemId);
    should(same.sameAsVersion).equal(1);
    should(same.changes?.entries).deepEqual([]);
    should(
      (await refusal(async () => await r.service.publishItemVersion(itemId, { digest: same.digest }))).refusal,
    ).equal('nothing_to_publish');
    r.tree.set(SKILL_PATH, CHANGED);
    const next = await r.service.previewItemVersion(itemId);
    r.tree.set(SKILL_PATH, { ...CHANGED, 'more.txt': 'more' });
    should(
      (await refusal(async () => await r.service.publishItemVersion(itemId, { digest: next.digest }))).refusal,
    ).equal('changed_since_preview');
    r.tree.set(SKILL_PATH, CHANGED);
    await r.service.publishItemVersion(itemId, { digest: next.digest });
    r.tree.set(SKILL_PATH, ORIGINAL);
    const back = await r.service.previewItemVersion(itemId);
    should(back.sameAsVersion).equal(1);
    const error = await refusal(async () => await r.service.publishItemVersion(itemId, { digest: back.digest }));
    should(error.refusal).equal('same_as_version');
    should(error.message).match(/exactly version 1 again/u);
  });

  it('should refuse a 1,001st version, and an unknown item', async () => {
    const { r, itemId } = await sharedTwice();
    const document = r.documents.document;
    const item = document.items.find(candidate => candidate.itemId === itemId);
    const first = item?.versions[0];
    if (item === undefined || first === undefined) throw new Error('no item');
    const extra = Array.from({ length: 999 }, (_, index) => ({
      ...first,
      version: index + 2,
      contentDigest: `sha256:${(index + 2).toString(16).padStart(64, '0')}`,
      bindings: first.bindings,
    }));
    r.documents.document = {
      ...document,
      items: document.items.map(candidate =>
        candidate.itemId === itemId ? { ...candidate, versions: [...candidate.versions, ...extra] } : candidate,
      ),
    };
    r.tree.set(SKILL_PATH, CHANGED);
    const preview = await r.service.previewItemVersion(itemId);
    should(
      (await refusal(async () => await r.service.publishItemVersion(itemId, { digest: preview.digest }))).refusal,
    ).equal('items_full');
    should(
      (await refusal(async () => await r.service.publishItemVersion('itm_unknown000000000000000', { digest: 'x' })))
        .refusal,
    ).equal('item_unknown');
  });

  it('should show what changed on the per-catalog preview too, and keep that route as an alias', async () => {
    const { r, first, itemId } = await sharedTwice();
    r.tree.set(SKILL_PATH, CHANGED);
    const preview = await r.service.previewItem(first.id, { itemId });
    should(preview.catalogId).equal(first.id);
    should(preview.changes?.entries.map(entry => entry.label)).containEql('Skill file extra.txt');
    const published = await r.service.publishVersion(first.id, itemId, { digest: preview.digest });
    should(published.itemVersion).equal(2);
  });

  it('should read an item, with its source state only when asked', async () => {
    const { r, itemId } = await sharedTwice();
    should(await r.service.getItem(itemId, { sourceState: false })).not.have.property('sourceState');
    should((await r.service.getItem(itemId, { sourceState: true })).sourceState).equal('unchanged');
    r.tree.set(SKILL_PATH, CHANGED);
    should((await r.service.getItem(itemId, { sourceState: true })).sourceState).equal('changed');
    should(
      (await refusal(async () => await r.service.getItem('itm_unknown000000000000000', { sourceState: false })))
        .refusal,
    ).equal('item_unknown');
  });

  it('should say which version every catalog serves, and refuse an unknown item', async () => {
    const { r, itemId } = await sharedTwice();
    should(await r.service.currentOf(itemId)).equal(1);
    should((await refusal(async () => await r.service.currentOf('itm_unknown000000000000000'))).refusal).equal(
      'item_unknown',
    );
  });

  it('should hand back one version in full and what changed between two', async () => {
    const { r, itemId } = await sharedTwice();
    r.tree.set(SKILL_PATH, CHANGED);
    const preview = await r.service.previewItemVersion(itemId);
    await r.service.publishItemVersion(itemId, { digest: preview.digest });
    const one = await r.service.itemVersion(itemId, 1);
    const two = await r.service.itemVersion(itemId, 2);
    should(one.version).equal(1);
    should(two.version).equal(2);
    should(two.name).equal('demo');
    should(two.size).be.above(one.size);
    should(JSON.stringify(two)).containEql('extra.txt');
    should(JSON.stringify(one)).not.containEql('extra.txt');
    const changes = await r.service.itemChanges(itemId, 1, 2);
    should(changes.entries.map(entry => entry.label)).deepEqual(['Skill file extra.txt']);
    should((await r.service.itemChanges(itemId, 2, 2)).entries).deepEqual([]);
  });

  it('should say a version does not exist, and find a damaged copy', async () => {
    const { r, itemId } = await sharedTwice();
    for (const work of [
      async () => await r.service.itemVersion(itemId, 2),
      async () => await r.service.itemChanges(itemId, 1, 2),
      async () => await r.service.itemChanges(itemId, 2, 1),
    ])
      should((await refusal(work)).refusal).equal('version_unknown');
    should((await refusal(async () => await r.service.itemVersion('itm_unknown000000000000000', 1))).refusal).equal(
      'item_unknown',
    );
    const [digest] = [...r.blobs.blobs.keys()];
    r.blobs.blobs.delete(digest as string);
    should((await refusal(async () => await r.service.itemVersion(itemId, 1))).message).match(/is missing/u);
  });

  describe('when the current version is not the latest', () => {
    const MORE = { ...CHANGED, 'more.txt': 'more' };

    /** Versions 1..3 kept; version 1 is the one every catalog serves, and version 3 remembers a source that is gone. */
    async function currentIsOne() {
      const shared = await sharedTwice();
      const { r, itemId } = shared;
      for (const files of [CHANGED, MORE]) {
        r.tree.set(SKILL_PATH, files);
        const preview = await r.service.previewItemVersion(itemId);
        await r.service.publishItemVersion(itemId, { digest: preview.digest });
      }
      const document = r.documents.document;
      r.documents.document = {
        ...document,
        items: document.items.map(item =>
          item.itemId === itemId
            ? {
                ...item,
                current: 1,
                versions: item.versions.map(version =>
                  version.version === 3
                    ? { ...version, source: { kind: 'skill' as const, path: '/gone/SKILL.md' } }
                    : version,
                ),
              }
            : item,
        ),
      };
      return shared;
    }

    it("should call a source that is the current version nothing to publish, and read the current version's source", async () => {
      const { r, itemId } = await currentIsOne();
      r.tree.set(SKILL_PATH, ORIGINAL);
      const preview = await r.service.previewItemVersion(itemId);
      should(preview.sameAsVersion).equal(1);
      should(preview.changes?.entries).deepEqual([]);
      should(
        (await refusal(async () => await r.service.publishItemVersion(itemId, { digest: preview.digest }))).refusal,
      ).equal('nothing_to_publish');
    });

    it('should name an older version a source matches, and show the changes against the current one', async () => {
      const { r, itemId } = await currentIsOne();
      r.tree.set(SKILL_PATH, MORE);
      const preview = await r.service.previewItemVersion(itemId);
      should(preview.sameAsVersion).equal(3);
      should(preview.changes?.entries.map(entry => entry.label).toSorted()).deepEqual([
        'Skill file extra.txt',
        'Skill file more.txt',
      ]);
      const error = await refusal(async () => await r.service.publishItemVersion(itemId, { digest: preview.digest }));
      should(error.refusal).equal('same_as_version');
      should(error.message).match(/exactly version 3 again/u);
    });
  });
});
