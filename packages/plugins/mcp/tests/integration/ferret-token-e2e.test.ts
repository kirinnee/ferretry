/**
 * A RUNNING CLAUDE FERRET KEEPS ITS SIGNED-IN MCP TOKEN FRESH, with no restart (docs/mcp-oauth.md › A ferret that outlives
 * its token), proved against real processes end to end:
 *
 * - the real `fyd` (every real plugin) on a temp home, with a machine MCP server signed in through the real sign-in
 *   routes against a FAKE OAuth provider on loopback (ports 7480–7499);
 * - the real `claude` CLI in a temp HOME and CLAUDE_CONFIG_DIR, whose server entry is the one the launch writes
 *   (`headersHelper: fy mcp token <VARIABLE>`), connecting to that provider's MCP endpoint;
 * - the real `fy` as the ferret, the owner and other ferrets.
 *
 * Fake tokens only, minted by the fake provider. The Claude child gets a SCRUBBED environment (a session's own
 * CLAUDE_CONFIG_DIR and credentials never reach it).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootRealDaemon, type RealDaemon } from './support/real-daemon.ts';
import { mcpOAuthSecretNames, mcpTokenCommand } from '../../contract/index.ts';
import { FakeProvider } from '../unit/oauth/fake-provider.ts';

const ROOT = join(import.meta.dir, '../../../../..');
const FY = join(ROOT, 'packages/cli/bin/fy.ts');
const PWA_REDIRECT = 'https://ferretry.example.test/oauth/mcp-callback';

let provider: FakeProvider;
let server: ReturnType<typeof Bun.serve>;
let daemon: RealDaemon;
let scratch: string;
let variable: string;
let staleToken: string;

/** The first loopback port of the test range this process can bind. */
function listen(fetch: (request: Request) => Promise<Response>): ReturnType<typeof Bun.serve> {
  for (let port = 7480; port <= 7499; port += 1)
    try {
      return Bun.serve({ hostname: '127.0.0.1', port, fetch });
    } catch {
      // taken by another test daemon: try the next
    }
  throw new Error('no free port in 7480-7499');
}

beforeAll(async () => {
  // Every token this provider issues lives 30 s, inside the sign-in service's 60 s margin: each use finds it due.
  let current: FakeProvider | undefined;
  server = listen(async request => await (current as FakeProvider).handle(request));
  provider = new FakeProvider(`http://127.0.0.1:${String(server.port)}`, { expiresIn: 30 });
  current = provider;
  variable = mcpOAuthSecretNames('linear', provider.serverUrl).variable;
  scratch = await mkdtemp(join(tmpdir(), 'fy-token-e2e-'));
  daemon = await bootRealDaemon(
    [
      { id: 'f1', mode: 'auto', harness: 'claude-code', runtime: 'claude-default' },
      { id: 'f2', mode: 'auto', harness: 'claude-code', runtime: 'claude-default' },
      // A ferret whose runtime does not carry the server.
      { id: 'f3', mode: 'auto', harness: 'claude-code' },
    ],
    {
      'config/logins/claude-you.yaml': 'harness: claude-code\nstore: ferretry\n',
      'config/runtimes/claude-default.yaml': 'login: claude-you\nprofile: default\nagent: true\n',
      'config/profiles/default.yaml': 'contents:\n  - mcp/linear\n',
      'config/mcp/linear.yaml': `url: ${provider.serverUrl}\nauth: oauth\n`,
    },
  );
  // Sign in through the real routes, as the owner at the machine.
  const start = await daemon.call('POST', '/v1/mcp/auth/linear', { redirectUri: PWA_REDIRECT });
  expect(start.status).toBe(200);
  const flow = JSON.parse(start.text) as { flowId: string; authorizeUrl: string };
  const callback = await provider.approve(flow.authorizeUrl);
  const done = await daemon.call('POST', `/v1/mcp/auth/flows/${flow.flowId}`, { callback });
  expect(done.status).toBe(200);
  // What the ferret's environment held when it LAUNCHED: the access token the sign-in filed (the access, then the refresh).
  staleToken = provider.issued.at(-2) as string;
});

afterAll(async () => {
  await daemon?.dispose();
  server?.stop(true);
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
});

/**
 * The real Claude CLI, as a ferret's pane would run it: the entry the launch writes for a signed-in server, the launch
 * variable holding the token it was LAUNCHED with, and `fy` on PATH acting as that ferret.
 */
