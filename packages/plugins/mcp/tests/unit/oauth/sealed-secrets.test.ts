import { describe, expect, test } from 'bun:test';
import type { StatePort } from '@ferretry/kernel/contract';
import type { DaemonContext } from '@ferretry/kernel/manifest';
import { state } from '@ferretry/kernel/host';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import {
  defineSealedDocument,
  type SealedDocumentDef,
  type SealedDocumentHandle,
  type SealedDocumentsApi,
  SealedDocumentsPort,
  type SecretName,
} from '@ferretry/core-vault/contract';
import { FakeSealedDocuments, FakeVault } from '@ferretry/core-vault/contract/testing';
import { MCP_OAUTH_SECRETS } from '../../../contract/index.ts';
import { sealedMcpOAuthSecrets } from '../../../daemon/adapters/oauth-sealed-secrets.ts';
import daemon from '../../../daemon/index.ts';
import manifest from '../../../manifest.ts';

/**
 * The sign-in's refresh tokens and client secrets (today's `state/mcp-oauth-secrets.json`) as MCP's own sealed
 * document: declared `store: 'secret'`, carried byte for byte, opened only through the Vault's sealed-document port
 * and only by the sign-in service. Every value here is a made-up fixture string; no real home is read.
 */

const HOME = '/home/fy';

/**
 * Today's `mcp-oauth-secrets.json` (rebuild-ref `bb89d054d`, sealed by today's `WebCryptoSecretCipher` under a FIXED
 * FAKE key and IV — the same fixture the Vault's D16 test opens), as the out-of-product carry-over writes it: the
 * envelope key `v` renamed to `format`, every entry untouched. Sealed value: `fixture-refresh-token-not-a-real-one`.
 */
const CARRIED =
  '{\n  "format": 1,\n  "cipher": "AES-256-GCM",\n  "entries": {\n    "MCP_DOCS_EXAMPLE_REFRESH": {\n      "iv": "oKGio6Slpqeoqaqr",\n      "ciphertext": "He0LfZgPyvhm40wiT2yEbW9BVAv+yowLUdV4flBTSeDrU2K8O5/wYQqc7yvju/B7me0eng==",\n      "createdAt": "2026-03-01T00:00:00.000Z",\n      "updatedAt": "2026-03-01T00:00:00.000Z"\n    }\n  }\n}\n';

const mcpState = (fs: state.MemoryHostFs): StatePort =>
  state.createStatePort({ home: HOME, pluginId: 'mcp', fs, files: manifest.data.state });

/** A sealed-document port that records every open and every value read, over the in-memory fake. */
class RecordingSealedDocuments implements SealedDocumentsApi {
  readonly opened: { own: StatePort; document: SealedDocumentDef }[] = [];
  readonly reads: string[] = [];
  readonly #inner = new FakeSealedDocuments();

  open(own: StatePort, document: SealedDocumentDef): SealedDocumentHandle {
    this.opened.push({ own, document });
    const handle = this.#inner.open(own, document);
    return {
      ...handle,
      get: async name => {
        this.reads.push(name);
        return await handle.get(name);
      },
      getBytes: async name => {
        this.reads.push(name);
        return await handle.getBytes(name);
      },
    };
  }
}

describe('MCP sign-in secrets: the declaration', () => {
  test("S174 today's mcp-oauth-secrets.json is declared store: 'secret', 0600, in MCP's own state", () => {
    expect(MCP_OAUTH_SECRETS.kind).toBe('sealed-document');
    expect(MCP_OAUTH_SECRETS.state).toMatchObject({
      name: 'oauth-secrets',
      path: 'oauth-secrets.json',
      store: 'secret',
      format: 1,
      mode: 0o600,
    });
    // Today's vault-shaped document: the name alone is the AAD and entries are stamped.
    expect(MCP_OAUTH_SECRETS.additionalData).toBe('');
    expect(MCP_OAUTH_SECRETS.stamped).toBe(true);
    // Exactly the declaration the Vault's D16 test opens today's bytes through.
    expect(MCP_OAUTH_SECRETS).toEqual(defineSealedDocument({ name: 'oauth-secrets', path: 'oauth-secrets.json' }));
    expect(manifest.data.state).toContain(MCP_OAUTH_SECRETS.state);
    expect(manifest.needs.sealed).toBe(SealedDocumentsPort);
  });

  test('S174 no route, verb or config names the sealed document', () => {
    const surface = JSON.stringify([manifest.actions.routes, manifest.actions.cli, manifest.data.config]);
    expect(/oauth-secrets|sealed/u.test(surface)).toBe(false);
  });
});

