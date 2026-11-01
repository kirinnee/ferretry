import { describe, it } from 'bun:test';
import { verifySharedCatalogFile } from '@ferretry/relay';
import should from 'should';
import { CatalogsDocumentSchema } from '../../../src/lib/shared-catalogs/document.ts';
import {
  NORMALISED_CATALOG_ID,
  NORMALISED_ITEM_ID,
  canonicalOrRefuse,
  sharedCopy,
} from '../../../src/lib/shared-catalogs/freeze.ts';
import { migrateCatalogs } from '../../../src/lib/shared-catalogs/migrate.ts';
import { CatalogRefusal } from '../../../src/lib/shared-catalogs/refusal.ts';
import {
  install,
  LEGACY_ALONE,
  LEGACY_CATALOG,
  LEGACY_MCP,
  LEGACY_OTHER,
  LEGACY_SKILL,
  legacyExport,
  legacyState,
} from './legacy.ts';
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

async function upgraded() {
  const r = await rig();
  const legacy = await legacyState(r);
  install(r, legacy);
  return { r, legacy };
}

describe('migrateCatalogs', () => {
  it('should be pure and deterministic, and keep every digest the version 1 manifest listed', async () => {
    const { r, legacy } = await upgraded();
    const read = async (digest: string) => r.blobs.blobs.get(digest);
    const first = await migrateCatalogs(crypto, legacy.document, read);
    const second = await migrateCatalogs(crypto, legacy.document, read);
    should(JSON.stringify(second)).equal(JSON.stringify(first));
    should(CatalogsDocumentSchema.safeParse(first.document).success).be.true();
    should(first.document.catalogs.map(catalog => catalog.revision)).deepEqual([6, 2]);
    should(first.document.catalogs[0]?.entries.map(entry => entry.withdrawnAt)).deepEqual([
      undefined,
      '2026-01-05T00:00:00.000Z',
    ]);
    const skill = first.document.items.find(item => item.itemId === LEGACY_SKILL);
    should(skill?.current).equal(2);
    should(skill?.versions.map(version => version.bindings[LEGACY_CATALOG]?.digest)).deepEqual(
      legacy.document.catalogs[0]?.items[0]?.versions.map(version => version.digest),
    );
    should(skill?.versions[0]?.fileCount).equal(2);
    should(first.document.items.find(item => item.itemId === LEGACY_MCP)?.versions[0]?.fileCount).be.undefined();
    // The two catalogs hold the same MCP setup under different ids: one shared copy, kept once.
    should(first.sharedBlobs).have.length(3);
    for (const blob of first.sharedBlobs) {
      const copy = await canonicalOrRefuse(crypto, JSON.parse(blob.text));
      should(copy.digest).equal(blob.digest);
      should(blob.text).containEql(NORMALISED_CATALOG_ID).and.containEql(NORMALISED_ITEM_ID);
    }
    should(first.document.items.find(item => item.itemId === LEGACY_ALONE)?.versions[0]?.contentDigest).equal(
      first.document.items.find(item => item.itemId === LEGACY_MCP)?.versions[0]?.contentDigest,
    );
  });

  it('should name the file of a frozen copy that is missing, changed, not JSON, not an item or somebody else’s', async () => {
    const { r, legacy } = await upgraded();
    const [digest] = [...legacy.blobs.keys()] as [string];
    const text = legacy.blobs.get(digest) as string;
    const hex = digest.slice('sha256:'.length);
    const attempt = async (blob: string | undefined) =>
      await refusal(
        async () =>
          await migrateCatalogs(crypto, legacy.document, async candidate =>
            candidate === digest ? blob : r.blobs.blobs.get(candidate),
          ),
      );
    for (const blob of [undefined, text.replace('notes', 'NOTES'), 'not json', '{"a":1}']) {
      const failed = await attempt(blob);
      should(failed.refusal).equal('store_damaged');
      should(failed.message)
        .containEql(`blobs/${hex}.json`)
        .and.match(/Nothing was changed/u);
    }
    // A sound file, but of another version than the document says it is.
    const item = JSON.parse(text);
    const other = { ...item, itemVersion: item.itemVersion + 7 };
    should((await attempt(JSON.stringify(other))).message).containEql(`blobs/${hex}.json`);
    // A sound file under the digest of its own text, but naming another catalog.
    const elsewhere = await canonicalOrRefuse(crypto, { ...item, catalogId: LEGACY_OTHER });
    const document = structuredClone(legacy.document);
    const version = document.catalogs[0]?.items[0]?.versions[0];
    if (version === undefined) throw new Error('fixture');
    Object.assign(version, { digest: elsewhere.digest });
    const wrong = await refusal(async () => await migrateCatalogs(crypto, document, async () => elsewhere.text));
    should(wrong.refusal).equal('store_damaged');
  });

  it('should refuse a document the version 2 schema would not accept', async () => {
    const { r, legacy } = await upgraded();
    const doubled = {
      ...legacy.document,
      catalogs: [legacy.document.catalogs[0], legacy.document.catalogs[0]],
    } as typeof legacy.document;
    const failed = await refusal(
      async () => await migrateCatalogs(crypto, doubled, async digest => r.blobs.blobs.get(digest)),
    );
    should(failed.refusal).equal('store_damaged');
    should(failed.message).match(/could not be upgraded/u);
  });
});

