import { describe, it } from 'bun:test';
import { verifySignedCatalogItemVersions, verifySignedCatalogManifest } from '@ferretry/relay';
import should from 'should';
import { CatalogRefusal } from '../../../src/lib/shared-catalogs/refusal.ts';
import { crypto, rig, SKILL_MD, SKILL_PATH } from './support.ts';

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
const V2 = { 'SKILL.md': SKILL_MD, 'notes.txt': 'notes', 'two.txt': 'two' };
const V3 = { ...V2, 'three.txt': 'three' };

type Rig = Awaited<ReturnType<typeof rig>>;

const publish = async (r: Rig, itemId: string, files: Record<string, string>) => {
  r.tree.set(SKILL_PATH, files);
  const preview = await r.service.previewItemVersion(itemId);
  return await r.service.publishItemVersion(itemId, { digest: preview.digest });
};

/** One skill at versions 1..3 (3 current). "First" has served it since 1; "Second" joined once 3 was current. */
async function joinedAtThree() {
  const r = await rig();
  const first = await r.service.create({ name: 'First' });
  const second = await r.service.create({ name: 'Second' });
  const preview = await r.service.previewItem(first.id, { source: SOURCE });
  const added = await r.service.addItem(first.id, { source: SOURCE, digest: preview.digest });
  await publish(r, added.itemId, V2);
  await publish(r, added.itemId, V3);
  await r.service.addItem(second.id, { itemId: added.itemId, version: 3 });
  return { r, first, second, itemId: added.itemId };
}

const revisionOf = (r: Rig, catalogId: string) =>
  r.documents.document.catalogs.find(catalog => catalog.id === catalogId)?.revision as number;

describe('making a version current', () => {
  it('should serve an older version everywhere in one write, rising each catalog once', async () => {
    const r = await rig();
    const first = await r.service.create({ name: 'First' });
    const second = await r.service.create({ name: 'Second' });
    const preview = await r.service.previewItem(first.id, { source: SOURCE });
    const { itemId } = await r.service.addItem(first.id, { source: SOURCE, digest: preview.digest });
    await r.service.addItem(second.id, { itemId, version: 1 });
    await publish(r, itemId, V2);
    const writes = r.documents.writes;
    const before = [revisionOf(r, first.id), revisionOf(r, second.id)] as const;
    const answer = await r.service.makeCurrent(itemId, { version: 1, from: 2 });
    should(r.documents.writes).equal(writes + 1);
    should(answer.current).equal(1);
    should(answer.itemVersion).equal(1);
    should(answer.catalogs.map(each => each.catalogId)).deepEqual([first.id, second.id]);
    should(answer.catalogs.map(each => each.revision)).deepEqual([before[0] + 1, before[1] + 1]);
    should((await r.service.signedManifest(first.id)).manifest.items[0]?.version).equal(1);
    should((await r.service.signedVersions(second.id, itemId)).versions.current).equal(1);
  });

  it('should answer only the catalogs that list the item, leaving an empty one alone', async () => {
    const r = await rig();
    const first = await r.service.create({ name: 'First' });
    const empty = await r.service.create({ name: 'Empty' });
    const preview = await r.service.previewItem(first.id, { source: SOURCE });
    const { itemId } = await r.service.addItem(first.id, { source: SOURCE, digest: preview.digest });
    await publish(r, itemId, V2);
    const emptyBefore = revisionOf(r, empty.id);
    const answer = await r.service.makeCurrent(itemId, { version: 1, from: 2 });
    should(answer.catalogs.map(each => each.catalogId)).deepEqual([first.id]);
    should(revisionOf(r, empty.id)).equal(emptyBefore);
  });

  it('should refuse a version from before a live catalog joined, naming it, and change nothing', async () => {
    const { r, first, itemId } = await joinedAtThree();
    const writes = r.documents.writes;
    const error = await refusal(async () => await r.service.makeCurrent(itemId, { version: 2, from: 3 }));
    should(error.refusal).equal('version_before_join');
    should(error.message).match(/Second/u);
    should(r.documents.writes).equal(writes);
    should(revisionOf(r, first.id)).be.a.Number();
    should(await r.service.currentOf(itemId)).equal(3);
  });

  it('should refuse a retired version, a stale page, and a version it never had', async () => {
    const r = await rig();
    const catalog = await r.service.create({ name: 'First' });
    const preview = await r.service.previewItem(catalog.id, { source: SOURCE });
    const { itemId } = await r.service.addItem(catalog.id, { source: SOURCE, digest: preview.digest });
    await publish(r, itemId, V2);
    await r.service.setRetired(itemId, 1, true);
    should((await refusal(async () => await r.service.makeCurrent(itemId, { version: 1, from: 2 }))).refusal).equal(
      'version_retired',
    );
    should((await refusal(async () => await r.service.makeCurrent(itemId, { version: 1, from: 1 }))).refusal).equal(
      'current_changed',
    );
    should((await refusal(async () => await r.service.makeCurrent(itemId, { version: 7, from: 2 }))).refusal).equal(
      'version_unknown',
    );
  });

  it('should fail closed when a write would leave a live line newer than the version served', async () => {
    const { r, itemId } = await joinedAtThree();
    const document = r.documents.document;
    r.documents.document = {
      ...document,
      catalogs: document.catalogs.map(catalog => ({
        ...catalog,
        entries: catalog.entries.map(entry => ({ ...entry, sinceVersion: 9 })),
      })),
    };
    const writes = r.documents.writes;
    const damaged = await refusal(async () => await r.service.setRetired(itemId, 1, true));
    should(damaged.refusal).equal('store_damaged');
    should(r.documents.writes).equal(writes);
  });
});

