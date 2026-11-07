import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, it } from 'bun:test';
import type { Clock } from '@ferretry/kernel/contract';
import { state } from '@ferretry/kernel/host';
import should from 'should';
import { SECRET_CIPHER_ALGORITHM, VaultFile, VaultKeyFile } from '../../../../contract/index.ts';
import {
  FileSecretDocumentStore,
  parseVaultDocument,
  SECRETS_DOCUMENT,
  SECRETS_KEY,
} from '../../../../daemon/adapters/secrets/file-secret-document-store.ts';
import { kernelSealedFiles, type SealedFiles } from '../../../../daemon/adapters/secrets/kernel-sealed-files.ts';
import { FileSecretKey, WebCryptoSecretCipher } from '../../../../daemon/adapters/secrets/webcrypto-secret-cipher.ts';
import { SecretDirectory, SecretStoreError, SecretVault } from '../../../../daemon/lib/secrets/index.ts';

/**
 * The vault against a REAL filesystem (the kernel's own state port over a temp home) and REAL WebCrypto (today's
 * `tests/integration/secrets/vault-at-rest.test.ts`, moved onto the kernel).
 *
 * The claims worth an integration tier are the ones a fake cipher cannot make: that the file on disk does not contain
 * the value, that `0600` and the separate key file are what lands, and (spine D16) that the sealed format is today's
 * byte for byte. Every case allocates a throwaway home; nothing resolves a real `~/.ferretry`.
 */

const TOKEN = 'sk-live-super-secret-value-0123456789';
const CLOCK = { now: () => '2026-01-01T00:00:00.000Z' } as unknown as Clock;
const homes: string[] = [];

/** The vault's own folder in a fresh home: `state/vault/`. */
interface Vault {
  readonly folder: string;
  readonly files: SealedFiles;
  readonly documents: FileSecretDocumentStore;
  readonly directory: SecretDirectory;
  readonly vault: SecretVault;
}

function over(folder: string, files: SealedFiles): Vault {
  const documents = new FileSecretDocumentStore(files);
  const cipher = new WebCryptoSecretCipher(new FileSecretKey(files));
  return {
    folder,
    files,
    documents,
    directory: new SecretDirectory(documents, cipher, CLOCK),
    vault: new SecretVault(documents, cipher),
  };
}

function statePort(home: string) {
  return state.createStatePort({
    home,
    pluginId: 'vault',
    fs: state.createNodeHostFs(),
    files: [VaultFile, VaultKeyFile],
  });
}

async function vault(label: string): Promise<Vault> {
  const home = await mkdtemp(join(tmpdir(), `fy-vault-${label}-`));
  homes.push(home);
  return over(state.pluginStateRoot(home, 'vault'), kernelSealedFiles(statePort(home)));
}

/** A fresh set of adapters over the same home, as a restart builds. */
function reopen(v: Vault): Vault {
  const home = v.folder.replace(/\/state\/vault$/u, '');
  return over(v.folder, kernelSealedFiles(statePort(home)));
}

afterAll(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
});