describe('the upgrade, inside the service', () => {
  it('should keep every export byte for byte what the version 1 daemon made, and every item', async () => {
    const { r, legacy } = await upgraded();
    for (const id of [LEGACY_CATALOG, LEGACY_OTHER]) {
      const before = await legacyExport(r, legacy, id);
      const after = await r.service.exportCatalog(id, {});
      should(JSON.stringify(after)).equal(JSON.stringify(before));
      should((await verifySharedCatalogFile(crypto, after)).ok).be.true();
      should(JSON.stringify(await r.service.exportCatalog(id, {}))).equal(JSON.stringify(before));
      should(JSON.stringify(await r.service.signedManifest(id))).equal(JSON.stringify(before.signedManifest));
    }
    for (const [itemId, versions] of legacy.items) {
      const catalogId = itemId === LEGACY_ALONE ? LEGACY_OTHER : LEGACY_CATALOG;
      for (const item of versions)
        if (itemId !== LEGACY_MCP)
          should(JSON.stringify(await r.service.frozenItem(catalogId, itemId, item.itemVersion))).equal(
            JSON.stringify(item),
          );
    }
    should(r.documents.raw.version).equal(2);
    should(r.documents.backup).equal(legacy.text);
  });

  it('should answer a list as the version 1 daemon did: same digests and sizes per catalog', async () => {
    const { r, legacy } = await upgraded();
    const listed = await r.service.list();
    const skill = legacy.document.catalogs[0]?.items[0];
    const item = listed.catalogs[0]?.items[0];
    should(item?.versions).deepEqual(
      skill?.versions.map(version => ({
        version: version.version,
        digest: version.digest,
        size: version.size,
        publishedAt: version.publishedAt,
      })),
    );
    should(listed.catalogs[0]?.items[1]?.withdrawnAt).equal('2026-01-05T00:00:00.000Z');
    should(listed.catalogs.map(catalog => catalog.revision)).deepEqual([6, 2]);
  });

  it('should put the shared copies first, then the backup, then the new file, and write nothing for version 2', async () => {
    const { r } = await upgraded();
    await r.service.list();
    const kinds = r.events.map(event => event.split(':')[0]);
    should(kinds).deepEqual(['blob', 'blob', 'blob', 'backup', 'document']);
    r.events.length = 0;
    await r.service.list();
    await r.service.exportCatalog(LEGACY_CATALOG, {});
    should(r.events).have.length(0);
  });

  it('should upgrade once when the first calls arrive together', async () => {
    const { r } = await upgraded();
    await Promise.all([
      r.service.list(),
      r.service.list(),
      r.service.exportCatalog(LEGACY_CATALOG, {}),
      r.service.signedManifest(LEGACY_OTHER),
      r.service.frozenItem(LEGACY_CATALOG, LEGACY_SKILL, 1),
      r.service.update(LEGACY_OTHER, { description: 'hello' }),
    ]);
    should(r.events.filter(event => event === 'backup')).have.length(1);
    should(r.events.filter(event => event === 'document')).have.length(2);
    should(r.documents.document.catalogs[1]?.revision).equal(3);
  });

  it('should repair a crash between any two steps by running again to the same bytes', async () => {
    const { r, legacy } = await upgraded();
    const fresh = () => {
      r.documents.raw = { version: 1, doc: legacy.document, text: legacy.text };
      r.documents.backup = undefined;
    };
    await r.service.list();
    const expected = JSON.stringify(r.documents.document);
    const failure = (message: string) => async (work: Promise<unknown>) =>
      await work.then(
        () => {
          throw new Error('expected a failure');
        },
        (error: Error) => should(error.message).equal(message),
      );

    fresh();
    r.documents.failBackup = true;
    await failure('disk full')(r.service.list());
    should(r.documents.raw.version).equal(1);
    should(r.documents.backup).be.undefined();
    r.documents.failBackup = false;
    await r.service.list();
    should(JSON.stringify(r.documents.document)).equal(expected);

    fresh();
    r.documents.failWrites = true;
    await failure('disk full')(r.service.list());
    should(r.documents.raw.version).equal(1);
    should(r.documents.backup).equal(legacy.text);
    r.documents.failWrites = false;
    await r.service.list();
    should(JSON.stringify(r.documents.document)).equal(expected);
    should(r.documents.backup).equal(legacy.text);
  });

  it('should fail closed on a damaged frozen copy, write nothing, and try again on the next call', async () => {
    const { r, legacy } = await upgraded();
    const [digest] = [...legacy.blobs.keys()] as [string];
    const text = legacy.blobs.get(digest) as string;
    r.blobs.blobs.delete(digest);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const failed = await refusal(async () => await r.service.list());
      should(failed.refusal).equal('store_damaged');
      should(failed.message).containEql(`blobs/${digest.slice('sha256:'.length)}.json`);
      should((await refusal(async () => await r.service.exportCatalog(LEGACY_OTHER, {}))).refusal).equal(
        'store_damaged',
      );
      should((await refusal(async () => await r.service.create({ name: 'New' }))).refusal).equal('store_damaged');
    }
    should(r.events).have.length(0);
    should(r.documents.raw.version).equal(1);
    r.blobs.blobs.set(digest, text);
    should((await r.service.list()).catalogs).have.length(2);
    should(r.documents.raw.version).equal(2);
  });
});

