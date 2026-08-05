import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, it } from 'bun:test';
import should from 'should';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import {
  FileSecretDocumentStore,
  FileSecretKey,
  parseVaultDocument,
  SECRET_CIPHER_ALGORITHM,
  SECRETS_DOCUMENT,
  SECRETS_KEY,
  WebCryptoSecretCipher,
} from '../../../src/adapters/secrets/index.ts';
import {
  createFoundationPaths,
  resolveStateHome,
  SecretDirectory,
  SecretStoreError,
  SecretVault,
  type FoundationPaths,
} from '../../../src/lib/index.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

/**
 * The vault against a REAL filesystem and REAL WebCrypto.
 *
 * The two claims worth an integration tier are the ones a fake cipher cannot make: that the file on
 * disk does not contain the value, and that the `0600` mode and the separate key file are actually
 * what lands. Everything else about the vault's decisions is proved in the unit tier.
 *
 * Every case allocates a throwaway state home. Nothing here resolves the developer's real
 * `~/.ferretry`.
 */

const TOKEN = 'sk-live-super-secret-value-0123456789';
const CLOCK = { now: () => '2026-01-01T00:00:00.000Z' };

interface Vault {
  readonly paths: FoundationPaths;
  readonly documents: FileSecretDocumentStore;
  readonly directory: SecretDirectory;
  readonly vault: SecretVault;
}

async function vault(label: string): Promise<Vault> {
  const home = await tempDirectory(label);
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  const files = new StateFileSystem(paths);
  await files.ensureDirectory(paths.home, 0o700);
  await files.ensureDirectory(paths.state, 0o700);
  await files.ensureDirectory(paths.temporary, 0o700);
  const documents = new FileSecretDocumentStore(paths, files);
  const cipher = new WebCryptoSecretCipher(new FileSecretKey(documents.keyFile, files));
  return {
    paths,
    documents,
    directory: new SecretDirectory(documents, cipher, CLOCK),
    vault: new SecretVault(documents, cipher),
  };
}

afterAll(async () => {
  await cleanupTempDirectories();
});

