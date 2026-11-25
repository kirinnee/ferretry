/**
 * MERGE BAR: Claude stays connected across the move. The converter's real output (the Connector step and the accepted
 * record, on one writer, in the converter's order) is seeded into a REAL 5.0 `fyd` on a temp home, and a real HTTP client
 * talks to the connector's own listener. Nothing here is the owner's: the v4 tree is synthetic, the address is a fake
 * loopback origin on a test port, and every token is a fake value of which v4 would have stored only the digest.
 *
 * The 5.0 code is imported by path, like the other tests of this package that need a 5.0 reader (this package is not a
 * workspace member). Port 7482 (test daemons own 7480-7499).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { dryConfigsOf } from '../../src/convert.ts';
import { acceptedConfigStep } from '../../src/steps/accepted-config.ts';
import { connectorStep } from '../../src/steps/connector.ts';
import { fixture } from './ferret-fixture.ts';

const repo = join(import.meta.dir, '../../../..');
const { bootRealDaemon } = await import(repo + '/packages/plugins/connector/tests/support/daemon.ts');

const PORT = 7482;
const ORIGIN = `http://127.0.0.1:${String(PORT)}`;
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const pad = (prefix: string, name: string): string => `${prefix}${name}`.padEnd(50, 'x');
const T = {
  access: pad('fyc_at_', 'LIVE-ACCESS-'),
  refresh: pad('fyc_rt_', 'LIVE-REFRESH-'),
  legacyUsed: pad('fyc_rt_', 'LEGACY-USED-'),
  firstUsed: pad('fyc_rt_', 'FIRST-USED-'),
  stranger: pad('fyc_at_', 'STRANGER-'),
  secondRefresh: pad('fyc_rt_', 'SECOND-LIVE-'),
};
const CLIENT = 'fycl_aaaaaaaaaa';
const GRANT = 'cg_liveliveli';
const GRANT_FIRST = 'cg_firstfirst';
const AT = '2026-11-01T00:00:00.000Z';

type RealDaemon = Awaited<ReturnType<typeof bootRealDaemon>>;
let daemon: RealDaemon;
let f: Awaited<ReturnType<typeof fixture>>;

async function filesOf(root: string, folder: string): Promise<[string, string][]> {
  const out: [string, string][] = [];
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else out.push([relative(root, child), await readFile(child, 'utf8')]);
    }
  };
  await walk(join(root, folder));
  return out;
}

beforeAll(async () => {
  f = await fixture();
  const now = Date.now();
  const token = (value: string, expiresAt: number) => ({
    digest: sha(value),
    expiresAt,
    audience: `${ORIGIN}/mcp`,
    scopes: ['fleet:read', 'fleet:write'],
  });
  await f.put('config/daemon.json', {
    connector: { enabled: true, publicUrl: ORIGIN, port: PORT, extraRedirectUris: [] },
  });
  await f.put('state/connector/connector.json', {
    version: 1,
    clients: [
      {
        id: CLIENT,
        name: 'Claude',
        redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
        grantTypes: ['authorization_code', 'refresh_token'],
        authMethod: 'none',
        createdAt: AT,
      },
    ],
    grants: [
      {
        id: GRANT,
        clientId: CLIENT,
        clientName: 'Claude',
        redirectHost: 'claude.ai',
        scopes: ['fleet:read', 'fleet:write'],
        createdAt: AT,
        approvedBy: 'device:d1',
        access: [token(T.access, now + 3_000_000)],
        refresh: [token(T.refresh, now + 20 * 86_400_000)],
        // An old file's bare digest: no retry window ever applied to it.
        usedRefresh: [sha(T.legacyUsed)],
      },
      {
        // A first rotation (PR 2550's marker) whose 60 s retry window is long past.
        id: GRANT_FIRST,
        clientId: CLIENT,
        clientName: 'Claude',
        redirectHost: 'claude.ai',
        scopes: ['fleet:read'],
        createdAt: AT,
        approvedBy: 'device:d1',
        access: [],
        refresh: [token(T.secondRefresh, now + 20 * 86_400_000)],
        usedRefresh: [
          {
            digest: sha(T.firstUsed),
            expiresAt: now + 20 * 86_400_000,
            rotatedAt: now - 86_400_000,
            successors: { access: sha('gone-access'), refresh: sha(T.secondRefresh) },
            retryable: true,
          },
        ],
      },
    ],
  });
  const steps = [connectorStep];
  const ctx = { ...f.ctx(), dryConfigs: dryConfigsOf(f.from, f.to, undefined, steps) };
  expect((await connectorStep.run(ctx)).status).toBe('converted');
  expect((await acceptedConfigStep.run(ctx)).status).toBe('converted');
  const seed = Object.fromEntries([...(await filesOf(f.to, 'config')), ...(await filesOf(f.to, 'state'))]);
  daemon = await bootRealDaemon(seed);
}, 240_000);
afterAll(async () => {
  await daemon?.dispose();
  await f?.clean();
});

const mcp = (bearer: string) =>
  fetch(`${ORIGIN}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: '{}',
  });
const refresh = (value: string) =>
  fetch(`${ORIGIN}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '203.0.113.50' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT, refresh_token: value }).toString(),
  });

test('the converted connector is ON at its own address with no confirmation asked, and the grant is there', async () => {
  const status = await daemon.fy(['connector', '--json']);
  expect(status.code, status.err).toBe(0);
  expect(status.json).toMatchObject({
    enabled: true,
    switchedOn: true,
    publicUrlSource: 'configured',
    mcpUrl: `${ORIGIN}/mcp`,
    grants: [
      expect.objectContaining({ id: GRANT, clientName: 'Claude' }),
      expect.objectContaining({ id: GRANT_FIRST }),
    ],
  });
});

test('the access token v4 minted is still accepted (the tools themselves are the MCP unit); a stranger is not', async () => {
  expect((await mcp(T.access)).status).not.toBe(401);
  expect((await mcp(T.stranger)).status).toBe(401);
});

test('the refresh token v4 minted still refreshes, and the old one is then spent', async () => {
  const rotated = await refresh(T.refresh);
  expect(rotated.status).toBe(200);
  const body = (await rotated.json()) as { access_token: string; refresh_token: string };
  expect((await mcp(body.access_token)).status).not.toBe(401);
  expect(body.refresh_token).not.toBe(T.refresh);
});

test("a v4 rotated-away token still means theft: presenting a bare digest's token revokes the grant", async () => {
  expect((await refresh(T.legacyUsed)).status).toBe(400);
  expect((await mcp(T.access)).status).toBe(401);
  const after = await daemon.fy(['connector', '--json']);
  expect(after.json).toMatchObject({
    grants: [
      expect.objectContaining({ id: GRANT, revokedAt: expect.any(String) }),
      expect.objectContaining({ id: GRANT_FIRST }),
    ],
  });
  expect((after.json as { grants: { id: string; revokedAt?: string }[] }).grants[1]?.revokedAt).toBeUndefined();
});

test('a first rotation whose retry window has passed also revokes: the marker is carried, and a window is only time', async () => {
  expect((await refresh(T.firstUsed)).status).toBe(400);
  const after = await daemon.fy(['connector', '--json']);
  expect(
    (after.json as { grants: { id: string; revokedAt?: string }[] }).grants.find(g => g.id === GRANT_FIRST)?.revokedAt,
  ).toEqual(expect.any(String));
});