describe('the vault at rest', () => {
  it('S34 never writes the value into the document; the key rests in its own file, both 0600', async () => {
    // Arrange
    const { folder, directory } = await vault('ciphertext');

    // Act
    await directory.put('TOKEN', TOKEN);
    const onDisk = await readFile(join(folder, SECRETS_DOCUMENT), 'utf8');

    // Assert — the file that travels is not the value, and either file leaking alone fails safe.
    should(onDisk).not.containEql(TOKEN);
    should(onDisk).containEql(SECRET_CIPHER_ALGORITHM);
    should((await stat(join(folder, SECRETS_DOCUMENT))).mode & 0o777).equal(0o600);
    should((await stat(join(folder, SECRETS_KEY))).mode & 0o777).equal(0o600);
  });

  it('should round-trip a value through real AES-GCM', async () => {
    // Arrange
    const { directory, vault: opened } = await vault('roundtrip');

    // Act
    await directory.put('TOKEN', TOKEN);
    await directory.put('OTHER', 'another-long-enough-value');

    // Assert
    const values = await opened.values();
    should(values.get('TOKEN')).equal(TOKEN);
    should(values.get('OTHER')).equal('another-long-enough-value');
  });

  it("D16 seals exactly as today: AES-256-GCM under the key file's 32 bytes, the name as AAD, base64 fields", async () => {
    // Arrange
    const { folder, directory } = await vault('byte-format');
    await directory.put('TOKEN', TOKEN);

    // Act — open the entry by hand with WebCrypto, from nothing but the two files and today's rules.
    const keyText = await readFile(join(folder, SECRETS_KEY), 'utf8');
    const document = JSON.parse(await readFile(join(folder, SECRETS_DOCUMENT), 'utf8')) as {
      readonly format: number;
      readonly cipher: string;
      readonly entries: Record<string, { iv: string; ciphertext: string; createdAt: string; updatedAt: string }>;
    };
    const entry = document.entries.TOKEN;
    should(entry).not.be.undefined();
    const key = await crypto.subtle.importKey(
      'raw',
      Buffer.from(keyText.trim(), 'base64'),
      { name: 'AES-GCM' },
      false,
      ['decrypt'],
    );
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: Buffer.from(entry?.iv ?? '', 'base64'),
        additionalData: new TextEncoder().encode('TOKEN'),
      },
      key,
      Buffer.from(entry?.ciphertext ?? '', 'base64'),
    );

    // Assert — the key file is today's text (base64 of 32 bytes and one newline); the envelope is `format: 1`.
    should(keyText).match(/^[A-Za-z0-9+/]{43}=\n$/u);
    should(Buffer.from(keyText.trim(), 'base64').length).equal(32);
    should(document.format).equal(1);
    should(document.cipher).equal('AES-256-GCM');
    should(Buffer.from(entry?.iv ?? '', 'base64').length).equal(12);
    should(new TextDecoder().decode(plain)).equal(TOKEN);
  });

  it("D16 opens an entry sealed by today's daemon, moved byte for byte under the new envelope", async () => {
    // Arrange — today's `secrets.json` entry and `secrets.key`, written by hand with today's algorithm; the only
    // change an out-of-product move makes is the envelope key `v` → `format`.
    const { folder, vault: opened } = await vault('moved');
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt']);
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('MOVED') },
      key,
      new TextEncoder().encode(TOKEN),
    );
    const entry = {
      iv: Buffer.from(iv).toString('base64'),
      ciphertext: Buffer.from(new Uint8Array(sealed)).toString('base64'),
      createdAt: '2026-03-01T00:00:00.000Z',
      updatedAt: '2026-03-01T00:00:00.000Z',
    };
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await writeFile(join(folder, SECRETS_KEY), `${Buffer.from(raw).toString('base64')}\n`, { mode: 0o600 });
    await writeFile(
      join(folder, SECRETS_DOCUMENT),
      `${JSON.stringify({ format: 1, cipher: 'AES-256-GCM', entries: { MOVED: entry } }, undefined, 2)}\n`,
      { mode: 0o600 },
    );

    // Act
    const values = await opened.values();

    // Assert — no decrypt-and-re-encrypt was needed to move it.
    should(values.get('MOVED')).equal(TOKEN);
  });

  it('S141 refuses ciphertext whose key file has gone (key_missing), never an empty vault', async () => {
    // Arrange
    const { folder, directory } = await vault('key-gone');
    await directory.put('TOKEN', TOKEN);

    // Act
    await rm(join(folder, SECRETS_KEY));

    // Assert — a person told "no secrets" here would write new ones over entries still on disk.
    await directory.list().then(
      () => should.fail('', '', 'a vault with no key must refuse'),
      (error: unknown) => should((error as SecretStoreError).failure).equal('key_missing'),
    );
  });

  it('should refuse an entry relabelled under another name', async () => {
    // Arrange — the name is authenticated data, so staging ciphertext moved under a production name must not open.
    const { folder, documents, directory, vault: opened } = await vault('relabel');
    await directory.put('STAGING_KEY', TOKEN);
    const document = parseVaultDocument(await readFile(join(folder, SECRETS_DOCUMENT), 'utf8'));
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
    const { folder, directory, vault: opened } = await vault('wrong-key');
    await directory.put('TOKEN', TOKEN);

    // Act — a key of the right SHAPE but the wrong bytes.
    await writeFile(join(folder, SECRETS_KEY), `${Buffer.alloc(32, 7).toString('base64')}\n`);

    // Assert
    await opened.values().then(
      () => should.fail('', '', 'a wrong key must refuse'),
      (error: unknown) => should((error as SecretStoreError).failure).equal('undecipherable'),
    );
  });

  it('should refuse a key file that is present and the wrong size', async () => {
    // Arrange — silently treating it as absent would mint a fresh key and orphan every secret.
    const v = await vault('short-key');
    await v.directory.put('TOKEN', TOKEN);
    await writeFile(join(v.folder, SECRETS_KEY), 'dHJ1bmNhdGVk\n');

    // Act / Assert
    await reopen(v)
      .vault.values()
      .then(
        () => should.fail('', '', 'a malformed key must refuse'),
        (error: unknown) => should((error as SecretStoreError).failure).equal('undecipherable'),
      );
  });

  it('should answer an empty vault for a state home that has never held a secret', async () => {
    // Arrange / Act / Assert — absent is a fact; damaged is not.
    const { directory, vault: opened, documents } = await vault('fresh');
    should(await documents.read()).be.undefined();
    should(await directory.list()).deepEqual([]);
    should([...(await opened.values())]).deepEqual([]);
  });

  it('should survive a daemon restart: a new store over the same home opens the same values', async () => {
    // Arrange
    const v = await vault('restart');
    await v.directory.put('TOKEN', TOKEN);

    // Act / Assert
    should((await reopen(v).vault.values()).get('TOKEN')).equal(TOKEN);
  });
});

