import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawn, type Subprocess } from 'bun';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DAEMON_RUN_FILE, DaemonRunSchema } from '@ferretry/kernel/contract';
import { FAKE_REPLY, startFakeProvider, type FakeProvider } from './fake-provider.ts';
import { writeStubBinaries } from './stub-binaries.ts';
import { allowedCallHeaders } from '@ferretry/kernel/manifest';
import type { FerretsClient } from '../../../../app/lib/client.ts';
import {
  emptyNewFerretDraft,
  startAttemptFor,
  startFerret,
} from '../../../../app/features/new-ferret/new-ferret-draft.ts';

/**
 * THE MERGE-BAR LINE: A FERRET AUTHENTICATES END TO END (docs/rebuild/merge-bar.md, before-merge line 7).
 *
 * Every per-plugin test passed while no 5.0 ferret could sign in: a login's env never reached a launch
 * (b190-ferret-env-trace) and an OAuth login's credential never reached the ferret's fresh agent home. This is the test
 * that would have caught it, so it goes through nothing but the real thing: a REAL `fyd` (the production entry point,
 * every real plugin, the real tmux runner) on a temp FY_HOME, started by the real `POST /v1/ferrets`, with one message
 * typed into the real pane. Only the provider is fake, and only the harness binary is a stand-in (stub-binaries.ts says
 * why, and what it reads).
 *
 * Per case: a fake provider (loopback, port 0) records each request's path and which auth header carried the FAKE
 * token; the ferret starts; its first message goes in; the provider must have been reached with the right header and the
 * reply must be in the pane the daemon reports for that ferret.
 *
 * Fake values only. Loopback only. Nothing here reads a real home, keychain or credential.
 *
 * EVIDENCE — what the real binaries read (probed 2026-11-11 with fake values against a loopback server, an empty
 * HOME and `env -i`; strace for the files and sockets):
 * - claude 2.1.317, ANTHROPIC_BASE_URL=<loopback> + ANTHROPIC_AUTH_TOKEN=<fake>: `HEAD /api/hello`, then
 *   `POST /v1/messages` with `Authorization: Bearer <fake>`; the reply was printed. Hermetic. (The `${secret:}` variant
 *   is the same child env once the Vault has resolved it.)
 * - claude, a fake `.credentials.json` (`claudeAiOauth.accessToken/refreshToken/expiresAt/scopes`, expiry a month out) in
 *   CLAUDE_CONFIG_DIR: `claude auth status` says `loggedIn: true, authMethod: claude.ai`; strace shows it opening
 *   `<CLAUDE_CONFIG_DIR>/.credentials.json` (CLAUDE_SECURESTORAGE_CONFIG_DIR, when set, names the directory instead), but
 *   `claude -p` then connects to 160.79.104.10:443 (api.anthropic.com) and ends `OAuth session expired and could not be
 *   refreshed` — it needs the network, so the real binary is NOT hermetic for an OAuth login.
 * - codex 0.166.0, `CODEX_HOME=<dir>` holding `auth.json`, `-c model_providers.fake={base_url=…,env_key=…,wire_api="responses"}`:
 *   reached the loopback server (`/v1/responses`), Bearer from the key.
 * - Packaging: `claude-code` is unfree in nixpkgs and the flake is stock nixpkgs with no allowUnfree, so a pinned real
 *   claude in the CI devshell needs unfree + a network fetch at BUILD time; hence the stand-ins (stub-binaries.ts), and
 *   the real-binary case below runs only where a `claude` is on PATH.
 *
 * TWO FINDINGS THIS TEST MADE ON THE WAY (neither is auth):
 * 1. A login file refuses a literal token: `ANTHROPIC_AUTH_TOKEN: <any literal>` is "a secret: save it in the secret
 *    store" even when short, so the brief's "literal token" variant cannot exist; the env case uses a literal base URL and a
 *    `${secret:}` token, which is the only form the daemon accepts.
 * 2. The tmux runner runs `start-server` and then `show-options` as two commands; a server with no session exits between
 *    them, so the first start on a daemon with no tmux server fails `runner_unavailable`. The fixture keeps an idle session
 *    (see `e2e-keeper`) so that does not mask the auth results.
 */

// Short and low-entropy on purpose: the config's raw-secret detector refuses a longer random-looking literal in a login file.
const FAKE_TOKEN = 'fake-token';
const SECRET_NAME = 'FAKE_PROVIDER_TOKEN';
const FYD = join(import.meta.dir, '../../../../../kernel/host/fyd.ts');
const FY = join(import.meta.dir, '../../../../../../cli/bin/fy.ts');
const REPO = join(import.meta.dir, '../../../../../../..');
const READY_MS = 90_000;
const SEE_MS = 45_000;

// A real daemon boot, a real tmux and a real pane: far past bun's 5 s default.
setDefaultTimeout(150_000);

const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const clean of cleanups.reverse()) await clean();
});

interface Daemon {
  readonly home: string;
  readonly base: string;
  readonly admin: string;
  readonly folder: string;
  readonly launches: () => Record<string, unknown>[];
  call(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; text: string }>;
}

