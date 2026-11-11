import { afterEach, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ChildHandle, RootName, RootsPort } from '@ferretry/kernel/contract';
import type { LoginKind } from '@ferretry/core-ferrets/contract';
import type { BrowsersApi } from '@ferretry/plugin-browsers/contract';
import { fakeBrowsers } from '@ferretry/plugin-browsers/contract/testing';
import { ensureInternalRootBases, nodeFs, rootsPortFor } from '@ferretry/kernel/host';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { fixedClock, owner, standInAdmission, testHost } from '@ferretry/kernel/testing';
import { instantFromEpochMs } from '@ferretry/std';
import { LoginsPort, type LoginId } from '../../../contract/index.ts';
import { OwnedLoginStore } from '../../../daemon/adapters/credentials/owned-store.ts';
import { AnthropicUsageProbe } from '../../../daemon/adapters/credentials/anthropic-usage-probe.ts';
import { CodexUsageProbe } from '../../../daemon/adapters/credentials/codex-usage-probe.ts';
import { buildLoginsDaemon } from '../../../daemon/index.ts';
import { codexSharedHostEnding } from '../../../daemon/lib/harness-login/codex-flow.ts';
import { emptyVault } from '../../support/fake-vault.ts';

const NOW = Date.parse('2026-10-16T09:00:00Z');
const TOKEN = 'oauth-access-TESTONLY-owned-store';
const REFRESH = 'refresh-TESTONLY-owned-store';
// The kernel's stand-in supplies caller identity only. Script the Gate's real governance field explicitly;
// production routes and hook authorization remain unchanged.
const admission = standInAdmission(() => owner());
const gate: typeof admission = {
  ...admission,
  admit: input => {
    const decision = admission.admit(input);
    return decision.outcome === 'refused'
      ? decision
      : {
          ...decision,
          standing: {
            ...decision.standing,
            governance: { governed: false, decide: () => ({ allowed: true, refusal: 'granted' }) },
          },
        };
  },
};
const tempHomes: string[] = [];
afterEach(async () => {
  await Promise.all(tempHomes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

/**
 * Only a temporary FY_HOME, opened through the kernel's REAL roots port (`rootsPortFor` over the host filesystem): the
 * same base placement, link/device fences and per-call checks the daemon gives Logins. `base: false` is a fresh home.
 */
async function fixture(options: { readonly base?: boolean } = {}) {
  const fyHome = await mkdtemp(join(tmpdir(), 'logins-owned-'));
  tempHomes.push(fyHome);
  const base = join(fyHome, 'state', 'logins', 'credentials');
  if (options.base !== false) await mkdir(base, { recursive: true, mode: 0o700 });
  const roots = (plugin = 'logins', declared: readonly RootName[] = ['credentials']): RootsPort =>
    rootsPortFor(
      nodeFs(() => 'fixture'),
      { home: fyHome, plugin, worktrees: `${fyHome}-worktrees` },
      declared,
      () => undefined,
    );
  const root = roots().root('credentials');
  const put = async (path: string, value: unknown) => {
    const target = join(base, path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, JSON.stringify(value), { mode: 0o600 });
  };
  return { fyHome, base, root, roots, put };
}

/** The actual default composition, with the kernel's real roots port in place of the test host's in-memory one. */
function composed(roots: RootsPort) {
  const daemon = buildLoginsDaemon();
  return implementDaemon(daemon.manifest, {
    build: context => {
      if (daemon.build === undefined) throw new Error('missing build');
      return daemon.build({ ...context, kernel: { ...context.kernel, roots } });
    },
  });
}

const jwt = (claims: unknown) => `fixture.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture`;
const codex = (expiresAt = NOW + 3_600_000) => ({
  tokens: {
    access_token: jwt({ exp: expiresAt / 1_000 }),
    refresh_token: REFRESH,
    id_token: jwt({ email: ' codex@example.test ', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } }),
    account_id: 'fixture-account',
  },
  last_refresh: new Date(NOW).toISOString(),
});
const claude = (expiresAt = NOW + 3_600_000) => ({
  claudeAiOauth: { accessToken: TOKEN, refreshToken: REFRESH, expiresAt },
});
const config = {
  logins: {
    claude: { harness: 'claude-code', store: 'ferretry' },
    codex: { harness: 'codex', store: 'ferretry' },
    host: { harness: 'claude-code', store: 'host' },
  },
};
const claudeOnly = () => new Map([['claude', { harness: 'claude-code' as const, store: 'ferretry' as const }]]);

/** A refused store: nothing read is ready, sign-in cannot prepare its folder, and the refusal is the kernel's. */
async function expectRefused(store: OwnedLoginStore, refusal: string) {
  const catalog = store.catalog(claudeOnly);
  const entry = await catalog.entry('claude');
  if (
    entry.resolution.store === 'environment' ||
    'unavailable' in entry.resolution ||
    entry.resolution.harness !== 'claude'
  )
    throw new Error('no store');
  const inspection = await store.inspectStored(entry.resolution);
  expect(inspection.reading.state).toBe('unreadable');
  expect(JSON.stringify(inspection).includes(TOKEN)).toBe(false);
  const target = catalog.signInTarget(entry);
  if (target.kind !== 'store') throw new Error('owned target refused');
  await expect(target.prepare()).rejects.toThrow(`root refused: ${refusal}`);
}

test('S175 the credentials root is Logins’ alone: another plugin cannot open it, and Logins never reads another plugin’s store', async () => {
  const f = await fixture();
  // Another subsystem declaring the same internal root gets nothing (the kernel's owner table, §7.7).
  expect(() => f.roots('another-plugin').root('credentials')).toThrow('root refused: not_declared');
  // A sign-in planted in another plugin's credentials folder is outside Logins' root: the login reads as never signed in.
  const foreign = join(f.fyHome, 'state/another-plugin/credentials/claude');
  await mkdir(foreign, { recursive: true, mode: 0o700 });
  await writeFile(join(foreign, '.credentials.json'), JSON.stringify(claude()), { mode: 0o600 });
  const store = new OwnedLoginStore(f.root, () => NOW);
  const entry = await store.catalog(claudeOnly).entry('claude');
  if (
    entry.resolution.store === 'environment' ||
    'unavailable' in entry.resolution ||
    entry.resolution.harness !== 'claude'
  )
    throw new Error('no store');
  expect(entry.resolution.credentialFile).toBe(join(f.base, 'claude/.credentials.json'));
  expect((await store.inspectStored(entry.resolution)).reading.state).toBe('missing');
  // And a path naming that folder is refused by the root itself, whatever spelling reaches it.
  expect(f.root.resolve('../../another-plugin/credentials/claude/.credentials.json').ok).toBe(false);
  expect(f.root.resolve(join(foreign, '.credentials.json')).ok).toBe(false);
});

test('S175 the kernel, not a caller, places the credentials base under its own absolute home', async () => {
  const f = await fixture();
  const base = f.root.resolve('');
  expect(base.ok ? String(base.value) : undefined).toBe(f.base);
  // There is no home argument left to forge: the kernel's roots port refuses a relative home outright.
  expect(() =>
    rootsPortFor(
      nodeFs(() => 'fixture'),
      { home: 'relative-home', plugin: 'logins', worktrees: '/w' },
      ['credentials'],
      () => undefined,
    ),
  ).toThrow('the home must be an absolute path');
  expect(() => new OwnedLoginStore(f.root, () => NOW)).not.toThrow();
});

test('S175 owned store refuses a credentials root linked into another plugin’s subtree', async () => {
  const f = await fixture();
  const foreign = join(f.fyHome, 'state/another-plugin/credentials');
  await mkdir(join(foreign, 'claude'), { recursive: true, mode: 0o700 });
  await writeFile(join(foreign, 'claude/.credentials.json'), JSON.stringify(claude()), { mode: 0o600 });
  await rm(f.base, { recursive: true });
  await symlink(foreign, f.base);
  await expectRefused(new OwnedLoginStore(f.root, () => NOW), 'link_escape');
  // Nothing was made through the link in the other plugin's folder.
  expect((await lstat(join(foreign, 'claude')).then(info => info.isDirectory())) && true).toBe(true);
  await expect(lstat(join(foreign, 'claude/sign-in'))).rejects.toThrow();
});

test('S175 a fresh home whose kernel made the credentials base at boot: the owned store reads and signs in with no setup step', async () => {
  const f = await fixture({ base: false });
  // What the kernel does before it builds Logins (§7.7): the base is made 0700, whatever the home had before.
  const refused = await ensureInternalRootBases(
    nodeFs(() => 'fixture'),
    { home: f.fyHome, plugin: 'logins' },
    ['credentials'],
  );
  expect(refused).toEqual([]);
  expect((await stat(f.base)).mode & 0o777).toBe(0o700);
  const store = new OwnedLoginStore(f.root, () => NOW);
  const catalog = store.catalog(claudeOnly);
  const entry = await catalog.entry('claude');
  if (
    entry.resolution.store === 'environment' ||
    'unavailable' in entry.resolution ||
    entry.resolution.harness !== 'claude'
  )
    throw new Error('no store');
  // Never signed in is a reading, not a refusal: the folder is there to be read.
  expect((await store.inspectStored(entry.resolution)).reading.state).toBe('missing');
  const target = catalog.signInTarget(entry);
  if (target.kind !== 'store') throw new Error('owned target refused');
  await target.prepare();
  expect((await stat(join(f.base, 'claude/sign-in'))).mode & 0o777).toBe(0o700);
  expect(await target.check()).toMatchObject({ signedIn: false });
  await f.put('claude/.credentials.json', claude());
  expect(await target.check()).toEqual({ signedIn: true });
});

test('S175 owned store refuses a missing credentials base and creates nothing (the kernel did not run: Logins never makes its own base)', async () => {
  const f = await fixture({ base: false });
  await expectRefused(new OwnedLoginStore(f.root, () => NOW), 'outside');
  await expect(lstat(f.base)).rejects.toThrow();
  await expect(lstat(join(f.fyHome, 'state'))).rejects.toThrow();
});

test('S175 owned store refuses an inaccessible credentials base', async () => {
  if (process.getuid?.() === 0) return; // root ignores the permission bits this case relies on
  const f = await fixture();
  await f.put('claude/.credentials.json', claude());
  const parent = dirname(f.base);
  await chmod(parent, 0o000);
  try {
    await expectRefused(new OwnedLoginStore(f.root, () => NOW), 'outside');
  } finally {
    await chmod(parent, 0o700);
  }
});

test('S175 owned store metadata reaches the actual daemon list: status, email, plan and private sign-in paths', async () => {
  const f = await fixture();
  await f.put('claude/.credentials.json', claude());
  await f.put('claude/sign-in/.claude.json', { oauthAccount: { emailAddress: ' claude@example.test ' } });
  await f.put('codex/auth.json', codex());
  const host = await testHost({
    plugins: [composed(f.roots())],
    fakes: { vault: emptyVault() },
    config,
    clock: fixedClock(instantFromEpochMs(NOW)),
  });
  try {
    const list = await host.provided(LoginsPort).list();
    const c = list.logins.find(login => login.id === 'claude');
    const x = list.logins.find(login => login.id === 'codex');
    expect(c?.email).toBe('claude@example.test');
    expect(c?.status.word).toBe('ready');
    expect(x?.email).toBe('codex@example.test');
    expect(x?.status).toMatchObject({ word: 'ready', reason: 'access_current', planType: 'plus' });
    expect(list.logins.find(login => login.id === 'host')?.signIn.available).toBe(false);
    const wire = JSON.stringify({ list, logs: host.logs, events: host.published });
    expect(wire.includes(TOKEN) || wire.includes(REFRESH)).toBe(false);
    expect(wire).not.toMatch(/fingerprint|access_token|refresh_token|accessToken|refreshToken/u);

    const store = new OwnedLoginStore(f.root, () => NOW);
    const catalog = store.catalog(() => new Map([['new', { harness: 'claude-code', store: 'ferretry' }]]));
    const target = catalog.signInTarget(await catalog.entry('new'));
    expect(target.kind).toBe('store');
    if (target.kind !== 'store') throw new Error('owned target refused');
    await target.prepare();
    expect(target.environment.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(join(f.base, 'new'));
    expect(target.environment.CLAUDE_CONFIG_DIR).toBe(join(f.base, 'new/sign-in'));
    expect((await stat(join(f.base, 'new/sign-in'))).mode & 0o777).toBe(0o700);
    expect(await target.check()).toMatchObject({ signedIn: false });
    await f.put('new/.credentials.json', claude());
    expect(await target.check()).toEqual({ signedIn: true });
  } finally {
    await host.stop();
  }
});

test('owned metadata retains today’s expiry/missing/unreadable rules and rereads changed Claude emails', async () => {
  const f = await fixture();
  await f.put('claude/.credentials.json', claude(NOW - 1));
  await f.put('codex/auth.json', codex(NOW + 60_000));
  const host = await testHost({
    plugins: [composed(f.roots())],
    fakes: { vault: emptyVault() },
    config,
    clock: fixedClock(instantFromEpochMs(NOW)),
  });
  try {
    const list = await host.provided(LoginsPort).list();
    expect(list.logins.find(login => login.id === 'claude')?.status.word).toBe('refresh_due');
    expect(list.logins.find(login => login.id === 'codex')?.status.word).toBe('refresh_due');
    const store = new OwnedLoginStore(f.root, () => NOW);
    const catalog = store.catalog(() => new Map([['claude', { harness: 'claude-code', store: 'ferretry' }]]));
    const entry = await catalog.entry('claude');
    if (entry.resolution.store === 'environment' || 'unavailable' in entry.resolution) throw new Error('no store');
    expect((await store.inspectStored(entry.resolution)).reading.state).toBe('refreshable');
    await f.put('claude/.credentials.json', { unknown: true });
    expect((await store.inspectStored(entry.resolution)).reading.state).toBe('missing');
    await writeFile(join(f.base, 'claude/.credentials.json'), '{', { mode: 0o600 });
    expect((await store.inspectStored(entry.resolution)).reading.state).toBe('unreadable');
    const source = catalog.emailSource(entry);
    if (source === undefined) throw new Error('no email source');
    await f.put('claude/sign-in/.claude.json', { oauthAccount: { emailAddress: 'first@example.test' } });
    expect(await store.email(source)).toBe('first@example.test');
    await f.put('claude/sign-in/.claude.json', { oauthAccount: { emailAddress: 'second@example.test' } });
    expect(await store.email(source)).toBe('second@example.test');
  } finally {
    await host.stop();
  }
});

test('S175 owned store refuses host paths, traversal, Claude links and links escaping the owned root', async () => {
  const f = await fixture();
  const store = new OwnedLoginStore(f.root, () => NOW);
  const catalog = store.catalog(
    () =>
      new Map([
        ['claude', { harness: 'claude-code', store: 'ferretry' }],
        ['codex', { harness: 'codex', store: 'ferretry' }],
        ['../escape', { harness: 'codex', store: 'ferretry' }],
      ]),
  );
  await f.put('other/.credentials.json', claude());
  await mkdir(join(f.base, 'claude'));
  await symlink(join(f.base, 'other/.credentials.json'), join(f.base, 'claude/.credentials.json'));
  const c = (await catalog.entry('claude')).resolution;
  if (c.store === 'environment' || 'unavailable' in c) throw new Error('no store');
  const inspection = await store.inspectStored(c);
  expect(inspection.reading.state).toBe('unreadable');
  expect(JSON.stringify(inspection)).toContain('symbolic link');
  expect(catalog.signInTarget(await catalog.entry('../escape')).kind).toBe('refused');
  await mkdir(join(f.base, 'codex'));
  const outside = join(f.fyHome, 'fixture-auth.json');
  await writeFile(outside, JSON.stringify(codex()), { mode: 0o600 });
  await symlink(outside, join(f.base, 'codex/auth.json'));
  const x = (await catalog.entry('codex')).resolution;
  if (x.store === 'environment' || 'unavailable' in x) throw new Error('no store');
  expect((await store.inspectStored(x)).reading.state).toBe('unreadable');
  expect((await store.inspectStored({ ...x, store: 'host' })).reading.state).toBe('unreadable');
  let refreshed = false;
  const noFetch = async (): Promise<never> => {
    throw new Error('no provider read expected');
  };
  const ports = store.statusPorts({
    anthropic: new AnthropicUsageProbe({ fetch: noFetch }),
    codex: new CodexUsageProbe({ fetch: noFetch, now: () => NOW }),
    refresh: {
      refresh: async () => {
        refreshed = true;
        return { outcome: 'ran' };
      },
    },
    usageIntervalMs: 60_000,
  });
  await expect(
    ports.refresh.refresh({ accountId: 'codex', kind: 'codex', home: join(f.base, 'codex') }, async () => true),
  ).rejects.toThrow('root refused: link_escape');
  expect(refreshed).toBe(false);
  const failed = new OwnedLoginStore(
    {
      ...f.root,
      readText: async () => {
        throw new Error(TOKEN);
      },
    },
    () => NOW,
  );
  // Use an ordinary owned file so the read, rather than the link check, is what fails.
  const ordinary = { ...x, canonicalFile: join(f.base, 'other/.credentials.json') };
  const failure = await failed.inspectStored(ordinary);
  expect(failure.reading.state).toBe('unreadable');
  expect(JSON.stringify(failure).includes(TOKEN)).toBe(false);
});

test('S178 actual daemon Check now makes only the free provider read; values and digests never reach the route', async () => {
  const f = await fixture();
  await f.put('claude/.credentials.json', claude());
  const requests: { url: string; method: string }[] = [];
  const host = await testHost({
    plugins: [composed(f.roots())],
    fakes: { vault: emptyVault() },
    config,
    clock: fixedClock(instantFromEpochMs(NOW)),
    gate,
    fetch: async (url, init) => {
      requests.push({ url: String(url), method: init?.method ?? 'GET' });
      expect(new Headers(init?.headers).get('authorization') === `Bearer ${TOKEN}`).toBe(true);
      return new Response('{"five_hour":{"utilization":12,"resets_at":null}}', { status: 200 });
    },
  });
  try {
    const response = await host.request('POST', '/v1/logins/claude/check', { body: {} });
    expect(response.status).toBe(200);
    expect(requests).toEqual([{ url: 'https://api.anthropic.com/api/oauth/usage', method: 'GET' }]);
    expect(response.body).toContain('provider_accepted');
    expect(response.body).not.toMatch(/fingerprint|accessToken|refreshToken/u);
    expect(response.body.includes(TOKEN) || response.body.includes(REFRESH)).toBe(false);
    expect(JSON.stringify(host.logs).includes(TOKEN)).toBe(false);
  } finally {
    await host.stop();
  }
});

test('owned passive usage supplies measured windows; a list never rotates Codex, and Check now uses its canonical store', async () => {
  const f = await fixture();
  await f.put('codex/auth.json', codex(NOW - 1));
  await f.put('claude/.credentials.json', claude());
  await f.put('claude/usage.json', { version: 1, source: 'claude-statusline', at: NOW, fiveHour: { usedPercent: 24 } });
  const daemon = composed(f.roots());
  const starts: { program: string; args: readonly string[]; env: unknown }[] = [];
  let launchKind: LoginKind | undefined;
  const wired = implementDaemon(daemon.manifest, {
    build: context => {
      if (daemon.build === undefined) throw new Error('missing build');
      const half = daemon.build({
        ...context,
        kernel: {
          ...context.kernel,
          spawn: {
            ...context.kernel.spawn,
            start: (program, args, options) => {
              starts.push({ program, args, env: options?.env });
              let exit!: (code: number) => void;
              const exited = new Promise<number>(resolve => {
                exit = resolve;
              });
              return {
                pid: 8,
                pipes: [],
                closePipes: () => undefined,
                stdout: new ReadableStream({
                  start(controller) {
                    controller.close();
                  },
                }),
                stderr: new ReadableStream({
                  start(controller) {
                    controller.close();
                  },
                }),
                write: chunk => {
                  const requests = String(chunk)
                    .trim()
                    .split('\n')
                    .map(line => JSON.parse(line));
                  expect(requests[1]).toMatchObject({
                    method: 'getAuthStatus',
                    params: { includeToken: false, refreshToken: true },
                  });
                  writeFileSync(
                    join(f.base, 'codex/auth.json'),
                    JSON.stringify({ ...codex(), last_refresh: new Date(NOW + starts.length).toISOString() }),
                    { mode: 0o600 },
                  );
                },
                kill: () => {
                  exit(0);
                },
                exited,
              };
            },
          },
        },
      });
      launchKind = half.hooks['logins:openai'];
      return half;
    },
  });
  const host = await testHost({
    plugins: [wired],
    fakes: { vault: emptyVault() },
    config,
    gate,
    clock: fixedClock(instantFromEpochMs(NOW)),
    fetch: async () =>
      new Response(
        '{"rate_limit":{"primary_window":{"used_percent":9,"reset_at":1900000000,"limit_window_seconds":18000}}}',
        { status: 200 },
      ),
  });
  try {
    const list = await host.provided(LoginsPort).list();
    expect(starts).toEqual([]);
    expect(list.logins.find(login => login.id === 'claude')?.usage.fiveHour.usedPercent).toBe(24);
    expect(list.logins.find(login => login.id === 'codex')?.status.word).toBe('refresh_due');
    const checked = await host.request('POST', '/v1/logins/codex/check', { body: {} });
    expect(checked.status).toBe(200);
    expect(starts).toEqual([
      {
        program: 'codex',
        args: ['-c', 'cli_auth_credentials_store="file"', 'app-server'],
        env: { CODEX_HOME: join(f.base, 'codex') },
      },
    ]);
    expect(checked.json<{ status: { word: string } }>().status.word).toBe('ready');
    expect(checked.body.includes(REFRESH)).toBe(false);
    if (launchKind?.refresh === undefined) throw new Error('missing actual launch refresh hook');
    expect(await launchKind.refresh('codex')).toEqual({ state: 'signed-in' });
    expect(starts).toHaveLength(2);
  } finally {
    await host.stop();
  }
});

const browserFacts = (shared?: boolean): BrowsersApi => ({
  ...fakeBrowsers(),
  ...(shared === undefined ? {} : { browserPorts: async () => ({ shared }) }),
});
const sharingCases: readonly { name: string; browsers?: BrowsersApi; automatic?: true }[] = [
  { name: 'absent Browsers' },
  { name: 'missing browserPorts method', browsers: browserFacts() },
  { name: 'shared browserPorts', browsers: browserFacts(true) },
  {
    name: 'throwing browserPorts',
    browsers: {
      ...browserFacts(),
      browserPorts: async () => {
        throw new Error('unavailable');
      },
    },
  },
  { name: 'non-shared browserPorts', browsers: browserFacts(false), automatic: true },
];

for (const scenario of sharingCases) {
  test(`${scenario.name} in real composition selects the safe Codex fallback and explicit-choice sentence`, async () => {
    const f = await fixture();
    const daemon = composed(f.roots());
    const calls: string[][] = [];
    let launchKind: LoginKind | undefined;
    const wired = implementDaemon(daemon.manifest, {
      build: context => {
        if (daemon.build === undefined) throw new Error('missing build');
        const half = daemon.build({
          ...context,
          kernel: {
            ...context.kernel,
            spawn: {
              ...context.kernel.spawn,
              start: (program, args): ChildHandle => {
                calls.push([program, ...args]);
                const device = args.includes('--device-auth');
                let end: ((code: number) => void) | undefined;
                const exited = device
                  ? Promise.resolve(1)
                  : new Promise<number>(resolve => {
                      end = resolve;
                    });
                return {
                  pid: 7,
                  pipes: [],
                  closePipes: () => undefined,
                  stdout: new ReadableStream({
                    start(controller) {
                      controller.enqueue(
                        new TextEncoder().encode(
                          device
                            ? 'Error logging in with device code: device code login is not enabled for this Codex server. Use the browser login or verify the server URL.\n'
                            : 'Starting local login server on http://localhost:1455.\nhttps://auth.openai.com/oauth/authorize?response_type=code&client_id=app_TESTONLY&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&code_challenge=challenge&code_challenge_method=S256&state=STATE-TESTONLY_abc&originator=codex_cli_rs\n',
                        ),
                      );
                      controller.close();
                    },
                  }),
                  stderr: new ReadableStream({
                    start(controller) {
                      controller.close();
                    },
                  }),
                  write: () => {},
                  kill: () => {
                    end?.(1);
                  },
                  exited,
                };
              },
            },
          },
        });
        launchKind = half.hooks['logins:openai'];
        return half;
      },
    });
    const host = await testHost({
      plugins: [wired],
      fakes: { vault: emptyVault() },
      config,
      gate,
      uses: scenario.browsers === undefined ? {} : { browsers: scenario.browsers },
    });
    try {
      const started = await host.request('POST', '/v1/logins/sign-in', { body: { loginId: 'codex' as LoginId } });
      expect(started.status).toBe(200);
      const { flowId } = started.json<{ flowId: string }>();
      let flow: { state?: string; reason?: string; remedy?: string } = {};
      const expectedState = scenario.automatic ? 'awaiting-callback' : 'failed';
      for (let attempt = 0; attempt < 1_000 && flow.state !== expectedState; attempt += 1) {
        flow = (await host.request('GET', `/v1/logins/sign-in/${flowId}`)).json();
        if (flow.state !== expectedState) await Bun.sleep(1);
      }
      if (scenario.automatic) {
        expect(flow.state).toBe('awaiting-callback');
        expect(calls).toHaveLength(2);
        expect(calls[1]?.at(-1)).toBe('login');
        if (launchKind === undefined) throw new Error('missing actual launch sign-in hook');
        // Ferrets' trusted hook can resume this sign-in, without fabricated governance or another child.
        expect(await launchKind.signIn('codex')).toMatchObject({ kind: 'browser' });
        expect(calls).toHaveLength(2);
      } else {
        const ending = codexSharedHostEnding();
        expect(flow).toMatchObject({ state: 'failed', reason: ending.reason, remedy: ending.remedy });
        expect(flow.remedy).toContain('choose the link sign-in yourself');
        expect(calls).toHaveLength(1);
      }
      expect(calls[0]?.at(-1)).toBe('--device-auth');
    } finally {
      await host.stop();
    }
  });
}

test('external entrypoints still refuse missing governance after private launch orchestration is wired', async () => {
  const f = await fixture();
  const host = await testHost({
    plugins: [composed(f.roots())],
    fakes: { vault: emptyVault() },
    config,
  });
  try {
    const signIn = await host.request('POST', '/v1/logins/sign-in', { body: { loginId: 'codex' } });
    const refresh = await host.request('POST', '/v1/logins/codex/check', { body: {} });
    expect(signIn.status).toBe(409);
    expect(signIn.body).toContain('fleet_login_unauthorized');
    expect(refresh.status).toBe(409);
    expect(refresh.body).toContain('fleet_credential_unauthorized');
  } finally {
    await host.stop();
  }
});
