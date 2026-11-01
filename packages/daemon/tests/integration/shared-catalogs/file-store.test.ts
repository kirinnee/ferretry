import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { FileCatalogBlobStore, FileCatalogDocumentStore } from '../../../src/adapters/shared-catalogs/index.ts';
import { createFoundationPaths, resolveStateHome } from '../../../src/lib/index.ts';
import { type CatalogsDocumentV1, CatalogsDocumentV1Schema } from '../../../src/lib/shared-catalogs/document-v1.ts';
import {
  type CatalogsDocument,
  documentProblem,
  EMPTY_CATALOGS_DOCUMENT,
  withCatalog,
  withNewItem,
} from '../../../src/lib/shared-catalogs/document.ts';
import { CatalogRefusal } from '../../../src/lib/shared-catalogs/refusal.ts';

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

    should(await documents.readRaw()).deepEqual({ version: 2, doc: written });
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

  it('should hand a version 1 file on with its exact text, and keep the backup beside it, 0600', async () => {
    const { paths, documents } = await fixture();
    const text = `${JSON.stringify({ schemaVersion: 1, catalogs: [] }, undefined, 2)}\n`;
    await documents.writeBackupV1('seed');
    await writeFile(paths.catalogsDocument, text);

    should(await documents.readRaw()).deepEqual({ version: 1, doc: { schemaVersion: 1, catalogs: [] }, text });

    await documents.writeBackupV1(text);
    should(await readFile(paths.catalogsBackupV1, 'utf8')).equal(text);
    should(await mode(paths.catalogsBackupV1)).equal(0o600);
    should(await readFile(paths.catalogsDocument, 'utf8')).equal(text);
  });

  it('should refuse a version 1 file the version 1 schema does not accept', async () => {
    const { paths, documents } = await fixture();
    await documents.write(EMPTY_CATALOGS_DOCUMENT);
    await writeFile(paths.catalogsDocument, JSON.stringify({ schemaVersion: 1, catalogs: [{ id: 'x' }] }));

    const failure = await documents.readRaw().then(
      () => undefined,
      (error: unknown) => error,
    );

    should(failure).have.property('refusal', 'store_damaged');
  });

  it('should leave a file whose top level is not an object to the version 2 schema, which refuses it', async () => {
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

/**
 * The previous daemon's read of `catalogs.json`, as origin/main's `FileCatalogDocumentStore.read` wrote it: the
 * version 1 schema, whose `schemaVersion` is the literal 1, and a refusal that names the file when it does not fit.
 */
async function previousRead(file: string): Promise<CatalogsDocumentV1> {
  const raw = await readFile(file, 'utf8');
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new CatalogRefusal('store_damaged', 'catalogs.json cannot be read: it is not JSON.');
  }
  const parsed = CatalogsDocumentV1Schema.safeParse(decoded);
  if (!parsed.success)
    throw new CatalogRefusal(
      'store_damaged',
      `catalogs.json cannot be read: ${documentProblem(parsed) ?? 'it is malformed'}. Nothing was changed.`,
    );
  return parsed.data;
}

const migrated = (): CatalogsDocument =>
  withNewItem(
    withCatalog(EMPTY_CATALOGS_DOCUMENT, {
      id: CAT,
      name: 'Team',
      description: 'for us',
      publisherName: 'host',
      now: '2026-01-01T00:00:00.000Z',
    }),
    CAT,
    {
      itemId: `itm_${'B'.repeat(22)}`,
      kind: 'mcp',
      name: 'files',
      ownSummary: false,
      createdAt: '2026-01-02T00:00:00.000Z',
      current: 1,
      versions: [
        {
          version: 1,
          contentDigest: `sha256:${'a'.repeat(64)}`,
          size: 340,
          publishedAt: '2026-01-02T00:00:00.000Z',
          summary: 'files summary',
          source: { kind: 'mcp', id: 'id-files', name: 'files' },
          bindings: { [CAT]: { digest: `sha256:${'b'.repeat(64)}`, size: 341 } },
        },
      ],
    },
    '2026-01-02T00:00:00.000Z',
  );

describe('a previous daemon meeting the version 2 file', () => {
  it('should refuse it, and a read, change and write through its service never writes or puts', async () => {
    const { paths, documents } = await fixture();
    const document = migrated();
    await documents.write(document);
    // A realistic file: a catalog, a shared item, its version and the binding to the catalog.
    should(document.items).have.length(1);
    should(await documents.readRaw()).deepEqual({ version: 2, doc: document });
    const longAgo = new Date('2020-01-01T00:00:00.000Z');
    await utimes(paths.catalogsDocument, longAgo, longAgo);
    const bytes = await readFile(paths.catalogsDocument);
    const before = await stat(paths.catalogsDocument);

    const failure = await previousRead(paths.catalogsDocument).then(
      () => undefined,
      (error: unknown) => error,
    );
    should(failure).have.property('refusal', 'store_damaged');
    should(failure)
      .have.property('message')
      .match(/catalogs\.json cannot be read/u);

    // The previous service: read the document, change it, put the frozen item, write the document.
    const writes: unknown[] = [];
    const puts: unknown[] = [];
    const previous = {
      read: () => previousRead(paths.catalogsDocument),
      write: async (next: unknown) => void writes.push(next),
      put: async (digest: string, text: string) => void puts.push([digest, text]),
    };
    const rename = async () => {
      const current = await previous.read();
      const next = { ...current, catalogs: current.catalogs.map(catalog => ({ ...catalog, name: 'Renamed' })) };
      await previous.put('sha256:x', 'text');
      await previous.write(next);
    };
    const renamed = await rename().then(
      () => undefined,
      (error: unknown) => error,
    );

    should(renamed).have.property('refusal', 'store_damaged');
    should(writes).have.length(0);
    should(puts).have.length(0);
    should(await readFile(paths.catalogsDocument)).deepEqual(bytes);
    const after = await stat(paths.catalogsDocument);
    should(after.mtimeMs).equal(before.mtimeMs);
    should(await readdir(paths.catalogs)).deepEqual(['catalogs.json']);
  });

  it('should still read a version 1 file, so the refusal above is the version and not the reader', async () => {
    const { paths, documents } = await fixture();
    await documents.write(EMPTY_CATALOGS_DOCUMENT);
    await writeFile(paths.catalogsDocument, JSON.stringify({ schemaVersion: 1, catalogs: [] }));

    should(await previousRead(paths.catalogsDocument)).deepEqual({ schemaVersion: 1, catalogs: [] });
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
