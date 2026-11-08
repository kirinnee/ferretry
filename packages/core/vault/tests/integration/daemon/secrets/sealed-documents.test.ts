import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { Clock, StatePort } from '@ferretry/kernel/contract';
import { state } from '@ferretry/kernel/host';
import {
  defineSealedDocument,
  MAX_SECRETS_PER_DAEMON,
  type SealedName,
  SealedDocumentsPort,
  VaultFile,
  VaultKeyFile,
} from '../../../../contract/index.ts';
import { sealedDocumentsConformance } from '../../../../contract/testing/index.ts';
import { FileSecretDocumentStore } from '../../../../daemon/adapters/secrets/file-secret-document-store.ts';
import { KernelSealedDocuments } from '../../../../daemon/adapters/secrets/kernel-sealed-documents.ts';
import { kernelSealedFiles } from '../../../../daemon/adapters/secrets/kernel-sealed-files.ts';
import { FileSecretKey, WebCryptoSecretCipher } from '../../../../daemon/adapters/secrets/webcrypto-secret-cipher.ts';
import { SecretStoreError } from '../../../../daemon/lib/secrets/types.ts';
import { SecretVault } from '../../../../daemon/lib/secrets/vault.ts';
import manifest from '../../../../manifest.ts';
import {
  linkKeys,
  loginSecrets,
  mcpOAuthSecrets,
  secretsKey,
  TODAY_FIXED_IV,
  TODAY_INSTANT,
} from './sealed-documents-today.fixture.ts';

/**
 * The sealed-document port (contract change C) over the kernel's REAL state port (on the in-memory host fs) and real
 * WebCrypto. Proves: a plugin's own round trip; another plugin's documents out of reach; the bytes are today's (a
 * document sealed by today's code opens, and the port seals the very same bytes given today's key and IV); the port
 * is not the secret store; nothing is logged and no failure names a value.
 */

const HOME = '/home/fy';
const CLOCK = { now: () => TODAY_INSTANT } as unknown as Clock;

/** Today's three separate sealed documents, each now its owner's own `store: 'secret'` file. */
const MCP_SECRETS = defineSealedDocument({ name: 'oauth-secrets', path: 'oauth-secrets.json' });
const LOGIN_SECRETS = defineSealedDocument({ name: 'login-secrets', path: 'login-secrets.json' });
const LINK_KEYS = defineSealedDocument({
  name: 'link-keys',
  path: 'link-keys.json',
  additionalData: 'catalog-link:',
  stamped: false,
});

interface World {
  readonly fs: state.MemoryHostFs;
  readonly key: FileSecretKey;
  readonly vaultFiles: ReturnType<typeof kernelSealedFiles>;
  readonly port: KernelSealedDocuments;
  plugin(id: string, ...documents: (typeof MCP_SECRETS)[]): StatePort;
}

function world(iv?: () => Uint8Array): World {
  const fs = state.createMemoryHostFs();
  const vaultFiles = kernelSealedFiles(
    state.createStatePort({ home: HOME, pluginId: 'vault', fs, files: [VaultFile, VaultKeyFile] }),
  );
  const key = new FileSecretKey(vaultFiles);
  return {
    fs,
    key,
    vaultFiles,
    port: new KernelSealedDocuments(key, CLOCK, iv),
    plugin: (id, ...documents) =>
      state.createStatePort({ home: HOME, pluginId: id, fs, files: documents.map(document => document.state) }),
  };
}

const text = (fs: state.MemoryHostFs, path: string): string | undefined => fs.snapshot().get(`${HOME}/state/${path}`);

/** The one change a move makes: today's envelope key `v` becomes `format`. Nothing inside an entry is touched. */
const moved = (today: string): string => today.replace('{\n  "v": 1,', '{\n  "format": 1,');

sealedDocumentsConformance('KernelSealedDocuments', () => {
  const w = world();
  return {
    port: w.port,
    mine: w.plugin('mcp', MCP_SECRETS),
    theirs: w.plugin('catalogs', MCP_SECRETS),
    document: MCP_SECRETS,
  };
});

