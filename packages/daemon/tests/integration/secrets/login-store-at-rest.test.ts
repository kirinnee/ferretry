import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, it } from 'bun:test';
import { PutLoginEntryRequestSchema } from '@ferretry/protocol';
import should from 'should';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import {
  FileLoginIndexStore,
  FileSecretDocumentStore,
  FileSecretKey,
  LOGIN_INDEX_DOCUMENT,
  LOGIN_SECRETS_DOCUMENT,
  WebCryptoSecretCipher,
} from '../../../src/adapters/secrets/index.ts';
import {
  createFoundationPaths,
  type FoundationPaths,
  LoginDirectory,
  LoginVault,
  resolveStateHome,
  SecretStoreError,
} from '../../../src/lib/index.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

/**
 * Saved logins against a REAL filesystem and REAL WebCrypto: the index holds no value, the sealed document
 * holds none in clear, both are `0600`, and a damaged index is refused rather than read as empty. Every case
 * allocates a throwaway state home; nothing here resolves the developer's real `~/.ferretry`.
 */

const PASSWORD = 'hunter2-UNIQUE-login-password';
const SEED = 'JBSWY3DPEHPK3PXP';
const CLOCK = { now: () => '2026-10-31T09:00:00.000Z' };

async function store(label: string): Promise<{
  readonly paths: FoundationPaths;
  readonly directory: LoginDirectory;
  readonly vault: LoginVault;
  readonly index: FileLoginIndexStore;
}> {
  const home = await tempDirectory(label);
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  const files = new StateFileSystem(paths);
  await files.ensureDirectory(paths.home, 0o700);
  await files.ensureDirectory(paths.state, 0o700);
  await files.ensureDirectory(paths.temporary, 0o700);
  const index = new FileLoginIndexStore(paths, files);
  const sealed = new FileSecretDocumentStore(paths, files, LOGIN_SECRETS_DOCUMENT);
  const cipher = new WebCryptoSecretCipher(new FileSecretKey(sealed.keyFile, files));
  return {
    paths,
    index,
    directory: new LoginDirectory(index, sealed, cipher, CLOCK),
    vault: new LoginVault(index, sealed, cipher),
  };
}

afterAll(async () => {
  await cleanupTempDirectories();
});

describe('saved logins at rest', () => {
  it('should keep no value in either file, keep both 0600, and still type the value back', async () => {
    const { paths, directory, vault } = await store('login-at-rest');
    await directory.put(
      'GITHUB_KIRINNEE',
      PutLoginEntryRequestSchema.parse({
        label: 'GitHub (kirinnee)',
        match: ['github.com'],
        username: 'kirinnee',
        password: PASSWORD,
        totp: { seed: SEED },
        totpAcknowledged: true,
      }),
    );
    const indexPath = join(paths.state, LOGIN_INDEX_DOCUMENT);
    const sealedPath = join(paths.state, LOGIN_SECRETS_DOCUMENT);

    for (const path of [indexPath, sealedPath]) {
      const text = await readFile(path, 'utf8');
      should(text).not.containEql(PASSWORD);
      should(text).not.containEql(SEED);
      should((await stat(path)).mode & 0o777).equal(0o600);
    }
    should(await readFile(indexPath, 'utf8')).containEql('kirinnee');
    should(await vault.fill('GITHUB_KIRINNEE', 'password', 0)).equal(PASSWORD);
    should(await vault.fill('GITHUB_KIRINNEE', 'totp', 59_000)).match(/^[0-9]{6}$/u);
  });

  it('should answer nothing for a home that never saved a login, and refuse an index it cannot read', async () => {
    const { paths, index } = await store('login-index-damaged');
    should(await index.read()).be.undefined();
    await writeFile(join(paths.state, LOGIN_INDEX_DOCUMENT), '{ not json');
    should(await index.read().catch(error => error)).be.instanceOf(SecretStoreError);
    await writeFile(join(paths.state, LOGIN_INDEX_DOCUMENT), JSON.stringify({ v: 2, entries: {} }));
    should(await index.read().catch(error => error)).be.instanceOf(SecretStoreError);
  });
});
