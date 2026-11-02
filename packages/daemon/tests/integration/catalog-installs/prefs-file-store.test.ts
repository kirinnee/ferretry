import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  CATALOG_INSTALL_PREFS_DOCUMENT,
  FileCatalogInstallPrefsStore,
} from '../../../src/adapters/catalog-installs/prefs-file-store.ts';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { type CatalogInstallPrefsState, EMPTY_CATALOG_INSTALL_PREFS } from '../../../src/lib/catalog-installs/prefs.ts';
import { CatalogInstallStateError } from '../../../src/lib/catalog-installs/store.ts';
import { createFoundationPaths, resolveStateHome } from '../../../src/lib/index.ts';

/** The record of stay / skip choices over a real state home: its mode, how it is written, and that a damaged file is never "empty". */

const homes = new Set<string>();

async function fixture(): Promise<{
  readonly file: string;
  readonly directory: string;
  readonly store: FileCatalogInstallPrefsStore;
}> {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-catalog-prefs-'));
  homes.add(home);
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  return {
    file: join(paths.state, CATALOG_INSTALL_PREFS_DOCUMENT),
    directory: paths.state,
    store: new FileCatalogInstallPrefsStore(paths, new StateFileSystem(paths)),
  };
}

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

const SOME: CatalogInstallPrefsState = {
  schemaVersion: 1,
  installs: { [`cin_${'i'.repeat(22)}`]: { hold: true, skippedVersion: 3 } },
};

const failure = async (work: Promise<unknown>): Promise<unknown> =>
  await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

describe('FileCatalogInstallPrefsStore', () => {
  it('should answer no choices for a state home that never made one', async () => {
    const { store } = await fixture();
    should(await store.read()).deepEqual(EMPTY_CATALOG_INSTALL_PREFS);
  });

  it('should read back what it wrote, in a file only its owner can read or write', async () => {
    const { store, file } = await fixture();
    await store.write(SOME);
    should(await store.read()).deepEqual(SOME);
    should((await stat(file)).mode & 0o777).equal(0o600);
  });

  it('should write by temp and rename, leaving no temporary file beside it', async () => {
    const { store, directory } = await fixture();
    await store.write(SOME);
    await store.write(EMPTY_CATALOG_INSTALL_PREFS);
    should((await readdir(directory)).filter(name => name.includes('prefs'))).deepEqual([
      CATALOG_INSTALL_PREFS_DOCUMENT,
    ]);
    should(await readFile(join(directory, CATALOG_INSTALL_PREFS_DOCUMENT), 'utf8')).equal(
      `${JSON.stringify(EMPTY_CATALOG_INSTALL_PREFS, undefined, 2)}\n`,
    );
  });

  it('should refuse a file that is not JSON, without echoing any of it', async () => {
    const { store, file } = await fixture();
    await store.write(EMPTY_CATALOG_INSTALL_PREFS);
    await writeFile(file, '{ secret-looking-garbage', 'utf8');
    const error = await failure(store.read());
    should(error).be.instanceOf(CatalogInstallStateError);
    should((error as Error).message).equal(
      `${CATALOG_INSTALL_PREFS_DOCUMENT} is not JSON, so no preference was changed`,
    );
    should((error as Error).message).not.containEql('secret-looking-garbage');
  });

  it('should refuse JSON that is not a record of choices, rather than call it empty', async () => {
    const { store, file } = await fixture();
    await store.write(EMPTY_CATALOG_INSTALL_PREFS);
    await writeFile(file, JSON.stringify({ schemaVersion: 2, installs: {} }), 'utf8');
    const error = await failure(store.read());
    should(error).be.instanceOf(CatalogInstallStateError);
    should((error as Error).message).containEql('is not a record of preferences this daemon writes');
  });
});
