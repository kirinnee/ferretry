import { afterEach, beforeEach, expect, test } from 'bun:test';
import { McpOAuthStateFileSchema } from '@ferretry/plugin-mcp/contract';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SealedDocumentSchema } from '@ferretry/core-vault/contract';
import { STEPS } from '../../src/steps/index.ts';
import { mcpStep, V5_MCP_OAUTH, V5_MCP_OAUTH_SECRETS } from '../../src/steps/mcp.ts';
import { V5_VAULT_FILE, V5_VAULT_KEY_FILE, vaultStep } from '../../src/steps/secrets.ts';
import { AT, fixture } from './ferret-fixture.ts';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

/** A FAKE sealed document (not a real ciphertext): it must stay where it is, unopened, and reach no output. */
const FAKE_SEALED =
  '{"v":1,"cipher":"AES-256-GCM","entries":{"MCP_FAKE_REFRESH":{"iv":"FAKE-IV","ciphertext":"FAKE-SEALED-CIPHERTEXT"}}}\n';

const registration = {
  issuer: 'https://auth.example.com',
  redirectUri: 'https://app.example.com/oauth/callback',
  clientId: 'fake-client-id',
  hasClientSecret: true,
  tokenAuth: 'client_secret_post',
};
const connection = {
  serverUrl: 'https://mcp.example.com/mcp',
  issuer: 'https://auth.example.com',
  redirectUri: 'https://app.example.com/oauth/callback',
  tokenEndpoint: 'https://auth.example.com/token',
  clientId: 'fake-client-id',
  hasClientSecret: false,
  clientSecretRef: 'MCP_FAKE_CLIENT_SECRET',
  resource: 'https://mcp.example.com/mcp',
  scope: 'read',
  signedInAt: AT,
  expiresAt: '2026-11-01T01:00:00.000Z',
  renewable: true,
};

test('the sign-in state keeps every record and component name; only the envelope changes', async () => {
  await f.put('state/mcp-oauth.json', {
    v: 1,
    registrations: { linear: [registration] },
    connections: { linear: connection, notion: { ...connection, needsSignIn: true } },
  });
  const report = await mcpStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.kept).toEqual([
    { what: 'MCP sign-ins (connections)', count: 2 },
    { what: 'MCP client registrations', count: 1 },
  ]);
  const written = JSON.parse(await readFile(join(f.to, V5_MCP_OAUTH), 'utf8')) as Record<string, unknown>;
  expect(Object.keys(written)[0]).toBe('format');
  expect(McpOAuthStateFileSchema.parse(written)).toEqual({
    format: 1,
    registrations: { linear: [registration] },
    connections: { linear: connection, notion: { ...connection, needsSignIn: true } },
  } as never);
  expect((await stat(join(f.to, V5_MCP_OAUTH))).mode & 0o777).toBe(0o600);
});

// ── the sealed half (lead decision 2026-11-07): moved with the vault key, still opened by it ─────────────────────────

/** v4's sealing (`WebCryptoSecretCipher`): AES-256-GCM, a 96-bit IV, the entry name as the AAD. FAKE values only. */
async function seal(key: CryptoKey, name: string, value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(name) },
      key,
      new TextEncoder().encode(value),
    ),
  );
  return {
    iv: Buffer.from(iv).toString('base64'),
    ciphertext: Buffer.from(ciphertext).toString('base64'),
    createdAt: AT,
    updatedAt: AT,
  };
}
async function open(key: CryptoKey, name: string, entry: { iv: string; ciphertext: string }) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: Buffer.from(entry.iv, 'base64'), additionalData: new TextEncoder().encode(name) },
    key,
    Buffer.from(entry.ciphertext, 'base64'),
  );
  return new TextDecoder().decode(plain);
}
const importKey = async (base64: string) =>
  await crypto.subtle.importKey('raw', Buffer.from(base64.trim(), 'base64'), 'AES-GCM', false, ['encrypt', 'decrypt']);