describe('sealed documents: scope', () => {
  test('the port is a daemon-side port the vault provides (never a route)', () => {
    expect(manifest.provides.sealedDocuments).toBe(SealedDocumentsPort);
    const routes = manifest.actions.routes.map(route => JSON.stringify(route));
    expect(routes.some(route => /\/sealed|sealed-doc/u.test(route))).toBe(false);
  });

  test("another plugin's document is refused by the kernel: a plugin can only name what it declared", async () => {
    const w = world();
    const catalogs = w.plugin('catalogs', LINK_KEYS);
    await w.port.open(catalogs, LINK_KEYS).put('lnk_one' as SealedName, 'link-key-of-catalogs');
    const mcp = w.plugin('mcp', MCP_SECRETS);
    const intruder = w.port.open(mcp, LINK_KEYS);

    await expect(intruder.get('lnk_one' as SealedName)).rejects.toThrow(/did not declare/u);
    await expect(intruder.delete('lnk_one' as SealedName)).rejects.toThrow(/did not declare/u);
    await expect(intruder.names()).rejects.toThrow(/did not declare/u);
    expect(await w.port.open(catalogs, LINK_KEYS).get('lnk_one' as SealedName)).toBe('link-key-of-catalogs');
  });

  test("a document rests sealed, 0600, in its owner's own folder; the key stays in the vault's", async () => {
    const w = world();
    await w.port
      .open(w.plugin('mcp', MCP_SECRETS), MCP_SECRETS)
      .put('MCP_X_REFRESH' as SealedName, 'refresh-value-123');

    const document = text(w.fs, 'mcp/oauth-secrets.json');
    expect(document).toBeDefined();
    expect(document?.includes('refresh-value-123')).toBe(false);
    expect(w.fs.modeOf(`${HOME}/state/mcp/oauth-secrets.json`)).toBe(0o600);
    expect(text(w.fs, 'vault/vault.key')).toMatch(/^[A-Za-z0-9+/]{43}=\n$/u);
    expect(text(w.fs, 'mcp/vault.key')).toBeUndefined();
  });

  test('it is not the secret store: `${secret:…}` and use never see a sealed document', async () => {
    const w = world();
    await w.port
      .open(w.plugin('mcp', MCP_SECRETS), MCP_SECRETS)
      .put('MCP_X_REFRESH' as SealedName, 'refresh-value-123');

    const vault = new SecretVault(new FileSecretDocumentStore(w.vaultFiles), new WebCryptoSecretCipher(w.key));
    expect((await vault.values()).has('MCP_X_REFRESH')).toBe(false);
    expect(text(w.fs, 'vault/vault.json')).toBeUndefined();
  });

  test("a document refuses a NEW name once it holds the daemon's limit, yet still lets one be replaced", async () => {
    const w = world();
    const own = w.port.open(w.plugin('mcp', MCP_SECRETS), MCP_SECRETS);
    await own.put('HELD_0' as SealedName, 'fixture-held-value');
    // Fill the document to the limit by copying the one sealed entry: the cap is counted before anything is opened.
    const path = `${HOME}/state/mcp/oauth-secrets.json`;
    const document = JSON.parse(w.fs.snapshot().get(path) ?? '{}') as { entries: Record<string, unknown> };
    const held = document.entries.HELD_0;
    for (let index = 1; index < MAX_SECRETS_PER_DAEMON; index += 1) document.entries[`HELD_${index}`] = held;
    w.fs.seed(path, `${JSON.stringify(document, undefined, 2)}\n`, 0o600);
    const full = w.fs.snapshot().get(path);

    const refused = await own.put('ONE_MORE' as SealedName, 'fixture-one-more').then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(refused).toBeInstanceOf(SecretStoreError);
    expect((refused as SecretStoreError).failure).toBe('full');
    expect((refused as SecretStoreError).message).toBe(`this daemon already holds ${MAX_SECRETS_PER_DAEMON} secrets`);
    expect(w.fs.snapshot().get(path)).toBe(full);
    await own.put('HELD_0' as SealedName, 'fixture-held-value-replaced');
    expect(await own.get('HELD_0' as SealedName)).toBe('fixture-held-value-replaced');
    expect(await own.names()).toHaveLength(MAX_SECRETS_PER_DAEMON);
  });
});