describe('a catalog added after a rollback', () => {
  const V4 = { ...V3, 'four.txt': 'four' };
  const V5 = { ...V4, 'five.txt': 'five' };

  /** Versions 1..5 exist, 3 is current again, and "Late" has just been given the item. */
  async function rolledBackThenAdded() {
    const r = await rig();
    const first = await r.service.create({ name: 'First' });
    const late = await r.service.create({ name: 'Late' });
    const preview = await r.service.previewItem(first.id, { source: SOURCE });
    const { itemId } = await r.service.addItem(first.id, { source: SOURCE, digest: preview.digest });
    for (const files of [V2, V3, V4, V5]) await publish(r, itemId, files);
    await r.service.makeCurrent(itemId, { version: 3, from: 5 });
    await r.service.addItem(late.id, { itemId, version: 3 });
    return { r, first, late, itemId };
  }

  it('should never offer or serve the versions that existed when it joined, but its own and later ones', async () => {
    const { r, first, late, itemId } = await rolledBackThenAdded();
    const entry = r.documents.document.catalogs.find(catalog => catalog.id === late.id)?.entries[0];
    should(entry?.sinceVersion).equal(3);
    should(entry?.joinedAtMax).equal(5);
    should((await r.service.signedVersions(late.id, itemId)).versions.offered.map(each => each.version)).deepEqual([3]);
    should((await r.service.signedVersions(first.id, itemId)).versions.offered.map(each => each.version)).deepEqual([
      1, 2, 3, 4, 5,
    ]);
    for (const version of [1, 2, 4, 5])
      should((await refusal(async () => await r.service.frozenItem(late.id, itemId, version))).refusal).equal(
        'item_unknown',
      );
    should((await r.service.frozenItem(late.id, itemId, 3)).itemVersion).equal(3);
    const refused = await refusal(async () => await r.service.makeCurrent(itemId, { version: 5, from: 3 }));
    should(refused.refusal).equal('version_before_join');
    should(refused.message).match(/Late/u);
  });

  it('should get the next version published, and serve it along with the one it began at', async () => {
    const { r, late, itemId } = await rolledBackThenAdded();
    const next = await publish(r, itemId, { ...V5, 'six.txt': 'six' });
    should(next.itemVersion).equal(6);
    should((await r.service.signedVersions(late.id, itemId)).versions.offered.map(each => each.version)).deepEqual([
      3, 6,
    ]);
    should((await r.service.frozenItem(late.id, itemId, 6)).itemVersion).equal(6);
    should((await r.service.frozenItem(late.id, itemId, 3)).itemVersion).equal(3);
    should((await refusal(async () => await r.service.frozenItem(late.id, itemId, 4))).refusal).equal('item_unknown');
  });
});

describe('retiring a version', () => {
  it('should retire and unretire, stamping the time, and raise every live catalog once each time', async () => {
    const { r, first, itemId } = await joinedAtThree();
    const second = r.documents.document.catalogs[1]?.id as string;
    const before = [revisionOf(r, first.id), revisionOf(r, second)] as const;
    r.clock.ms += 5_000;
    const retired = await r.service.setRetired(itemId, 2, true);
    should(retired.retiredAt).be.a.String();
    should(retired.catalogs.map(each => each.revision)).deepEqual([before[0] + 1, before[1] + 1]);
    const listed = await r.service.getItem(itemId, { sourceState: false });
    should(listed.versions.find(each => each.version === 2)?.retiredAt).equal(retired.retiredAt);
    const back = await r.service.setRetired(itemId, 2, false);
    should(back.retiredAt).be.undefined();
    should(back.catalogs.map(each => each.revision)).deepEqual([before[0] + 2, before[1] + 2]);
  });

  it('should write nothing when the version is already in the state asked for', async () => {
    const { r, itemId } = await joinedAtThree();
    const writes = r.documents.writes;
    const same = await r.service.setRetired(itemId, 1, false);
    should(same.retiredAt).be.undefined();
    should(r.documents.writes).equal(writes);
  });

  it('should refuse the current version and a version never made, and never reuse a retired number', async () => {
    const { r, first, itemId } = await joinedAtThree();
    should((await refusal(async () => await r.service.setRetired(itemId, 3, true))).refusal).equal('version_current');
    should((await refusal(async () => await r.service.setRetired(itemId, 9, true))).refusal).equal('version_unknown');
    await r.service.setRetired(itemId, 2, true);
    const next = await publish(r, itemId, { ...V3, 'four.txt': 'four' });
    should(next.itemVersion).equal(4);
    should(first.id).be.a.String();
  });
});