/** Writes `files` (path under FY_HOME → text) before the first boot, starts fyd, and returns once it answers. */
async function boot(
  provider: FakeProvider,
  files: (home: string) => Readonly<Record<string, string>>,
  secret?: string,
  realClaude?: string,
  /**
   * Config files that name a `${secret:NAME}`, by path under `config/`. A reference written straight to disk is HELD for
   * the owner's acknowledgment (kernel/host/config/evaluate.ts, addedSecretReferenceSentences: only an owner-written
   * reference may be resolved), so these go through the door the product uses: the owner's `PUT /v1/config/file`, and
   * `POST /v1/config/confirm` if the daemon holds the edit. The guard is exercised, never bypassed.
   */
  ownerFiles: Readonly<Record<string, string>> = {},
): Promise<Daemon> {
  const root = await mkdtemp(join(tmpdir(), 'fy-auth-e2e-'));
  const home = join(root, 'fy-home');
  const userHome = join(root, 'user-home');
  const folder = join(root, 'work');
  await mkdir(userHome, { recursive: true });
  await mkdir(folder, { recursive: true });
  execFileSync('git', ['init', '-q', folder]);
  const stubs = await writeStubBinaries(root, provider.url);
  const homeJson = { format: 1, createdBy: 'ferret-auth-e2e', createdAt: new Date().toISOString() };
  const written = {
    ...files(home),
    [join(home, 'home.json')]: JSON.stringify(homeJson),
    // Where the harness locates its binary: the stand-in, by the explicit-path rule (docs/harness-paths.md).
    [join(home, 'config/harness-claude-code.yaml')]: `binary: ${realClaude ?? join(stubs.dir, 'claude')}\n`,
    [join(home, 'config/harness-codex.yaml')]: `binary: ${join(stubs.dir, 'codex')}\n`,
  };
  for (const [path, text] of Object.entries(written)) {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, text, { mode: 0o600 });
  }
  const stderr: string[] = [];
  const child: Subprocess<'ignore', 'pipe', 'pipe'> = spawn({
    cmd: [process.execPath, FYD],
    cwd: REPO,
    env: {
      PATH: `${stubs.dir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: userHome,
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      LANG: 'C.UTF-8',
      FY_HOME: home,
      FY_PORT: '0',
      // Offline, as scripts/ci/test.sh runs every tier: no model catalog, hosted relay directory or update check.
      FY_MODEL_CATALOG: 'off',
      FY_LOCAL_MODELS: 'off',
      FY_RELAY_DIRECTORY_ORIGIN: 'off',
      FY_UPDATE_CHECK: 'off',
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let ready = false;
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      stderr.push(text);
      if (/\bfyd \S+ ready \(/u.test(text)) ready = true;
    }
  };
  void pump(child.stderr);
  void pump(child.stdout);
  cleanups.push(async () => {
    child.kill('SIGTERM');
    await Promise.race([child.exited, Bun.sleep(10_000)]);
    child.kill('SIGKILL');
    const tmux = Bun.which('tmux');
    const socket = join(home, 'state/terminals/tmux.sock');
    if (tmux !== null && existsSync(socket)) spawnSync(tmux, ['-S', socket, 'kill-server'], { stdio: 'ignore' });
    if (process.env.FY_KEEP_E2E_HOME === undefined) await rm(root, { recursive: true, force: true });
    else console.error('kept', root);
  });
  const until = Date.now() + READY_MS;
  while (!ready && Date.now() < until) {
    if (child.exitCode !== null)
      throw new Error(`fyd exited ${String(child.exitCode)}: ${stderr.join('').slice(-1500)}`);
    await Bun.sleep(200);
  }
  if (!ready) throw new Error(`fyd was not ready in ${String(READY_MS)} ms: ${stderr.join('').slice(-1500)}`);
  const run = DaemonRunSchema.parse(JSON.parse(await readFile(join(home, DAEMON_RUN_FILE), 'utf8')));
  const base = `http://127.0.0.1:${String(run.port)}`;
  const admin = (await readFile(join(home, 'state/gate/admin-token'), 'utf8')).trim();
  const call: Daemon['call'] = async (method, path, body, headers = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${admin}`,
        'x-ferretry-client': 'cli',
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, text: await response.text() };
  };
  const daemon: Daemon = {
    home,
    base,
    admin,
    folder,
    call,
    launches: () =>
      readFileSync(stubs.log, 'utf8')
        .split('\n')
        .filter(line => line !== '')
        .map(line => JSON.parse(line) as Record<string, unknown>),
  };
  // FINDING (reported with this test): the tmux runner does `tmux start-server` and THEN `show-options` as two
  // commands, and a server with no session exits in between (tmux 3.7+/3.8), so the FIRST ferret start on a daemon with
  // no tmux server answers `runner_unavailable` whatever its login. That is a different defect from auth, and it would
  // hide the auth ones, so the fixture keeps one idle session alive on the daemon's own socket. Remove this when the
  // runner stops depending on a server that outlives `start-server`.
  const tmux = Bun.which('tmux');
  if (tmux === null) throw new Error('the ferret-auth test needs tmux');
  execFileSync(
    tmux,
    ['-S', join(home, 'state/terminals/tmux.sock'), 'new-session', '-d', '-s', 'e2e-keeper', 'sleep', '86400'],
    {
      // A CLEAN environment: a pane inherits its tmux server's, and the developer's own CLAUDE_* must never leak into a ferret.
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: userHome },
    },
  );
  if (secret !== undefined) {
    const put = await call('POST', '/v1/secrets', { name: SECRET_NAME, value: secret });
    if (put.status >= 300) throw new Error(`could not set the temp Vault secret: ${String(put.status)} ${put.text}`);
  }
  for (const [path, text] of Object.entries(ownerFiles)) await ownerWrites(daemon, path, text);
  return daemon;
}

/** The owner's door for a config file: write it, and confirm the held edit when the daemon holds it. */
async function ownerWrites(daemon: Daemon, path: string, text: string): Promise<void> {
  const wrote = await daemon.call('PUT', '/v1/config/file', { path, text });
  if (wrote.status >= 300)
    throw new Error(`the owner write of ${path} was refused: ${String(wrote.status)} ${wrote.text}`);
  const { outcome, etag } = JSON.parse(wrote.text) as { outcome: string; etag: string };
  if (outcome === 'pending') {
    const confirmed = await daemon.call('POST', '/v1/config/confirm', { path, etag });
    if (confirmed.status >= 300 || !(JSON.parse(confirmed.text) as { confirmed: boolean }).confirmed)
      throw new Error(`the held edit of ${path} was not confirmed: ${String(confirmed.status)} ${confirmed.text}`);
  } else if (outcome !== 'applied') throw new Error(`the owner write of ${path} answered ${outcome}`);
}

/** Starts a ferret on `login`, waits for the daemon's own transcript read (`GET …/messages`) to show the reply, and returns what the daemon reported. */
async function startAndSee(daemon: Daemon, harness: 'claude-code' | 'codex', login: string): Promise<string> {
  const started = await daemon.call(
    'POST',
    '/v1/ferrets',
    { harness, login, folder: daemon.folder, prompt: 'say hello', mode: 'interactive' },
    { 'x-fy-request-id': crypto.randomUUID() },
  );
  expect(started.status, `start: ${started.text}`).toBeLessThan(300);
  const { id } = JSON.parse(started.text) as { id: string };
  const until = Date.now() + SEE_MS;
  let seen = '';
  while (Date.now() < until) {
    const messages = await daemon.call('GET', `/v1/ferrets/${id}/messages`);
    // Claude's reply is read from its transcript; a Codex rollout is matched by a token this stand-in does not write,
    // so for Codex the daemon's own view of the pane is the report.
    const pane = harness === 'codex' ? await daemon.call('GET', `/v1/ferrets/${id}/snapshot`) : undefined;
    seen = messages.text + (pane?.text ?? '');
    if (seen.includes(FAKE_REPLY)) return seen;
    await Bun.sleep(500);
  }
  return seen;
}

const claudeLogin = (store: 'ferretry' | 'environment', env: Record<string, string> = {}) =>
  [
    'harness: claude-code',
    `store: ${store}`,
    ...(Object.keys(env).length === 0
      ? []
      : ['env:', ...Object.entries(env).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)]),
    '',
  ].join('\n');

describe('a ferret authenticates end to end (merge bar 7)', () => {
  test('(a) Claude OAuth login: a fake .credentials.json where Logins stores it reaches the ferret', async () => {
    const provider = startFakeProvider(FAKE_TOKEN);
    cleanups.push(() => provider.stop());
    const daemon = await boot(provider, home => ({
      [join(home, 'config/logins/oauth.yaml')]: claudeLogin('ferretry'),
      [join(home, 'state/logins/credentials/oauth/.credentials.json')]: JSON.stringify({
        claudeAiOauth: {
          accessToken: FAKE_TOKEN,
          refreshToken: 'fake-refresh',
          expiresAt: 4_102_444_800_000,
          scopes: ['user:inference'],
        },
      }),
    }));

    const pane = await startAndSee(daemon, 'claude-code', 'oauth');

    expect(provider.seen.map(r => [r.path, r.authHeaders, r.tokenMatches])).toEqual([
      ['/v1/messages', ['authorization'], true],
    ]);
    expect(pane).toContain(FAKE_REPLY);
  });

  test('(b) Claude env login (dummy base URL, secret-backed token): the login env reaches the ferret', async () => {
    const provider = startFakeProvider(FAKE_TOKEN);
    cleanups.push(() => provider.stop());
    const daemon = await boot(provider, () => ({}), FAKE_TOKEN, undefined, {
      'logins/envsec.yaml': claudeLogin('environment', {
        ANTHROPIC_BASE_URL: provider.url,
        ANTHROPIC_AUTH_TOKEN: `\${secret:${SECRET_NAME}}`,
      }),
    });

    const pane = await startAndSee(daemon, 'claude-code', 'envsec');

    expect(provider.seen.map(r => [r.path, r.authHeaders, r.tokenMatches])).toEqual([
      ['/v1/messages', ['authorization'], true],
    ]);
    expect(pane).toContain(FAKE_REPLY);
  });

  /** Starts a ferret on `login` without waiting for a reply, and returns once the stand-in claude has been launched. */
  const startAndLaunch = async (daemon: Daemon, login: string) => {
    const started = await daemon.call(
      'POST',
      '/v1/ferrets',
      { harness: 'claude-code', login, folder: daemon.folder, prompt: 'say hello', mode: 'interactive' },
      { 'x-fy-request-id': crypto.randomUUID() },
    );
    // A project's own settings are never a reason to refuse the start.
    expect(started.status, `start: ${started.text}`).toBeLessThan(300);
    const until = Date.now() + SEE_MS;
    while (Date.now() < until) {
      const launched = daemon.launches().filter(record => record.binary === 'claude');
      if (launched.length > 0) return launched.at(-1);
      await Bun.sleep(250);
    }
    throw new Error('the stand-in claude was never launched');
  };

  /** What no launch may hold: the credential, in an argv, a pane's recorded start command, a process listing or a file. */
  const expectNoCredentialAnywhere = (daemon: Daemon, argv: unknown) => {
    expect(JSON.stringify(argv)).not.toContain(FAKE_TOKEN);
    const tmux = Bun.which('tmux') ?? 'tmux';
    const paneCommands = spawnSync(
      tmux,
      ['-S', join(daemon.home, 'state/terminals/tmux.sock'), 'list-panes', '-a', '-F', '#{pane_start_command}'],
      { encoding: 'utf8' },
    ).stdout;
    expect(paneCommands).toContain('--settings');
    expect(paneCommands).not.toContain(FAKE_TOKEN);
    expect(spawnSync('ps', ['-eo', 'args'], { encoding: 'utf8' }).stdout).not.toContain(FAKE_TOKEN);
    const homes = join(daemon.home, 'state/claude-code/agent-homes');
    const ferretHome = readdirSync(homes)
      .map(name => join(homes, name))
      .find(path => existsSync(join(path, 'launch-settings.json')));
    expect(ferretHome).toBeDefined();
    const overlay = join(ferretHome as string, 'launch-settings.json');
    // No login environment is pinned in the ferret's private settings file: a project's own settings win over it.
    expect(JSON.parse(readFileSync(overlay, 'utf8')).env).toBeUndefined();
    expect(readFileSync(overlay, 'utf8')).not.toContain(FAKE_TOKEN);
    expect(statSync(overlay).mode & 0o777).toBe(0o600);
  };

  test('(d) Claude env login in a project whose .claude/settings.local.json blanks ANTHROPIC_BASE_URL: the PROJECT wins, the start is not refused, and no credential is in an argv (!A500)', async () => {
    const provider = startFakeProvider(FAKE_TOKEN);
    cleanups.push(() => provider.stop());
    const daemon = await boot(provider, () => ({}), FAKE_TOKEN, undefined, {
      'logins/envblank.yaml': claudeLogin('environment', {
        ANTHROPIC_BASE_URL: provider.url,
        ANTHROPIC_AUTH_TOKEN: `\${secret:${SECRET_NAME}}`,
      }),
    });
    // The project's own settings blank the login's provider: Claude Code ranks them above the process environment.
    await mkdir(join(daemon.folder, '.claude'), { recursive: true });
    await writeFile(
      join(daemon.folder, '.claude/settings.local.json'),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: '' } }),
    );

    const launched = await startAndLaunch(daemon, 'envblank');

    // 1. The project's blank beat the login's base URL (the login's value is in the process environment only), so the
    //    provider was never reached.
    expect(launched?.baseUrl).toBeNull();
    await Bun.sleep(1_000);
    expect(provider.seen).toEqual([]);
    // 2. Still no credential anywhere, and no pin in the ferret's private settings file.
    expectNoCredentialAnywhere(daemon, launched?.argv);
  });

  test('(d2) Claude env login whose store-held token the project also sets: not refused, the project’s value wins, no credential in an argv (!A500)', async () => {
    const provider = startFakeProvider(FAKE_TOKEN);
    cleanups.push(() => provider.stop());
    const daemon = await boot(provider, () => ({}), FAKE_TOKEN, undefined, {
      'logins/envtoken.yaml': claudeLogin('environment', {
        ANTHROPIC_BASE_URL: provider.url,
        ANTHROPIC_AUTH_TOKEN: `\${secret:${SECRET_NAME}}`,
      }),
    });
    await mkdir(join(daemon.folder, '.claude'), { recursive: true });
    await writeFile(
      join(daemon.folder, '.claude/settings.json'),
      JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'project-token' } }),
    );

    const launched = await startAndLaunch(daemon, 'envtoken');

    // The base URL is the login's (the project did not set it); the token the provider sees is the project's.
    expect(launched?.baseUrl).toBe(provider.url);
    const until = Date.now() + SEE_MS;
    while (provider.seen.length === 0 && Date.now() < until) await Bun.sleep(250);
    expect(provider.seen.map(r => [r.path, r.authHeaders, r.tokenMatches])).toEqual([
      ['/v1/messages', ['authorization'], false],
    ]);
    expectNoCredentialAnywhere(daemon, launched?.argv);
  });

  test('(c) Codex login: a fake auth.json where Logins stores it reaches the ferret', async () => {
    const provider = startFakeProvider(FAKE_TOKEN);
    cleanups.push(() => provider.stop());
    const daemon = await boot(provider, home => ({
      [join(home, 'config/logins/cdx.yaml')]: 'harness: codex\nstore: ferretry\n',
      [join(home, 'state/logins/credentials/cdx/auth.json')]: JSON.stringify({
        OPENAI_API_KEY: FAKE_TOKEN,
        auth_mode: 'apikey',
      }),
    }));

    const pane = await startAndSee(daemon, 'codex', 'cdx');

    expect(provider.seen.map(r => [r.path, r.authHeaders, r.tokenMatches])).toEqual([
      ['/v1/responses', ['authorization'], true],
    ]);
    expect(pane).toContain(FAKE_REPLY);
  });
});

/**
 * THE MERGE-BAR LINE: A START BY RUNTIME REACHES THE PROVIDER SIGNED IN (docs/rebuild/merge-bar.md, before-merge line 11;
 * smoke step 2).
 *
 * The 5.0 preview answered `fy new` / `fy start` with "a start must carry x-fy-request-id" and no ferret was made, and
 * once that was fixed `fy new --runtime rt` still launched SIGNED OUT: the request names a runtime, nothing turned the
 * runtime into its login, so the record had no login and the launch carried no credential. Every test above starts a
 * ferret with a raw `POST /v1/ferrets` that names the login itself, which is exactly the part that was broken, so none
 * could see it. These cases start the way the owner does, on a configured runtime (`login: oauth`, a real profile):
 *
 * - the real `fy` process (the production entry point, its real shell client and HTTP transport) typing `fy new --runtime`;
 * - the APP's new-ferret request: the app's own draft/request builder (`startFerret`, the code behind the New ferret
 *   button) sending through a loopback client to the real fyd. The client applies the SAME closed header list the app's
 *   `DaemonClient` uses (`allowedCallHeaders`), so a header the app does not set does not reach the daemon. NOT covered
 *   (a test in this package may not import the app shell, rebuild-checks `context-imports`): the app's `DaemonClient`
 *   route guard and inventory hash check, the sealed session / carrier the browser really uses to reach the daemon (that
 *   needs a paired device and a relay), and the React page that collects the draft. The shell's own client tests cover
 *   the guard and the header list with a fake transport; all of them reach this same `POST /v1/ferrets`.
 *
 * The fake provider here is STRICT: it answers only a request carrying the signed-in login's credential, so a signed-out
 * launch gets no reply. Each case reads the reply back and checks the non-secret login facts of the launch (its auth kind
 * and the credential store the login names; never a value). Same stand-in harness; loopback only, fake values only.
 */
describe('a start by runtime reaches the provider signed in (merge bar 11)', () => {
  const fy = async (daemon: Daemon, args: readonly string[]) => {
    const proc = Bun.spawn([process.execPath, FY, ...args], {
      cwd: daemon.folder,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: join(daemon.home, '..', 'user-home'),
        NO_COLOR: '1',
        FY_HOME: daemon.home,
      },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 60_000,
      killSignal: 'SIGKILL',
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, out, err };
  };

  /** The fake OAuth login `oauth` (signed in) and the runtime `rt` over it: `login`, a real `profile`, launched as an agent. */
  const oauthWorld = (home: string): Record<string, string> => ({
    [join(home, 'config/logins/oauth.yaml')]: claudeLogin('ferretry'),
    [join(home, 'config/profiles/plain.yaml')]: 'contents: []\n',
    [join(home, 'config/runtimes/rt.yaml')]: 'login: oauth\nprofile: plain\nagent: true\n',
    // A runtime whose login has no credential: it exists but cannot serve a launch (needs sign-in).
    [join(home, 'config/logins/signedout.yaml')]: claudeLogin('ferretry'),
    [join(home, 'config/runtimes/rt-signedout.yaml')]: 'login: signedout\nprofile: plain\nagent: true\n',
    [join(home, 'state/logins/credentials/oauth/.credentials.json')]: JSON.stringify({
      claudeAiOauth: {
        accessToken: FAKE_TOKEN,
        refreshToken: 'fake-refresh',
        expiresAt: 4_102_444_800_000,
        scopes: ['user:inference'],
      },
    }),
  });

  const bootStrict = async () => {
    const provider = startFakeProvider(FAKE_TOKEN, { strict: true });
    cleanups.push(() => provider.stop());
    return { provider, daemon: await boot(provider, oauthWorld) };
  };

  /** The stand-in claude's launch record of the ferret: waits for it. */
  const launchedClaude = async (daemon: Daemon) => {
    const until = Date.now() + SEE_MS;
    while (Date.now() < until) {
      const launched = daemon.launches().filter(record => record.binary === 'claude');
      if (launched.length > 0) return launched.at(-1);
      await Bun.sleep(250);
    }
    throw new Error('the stand-in claude was never launched');
  };

  /** Waits for the daemon's own transcript read of ferret `id` to show the provider's reply. */
  const readsReply = async (daemon: Daemon, id: string) => {
    const until = Date.now() + SEE_MS;
    let seen = '';
    while (Date.now() < until && !seen.includes(FAKE_REPLY)) {
      seen = (await daemon.call('GET', `/v1/ferrets/${id}/messages`)).text;
      if (!seen.includes(FAKE_REPLY)) await Bun.sleep(500);
    }
    return seen;
  };

  /** What the launch proves of the login, none of it secret: the auth kind it found and the credential store it was handed. */
  const expectSignedInOn = async (daemon: Daemon, provider: FakeProvider, id: string) => {
    expect(await readsReply(daemon, id)).toContain(FAKE_REPLY);
    const launched = await launchedClaude(daemon);
    expect(launched?.auth).toBe('oauth-file');
    // Logins' store variable reached the CLI itself (the direct launch, not a wrapper), as the `--login` path gives it.
    expect(launched?.envNames).toContain('CLAUDE_SECURESTORAGE_CONFIG_DIR');
    expect(String(launched?.storeDir)).toMatch(/\/credentials\/oauth$/u);
    expect(provider.seen.map(r => [r.path, r.authHeaders, r.tokenMatches])).toEqual([
      ['/v1/messages', ['authorization'], true],
    ]);
  };

  /** Runs the real `fy` with `args`, and returns the ferret id it printed (`callsign (id)  state ...`). */
  const startsViaFy = async (daemon: Daemon, args: readonly string[]) => {
    const started = await fy(daemon, args);
    // The shell forwarded the request id: no refusal, an exit of 0 and a ferret id on the screen.
    expect(`${started.out}\n${started.err}`.includes('x-fy-request-id')).toBe(false);
    expect(started.code, `fy start: ${started.err}`).toBe(0);
    const id = /\(([^()\s]+)\)/u.exec(started.out)?.[1];
    expect(typeof id).toBe('string');
    const listed = await fy(daemon, ['ps']);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain(id as string);
    return id as string;
  };

  test('`fy start --harness claude-code --login oauth` makes a ferret, which `fy ps` lists, and the reply reaches it', async () => {
    const { provider, daemon } = await bootStrict();
    const id = await startsViaFy(daemon, [
      'start',
      '--harness',
      'claude-code',
      '--login',
      'oauth',
      '--mode',
      'interactive',
      '--cwd',
      daemon.folder,
      'say hello',
    ]);
    await expectSignedInOn(daemon, provider, id);
  });

  test('`fy new --runtime rt` (the command the owner types) on a configured runtime reaches the provider signed in', async () => {
    const { provider, daemon } = await bootStrict();
    const id = await startsViaFy(daemon, [
      'new',
      '--runtime',
      'rt',
      '--mode',
      'interactive',
      '--cwd',
      daemon.folder,
      'say hello',
    ]);
    const listing = JSON.parse((await daemon.call('GET', '/v1/ferrets')).text) as { id: string; runtime?: string }[];
    expect(listing.find(ferret => ferret.id === id)?.runtime).toBe('rt');
    await expectSignedInOn(daemon, provider, id);
  });

  test("the app's new-ferret request (its own request builder, the app's header list, a loopback client) on a configured runtime reaches the provider signed in", async () => {
    const { provider, daemon } = await bootStrict();
    // The app's own start: `startFerret` builds `POST /v1/ferrets` from the form's draft, and the client sends it.
    const id = await startFerret(loopbackClient(daemon), {
      ...emptyNewFerretDraft,
      runtime: 'rt',
      folder: daemon.folder,
      mode: 'interactive',
      prompt: 'say hello',
    });
    await expectSignedInOn(daemon, provider, id);
  });

  /** The world above plus a second fake OAuth login `off` the owner switched off (valid sign-in material), and `rt-off` over it. */
  const withSwitchedOffLogin = (home: string): Record<string, string> => {
    const files = oauthWorld(home);
    return {
      ...files,
      [join(home, 'config/logins/off.yaml')]: `${claudeLogin('ferretry')}disabled: {reason: owner-off}\n`,
      [join(home, 'state/logins/credentials/off/.credentials.json')]: files[
        join(home, 'state/logins/credentials/oauth/.credentials.json')
      ] as string,
      [join(home, 'config/runtimes/rt-off.yaml')]: 'login: off\nprofile: plain\nagent: true\n',
    };
  };

  /** A stopped ferret as the v4 -> v5 converter writes it: a runtime, a harness, and NO login. */
  const convertedRecord = (home: string): Record<string, string> => ({
    ...oauthWorld(home),
    [join(home, 'state/ferrets/tokens.json')]: JSON.stringify({ format: 1, tokens: [] }),
    [join(home, 'state/ferrets/converted/ferret.json')]: JSON.stringify({
      format: 1,
      id: 'converted',
      name: 'cedar',
      role: 'lead',
      birth: 'person',
      harness: 'claude-code',
      runner: 'tmux',
      runtime: 'rt',
      mode: 'interactive',
      folder: join(home, '..', 'work'),
      state: 'stopped',
      createdAt: '2026-11-01T00:00:00Z',
      stateAt: '2026-11-01T00:00:00Z',
    }),
  });

  test('a converted ferret (a runtime, no login) RESUMES signed in on its runtime’s login: resume resolves the runtime like a start', async () => {
    const provider = startFakeProvider(FAKE_TOKEN, { strict: true });
    cleanups.push(() => provider.stop());
    const daemon = await boot(provider, convertedRecord);

    const resumed = await daemon.call('POST', '/v1/ferrets/converted/resume', { message: 'say hello' });

    expect(resumed.status, resumed.text).toBeLessThan(300);
    // The daemon cannot read a converted ferret's transcript back, so the proof is the launch's own facts and the strict
    // provider seeing the signed-in credential on the request the resumed ferret made.
    const launched = await launchedClaude(daemon);
    expect(launched?.auth).toBe('oauth-file');
    expect(launched?.envNames).toContain('CLAUDE_SECURESTORAGE_CONFIG_DIR');
    expect(String(launched?.storeDir)).toMatch(/\/credentials\/oauth$/u);
    const until = Date.now() + SEE_MS;
    while (Date.now() < until && provider.seen.length === 0) await Bun.sleep(250);
    expect(provider.seen.map(r => [r.path, r.authHeaders, r.tokenMatches])).toEqual([
      ['/v1/messages', ['authorization'], true],
    ]);
  });

  test('a converted ferret whose runtime cannot serve (its login needs sign-in) is NOT resumed signed out', async () => {
    const provider = startFakeProvider(FAKE_TOKEN, { strict: true });
    cleanups.push(() => provider.stop());
    const daemon = await boot(provider, home => {
      const files = convertedRecord(home);
      const path = join(home, 'state/ferrets/converted/ferret.json');
      return { ...files, [path]: (files[path] as string).replace('"runtime":"rt"', '"runtime":"rt-signedout"') };
    });

    const resumed = await daemon.call('POST', '/v1/ferrets/converted/resume', {});

    expect(resumed.status).toBeGreaterThanOrEqual(400);
    expect(resumed.text).toContain('rt-signedout');
    expect(daemon.launches().filter(record => record.binary === 'claude')).toEqual([]);
  });

  test('a runtime is its own account: another login named beside it is refused, its own login starts', async () => {
    const provider = startFakeProvider(FAKE_TOKEN, { strict: true });
    cleanups.push(() => provider.stop());
    const daemon = await boot(provider, withSwitchedOffLogin);
    const start = async (body: Record<string, unknown>) =>
      await daemon.call(
        'POST',
        '/v1/ferrets',
        { folder: daemon.folder, mode: 'interactive', prompt: 'say hello', ...body },
        { 'x-fy-request-id': crypto.randomUUID() },
      );

    const refused = await start({ runtime: 'rt', login: 'off' });

    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.text).toContain('signs in with its own login, not off');
    expect(daemon.launches().filter(record => record.binary === 'claude')).toEqual([]);
    expect(JSON.parse((await daemon.call('GET', '/v1/ferrets')).text)).toEqual([]);

    const started = await start({ runtime: 'rt', login: 'oauth' });
    expect(started.status, started.text).toBeLessThan(300);
    await expectSignedInOn(daemon, provider, (JSON.parse(started.text) as { id: string }).id);
  });

  test('a login the owner switched off is refused when named directly or through its runtime: nothing is spent', async () => {
    const provider = startFakeProvider(FAKE_TOKEN, { strict: true });
    cleanups.push(() => provider.stop());
    const daemon = await boot(provider, withSwitchedOffLogin);

    const direct = await fy(daemon, [
      'start',
      '--harness',
      'claude-code',
      '--login',
      'off',
      '--mode',
      'interactive',
      '--cwd',
      daemon.folder,
      'say hello',
    ]);
    const viaRuntime = await fy(daemon, [
      'new',
      '--runtime',
      'rt-off',
      '--mode',
      'interactive',
      '--cwd',
      daemon.folder,
      'say hello',
    ]);

    expect(direct.code).not.toBe(0);
    expect(`${direct.out}\n${direct.err}`).toContain('login off is switched off (owner-off)');
    expect(viaRuntime.code).not.toBe(0);
    expect(`${viaRuntime.out}\n${viaRuntime.err}`).toContain('switched off');
    expect(JSON.parse((await daemon.call('GET', '/v1/ferrets')).text)).toEqual([]);
    expect(daemon.launches().filter(record => record.binary === 'claude')).toEqual([]);
    expect(provider.seen).toEqual([]);
  });

  test("the app's new-ferret start whose reply was lost, then submitted again as the page does, starts ONE ferret", async () => {
    const { provider, daemon } = await bootStrict();
    const real = loopbackClient(daemon);
    const lose = async (route: string, init?: Parameters<FerretsClient['call']>[1]) => {
      await real.call(route, init);
      throw new TypeError('fetch failed');
    };
    const draft = {
      ...emptyNewFerretDraft,
      runtime: 'rt',
      folder: daemon.folder,
      mode: 'interactive' as const,
      prompt: 'say hello',
    };
    // The first attempt: BOTH sends reach the daemon but their answers are lost, and so is the recovery read.
    let losing = 3;
    const flaky: FerretsClient = {
      call: (async (route: string, init?: Parameters<FerretsClient['call']>[1]) => {
        if (losing > 0) {
          losing -= 1;
          return await lose(route, init);
        }
        return await real.call(route, init);
      }) as FerretsClient['call'],
    };
    const attempt = startAttemptFor(draft);

    await expect(startFerret(flaky, draft, attempt)).rejects.toThrow('fetch failed');
    // The page keeps the attempt; the person presses Create again with the draft unchanged.
    const id = await startFerret(flaky, draft, startAttemptFor(draft, attempt));

    const listing = JSON.parse((await daemon.call('GET', '/v1/ferrets')).text) as { id: string }[];
    expect(listing.map(ferret => ferret.id)).toEqual([id]);
    await expectSignedInOn(daemon, provider, id);
  });

  test('a runtime that does not exist, or whose login needs sign-in, is refused with a sentence naming it: no ferret, no signed-out launch', async () => {
    const { daemon } = await bootStrict();
    for (const runtime of ['no-such-runtime', 'rt-signedout']) {
      const refused = await fy(daemon, [
        'new',
        '--runtime',
        runtime,
        '--mode',
        'interactive',
        '--cwd',
        daemon.folder,
        'say hello',
      ]);
      expect(refused.code, `fy new ${runtime}`).not.toBe(0);
      expect(`${refused.out}\n${refused.err}`).toContain(runtime);
    }
    const listing = JSON.parse((await daemon.call('GET', '/v1/ferrets')).text) as unknown[];
    expect(listing).toEqual([]);
    expect(daemon.launches().filter(record => record.binary === 'claude')).toEqual([]);
  });
});

/**
 * The per-daemon client the ferrets app half is handed, over loopback HTTP to a real fyd. It fills the route's path
 * parameters and sends the call's headers through the closed list every shell uses (`allowedCallHeaders`); it holds the
 * admin credential the way a paired device's session would. The sealed session the browser really uses is NOT part of this.
 */
function loopbackClient(daemon: Daemon): FerretsClient {
  return {
    call: async <Answer = unknown>(
      route: string,
      init?: {
        readonly params?: Readonly<Record<string, string>>;
        readonly query?: Readonly<Record<string, string>>;
        readonly body?: unknown;
        readonly headers?: Parameters<typeof allowedCallHeaders>[0];
      },
    ): Promise<Answer> => {
      const [method, template] = route.split(' ') as [string, string];
      const path = template.replace(/:(\w+)/gu, (_, name: string) => encodeURIComponent(init?.params?.[name] ?? ''));
      const query = init?.query === undefined ? '' : `?${new URLSearchParams(init.query).toString()}`;
      const response = await fetch(`${daemon.base}${path}${query}`, {
        method,
        headers: {
          authorization: `Bearer ${daemon.admin}`,
          'x-ferretry-client': 'cli',
          accept: 'application/json',
          ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...allowedCallHeaders(init?.headers),
        },
        ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      const text = await response.text();
      // An answered refusal carries its status, as the shell's `DaemonCallError` does: it is not a lost answer.
      if (!response.ok)
        throw Object.assign(new Error(`${route} answered ${String(response.status)}: ${text}`), {
          status: response.status,
        });
      return JSON.parse(text) as Answer;
    },
  };
}

// THE REAL BINARY, for (b) only. Measured (claude 2.1.317, strace, a loopback server): with ANTHROPIC_BASE_URL and
// ANTHROPIC_AUTH_TOKEN the real claude makes `POST /v1/messages` with `Authorization: Bearer <token>` and no other host
// is contacted, so this case is hermetic. It runs only where a `claude` is on PATH, and says so when it does not.
// (The OAuth case cannot be run on the real binary: it contacts api.anthropic.com to refresh. Codex is not on PATH in
// CI and its `-c model_providers` route is not what the harness launches with.)
const realClaude = Bun.which('claude');
describe('a ferret authenticates end to end with the REAL claude binary (merge bar 7, case b)', () => {
  test.skipIf(realClaude === null)(
    '(b) Claude env login on the real claude: the first request reaches the fake provider with the Bearer token',
    async () => {
      const provider = startFakeProvider(FAKE_TOKEN);
      cleanups.push(() => provider.stop());
      const daemon = await boot(provider, () => ({}), FAKE_TOKEN, realClaude ?? undefined, {
        'logins/envreal.yaml': claudeLogin('environment', {
          ANTHROPIC_BASE_URL: provider.url,
          ANTHROPIC_AUTH_TOKEN: `\${secret:${SECRET_NAME}}`,
        }),
      });

      await startAndSee(daemon, 'claude-code', 'envreal');

      // The real TUI does not write the stand-in's transcript, so the proof here is the provider's own record.
      expect(
        provider.seen.some(r => r.path === '/v1/messages' && r.authHeaders.includes('authorization') && r.tokenMatches),
      ).toBe(true);
    },
  );
  if (realClaude === null) test('(b) real claude case skipped: no `claude` binary on PATH', () => {});
});