describe('opening the vault', () => {
  /** The sealed files, with every read of the key counted. */
  async function counted(label: string) {
    const v = await vault(label);
    let keyReads = 0;
    const files: SealedFiles = {
      readText: async file => {
        if (file === 'key') keyReads += 1;
        return await v.files.readText(file);
      },
      writeText: async (file, text) => await v.files.writeText(file, text),
    };
    const counting = over(v.folder, files);
    const cipher = new WebCryptoSecretCipher(new FileSecretKey(files));
    return { ...counting, cipher, reads: () => keyReads, reset: () => (keyReads = 0) };
  }

  it('should read the key once for the whole vault, not once per entry', async () => {
    // Arrange — every masking of served text opens the vault, and each entry used to re-read the key.
    const c = await counted('one-key-read');
    for (const name of ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX']) await c.directory.put(name, `${name}-${TOKEN}`);
    c.reset();

    // Act
    const values = await c.vault.values();

    // Assert — one for the document's own "is the key still there" check, one to open every entry.
    should(values.size).equal(6);
    should(values.get('FOUR')).equal(`FOUR-${TOKEN}`);
    should(c.reads()).equal(2);
  });

  it('should open nothing, and read no key, for a vault with no entries', async () => {
    // Arrange
    const c = await counted('open-nothing');

    // Act
    const opened = await c.cipher.openAll({});

    // Assert
    should(opened.size).equal(0);
    should(c.reads()).equal(0);
  });
});

describe('reading a damaged document', () => {
  const cases: readonly [string, string][] = [
    ['not JSON at all', 'this is not json'],
    ['a JSON array', '[]'],
    ['a document with no format', '{"cipher":"AES-256-GCM","entries":{}}'],
    ['a document with no entry table', '{"format":1,"cipher":"AES-256-GCM"}'],
    ['an entry that is not an object', '{"format":1,"cipher":"AES-256-GCM","entries":{"A":"nope"}}'],
    ['an entry missing its sealed fields', '{"format":1,"cipher":"AES-256-GCM","entries":{"A":{"iv":"x"}}}'],
  ];

  for (const [label, raw] of cases) {
    it(`S141 refuses ${label} rather than read it as an empty vault`, () => {
      // Arrange / Act / Assert
      should(() => parseVaultDocument(raw)).throw(SecretStoreError);
    });
  }

  it('should never quote the file body in the refusal', () => {
    // Arrange / Act
    let message = '';
    try {
      parseVaultDocument(`{"format":1,"cipher":"AES-256-GCM","entries":{"A":{"iv":"${TOKEN}"}}}`);
    } catch (error) {
      message = (error as Error).message;
    }

    // Assert — a parser that echoes its input is a habit that leaks the moment the shape changes.
    should(message).not.containEql(TOKEN);
  });
});
