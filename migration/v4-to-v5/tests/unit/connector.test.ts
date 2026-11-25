import { afterEach, beforeEach, expect, test } from 'bun:test';
import { ConnectorConfigSchema, ConnectorStateFileSchema } from '@ferretry/plugin-connector/contract';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { connectorStep, V5_CONNECTOR_CALLS, V5_CONNECTOR_STATE } from '../../src/steps/connector.ts';
import { daemonSettingsStep } from '../../src/steps/daemon-settings.ts';
import { STEPS } from '../../src/steps/index.ts';
import { CONFIG_TARGETS, configOwner } from '../../src/v5/targets.ts';
import { AT, fixture } from './ferret-fixture.ts';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

const NOW = new Date('2026-11-25T12:00:00.000Z');
const DAY = 86_400_000;
const FUTURE = NOW.getTime() + 20 * DAY;
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
// Fake token values: only their digests ever reach a v4 file, and none of these may reach any output.
const FAKE = { access: 'fyc_at_FAKE-ACCESS-0001', refresh: 'fyc_rt_FAKE-REFRESH-0001', secret: 'FAKE-CLIENT-SECRET' };
const ORIGIN = 'https://ferretry.atomi.cloud';
const CLIENT_A = 'fycl_aaaaaaaaaa';
const CLIENT_B = 'fycl_bbbbbbbbbb';
const GRANT_LIVE = 'cg_liveliveli';
const GRANT_REVOKED = 'cg_revokedrev';
const token = (value: string, expiresAt = FUTURE) => ({
  digest: sha(value),
  expiresAt,
  audience: `${ORIGIN}/mcp`,
  scopes: ['fleet:read', 'fleet:write'],
});

/** A v4 `connector.json` as v4 (after PR 2550) writes it: two clients, a live grant and a revoked one. */
const v4State = (used: unknown[] = []) => ({
  version: 1,
  clients: [
    {
      id: CLIENT_A,
      name: 'Claude',
      redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
      grantTypes: ['authorization_code', 'refresh_token'],
      authMethod: 'none',
      createdAt: AT,
    },
    {
      id: CLIENT_B,
      name: 'Inspector',
      redirectUris: ['http://localhost:6274/oauth/callback'],
      grantTypes: ['authorization_code'],
      authMethod: 'client_secret_post',
      secretDigest: sha(FAKE.secret),
      createdAt: AT,
    },
  ],
  grants: [
    {
      id: GRANT_LIVE,
      clientId: CLIENT_A,
      clientName: 'Claude',
      redirectHost: 'claude.ai',
      scopes: ['fleet:read', 'fleet:write'],
      createdAt: AT,
      approvedBy: 'device:d1',
      lastUsedAt: AT,
      access: [token(FAKE.access, NOW.getTime() + 600_000)],
      refresh: [token(FAKE.refresh)],
      usedRefresh: used,
    },
    {
      id: GRANT_REVOKED,
      clientId: CLIENT_B,
      clientName: 'Inspector',
      redirectHost: 'localhost',
      scopes: ['fleet:read'],
      createdAt: AT,
      approvedBy: 'host',
      revokedAt: AT,
      access: [],
      refresh: [],
      usedRefresh: [],
    },
  ],
});

const daemon = (connector: unknown) => f.put('config/daemon.json', { connector });
const ctx = (dryRun = false) => ({ ...f.ctx(dryRun), now: () => NOW });
const readState = async () =>
  ConnectorStateFileSchema.parse(JSON.parse(await readFile(join(f.to, V5_CONNECTOR_STATE), 'utf8')));
const exists = (path: string) =>
  stat(join(f.to, path)).then(
    () => true,
    () => false,
  );
const everything = (value: unknown): string => JSON.stringify(value);

test("the owner's block keeps its switch, address, port and redirects, key for key", async () => {
  await daemon({
    enabled: true,
    publicUrl: ORIGIN,
    port: 7461,
    extraRedirectUris: ['http://localhost:6274/oauth/callback'],
  });
  const report = await connectorStep.run(ctx());
  expect(report.status).toBe('converted');
  const text = await readFile(join(f.to, 'config/connector.yaml'), 'utf8');
  expect(ConnectorConfigSchema.parse(parse(text, { version: '1.2' }))).toEqual({
    enabled: true,
    publicUrl: ORIGIN,
    port: 7461,
    extraRedirectUris: ['http://localhost:6274/oauth/callback'],
  });
  expect((await stat(join(f.to, 'config/connector.yaml'))).mode & 0o777).toBe(0o600);
});

test('only the keys the owner wrote are written: v5 defaults are v5 to choose', async () => {
  await daemon({ enabled: false, publicUrl: ORIGIN });
  await connectorStep.run(ctx());
  expect(parse(await readFile(join(f.to, 'config/connector.yaml'), 'utf8'), { version: '1.2' })).toEqual({
    enabled: false,
    publicUrl: ORIGIN,
  });
});

