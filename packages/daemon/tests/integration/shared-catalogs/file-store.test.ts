import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { FileCatalogBlobStore, FileCatalogDocumentStore } from '../../../src/adapters/shared-catalogs/index.ts';
import { createFoundationPaths, resolveStateHome } from '../../../src/lib/index.ts';
import { EMPTY_CATALOGS_DOCUMENT, withCatalog } from '../../../src/lib/shared-catalogs/document.ts';

/** The catalogs state under a real state home: its modes, its atomic writes, and a damaged file that is not empty. */

const homes = new Set<string>();

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-catalogs-'));
  homes.add(home);
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  const files = new StateFileSystem(paths);
  return {
    paths,
    documents: new FileCatalogDocumentStore(paths, files),
    blobs: new FileCatalogBlobStore(paths, files),
  };
}

const CAT = `cat_${'A'.repeat(22)}`;
const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

describe('the catalogs document on disk', () => {
  it('should read as no catalogs on a machine that has never published', async () => {
    const { documents } = await fixture();

    should(await documents.read()).deepEqual(EMPTY_CATALOGS_DOCUMENT);
  });

  it('should write it 0600 in a 0700 folder and read back what it wrote', async () => {
    const { paths, documents } = await fixture();
    const written = withCatalog(EMPTY_CATALOGS_DOCUMENT, {
      id: CAT,
      name: 'Team',
      description: '',
      now: '2026-01-01T00:00:00.000Z',
    });

    await documents.write(written);

    should(await documents.read()).deepEqual(written);
    should(await mode(paths.catalogsDocument)).equal(0o600);
    should(await mode(paths.catalogs)).equal(0o700);
    should((await readdir(paths.catalogs)).filter(name => name.includes('tmp'))).deepEqual([]);
  });

  it('should refuse a file that is not JSON instead of answering empty', async () => {
    const { paths, documents } = await fixture();
    await documents.write(EMPTY_CATALOGS_DOCUMENT);
    await writeFile(paths.catalogsDocument, '{ not json');

    const failure = await documents.read().then(
      () => undefined,
      (error: unknown) => error,
    );

    should(failure).have.property('refusal', 'store_damaged');
    should(await readFile(paths.catalogsDocument, 'utf8')).equal('{ not json');
  });

  it('should refuse a file that is JSON the schema does not accept', async () => {
    const { paths, documents } = await fixture();
    await documents.write(EMPTY_CATALOGS_DOCUMENT);
    await writeFile(paths.catalogsDocument, JSON.stringify({ schemaVersion: 99, catalogs: [] }));

    const failure = await documents.read().then(
      () => undefined,
      (error: unknown) => error,
    );

    should(failure).have.property('refusal', 'store_damaged');
  });
});

describe('the frozen item blobs on disk', () => {
  const DIGEST = `sha256:${'ab'.repeat(32)}`;

  it('should keep a blob under its hex digest, 0600, and read it back', async () => {
    const { paths, blobs } = await fixture();

    await blobs.put(DIGEST, '{"a":1}');

    should(await blobs.get(DIGEST)).equal('{"a":1}');
    should(await mode(join(paths.catalogBlobs, `${'ab'.repeat(32)}.json`))).equal(0o600);
    should(await mode(paths.catalogBlobs)).equal(0o700);
  });

  it('should never rewrite a blob that is already there', async () => {
    const { blobs } = await fixture();
    await blobs.put(DIGEST, 'first');

    await blobs.put(DIGEST, 'second');

    should(await blobs.get(DIGEST)).equal('first');
  });

  it('should answer undefined for a digest it has no blob for', async () => {
    const { blobs } = await fixture();

    should(await blobs.get(`sha256:${'cd'.repeat(32)}`)).equal(undefined);
  });

  it('should refuse a digest that is not a sha256 rather than build a path from it', async () => {
    const { blobs } = await fixture();

    const failure = await blobs.get('../../etc/passwd').then(
      () => undefined,
      (error: unknown) => error,
    );

    should(failure).have.property('refusal', 'store_damaged');
  });
});