describe('sealed documents: D16 a lost key never orphans existing entries', () => {
  for (const document of [MCP_SECRETS, LINK_KEYS]) {
    for (const name of ['EXISTING', 'NEW'] as const) {
      test(`D16 put ${name} refuses key_missing without minting or writing ${document.state.path}`, async () => {
        const w = world();
        const own = w.port.open(w.plugin('plugin', document), document);
        await own.put('EXISTING' as SealedName, 'fixture-existing-value');
        const before = text(w.fs, `plugin/${document.state.path}`);
        expect(before).toBeDefined();
        await w.fs.remove(`${HOME}/state/vault/vault.key`);
        const ensure = spyOn(w.key, 'ensure');
        try {
          await expect(own.put(name as SealedName, 'fixture-new-value')).rejects.toMatchObject({
            failure: 'key_missing',
          });
          expect(ensure).not.toHaveBeenCalled();
          expect(text(w.fs, 'vault/vault.key')).toBeUndefined();
          expect(text(w.fs, `plugin/${document.state.path}`)).toBe(before);
          await expect(own.names()).rejects.toMatchObject({ failure: 'key_missing' });
        } finally {
          ensure.mockRestore();
        }
      });
    }
  }
});

describe('sealed documents: D16 bytes are today’s', () => {
  const cases = [
    {
      title: 'mcp-oauth-secrets.json',
      plugin: 'mcp',
      document: MCP_SECRETS,
      today: mcpOAuthSecrets,
      name: 'MCP_DOCS_EXAMPLE_REFRESH',
      value: 'fixture-refresh-token-not-a-real-one',
    },
    {
      title: 'login-secrets.json',
      plugin: 'accounts',
      document: LOGIN_SECRETS,
      today: loginSecrets,
      name: 'ACCOUNT_FIXTURE_PASSWORD',
      value: 'fixture-password-not-real-42',
    },
    {
      title: 'catalogs/link-keys.json',
      plugin: 'catalogs',
      document: LINK_KEYS,
      today: linkKeys,
      name: 'lnk_AAAAAAAAAAAAAAAAAAAAAA',
      value: 'fixture-link-key-not-real',
    },
  ] as const;

  for (const c of cases) {
    test(`D16 opens today's ${c.title}, moved byte for byte under the format 1 envelope`, async () => {
      const w = world();
      w.fs.seed(`${HOME}/state/vault/vault.key`, secretsKey, 0o600);
      w.fs.seed(`${HOME}/state/${c.plugin}/${c.document.state.path}`, moved(c.today), 0o600);

      const opened = await w.port.open(w.plugin(c.plugin, c.document), c.document).get(c.name as SealedName);

      expect(opened).toBe(c.value);
    });

    test(`D16 seals ${c.title} to the very bytes today's code wrote, given today's key and IV`, async () => {
      const w = world(() => TODAY_FIXED_IV);
      w.fs.seed(`${HOME}/state/vault/vault.key`, secretsKey, 0o600);

      await w.port.open(w.plugin(c.plugin, c.document), c.document).put(c.name as SealedName, c.value);

      expect(text(w.fs, `${c.plugin}/${c.document.state.path}`)).toBe(moved(c.today));
    });
  }

  test('an entry moved under another name, or into another document flavour, does not open', async () => {
    const w = world();
    w.fs.seed(`${HOME}/state/vault/vault.key`, secretsKey, 0o600);
    const relabelled = moved(mcpOAuthSecrets).replace('MCP_DOCS_EXAMPLE_REFRESH', 'MCP_OTHER_REFRESH');
    w.fs.seed(`${HOME}/state/mcp/oauth-secrets.json`, relabelled, 0o600);
    // The link key's AAD carries `catalog-link:`; filed in a name-only document it must not open.
    w.fs.seed(`${HOME}/state/accounts/login-secrets.json`, moved(linkKeys), 0o600);

    await expect(
      w.port.open(w.plugin('mcp', MCP_SECRETS), MCP_SECRETS).get('MCP_OTHER_REFRESH' as SealedName),
    ).rejects.toThrow(/did not authenticate/u);
    await expect(
      w.port.open(w.plugin('accounts', LOGIN_SECRETS), LOGIN_SECRETS).get('lnk_AAAAAAAAAAAAAAAAAAAAAA' as SealedName),
    ).rejects.toThrow(/did not authenticate/u);
  });
});

