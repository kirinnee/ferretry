import { describe, it } from 'bun:test';
import { verifySharedCatalogFile } from '@ferretry/relay';
import should from 'should';
import { CatalogsDocumentSchema } from '../../../src/lib/shared-catalogs/document.ts';
import { NORMALISED_CATALOG_ID, NORMALISED_ITEM_ID, sharedCopy } from '../../../src/lib/shared-catalogs/freeze.ts';
import { CatalogRefusal } from '../../../src/lib/shared-catalogs/refusal.ts';
import { install, SEED_ALONE, SEED_CATALOG, SEED_OTHER, SEED_SKILL, seededStore } from './seed.ts';
import { crypto, rig, SKILL_MD, SKILL_PATH, stdio } from './support.ts';

const refusal = async (work: () => Promise<unknown>): Promise<CatalogRefusal> => {
  try {
    await work();
  } catch (error) {
    if (error instanceof CatalogRefusal) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

async function seeded() {
  const r = await rig();
  const seed = await seededStore(r);
  install(r, seed);
  return { r, seed };
}

describe('what every read checks', () => {
  it('should check the shared copy against its content digest and the catalog item against its own digest', async () => {
    const { r } = await seeded();
    const document = r.documents.document;
    const skill = document.items.find(item => item.itemId === SEED_SKILL);
    const version = skill?.versions[0];
    if (skill === undefined || version === undefined) throw new Error('fixture');

    // The catalog's digest no longer matches what the shared copy makes of it.
    const swapped = {
      ...document,
      items: document.items.map(item =>
        item.itemId === SEED_SKILL
          ? {
              ...item,
              versions: item.versions.map(candidate =>
                candidate.version === 1
                  ? { ...candidate, bindings: { [SEED_CATALOG]: { digest: `sha256:${'e'.repeat(64)}`, size: 5 } } }
                  : candidate,
              ),
            }
          : item,
      ),
    };
    r.documents.document = swapped;
    const mismatch = await refusal(async () => await r.service.frozenItem(SEED_CATALOG, SEED_SKILL, 1));
    should(mismatch.refusal).equal('store_damaged');
    should(mismatch.message).match(/no longer matches its digest/u);

    // The shared copy no longer matches its content digest.
    r.documents.document = document;
    const exported = JSON.stringify(await r.service.exportCatalog(SEED_CATALOG, {}));
    const text = r.blobs.blobs.get(version.contentDigest) as string;
    r.blobs.blobs.set(version.contentDigest, text.replace('Does the demo thing', 'Does the demo thinG'));
    should((await refusal(async () => await r.service.frozenItem(SEED_CATALOG, SEED_SKILL, 1))).message).match(
      /no longer matches its digest/u,
    );
    r.blobs.blobs.set(version.contentDigest, text);
    should(JSON.stringify(await r.service.exportCatalog(SEED_CATALOG, {}))).equal(exported);
  });

  it('should hand the same shared copy to two catalogs as two different items', async () => {
    const { r } = await seeded();
    const mine = await r.service.frozenItem(SEED_OTHER, SEED_ALONE, 1);
    const copy = r.blobs.blobs.get(
      r.documents.document.items.find(item => item.itemId === SEED_ALONE)?.versions[0]?.contentDigest ?? '',
    );
    should(copy).be.a.String();
    should(mine.catalogId).equal(SEED_OTHER);
    should(sharedCopy(mine)).deepEqual(JSON.parse(copy as string));
  });
});

describe('an item two catalogs list', () => {
  it('should bump every catalog that lists it live, bind both, and export each as its own', async () => {
    const { r } = await seeded();
    const document = r.documents;
    const base = document.document;
    // The same MCP setup, listed by both catalogs: what a later slice's "add to another catalog" makes.
    const mcp = base.items.find(item => item.itemId === SEED_ALONE);
    const only = mcp?.versions[0];
    if (mcp === undefined || only === undefined) throw new Error('fixture');
    const shared = {
      ...base,
      items: base.items.map(item =>
        item.itemId === SEED_ALONE
          ? {
              ...item,
              versions: [
                {
                  ...only,
                  bindings: { ...only.bindings, [SEED_CATALOG]: { digest: `sha256:${'f'.repeat(64)}`, size: 9 } },
                },
              ],
            }
          : item,
      ),
      catalogs: base.catalogs.map(catalog =>
        catalog.id === SEED_CATALOG
          ? { ...catalog, entries: [...catalog.entries, { itemId: SEED_ALONE, addedAt: '2026-01-04T00:00:00.000Z' }] }
          : catalog,
      ),
    };
    should(CatalogsDocumentSchema.safeParse(shared).success).be.true();
    document.document = shared;
    r.servers = [stdio('files', { CHANGED: '1' })];
    r.clock.ms = Date.UTC(2026, 0, 9);
    const preview = await r.service.previewItem(SEED_OTHER, { itemId: SEED_ALONE });
    const published = await r.service.publishVersion(SEED_OTHER, SEED_ALONE, { digest: preview.digest });
    should(published.itemVersion).equal(2);
    const catalogs = r.documents.document.catalogs;
    should(catalogs.map(catalog => catalog.revision)).deepEqual([7, 3]);
    const stored = r.documents.document.items.find(item => item.itemId === SEED_ALONE)?.versions[1];
    should(Object.keys(stored?.bindings ?? {}).sort()).deepEqual([SEED_CATALOG, SEED_OTHER].sort());
    for (const id of [SEED_CATALOG, SEED_OTHER]) {
      const file = await r.service.exportCatalog(id, {});
      should((await verifySharedCatalogFile(crypto, file)).ok).be.true();
      should(file.items.find(item => item.itemId === SEED_ALONE)?.catalogId).equal(id);
      should(file.items.find(item => item.itemId === SEED_ALONE)?.itemVersion).equal(2);
    }
  });
});

describe('deleting a catalog', () => {
  it('should keep the items and versions it listed', async () => {
    const { r } = await seeded();
    await r.service.remove(SEED_OTHER);
    const document = r.documents.document;
    should(document.catalogs.map(catalog => catalog.id)).deepEqual([SEED_CATALOG]);
    should(document.items.map(item => item.itemId)).containEql(SEED_ALONE);
    should(CatalogsDocumentSchema.safeParse(document).success).be.true();
  });
});

describe('new ids', () => {
  it('should never hand out the placeholder id a shared copy is stored under', async () => {
    let calls = 0;
    const zeros = Object.assign(Object.create(crypto) as typeof crypto, {
      randomBytes: (length: number) => {
        calls += 1;
        return calls === 1 ? new Uint8Array(length) : crypto.randomBytes(length);
      },
    });
    const r = await rig({ crypto: zeros });
    const catalog = await r.service.create({ name: 'Team' });
    should(catalog.id).not.equal(NORMALISED_CATALOG_ID);
    should(calls).equal(2);
    const preview = await r.service.previewItem(catalog.id, { source: { kind: 'skill', skill: SKILL_PATH } });
    calls = 0;
    const added = await r.service.addItem(catalog.id, {
      source: { kind: 'skill', skill: SKILL_PATH },
      digest: preview.digest,
    });
    should(added.itemId).not.equal(NORMALISED_ITEM_ID);
    should(SKILL_MD).be.a.String();
    should(calls).equal(2);
  });

  it('should give up after three placeholders instead of looping', async () => {
    let calls = 0;
    const zeros = Object.assign(Object.create(crypto) as typeof crypto, {
      randomBytes: (length: number) => {
        calls += 1;
        return new Uint8Array(length);
      },
    });
    const r = await rig({ crypto: zeros });
    const failure = await r.service.create({ name: 'Team' }).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    should(failure?.message).match(/placeholder id three times/u);
    should(calls).equal(3);
    should(r.events).have.length(0);
  });
});
