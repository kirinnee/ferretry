import { afterEach, beforeEach, expect, test } from 'bun:test';
import { McpOAuthStateFileSchema } from '@ferretry/plugin-mcp/contract';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mcpStep, V5_MCP_OAUTH } from '../../src/steps/mcp.ts';
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

async function everything(root: string): Promise<string> {
  const names = await readdir(root, { recursive: true }).catch(() => []);
  const texts = await Promise.all(
    names.map(async name => ((await stat(join(root, name))).isFile() ? readFile(join(root, name), 'utf8') : '')),
  );
  return texts.join('\n');
}

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

test('the sealed refresh tokens are left unopened in v4, byte for byte, and appear nowhere in v5 or the report', async () => {
  await f.put('state/mcp-oauth.json', { v: 1, registrations: {}, connections: { linear: connection } });
  const sealed = join(f.from, 'state/mcp-oauth-secrets.json');
  await writeFile(sealed, FAKE_SEALED, { mode: 0o600 });
  const before = await readFile(sealed);
  const report = await mcpStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.note).toBe(
    'state/mcp-oauth-secrets.json left unopened in the v4 backup (no v5 file declared for it yet)',
  );
  expect(report.notCarried[0]?.what).toContain('state/mcp-oauth-secrets.json');
  expect(report.sealed).toEqual([]);
  expect((await readFile(sealed)).equals(before)).toBe(true);
  const output = `${await everything(f.to)}\n${JSON.stringify(report)}`;
  for (const fake of ['FAKE-SEALED-CIPHERTEXT', 'FAKE-IV', 'MCP_FAKE_REFRESH']) expect(output).not.toContain(fake);
  expect((await readdir(join(f.to, 'state/mcp'))).sort()).toEqual(['oauth.json']);
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