describe('what every read checks', () => {
  it('should check the shared copy against its content digest and the catalog item against its own digest', async () => {
    const { r, legacy } = await upgraded();
    await r.service.list();
    const document = r.documents.document;
    const skill = document.items.find(item => item.itemId === LEGACY_SKILL);
    const version = skill?.versions[0];
    if (skill === undefined || version === undefined) throw new Error('fixture');

    // The catalog's digest no longer matches what the shared copy makes of it.
    const swapped = {
      ...document,
      items: document.items.map(item =>
        item.itemId === LEGACY_SKILL
          ? {
              ...item,
              versions: item.versions.map(candidate =>
                candidate.version === 1
                  ? { ...candidate, bindings: { [LEGACY_CATALOG]: { digest: `sha256:${'e'.repeat(64)}`, size: 5 } } }
                  : candidate,
              ),
            }
          : item,
      ),
    };
    r.documents.document = swapped;
    const mismatch = await refusal(async () => await r.service.frozenItem(LEGACY_CATALOG, LEGACY_SKILL, 1));
    should(mismatch.refusal).equal('store_damaged');
    should(mismatch.message).match(/no longer matches its digest/u);

    // The shared copy no longer matches its content digest.
    r.documents.document = document;
    const text = r.blobs.blobs.get(version.contentDigest) as string;
    r.blobs.blobs.set(version.contentDigest, text.replace('demo summary', 'demo summarY'));
    should((await refusal(async () => await r.service.frozenItem(LEGACY_CATALOG, LEGACY_SKILL, 1))).message).match(
      /no longer matches its digest/u,
    );
    r.blobs.blobs.set(version.contentDigest, text);
    should(JSON.stringify(await r.service.exportCatalog(LEGACY_CATALOG, {}))).equal(
      JSON.stringify(await legacyExport(r, legacy, LEGACY_CATALOG)),
    );
  });

  it('should hand the same shared copy to two catalogs as two different items', async () => {
    const { r } = await upgraded();
    const mine = await r.service.frozenItem(LEGACY_OTHER, LEGACY_ALONE, 1);
    const copy = r.blobs.blobs.get(
      r.documents.document.items.find(item => item.itemId === LEGACY_ALONE)?.versions[0]?.contentDigest ?? '',
    );
    should(copy).be.a.String();
    should(mine.catalogId).equal(LEGACY_OTHER);
    should(sharedCopy(mine)).deepEqual(JSON.parse(copy as string));
  });
});