describe('sealed documents: nothing logged, no value in a failure', () => {
  const spies: ReturnType<typeof spyOn>[] = [];
  beforeEach(() => {
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const)
      spies.push(spyOn(console, method).mockImplementation(() => undefined));
  });
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  test('a round trip, a tampered entry and a lost key log nothing and never name the value', async () => {
    const VALUE = 'client-secret-do-not-print-0123';
    const w = world();
    const own = w.port.open(w.plugin('mcp', MCP_SECRETS), MCP_SECRETS);
    await own.put('MCP_X_CLIENT' as SealedName, VALUE);
    expect(await own.get('MCP_X_CLIENT' as SealedName)).toBe(VALUE);

    const path = `${HOME}/state/mcp/oauth-secrets.json`;
    const document = JSON.parse(w.fs.snapshot().get(path) ?? '{}') as {
      entries: Record<string, { ciphertext: string }>;
    };
    const entry = document.entries.MCP_X_CLIENT;
    if (entry !== undefined) entry.ciphertext = Buffer.from('tampered-bytes-here').toString('base64');
    w.fs.seed(path, `${JSON.stringify(document, undefined, 2)}\n`, 0o600);
    const tampered = await own.get('MCP_X_CLIENT' as SealedName).then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    await own.put('MCP_Y_CLIENT' as SealedName, VALUE);
    await w.fs.remove(`${HOME}/state/vault/vault.key`);
    const keyGone = await own.get('MCP_Y_CLIENT' as SealedName).then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    expect(tampered?.message).toMatch(/did not authenticate/u);
    expect(keyGone?.message).toMatch(/vault key is gone/u);
    for (const error of [tampered, keyGone])
      expect(`${error?.message} ${String(error?.stack)}`.includes(VALUE)).toBe(false);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('sealed documents: a document that is not what it was declared to be', () => {
  const PATH = `${HOME}/state/mcp/oauth-secrets.json`;

  test('a document not declared as a secret file is refused before anything is read', () => {
    const w = world();
    const plain = { ...MCP_SECRETS, state: { ...MCP_SECRETS.state, store: 'json' } } as unknown as typeof MCP_SECRETS;
    expect(() => w.port.open(w.plugin('mcp', MCP_SECRETS), plain)).toThrow(
      "sealed document oauth-secrets is not declared with store: 'secret'",
    );
  });

  test('a file that is not JSON is unreadable, and says so without quoting it', async () => {
    const w = world();
    await w.fs.writeAtomic(PATH, 'sk-live-not-json-at-all', 0o600);
    const own = w.port.open(w.plugin('mcp', MCP_SECRETS), MCP_SECRETS);
    const error = await own.names().catch((thrown: unknown) => thrown as SecretStoreError);
    expect(error).toBeInstanceOf(SecretStoreError);
    expect(error).toMatchObject({ failure: 'unreadable' });
    expect(String((error as Error).message)).toBe('oauth-secrets.json is not JSON');
    expect(String((error as Error).message)).not.toContain('sk-live');
  });

  test('JSON of another shape is unreadable too, never an empty document', async () => {
    const w = world();
    await w.fs.writeAtomic(PATH, '{"format":2,"cipher":"ROT13","entries":{}}', 0o600);
    const own = w.port.open(w.plugin('mcp', MCP_SECRETS), MCP_SECRETS);
    await expect(own.names()).rejects.toMatchObject({
      failure: 'unreadable',
      message: 'oauth-secrets.json is not a sealed document of format 1 and AES-256-GCM',
    });
  });

  test('an entry whose key goes missing between the document check and the open is key_missing, not nothing', async () => {
    const w = world();
    const own = w.port.open(w.plugin('mcp', MCP_SECRETS), MCP_SECRETS);
    await own.put('MCP_X_REFRESH' as SealedName, 'refresh-value-123');
    let reads = 0;
    const vanishing = {
      ensure: async () => await w.key.ensure(),
      // The first read is the document's own "is the key still there" check; the open finds it gone.
      read: async () => (++reads === 1 ? await w.key.read() : undefined),
    } as unknown as FileSecretKey;
    const port = new KernelSealedDocuments(vanishing, CLOCK);
    await expect(
      port.open(w.plugin('mcp', MCP_SECRETS), MCP_SECRETS).get('MCP_X_REFRESH' as SealedName),
    ).rejects.toMatchObject({
      failure: 'key_missing',
      message: 'the vault key is gone, so oauth-secrets.json entry MCP_X_REFRESH cannot be opened',
    });
  });
});
