import { describe, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { OwnedCatalogList } from '@ferretry/protocol';
import { verifySharedCatalogFile } from '@ferretry/relay';
import should from 'should';
import { CatalogsDocumentSchema } from '../../../src/lib/shared-catalogs/document.ts';
import { SEED_ALONE, SEED_CATALOG, SEED_OTHER, install } from './seed.ts';
import { crypto, rig } from './support.ts';

/**
 * The answers a known-good build gave for a fixed store, held byte for byte (see `golden/README.md`).
 * Nothing in `golden/` is produced by the code under test: the expectation is a file, not a second copy of the logic.
 */
const GOLDEN: Readonly<Record<string, unknown>> = JSON.parse(
  readFileSync(new URL('./golden/main-output.json', import.meta.url), 'utf8'),
);
const STORE = JSON.parse(readFileSync(new URL('./golden/v3-state.json', import.meta.url), 'utf8')) as {
  readonly document: unknown;
  readonly blobs: Readonly<Record<string, string>>;
};

/** The keys added since the golden answers were made, each optional, taken off so the answer is held to the old bytes. */
function withoutAddedKeys(list: OwnedCatalogList): unknown {
  return {
    ...list,
    catalogs: list.catalogs.map(({ role: _role, ...catalog }) => ({
      ...catalog,
      items: catalog.items.map(({ current: _current, ...item }) => item),
    })),
  };
}

async function stored() {
  const r = await rig();
  const parsed = CatalogsDocumentSchema.parse(STORE.document);
  install(r, { document: parsed, blobs: new Map(Object.entries(STORE.blobs)) });
  return r;
}

describe('the fixed store against the recorded answers', () => {
  it('should export and sign every catalog as the recorded bytes, and the manifest alone the same way', async () => {
    const r = await stored();
    for (const id of [SEED_CATALOG, SEED_OTHER]) {
      const after = await r.service.exportCatalog(id, {});
      should(JSON.stringify(after)).equal(JSON.stringify(GOLDEN[`export:${id}`]));
      should((await verifySharedCatalogFile(crypto, after)).ok).be.true();
      should(JSON.stringify(await r.service.signedManifest(id))).equal(JSON.stringify(GOLDEN[`manifest:${id}`]));
    }
    should(r.events).have.length(0);
  });

  it('should list the catalogs with the recorded digests, sizes and revisions', async () => {
    const r = await stored();
    should(JSON.stringify(withoutAddedKeys(await r.service.list()))).equal(JSON.stringify(GOLDEN.list));
    should(JSON.stringify(withoutAddedKeys(await r.service.list({ sourceState: true })))).equal(
      JSON.stringify(GOLDEN.listWithState),
    );
  });

  it('should hand the shared item to the catalog that asks for it with that catalog’s own id', async () => {
    const r = await stored();
    should((await r.service.frozenItem(SEED_OTHER, SEED_ALONE, 1)).catalogId).equal(SEED_OTHER);
  });
});