describe('an item two catalogs list', () => {
  it('should bump every catalog that lists it live, bind both, and export each as its own', async () => {
    const { r } = await upgraded();
    const document = r.documents;
    await r.service.list();
    const base = document.document;
    // The same MCP setup, listed by both catalogs: what a later slice's "add to another catalog" makes.
    const mcp = base.items.find(item => item.itemId === LEGACY_ALONE);
    const only = mcp?.versions[0];
    if (mcp === undefined || only === undefined) throw new Error('fixture');
    const shared = {
      ...base,
      items: base.items.map(item =>
        item.itemId === LEGACY_ALONE
          ? {
              ...item,
              versions: [
                {
                  ...only,
                  bindings: { ...only.bindings, [LEGACY_CATALOG]: { digest: `sha256:${'f'.repeat(64)}`, size: 9 } },
                },
              ],
            }
          : item,
      ),
      catalogs: base.catalogs.map(catalog =>
        catalog.id === LEGACY_CATALOG
          ? { ...catalog, entries: [...catalog.entries, { itemId: LEGACY_ALONE, addedAt: '2026-01-04T00:00:00.000Z' }] }
          : catalog,
      ),
    };
    should(CatalogsDocumentSchema.safeParse(shared).success).be.true();
    document.document = shared;
    r.servers = [stdio('files', { CHANGED: '1' })];
    r.clock.ms = Date.UTC(2026, 0, 9);
    const preview = await r.service.previewItem(LEGACY_OTHER, { itemId: LEGACY_ALONE });
    const published = await r.service.publishVersion(LEGACY_OTHER, LEGACY_ALONE, { digest: preview.digest });
    should(published.itemVersion).equal(2);
    const catalogs = r.documents.document.catalogs;
    should(catalogs.map(catalog => catalog.revision)).deepEqual([7, 3]);
    const stored = r.documents.document.items.find(item => item.itemId === LEGACY_ALONE)?.versions[1];
    should(Object.keys(stored?.bindings ?? {}).sort()).deepEqual([LEGACY_CATALOG, LEGACY_OTHER].sort());
    for (const id of [LEGACY_CATALOG, LEGACY_OTHER]) {
      const file = await r.service.exportCatalog(id, {});
      should((await verifySharedCatalogFile(crypto, file)).ok).be.true();
      should(file.items.find(item => item.itemId === LEGACY_ALONE)?.catalogId).equal(id);
      should(file.items.find(item => item.itemId === LEGACY_ALONE)?.itemVersion).equal(2);
    }
  });
});

describe('deleting a catalog', () => {
  it('should keep the items and versions it listed', async () => {
    const { r } = await upgraded();
    await r.service.remove(LEGACY_OTHER);
    const document = r.documents.document;
    should(document.catalogs.map(catalog => catalog.id)).deepEqual([LEGACY_CATALOG]);
    should(document.items.map(item => item.itemId)).containEql(LEGACY_ALONE);
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
});