test('MCP refresh tokens move with the vault key: the moved key opens both moved documents', async () => {
  const keyText = `${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')}\n`;
  const v4Key = await importKey(keyText);
  await mkdir(join(f.from, 'state'), { recursive: true, mode: 0o700 });
  await writeFile(join(f.from, 'state/secrets.key'), keyText, { mode: 0o600 });
  await writeFile(
    join(f.from, 'state/secrets.json'),
    JSON.stringify({
      v: 1,
      cipher: 'AES-256-GCM',
      entries: { FAKE_TOKEN: await seal(v4Key, 'FAKE_TOKEN', 'FAKE-VAULT-VALUE') },
    }),
    { mode: 0o600 },
  );
  await writeFile(
    join(f.from, 'state/mcp-oauth-secrets.json'),
    JSON.stringify({
      v: 1,
      cipher: 'AES-256-GCM',
      entries: { MCP_FAKE_REFRESH: await seal(v4Key, 'MCP_FAKE_REFRESH', 'FAKE-REFRESH-VALUE') },
    }),
    { mode: 0o600 },
  );
  await f.put('state/mcp-oauth.json', { v: 1, registrations: {}, connections: { linear: connection } });
  const before = await readFile(join(f.from, 'state/mcp-oauth-secrets.json'));

  // The step table's order: the vault step moves the key once, then MCP moves its sealed document.
  const names = STEPS.map(step => step.id);
  expect(names.indexOf('vault')).toBeLessThan(names.indexOf('mcp'));
  expect((await vaultStep.run(f.ctx())).status).toBe('converted');
  const report = await mcpStep.run(f.ctx());
  expect(report.status).toBe('converted');

  const v5Key = await importKey(await readFile(join(f.to, V5_VAULT_KEY_FILE), 'utf8'));
  const vault = JSON.parse(await readFile(join(f.to, V5_VAULT_FILE), 'utf8'));
  const oauth = SealedDocumentSchema.parse(JSON.parse(await readFile(join(f.to, V5_MCP_OAUTH_SECRETS), 'utf8')));
  expect(await open(v5Key, 'FAKE_TOKEN', vault.entries.FAKE_TOKEN)).toBe('FAKE-VAULT-VALUE');
  expect(await open(v5Key, 'MCP_FAKE_REFRESH', oauth.entries.MCP_FAKE_REFRESH!)).toBe('FAKE-REFRESH-VALUE');
  expect(oauth.format).toBe(1);
  expect((await stat(join(f.to, V5_MCP_OAUTH_SECRETS))).mode & 0o777).toBe(0o600);
  expect((await stat(join(f.to, V5_VAULT_KEY_FILE))).mode & 0o777).toBe(0o600);
  expect(report.sealed).toEqual([
    { file: V5_MCP_OAUTH_SECRETS, bytes: (await stat(join(f.to, V5_MCP_OAUTH_SECRETS))).size },
  ]);
  // The v4 backup is untouched, and no value or ciphertext reaches the report.
  expect((await readFile(join(f.from, 'state/mcp-oauth-secrets.json'))).equals(before)).toBe(true);
  const shown = JSON.stringify(report);
  for (const value of ['FAKE-REFRESH-VALUE', oauth.entries.MCP_FAKE_REFRESH!.ciphertext])
    expect(shown).not.toContain(value);
});

test('a sealed MCP document with no vault key to open it fails, naming the files only', async () => {
  await mkdir(join(f.from, 'state'), { recursive: true, mode: 0o700 });
  await writeFile(join(f.from, 'state/mcp-oauth-secrets.json'), FAKE_SEALED, { mode: 0o600 });
  const report = await mcpStep.run(f.ctx());
  expect(report.status).toBe('failed');
  expect(report.note).toContain('state/secrets.key');
  for (const fake of ['FAKE-SEALED-CIPHERTEXT', 'FAKE-IV']) expect(JSON.stringify(report)).not.toContain(fake);
});

test('a damaged document fails naming the file, never its content (v4 raised on it too)', async () => {
  await f.put('state/mcp-oauth.json', { v: 2, registrations: {}, connections: {}, FAKE: 'FAKE-CONTENT' });
  const report = await mcpStep.run(f.ctx());
  expect(report.status).toBe('failed');
  expect(report.note).toBe('state/mcp-oauth.json: is not a v4 MCP sign-in document (v: 1)');
  expect(JSON.stringify(report)).not.toContain('FAKE-CONTENT');
});

test('a record v5 refuses fails naming its component, never its values', async () => {
  await f.put('state/mcp-oauth.json', {
    v: 1,
    registrations: {},
    connections: { linear: { ...connection, clientSecretRef: 'fake_lowercase_name', extra: 'FAKE-EXTRA' } },
  });
  const report = await mcpStep.run(f.ctx());
  expect(report.status).toBe('failed');
  expect(report.note).toBe('state/mcp-oauth.json: connections of component "linear" does not fit the v5 record');
  expect(JSON.stringify(report)).not.toContain('FAKE-EXTRA');
  expect(await stat(join(f.to, V5_MCP_OAUTH)).catch(() => undefined)).toBeUndefined();
});

test('a home without MCP sign-ins converts to nothing; a dry run writes nothing', async () => {
  const empty = await mcpStep.run(f.ctx());
  expect(empty.status).toBe('converted');
  expect(empty.note).toBe('this home has no MCP sign-ins');
  await f.put('state/mcp-oauth.json', { v: 1, registrations: {}, connections: { linear: connection } });
  const report = await mcpStep.run(f.ctx(true));
  expect(report.status).toBe('converted');
  expect(report.note).toBe('dry run: nothing written');
  expect(await stat(f.to).catch(() => undefined)).toBeUndefined();
});