describe('the vault at rest', () => {
  it('should never write the value into the document', async () => {
    // Arrange
    const { paths, directory } = await vault('vault-ciphertext');

    // Act
    await directory.put('TOKEN', TOKEN);
    const onDisk = await readFile(join(paths.state, SECRETS_DOCUMENT), 'utf8');

    // Assert — this is the whole point of encrypting at rest: the file that travels is not the value.
    should(onDisk).not.containEql(TOKEN);
    should(onDisk).containEql(SECRET_CIPHER_ALGORITHM);
  });

  it('should round-trip a value through real AES-GCM', async () => {
    // Arrange
    const { directory, vault: opened } = await vault('vault-roundtrip');

    // Act
    await directory.put('TOKEN', TOKEN);
    await directory.put('OTHER', 'another-long-enough-value');

    // Assert
    const values = await opened.values();
    should(values.get('TOKEN')).equal(TOKEN);
    should(values.get('OTHER')).equal('another-long-enough-value');
  });

  it('should keep the value and the key in separate files, both owner-only', async () => {
    // Arrange
    const { paths, directory } = await vault('vault-modes');

    // Act
    await directory.put('TOKEN', TOKEN);

    // Assert — one file travelling without the other is the accident this protects against.
    should((await stat(join(paths.state, SECRETS_DOCUMENT))).mode & 0o777).equal(0o600);
    should((await stat(join(paths.state, SECRETS_KEY))).mode & 0o777).equal(0o600);
  });

  it('should refuse ciphertext whose key file has gone, rather than report an empty vault', async () => {
    // Arrange
    const { paths, directory } = await vault('vault-key-gone');
    await directory.put('TOKEN', TOKEN);

    // Act
    await rm(join(paths.state, SECRETS_KEY));

    // Assert — a person told "no secrets" here would write new ones over entries still on disk.
    await directory.list().then(
      () => should.fail('', '', 'a vault with no key must refuse'),
      (error: unknown) => should((error as SecretStoreError).failure).equal('key_missing'),
    );
  });

  it('should refuse an entry relabelled under another name', async () => {
    // Arrange — the name is authenticated data, so moving staging ciphertext under a production name
    // must fail rather than hand a staging credential to something that asked for production.
    const { paths, documents, directory, vault: opened } = await vault('vault-relabel');
    await directory.put('STAGING_KEY', TOKEN);
    const document = parseVaultDocument(await readFile(join(paths.state, SECRETS_DOCUMENT), 'utf8'));
    const moved = document.entries.STAGING_KEY;
    should(moved).not.be.undefined();
    if (moved === undefined) return;
    await documents.write({ ...document, entries: { PRODUCTION_KEY: moved } });

    // Act / Assert
    await opened.values().then(
      () => should.fail('', '', 'a relabelled entry must not open'),
      (error: unknown) => should((error as SecretStoreError).failure).equal('undecipherable'),
    );
  });

  it('should refuse a replaced key rather than serve nonsense', async () => {
    // Arrange
    const { paths, directory, vault: opened } = await vault('vault-wrong-key');
    await directory.put('TOKEN', TOKEN);

    // Act — a key of the right SHAPE but the wrong bytes.
    await writeFile(join(paths.state, SECRETS_KEY), `${Buffer.alloc(32, 7).toString('base64')}\n`);

    // Assert
    await opened.values().then(
      () => should.fail('', '', 'a wrong key must refuse'),
      (error: unknown) => should((error as SecretStoreError).failure).equal('undecipherable'),
    );
  });

  it('should refuse a key file that is present and the wrong size', async () => {
    // Arrange — silently treating it as absent would mint a fresh key and orphan every secret.
    const { paths, directory } = await vault('vault-short-key');
    await directory.put('TOKEN', TOKEN);
    await writeFile(join(paths.state, SECRETS_KEY), 'dHJ1bmNhdGVk\n');

    // Act / Assert
    await new SecretVault(
      new FileSecretDocumentStore(
        createFoundationPaths(resolveStateHome({ fyHome: paths.home, homeDirectory: paths.home })),
        new StateFileSystem(paths),
      ),
      new WebCryptoSecretCipher(new FileSecretKey(join(paths.state, SECRETS_KEY), new StateFileSystem(paths))),
    )
      .values()
      .then(
        () => should.fail('', '', 'a malformed key must refuse'),
        (error: unknown) => should((error as SecretStoreError).failure).equal('undecipherable'),
      );
  });

  it('should answer an empty vault for a state home that has never held a secret', async () => {
    // Arrange / Act / Assert — absent is a fact; damaged is not.
    const { directory, vault: opened, documents } = await vault('vault-fresh');
    should(await documents.read()).be.undefined();
    should(await directory.list()).deepEqual([]);
    should([...(await opened.values())]).deepEqual([]);
  });

  it('should survive a daemon restart: a new store over the same home opens the same values', async () => {
    // Arrange
    const { paths, directory } = await vault('vault-restart');
    await directory.put('TOKEN', TOKEN);

    // Act — a fresh set of adapters over the same directory, as a restart builds.
    const files = new StateFileSystem(paths);
    const documents = new FileSecretDocumentStore(paths, files);
    const reopened = new SecretVault(documents, new WebCryptoSecretCipher(new FileSecretKey(documents.keyFile, files)));

    // Assert
    should((await reopened.values()).get('TOKEN')).equal(TOKEN);
  });
});

describe('reading a damaged document', () => {
  const cases: readonly [string, string][] = [
    ['not JSON at all', 'this is not json'],
    ['a JSON array', '[]'],
    ['a document with no version', '{"cipher":"AES-256-GCM","entries":{}}'],
    ['a document with no entry table', '{"v":1,"cipher":"AES-256-GCM"}'],
    ['an entry that is not an object', '{"v":1,"cipher":"AES-256-GCM","entries":{"A":"nope"}}'],
    ['an entry missing its sealed fields', '{"v":1,"cipher":"AES-256-GCM","entries":{"A":{"iv":"x"}}}'],
  ];

  for (const [label, raw] of cases) {
    it(`should refuse ${label} rather than read it as an empty vault`, () => {
      // Arrange / Act / Assert
      should(() => parseVaultDocument(raw)).throw(SecretStoreError);
    });
  }

  it('should never quote the file body in the refusal', () => {
    // Arrange / Act
    let message = '';
    try {
      parseVaultDocument(`{"v":1,"cipher":"AES-256-GCM","entries":{"A":{"iv":"${TOKEN}"}}}`);
    } catch (error) {
      message = (error as Error).message;
    }

    // Assert — a parser that echoes its input is a habit that leaks the moment the shape changes.
    should(message).not.containEql(TOKEN);
  });
});
