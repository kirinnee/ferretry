import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeGate, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeVault, fakeChildEnvironmentValues } from '@ferretry/core-vault/contract/testing';
import type { SecretName } from '@ferretry/core-vault/contract';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { err, ok } from '@ferretry/std';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import { Harnesses, Logins, type LoginKind, Runners } from '../../../../contract/index.ts';
import { FakeHarness, FakeLoginKind, FakeRunner } from '../../../../contract/testing/index.ts';
import ferrets from '../../../../daemon/index.ts';

/**
 * The daemon half of Ferrets, booted whole, starts a ferret on a login: the `logins:<kind>` provider that HOLDS the
 * login answers `env`, the Vault resolves its `${secret:}` references into the child, and the harness sees the login's
 * environment on the spec. Fake values only, no network, no real home. (Another package's daemon half is not importable
 * from here, so the provider is a stand-in with the real hook shape; the real kinds' `holds`/`env` are covered where they
 * live, in the Logins package.)
 */

const GATEWAY_URL = 'https://gateway.example.test';
const GATEWAY_TOKEN = 'fake-gateway-token-value';
const STORE_VARIABLE = 'CLAUDE_SECURESTORAGE_CONFIG_DIR';
const STORE_DIRECTORY = '/fixture-fy/state/logins/credentials/personal';

/** A kind holding exactly the logins it was given, each with the env it answers per harness. */
class HoldingKind extends FakeLoginKind implements LoginKind {
  constructor(
    key: ConstructorParameters<typeof FakeLoginKind>[0],
    private readonly logins: Readonly<Record<string, Readonly<Record<string, string>>>>,
    /** What Ferretry sets for a sign-in (`launchEnvironment`), by login; a login named here with `null` has no usable sign-in. */
    private readonly launch: Readonly<Record<string, Readonly<Record<string, string>> | null>> = {},
  ) {
    super(key, Object.keys(logins));
  }
  async launchEnvironment(login: string) {
    const found = this.launch[login];
    return found === null
      ? err(`the login ${login} is not signed in (sign in again), so the ferret was not started`)
      : ok(found ?? {});
  }
  override async env(login: string) {
    const found = this.logins[login];
    if (found === undefined) throw new Error('not held');
    return found;
  }
}

class RecordingHarness extends FakeHarness {
  readonly children: Record<string, string>[] = [];
  override async start(...args: Parameters<FakeHarness['start']>) {
    this.children.push({ ...(fakeChildEnvironmentValues(args[2]) ?? {}) });
    return await super.start(...args);
  }
}

const harnessPlugin = (harness: FakeHarness) =>
  implementDaemon(
    definePlugin({
      id: 'claude-code',
      title: 'Claude Code (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: Harnesses, key: 'claude-code' }] },
    }),
    { build: () => ({ hooks: { 'harnesses:claude-code': harness } }) },
  );
const runnerPlugin = (runner: FakeRunner) =>
  implementDaemon(
    definePlugin({
      id: 'terminals',
      title: 'Terminals (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: Runners, key: 'tmux' }] },
    }),
    { build: () => ({ hooks: { 'runners:tmux': runner } }) },
  );
const loginsPlugin = (endpoint: LoginKind, anthropic: LoginKind) =>
  implementDaemon(
    definePlugin({
      id: 'logins',
      title: 'Logins (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: {
        takes: [
          { hook: Logins, key: 'endpoint' },
          { hook: Logins, key: 'anthropic' },
        ],
      },
    }),
    { build: () => ({ hooks: { 'logins:endpoint': endpoint, 'logins:anthropic': anthropic } }) },
  );

async function boot(withLogins = true) {
  const harness = new RecordingHarness('claude-code');
  const vault = new FakeVault();
  await vault.put('GATEWAY_TOKEN' as SecretName, GATEWAY_TOKEN);
  const endpoint = new HoldingKind('endpoint', {
    gw: {
      ANTHROPIC_BASE_URL: GATEWAY_URL,
      ANTHROPIC_AUTH_TOKEN: '${secret:GATEWAY_TOKEN}',
      FY_SESSION_TOKEN: 'forged',
      HOME: '/elsewhere',
    },
    broken: { ANTHROPIC_AUTH_TOKEN: '${secret:NOT_STORED}' },
  });
  const oauth = new HoldingKind(
    'anthropic',
    { personal: {}, lapsed: {} },
    { personal: { [STORE_VARIABLE]: STORE_DIRECTORY }, lapsed: null },
  );
  const host: TestHost = await testHost({
    plugins: [
      ferrets,
      harnessPlugin(harness),
      runnerPlugin(new FakeRunner()),
      ...(withLogins ? [loginsPlugin(endpoint, oauth)] : []),
    ],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: { gate: new FakeGate(), vault, asks: new FakeAsks() },
    everyDirectory: true,
  });
  return { host, harness };
}