async function claudeConnects(ferret: string): Promise<string> {
  const home = join(scratch, `claude-${ferret}-${String(Date.now())}`);
  const bin = join(home, 'bin');
  await mkdir(join(home, '.claude'), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'fy'), `#!/bin/sh\nexec ${process.execPath} ${FY} "$@"\n`);
  await chmod(join(bin, 'fy'), 0o755);
  await writeFile(
    join(home, '.claude', '.claude.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      mcpServers: {
        linear: {
          type: 'http',
          url: provider.serverUrl,
          headers: { Authorization: `Bearer \${${variable}}` },
          headersHelper: mcpTokenCommand(variable),
        },
      },
    }),
  );
  const fy = daemon.environment(ferret);
  const proc = Bun.spawn({
    cmd: ['claude', 'mcp', 'list'],
    cwd: home,
    // SCRUBBED: nothing of the caller's CLAUDE_*/ANTHROPIC_* environment, only what a pane would hold.
    env: {
      PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      LANG: 'C.UTF-8',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      FY_HOME: fy.FY_HOME as string,
      FY_URL: fy.FY_URL as string,
      FY_SESSION_ID: fy.FY_SESSION_ID as string,
      FY_SESSION_TOKEN: fy.FY_SESSION_TOKEN as string,
      [variable]: staleToken,
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return out;
}

describe('a running Claude ferret and its signed-in MCP server, with no restart', () => {
  test('Claude runs the headersHelper and the server sees a FRESH token, not the launch-time one, each time it rotates', async () => {
    const before = provider.bearersSeen.length;
    const refreshes = provider.tokenRequests.length;

    const first = await claudeConnects('f1');
    const second = await claudeConnects('f1');

    // The helper asked the daemon, which renewed the sign-in at the provider (a refresh grant) before answering.
    const grants = provider.tokenRequests.slice(refreshes).map(form => form.get('grant_type'));
    expect(grants.length).toBeGreaterThanOrEqual(2);
    expect(new Set(grants)).toEqual(new Set(['refresh_token']));
    const seen = provider.bearersSeen.slice(before);
    expect(seen.length).toBeGreaterThan(0);
    // Never the token the ferret was launched with: the helper's header replaced the static one…
    expect(seen).not.toContain(staleToken);
    // …every token it presented was issued by the provider AFTER the sign-in, and the second run's differs from the first's.
    for (const bearer of seen) expect(provider.issued).toContain(bearer);
    expect(new Set(seen).size).toBeGreaterThanOrEqual(2);
    expect(first).toContain('linear');
    expect(second).toContain('linear');
  }, 120_000);

  test('fy mcp token, as the ferret itself, prints exactly the headers object', async () => {
    const ran = await daemon.fy('f1', ['mcp', 'token', variable]);

    expect(ran.code).toBe(0);
    expect(ran.err).toBe('');
    const headers = ran.json as { Authorization: string };
    expect(Object.keys(headers)).toEqual(['Authorization']);
    expect(provider.issued).toContain(headers.Authorization.replace(/^Bearer /u, ''));
  });
});

describe('nobody else gets a ferret’s token', () => {
  const asHttp = async (credential: string, path: string, headers: Record<string, string> = {}) => {
    const fy = daemon.environment('f1');
    return await fetch(`${fy.FY_URL}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ variable }),
    });
  };
  const tokenOf = (ferret: string): string => daemon.environment(ferret).FY_SESSION_TOKEN as string;

  test('another ferret asking for f1’s route is refused 403, and no refresh is spent', async () => {
    const refreshes = provider.tokenRequests.length;

    const refused = await asHttp(tokenOf('f2'), '/v1/ferrets/f1/mcp/token');

    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { code: string }).code).toBe('not_this_ferret');
    expect(provider.tokenRequests.length).toBe(refreshes);
  });

  test('the owner (the admin token), even naming the ferret in a header, is refused 403', async () => {
    const admin = await daemon.call(
      'POST',
      '/v1/ferrets/f1/mcp/token',
      { variable },
      { 'x-ferretry-session-id': 'f1' },
    );

    expect(admin.status).toBe(403);
    expect(admin.text).not.toContain('Bearer');
  });

  test('fy mcp token as the owner exits 2 outside a ferret, and prints nothing', async () => {
    const ran = await daemon.fy('owner', ['mcp', 'token', variable]);

    expect(ran.code).toBe(2);
    expect(ran.out).toBe('');
  });

  test('a ferret whose own launch does not hold that server is told so: 404, nothing handed over', async () => {
    const ran = await daemon.fy('f3', ['mcp', 'token', variable]);

    expect(ran.code).toBe(1);
    expect(ran.out).toBe('');
    expect(ran.err).toContain('not a sign-in variable this ferret was launched with');
  });

  test('a ferret cannot name a variable of the right shape for a server it never had', async () => {
    const ran = await daemon.fy('f1', ['mcp', 'token', 'FY_MCP_NOPE_0123456789ABCDEF_TOKEN']);

    expect(ran.code).toBe(1);
    expect(ran.out).toBe('');
  });

  test('no fake token the provider ever issued is in the security log', async () => {
    const audit = await daemon.call('GET', '/v1/audit');

    for (const issued of provider.issued) expect(audit.text).not.toContain(issued);
    // The security log names WHICH ferret and WHICH variable, and nothing that could be used as a token.
    expect(audit.text).toContain('mcp-token');
    expect(audit.text).toContain(variable);
  });
});
