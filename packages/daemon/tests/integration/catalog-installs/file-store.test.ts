import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  CATALOG_INSTALLS_DOCUMENT,
  FileCatalogInstallStore,
} from '../../../src/adapters/catalog-installs/file-store.ts';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import {
  type CatalogInstallState,
  CatalogInstallStateError,
  EMPTY_CATALOG_INSTALL_STATE,
} from '../../../src/lib/catalog-installs/store.ts';
import { createFoundationPaths, resolveStateHome } from '../../../src/lib/index.ts';

/** The record of installs over a real state home: its mode, how it is written, and that a damaged file is never "empty". */

const homes = new Set<string>();

async function fixture(): Promise<{
  readonly file: string;
  readonly directory: string;
  readonly store: FileCatalogInstallStore;
}> {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-catalog-installs-'));
  homes.add(home);
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  return {
    file: join(paths.state, CATALOG_INSTALLS_DOCUMENT),
    directory: paths.state,
    store: new FileCatalogInstallStore(paths, new StateFileSystem(paths)),
  };
}

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

const SOME_STATE: CatalogInstallState = {
  ...EMPTY_CATALOG_INSTALL_STATE,
  publishers: { [`fy_daemon_${'A'.repeat(43)}`]: '2026-10-31T09:00:00.000Z' },
  pins: { [`cat_${'c'.repeat(22)}`]: `fy_daemon_${'A'.repeat(43)}` },
  revisions: { [`cat_${'c'.repeat(22)}`]: 4 },
};

describe('FileCatalogInstallStore', () => {
  it('should answer the empty state for a state home that never installed anything', async () => {
    // Arrange
    const { store } = await fixture();

    // Act
    const state = await store.read();

    // Assert
    should(state).deepEqual(EMPTY_CATALOG_INSTALL_STATE);
  });

  it('should read back exactly what it wrote, in a file only its owner can read or write', async () => {
    // Arrange
    const { store, file } = await fixture();

    // Act
    await store.write(SOME_STATE);
    const read = await store.read();
    const mode = (await stat(file)).mode & 0o777;

    // Assert
    should(read).deepEqual(SOME_STATE);
    should(mode).equal(0o600);
  });

  it('should write by temp and rename, leaving no temporary file beside the record', async () => {
    // Arrange
    const { store, directory } = await fixture();

    // Act
    await store.write(SOME_STATE);
    await store.write(EMPTY_CATALOG_INSTALL_STATE);

    // Assert
    should((await readdir(directory)).filter(name => name.includes('catalog-installs'))).deepEqual([
      CATALOG_INSTALLS_DOCUMENT,
    ]);
    should(await readFile(join(directory, CATALOG_INSTALLS_DOCUMENT), 'utf8')).equal(
      `${JSON.stringify(EMPTY_CATALOG_INSTALL_STATE, undefined, 2)}\n`,
    );
  });

  it('should refuse a file that is not JSON, without echoing any of it', async () => {
    // Arrange
    const { store, file } = await fixture();
    await store.write(EMPTY_CATALOG_INSTALL_STATE);
    await writeFile(file, '{ secret-looking-garbage', 'utf8');

    // Act
    const error = await store.read().then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    // Assert
    should(error).be.instanceOf(CatalogInstallStateError);
    should((error as Error).message).equal(`${CATALOG_INSTALLS_DOCUMENT} is not JSON, so no install was changed`);
    should((error as Error).message).not.containEql('secret-looking-garbage');
  });

  it('should refuse JSON that is not a record of installs, rather than call it empty', async () => {
    // Arrange
    const { store, file } = await fixture();
    await store.write(EMPTY_CATALOG_INSTALL_STATE);
    await writeFile(file, JSON.stringify({ schemaVersion: 2, installs: [] }), 'utf8');

    // Act
    const error = await store.read().then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    // Assert
    should(error).be.instanceOf(CatalogInstallStateError);
    should((error as Error).message).equal(
      `${CATALOG_INSTALLS_DOCUMENT} is not a record of installs this daemon writes, so no install was changed`,
    );
  });
});