test('the Daemon settings step still reads a daemon.json that carries a connector block (it refused the key before)', async () => {
  await daemon({ enabled: true, publicUrl: ORIGIN });
  const report = await daemonSettingsStep.run(f.ctx());
  expect(report.status, report.note).toBe('converted');
});

test('never wider: a block v5 refuses writes no file, names the key path, never the value, and the sign-ins still move', async () => {
  await daemon({ enabled: true, publicUrl: 'https://ferretry.example/with/a/path', surprise: 'SURPRISE-VALUE' });
  await f.put('state/connector/connector.json', v4State());
  const report = await connectorStep.run(ctx());
  expect(report.status).toBe('converted');
  expect(await exists('config/connector.yaml')).toBe(false);
  expect(report.note).toContain('the connector is off');
  expect(report.note).toContain('connector');
  expect(everything(report)).not.toContain('SURPRISE-VALUE');
  expect(everything(report)).not.toContain('with/a/path');
  expect((await readState()).grants).toHaveLength(2);
});

test('a block that is not an object is refused the same way', async () => {
  await daemon('on');
  const report = await connectorStep.run(ctx());
  expect(report.status).toBe('converted');
  expect(await exists('config/connector.yaml')).toBe(false);
  expect(report.notCarried.some(item => item.what.includes('connector'))).toBe(true);
});

test('clients, grants, live token digests and the revoked grant move unchanged in v5 shape', async () => {
  await f.put('state/connector/connector.json', v4State());
  const report = await connectorStep.run(ctx());
  expect(report.status, report.note).toBe('converted');
  const text = await readFile(join(f.to, V5_CONNECTOR_STATE), 'utf8');
  expect(Object.keys(JSON.parse(text) as object)[0]).toBe('format');
  const state = await readState();
  expect(state.clients.map(client => client.id)).toEqual([CLIENT_A, CLIENT_B]);
  expect(state.clients[1]?.secretDigest).toBe(sha(FAKE.secret));
  const [live, revoked] = state.grants;
  expect(live?.access[0]?.digest).toBe(sha(FAKE.access));
  expect(live?.refresh[0]?.digest).toBe(sha(FAKE.refresh));
  expect(live?.access[0]?.audience).toBe(`${ORIGIN}/mcp`);
  expect(revoked).toMatchObject({ id: GRANT_REVOKED, revokedAt: AT, access: [], refresh: [] });
  expect((await stat(join(f.to, V5_CONNECTOR_STATE))).mode & 0o777).toBe(0o600);
  expect((await stat(join(f.to, 'state/connector'))).mode & 0o777).toBe(0o700);
  expect(report.kept).toContainEqual({ what: `connector grants, live (${GRANT_LIVE})`, count: 1 });
  expect(report.kept).toContainEqual({ what: 'connector grants, revoked', count: 1 });
});

test('rotated-away refresh tokens: every v4 spelling becomes the one v5 record, and the first-rotation marker survives only where v4 honoured it', async () => {
  const first = sha('first-rotation');
  const bare = sha('bare-digest');
  const unstamped = sha('no-stamps');
  const retried = sha('already-retried');
  const halfMarked = sha('marker-without-successors');
  const rotatedAt = NOW.getTime() - 5 * DAY;
  await f.put(
    'state/connector/connector.json',
    v4State([
      // 1. a first rotation: the full record, with the retry marker
      {
        digest: first,
        expiresAt: FUTURE,
        rotatedAt,
        successors: { access: sha('s-access'), refresh: sha('s-refresh') },
        retryable: true,
      },
      // 2. an old file's bare digest
      bare,
      // 3. an object from before the 30-day stamp existed
      { digest: unstamped },
      // 4. a retry already spent: no marker, no successors
      { digest: retried, expiresAt: FUTURE, rotatedAt },
      // 5. a marker v4 would not honour (no successors): left off, so a reuse revokes as it did
      { digest: halfMarked, expiresAt: FUTURE, rotatedAt, retryable: true },
    ]),
  );
  const report = await connectorStep.run(ctx());
  expect(report.status, report.note).toBe('converted');
  const used = Object.fromEntries((await readState()).grants[0]?.usedRefresh.map(entry => [entry.digest, entry]) ?? []);
  expect(used[first]).toEqual({
    digest: first,
    expiresAt: FUTURE,
    rotatedAt,
    successors: { access: sha('s-access'), refresh: sha('s-refresh') },
    retryable: true,
  });
  const stamp = NOW.getTime() + 30 * DAY;
  expect(used[bare]).toEqual({ digest: bare, expiresAt: stamp, rotatedAt: NOW.getTime() });
  expect(used[unstamped]).toEqual({ digest: unstamped, expiresAt: stamp, rotatedAt: NOW.getTime() });
  expect(used[retried]).toEqual({ digest: retried, expiresAt: FUTURE, rotatedAt });
  expect(used[halfMarked]).toEqual({ digest: halfMarked, expiresAt: FUTURE, rotatedAt });
  expect(report.kept).toContainEqual({ what: 'rotated-away refresh digests (reuse still revokes)', count: 5 });
});