const start = async (host: TestHost, login?: string) =>
  await host.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': randomUUID() },
    body: { folder: '/work/a', prompt: 'Work.', ...(login === undefined ? {} : { login }) },
  });

describe('a ferret started on a login launches with that login’s environment', () => {
  test('the holding kind answers; the Vault resolves the secret into the child; FY_*/HOME stay ours', async () => {
    const { host, harness } = await boot();

    const started = await start(host, 'gw');
    await host.settle();

    expect(started.status).toBeLessThan(300);
    const child = harness.children[0] ?? {};
    expect(child.ANTHROPIC_BASE_URL).toBe(GATEWAY_URL);
    expect(child.ANTHROPIC_AUTH_TOKEN).toBe(GATEWAY_TOKEN);
    expect(child.HOME).toBeUndefined();
    expect(child.FY_SESSION_TOKEN).not.toBe('forged');
    // The spec carries no copy of the login's environment (nothing pins it over a project's own), never the resolved value.
    const spec = harness.launched[0];
    expect(spec).not.toHaveProperty('loginEnv');
    expect(JSON.stringify(spec)).not.toContain(GATEWAY_TOKEN);
  });

  test('a signed-in Claude OAuth login launches with exactly its store variable; a start with no login gets none', async () => {
    const { host, harness } = await boot();

    expect((await start(host, 'personal')).status).toBeLessThan(300);
    expect((await start(host)).status).toBeLessThan(300);
    await host.settle();

    expect(harness.children[0]?.[STORE_VARIABLE]).toBe(STORE_DIRECTORY);
    expect(Object.keys(harness.children[0] ?? {}).filter(name => name.startsWith('ANTHROPIC'))).toEqual([]);
    expect(harness.children[1]?.[STORE_VARIABLE]).toBeUndefined();
    // It is Ferretry's own variable, not part of what the login file declares.
    for (const spec of harness.launched) expect(spec).not.toHaveProperty('loginEnv');
  });

  test('an OAuth login with no usable sign-in refuses the start with a sentence and launches nothing', async () => {
    const { host, harness } = await boot();

    const started = await start(host, 'lapsed');

    expect(started.status).toBeGreaterThanOrEqual(400);
    expect(started.body).toContain('the login lapsed is not signed in');
    expect(harness.launched).toHaveLength(0);
  });

  test('a login no kind holds refuses the start with a sentence, and nothing launches', async () => {
    const { host, harness } = await boot();

    const started = await start(host, 'ghost');

    expect(started.status).toBeGreaterThanOrEqual(400);
    expect(started.body).toContain('there is no login named ghost');
    expect(harness.launched).toHaveLength(0);
  });

  test('a login whose secret is not stored refuses the start as login_unavailable', async () => {
    const { host, harness } = await boot();

    const started = await start(host, 'broken');

    expect(started.status).toBeGreaterThanOrEqual(400);
    expect(started.body).toContain('NOT_STORED');
    expect(started.body).not.toContain(GATEWAY_TOKEN);
    expect(harness.launched).toHaveLength(0);
  });

  test('with no Logins provider running, a start that names a login says so instead of launching bare', async () => {
    const { host, harness } = await boot(false);

    const started = await start(host, 'gw');

    expect(started.status).toBeGreaterThanOrEqual(400);
    expect(started.body).toContain('no login provider is running');
    expect(harness.launched).toHaveLength(0);
  });
});

/**
 * The same launch, end to end over loopback: the login's `ANTHROPIC_BASE_URL` points at a fake HTTP server inside this
 * test and the "claude" binary is a stub that reads that variable from ITS OWN environment and makes one request to it.
 * The harness here is the only stand-in (another package's harness is not importable): it runs the stub with exactly
 * the environment the Vault resolved for the launch, which is what a real runner hands the pane. No real credential and
 * no network beyond 127.0.0.1.
 */