describe('the signed version list', () => {
  it('should offer a catalog only what it began serving, never a retired version, and always the current', async () => {
    const { r, first, second, itemId } = await joinedAtThree();
    await r.service.setRetired(itemId, 2, true);
    const all = await r.service.signedVersions(first.id, itemId);
    should(all.versions.offered.map(each => each.version)).deepEqual([1, 3]);
    const late = await r.service.signedVersions(second.id, itemId);
    should(late.versions.offered.map(each => each.version)).deepEqual([3]);
    should(late.versions.current).equal(3);
    should(late.versions.offered.some(each => each.version < 3)).be.false();
  });

  it('should agree with the manifest on publisher, catalog, item, revision, instant, current and digest', async () => {
    const { r, first, itemId } = await joinedAtThree();
    const manifest = (await r.service.signedManifest(first.id)).manifest;
    const list = (await r.service.signedVersions(first.id, itemId)).versions;
    const line = manifest.items.find(each => each.itemId === itemId);
    should(list.publisher).equal(manifest.publisher);
    should(list.catalogId).equal(manifest.catalogId);
    should(list.revision).equal(manifest.revision);
    should(list.issuedAt).equal(manifest.issuedAt);
    should(list.current).equal(line?.version);
    should(list.offered.find(each => each.version === list.current)?.digest).equal(line?.digest);
    should(
      (await verifySignedCatalogItemVersions(crypto, await r.service.signedVersions(first.id, itemId))).ok,
    ).be.true();
  });

  it('should keep a manifest signature from verifying as a list and the reverse', async () => {
    const { r, first, itemId } = await joinedAtThree();
    const manifest = await r.service.signedManifest(first.id);
    const list = await r.service.signedVersions(first.id, itemId);
    const asList = { versions: list.versions, spki: manifest.spki, sig: manifest.sig };
    should((await verifySignedCatalogItemVersions(crypto, asList)).ok).be.false();
    const asManifest = { manifest: manifest.manifest, spki: list.spki, sig: list.sig };
    should((await verifySignedCatalogManifest(crypto, asManifest)).ok).be.false();
  });

  it('should read the revision without signing, and refuse an item the catalog does not offer', async () => {
    const { r, first, itemId } = await joinedAtThree();
    const kept = r.identity;
    r.identity = undefined;
    should(await r.service.versionsRevision(first.id, itemId)).equal(revisionOf(r, first.id));
    r.identity = kept;
    await r.service.withdraw(first.id, itemId);
    should((await refusal(async () => await r.service.versionsRevision(first.id, itemId))).refusal).equal(
      'item_unknown',
    );
  });

  it('should refuse a withdrawn item, an unknown item, and a machine that cannot sign', async () => {
    const { r, first, itemId } = await joinedAtThree();
    await r.service.withdraw(first.id, itemId);
    should((await refusal(async () => await r.service.signedVersions(first.id, itemId))).refusal).equal('item_unknown');
    should(
      (await refusal(async () => await r.service.signedVersions(first.id, 'itm_unknown000000000000000'))).refusal,
    ).be.a.String();
    r.identity = undefined;
    should((await refusal(async () => await r.service.signedVersions(first.id, itemId))).refusal).equal(
      'signing_unavailable',
    );
  });

  it('should count as a signing, so an undo withdraws rather than retracting', async () => {
    const r = await rig();
    const answer = await r.service.quickAdd('host', { source: SOURCE });
    if (answer.outcome !== 'added') throw new Error('expected an add');
    await r.service.signedVersions(answer.catalog.catalogId, answer.itemId);
    should((await r.service.undoQuickAdd('host', answer.undo.token)).mode).equal('withdrawn');
  });

  it('should have the member item read refuse a retired version and one from before the catalog joined', async () => {
    const { r, first, second, itemId } = await joinedAtThree();
    await r.service.setRetired(itemId, 2, true);
    const error = await refusal(async () => await r.service.frozenItem(first.id, itemId, 2));
    should(error.refusal).equal('item_unknown');
    should(error.message).match(/not offered/u);
    should((await refusal(async () => await r.service.frozenItem(second.id, itemId, 1))).refusal).equal('item_unknown');
    should((await r.service.frozenItem(first.id, itemId, 1)).version).equal(1);
    should(first.id).be.a.String();
  });
});