describe('MCP sign-in secrets: carried byte for byte (spine D16)', () => {
  test("D16 today's mcp-oauth-secrets.json, moved to state/mcp/oauth-secrets.json, reads back byte for byte", async () => {
    const fs = state.createMemoryHostFs();
    fs.seed(`${HOME}/state/mcp/oauth-secrets.json`, CARRIED, 0o600);

    const read = await mcpState(fs).read(MCP_OAUTH_SECRETS.state);

    // The kernel never parses a secret file: what it hands the Vault is the carried bytes, untouched.
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error('unreadable');
    expect(new TextDecoder().decode(read.value as Uint8Array)).toBe(CARRIED);
    expect(fs.snapshot().get(`${HOME}/state/mcp/oauth-secrets.json`)).toBe(CARRIED);
  });

  test('D16 the kernel will not update a sealed document in place (never re-sealed)', async () => {
    const fs = state.createMemoryHostFs();
    fs.seed(`${HOME}/state/mcp/oauth-secrets.json`, CARRIED, 0o600);
    const own = mcpState(fs);
    await expect(own.update(MCP_OAUTH_SECRETS.state as never, () => new Uint8Array() as never)).rejects.toThrow();
    expect(fs.snapshot().get(`${HOME}/state/mcp/oauth-secrets.json`)).toBe(CARRIED);
  });
});

describe('MCP sign-in secrets: the use path', () => {
  const REFRESH = 'MCP_DOCS_EXAMPLE_REFRESH' as SecretName;
  const VALUE = 'fixture-refresh-token-not-a-real-one';

  test("S8 the internal store is MCP's own sealed document, over MCP's own state port, and nothing else", async () => {
    const sealed = new RecordingSealedDocuments();
    const own = mcpState(state.createMemoryHostFs());
    const internal = sealedMcpOAuthSecrets(sealed, own);

    await internal.put(REFRESH, VALUE);

    expect(sealed.opened).toHaveLength(1);
    expect(sealed.opened[0]?.own).toBe(own);
    expect(sealed.opened[0]?.document).toBe(MCP_OAUTH_SECRETS);
    expect(await sealed.open(own, MCP_OAUTH_SECRETS).get(REFRESH)).toBe(VALUE);
  });

  test('S174 listing answers names only; a value is opened only when the sign-in spends it', async () => {
    const sealed = new RecordingSealedDocuments();
    const internal = sealedMcpOAuthSecrets(sealed, mcpState(state.createMemoryHostFs()));
    await internal.put(REFRESH, VALUE);

    const listed = await internal.list();
    expect(listed).toEqual([{ name: REFRESH }]);
    expect(JSON.stringify(listed).includes(VALUE)).toBe(false);
    expect(sealed.reads).toEqual([]);

    // Today's use: the service opens the internal value to send the refresh token to its provider.
    expect(await internal.value(REFRESH)).toBe(VALUE);
    expect(sealed.reads).toEqual([REFRESH]);

    expect(await internal.remove(REFRESH)).toBe(true);
    expect(await internal.list()).toEqual([]);
    expect(await internal.remove(REFRESH)).toBe(false);
  });

  test('S174 spending one value opens only that entry, never the other servers’ tokens or client secrets', async () => {
    const sealed = new RecordingSealedDocuments();
    const internal = sealedMcpOAuthSecrets(sealed, mcpState(state.createMemoryHostFs()));
    const spent = 'MCP_B_REFRESH' as SecretName;
    await internal.put('MCP_A_REFRESH' as SecretName, 'fixture-a-refresh-not-real');
    await internal.put(spent, 'fixture-b-refresh-not-real');
    await internal.put('MCP_C_CLIENT' as SecretName, 'fixture-c-client-secret-not-real');

    expect((await internal.list()).map(entry => entry.name).sort()).toEqual([
      'MCP_A_REFRESH',
      'MCP_B_REFRESH',
      'MCP_C_CLIENT',
    ]);
    expect(sealed.reads).toEqual([]);

    expect(await internal.value(spent)).toBe('fixture-b-refresh-not-real');
    expect(sealed.reads).toEqual([spent]);
    expect(await internal.value('MCP_D_REFRESH' as SecretName)).toBeUndefined();
    expect(sealed.reads).toEqual([spent, 'MCP_D_REFRESH']);
  });

  test('S8 the daemon half opens only MCP_OAUTH_SECRETS over its own state, and its port has no value getter', async () => {
    const sealed = new RecordingSealedDocuments();
    const own = mcpState(state.createMemoryHostFs());
    const half = daemon.build?.({
      manifest,
      needs: { ferrets: new FakeFerrets(), vault: new FakeVault(), sealed },
      uses: {
        claudeCode: { current: () => undefined },
        codex: { current: () => undefined },
        projects: { current: () => undefined },
      },
      hooks: {} as never,
      kernel: { state: own, config: { collection: () => new Map() } } as unknown as DaemonContext<
        typeof manifest
      >['kernel'],
    } as DaemonContext<typeof manifest>);

    expect(sealed.opened.map(entry => entry.document)).toEqual([MCP_OAUTH_SECRETS]);
    expect(sealed.opened[0]?.own).toBe(own);
    // Building opens no value; the provided port answers inventories, checks and connection facts only.
    expect(sealed.reads).toEqual([]);
    expect(Object.keys(half?.provides?.mcp ?? {}).sort()).toEqual(['check', 'connections', 'inventory']);
    expect(Object.keys(half?.routes ?? {}).some(key => /secret|sealed/u.test(key))).toBe(false);
  });
});