describe('a ferret on an environment login reaches the login’s endpoint', () => {
  const STUB = [
    'const base = process.env.ANTHROPIC_BASE_URL;',
    'const token = process.env.ANTHROPIC_AUTH_TOKEN ?? "";',
    'if (base === undefined) process.exit(3);',
    'const reply = await fetch(`${base}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${token}` } });',
    'process.exit(reply.ok ? 0 : 4);',
    '',
  ].join('\n');

  class StubClaudeHarness extends RecordingHarness {
    readonly exits: Promise<number>[] = [];
    constructor(private readonly script: string) {
      super('claude-code');
    }
    override async start(...args: Parameters<FakeHarness['start']>) {
      const started = await super.start(...args);
      // Only what the Vault resolved: nothing of the test process's own environment reaches the stub.
      const child = Bun.spawn([process.execPath, this.script], {
        env: { ...(fakeChildEnvironmentValues(args[2]) ?? {}) },
        stdout: 'ignore',
        stderr: 'ignore',
      });
      this.exits.push(child.exited);
      return started;
    }
  }

  test('the stub reads the login’s base URL and token from its environment and the fake server is hit with them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fy-login-env-'));
    const hits: { path: string; authorized: boolean }[] = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        hits.push({
          path: new URL(request.url).pathname,
          authorized: request.headers.get('authorization') === `Bearer ${GATEWAY_TOKEN}`,
        });
        return new Response('{}', { headers: { 'content-type': 'application/json' } });
      },
    });
    try {
      const script = join(dir, 'claude-stub.ts');
      await writeFile(script, STUB);
      const harness = new StubClaudeHarness(script);
      const vault = new FakeVault();
      await vault.put('GATEWAY_TOKEN' as SecretName, GATEWAY_TOKEN);
      const endpoint = new HoldingKind('endpoint', {
        local: {
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
          ANTHROPIC_AUTH_TOKEN: '${secret:GATEWAY_TOKEN}',
        },
      });
      const host = await testHost({
        plugins: [
          ferrets,
          harnessPlugin(harness),
          runnerPlugin(new FakeRunner()),
          loginsPlugin(endpoint, new HoldingKind('anthropic', {})),
        ],
        gate: new StandInAdmission(() => ownerStanding()),
        fakes: { gate: new FakeGate(), vault, asks: new FakeAsks() },
        everyDirectory: true,
      });

      const started = await start(host, 'local');
      const codes = await Promise.all(harness.exits);

      expect(started.status).toBeLessThan(300);
      // The child carries the login's names (and the token only as the resolved value, never in the spec).
      expect(Object.keys(harness.children[0] ?? {})).toEqual(
        expect.arrayContaining(['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']),
      );
      expect(JSON.stringify(harness.launched[0])).not.toContain(GATEWAY_TOKEN);
      expect(codes).toEqual([0]);
      expect(hits).toEqual([{ path: '/v1/messages', authorized: true }]);
    } finally {
      await server.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a ferret with no login makes the stub find no base URL, and the server is never hit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fy-login-env-'));
    let hit = 0;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        hit += 1;
        return new Response('{}');
      },
    });
    try {
      const script = join(dir, 'claude-stub.ts');
      await writeFile(script, STUB);
      const harness = new StubClaudeHarness(script);
      const host = await testHost({
        plugins: [ferrets, harnessPlugin(harness), runnerPlugin(new FakeRunner())],
        gate: new StandInAdmission(() => ownerStanding()),
        fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
        everyDirectory: true,
      });

      await start(host);

      expect(await Promise.all(harness.exits)).toEqual([3]);
      expect(hit).toBe(0);
    } finally {
      await server.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Claude's documented store rule, as a stand-in: the secure-storage variable if set, else the config dir. Reads only
  // whether the sign-in file is there; it prints nothing. (macOS keeps the same store as a keychain item hashed from the
  // same directory, so the one variable selects it on both platforms and the launch keeps the real HOME.)
  const SIGNED_IN_STUB = [
    'import { existsSync } from "node:fs";',
    'const store = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? "";',
    'process.exit(store !== "" && existsSync(`${store}/.credentials.json`) ? 0 : 1);',
    '',
  ].join('\n');

  test('a ferret on a signed-in OAuth login finds its sign-in through the variable; one without the login does not', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fy-login-env-'));
    try {
      const store = join(dir, 'state', 'logins', 'credentials', 'personal');
      await mkdir(store, { recursive: true });
      await writeFile(join(store, '.credentials.json'), '{"fake":"not-a-credential"}');
      const script = join(dir, 'claude-stub.ts');
      await writeFile(script, SIGNED_IN_STUB);
      const harness = new StubClaudeHarness(script);
      const host = await testHost({
        plugins: [
          ferrets,
          harnessPlugin(harness),
          runnerPlugin(new FakeRunner()),
          loginsPlugin(
            new HoldingKind('endpoint', {}),
            new HoldingKind('anthropic', { personal: {} }, { personal: { [STORE_VARIABLE]: store } }),
          ),
        ],
        gate: new StandInAdmission(() => ownerStanding()),
        fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
        everyDirectory: true,
      });

      await start(host, 'personal');
      await start(host);

      // The first reads the sign-in; the second (positive control: same launch, no login, so no variable) is signed out.
      expect(await Promise.all(harness.exits)).toEqual([0, 1]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