test('a connector.json v4 would refuse fails the step, writes nothing, and quotes nothing', async () => {
  await writeFile(join(f.from, 'junk'), '');
  await mkdir(join(f.from, 'state/connector'), { recursive: true, mode: 0o700 });
  await writeFile(
    join(f.from, 'state/connector/connector.json'),
    JSON.stringify({ ...v4State(), grants: [{ id: 'cg_SECRET-LOOKING-VALUE' }] }),
    { mode: 0o600 },
  );
  const report = await connectorStep.run(ctx());
  expect(report.status).toBe('failed');
  expect(await exists(V5_CONNECTOR_STATE)).toBe(false);
  expect(everything(report)).not.toContain('SECRET-LOOKING-VALUE');
});

test('the calls log moves in order (rotated file first), each line re-stamped with format first and its fields intact', async () => {
  const call = (tool: string, at: string) => ({
    at,
    tool,
    grantId: GRANT_LIVE,
    tokenId: 'abcdef012345',
    args: { id: 'f1' },
    outcome: 'ok',
  });
  const raw = async (path: string, text: string) => {
    await mkdir(join(f.from, 'state/connector'), { recursive: true, mode: 0o700 });
    await writeFile(join(f.from, path), text, { mode: 0o600 });
  };
  await raw('state/connector/calls.1.jsonl', `${JSON.stringify(call('stop_ferret', '2026-11-20T00:00:00.000Z'))}\n`);
  await raw(
    'state/connector/calls.jsonl',
    `${JSON.stringify(call('send_to_ferret', '2026-11-24T00:00:00.000Z'))}\nnot json at all\n${JSON.stringify(call('spawn_ferret', '2026-11-25T00:00:00.000Z'))}\n`,
  );
  const report = await connectorStep.run(ctx());
  expect(report.status, report.note).toBe('converted');
  const lines = (await readFile(join(f.to, V5_CONNECTOR_CALLS), 'utf8')).trim().split('\n');
  expect(lines.map(line => Object.keys(JSON.parse(line) as object)[0])).toEqual(['format', 'format', 'format']);
  expect(lines.map(line => (JSON.parse(line) as { tool: string }).tool)).toEqual([
    'stop_ferret',
    'send_to_ferret',
    'spawn_ferret',
  ]);
  expect(JSON.parse(lines[0] ?? '')).toEqual({ format: 1, ...call('stop_ferret', '2026-11-20T00:00:00.000Z') });
  expect(report.notCarried.some(item => item.what.includes('calls-log lines'))).toBe(true);
  expect(everything(report)).not.toContain('not json at all');
  expect((await stat(join(f.to, V5_CONNECTOR_CALLS))).mode & 0o777).toBe(0o600);
});

test('the report names counts and ids, never a digest or any token value', async () => {
  await daemon({ enabled: true, publicUrl: ORIGIN });
  await f.put('state/connector/connector.json', v4State([sha('x'), { digest: sha('y'), retryable: true }]));
  const text = everything(await connectorStep.run(ctx()));
  for (const secret of [
    sha(FAKE.access),
    sha(FAKE.refresh),
    sha(FAKE.secret),
    sha('x'),
    FAKE.access,
    FAKE.refresh,
    FAKE.secret,
  ])
    expect(text).not.toContain(secret);
  expect(text).toContain(GRANT_LIVE);
});

test('a dry run reports the same counts and writes nothing', async () => {
  await daemon({ enabled: true, publicUrl: ORIGIN });
  await f.put('state/connector/connector.json', v4State());
  const dry = await connectorStep.run(ctx(true));
  expect(await exists(V5_CONNECTOR_STATE)).toBe(false);
  expect(await exists('config/connector.yaml')).toBe(false);
  const real = await connectorStep.run(ctx());
  expect(dry.kept).toEqual(real.kept);
});

test('a preview carries nothing: its tokens would authenticate against v4 and its listener would fight it', async () => {
  await daemon({ enabled: true, publicUrl: ORIGIN });
  await f.put('state/connector/connector.json', v4State());
  const report = await connectorStep.run({ ...ctx(), preview: true });
  expect(report.status).toBe('converted');
  expect(report.kept).toEqual([]);
  expect(await exists(V5_CONNECTOR_STATE)).toBe(false);
  expect(await exists('config/connector.yaml')).toBe(false);
});

test('a home with no connector converts cleanly and writes no connector file', async () => {
  const report = await connectorStep.run(ctx());
  expect(report.status).toBe('converted');
  expect(report.kept).toEqual([]);
  expect(await exists('state/connector')).toBe(false);
});

test('the step is registered, and v5 names the connector as the owner of its config file', () => {
  expect(STEPS.map(step => step.id)).toContain('connector');
  expect(configOwner('config/connector.yaml')).toBe('connector');
  expect(CONFIG_TARGETS.CONNECTOR.plugin).toBe('connector');
});
