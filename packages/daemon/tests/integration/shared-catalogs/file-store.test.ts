import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
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

const CAT = `cat_${'B'.repeat(22)}`;
const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

describe('the catalogs document on disk', () => {
  it('should read as no catalogs on a machine that has never published', async () => {
    const { documents } = await fixture();

    should(await documents.readRaw()).deepEqual({ version: 'none' });
  });

  it('should write it 0600 in a 0700 folder and read back what it wrote', async () => {
    const { paths, documents } = await fixture();
    const written = withCatalog(EMPTY_CATALOGS_DOCUMENT, {
      id: CAT,
      name: 'Team',
      description: '',
      publisherName: 'host',
      now: '2026-01-01T00:00:00.000Z',
    });

    await documents.write(written);

    should(await documents.readRaw()).deepEqual({ version: 3, doc: written });
    should(await mode(paths.catalogsDocument)).equal(0o600);
    should(await mode(paths.catalogs)).equal(0o700);
    should((await readdir(paths.catalogs)).filter(name => name.includes('tmp'))).deepEqual([]);
  });

  it('should refuse a file that is not JSON instead of answering empty', async () => {
    const { paths, documents } = await fixture();
    await documents.write(EMPTY_CATALOGS_DOCUMENT);
    await writeFile(paths.catalogsDocument, '{ not json');

    const failure = await documents.readRaw().then(
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

    const failure = await documents.readRaw().then(
      () => undefined,
      (error: unknown) => error,
    );

    should(failure).have.property('refusal', 'store_damaged');
  });

  it('should refuse a file from before version 3, naming it as damaged and leaving it as it was', async () => {
    const { paths, documents } = await fixture();
    for (const schemaVersion of [1, 2]) {
      const text = `${JSON.stringify({ schemaVersion, catalogs: [] })}\n`;
      await writeFile(paths.catalogsDocument, text);

      const failure = await documents.readRaw().then(
        () => undefined,
        (error: unknown) => error,
      );

      should(failure).have.property('refusal', 'store_damaged');
      should(await readFile(paths.catalogsDocument, 'utf8')).equal(text);
    }
  });

  it('should leave a file whose top level is not an object, which the schema refuses', async () => {
    const { paths, documents } = await fixture();
    await documents.write(EMPTY_CATALOGS_DOCUMENT);
    for (const text of ['[1]', 'null', '7']) {
      await writeFile(paths.catalogsDocument, text);

      const failure = await documents.readRaw().then(
        () => undefined,
        (error: unknown) => error,
      );

      should(failure).have.property('refusal', 'store_damaged');
    }
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

  it('should leave a blob that already holds the text alone', async () => {
    const { paths, blobs } = await fixture();
    await blobs.put(DIGEST, 'first');
    const file = join(paths.catalogBlobs, `${'ab'.repeat(32)}.json`);
    const longAgo = new Date('2020-01-01T00:00:00.000Z');
    await utimes(file, longAgo, longAgo);

    await blobs.put(DIGEST, 'first');

    should(await blobs.get(DIGEST)).equal('first');
    should((await stat(file)).mtimeMs).equal(longAgo.getTime());
  });

  it('should replace a blob that holds anything else, since the name is the digest of the text', async () => {
    const { paths, blobs } = await fixture();
    await blobs.put(DIGEST, 'damaged');

    await blobs.put(DIGEST, 'the text the digest names');

    should(await blobs.get(DIGEST)).equal('the text the digest names');
    should(await mode(join(paths.catalogBlobs, `${'ab'.repeat(32)}.json`))).equal(0o600);
    should((await readdir(paths.catalogBlobs)).filter(name => name.includes('tmp'))).deepEqual([]);
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
