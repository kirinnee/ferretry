/**
 * The update ports over real child processes: the host's `bunSpawn` starting stand-in programs (small shell scripts in a
 * temp folder, put first on the child's PATH) for `claude`, `readlink`, `nix`, `printenv`, `uname` and `which`; and the
 * newest-version question put to a real HTTP server on loopback. Nothing leaves this machine, and no real `claude`, `nix`
 * or npm is ever asked.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchPort } from '@ferretry/kernel/contract';
import { bunSpawn } from '@ferretry/kernel/host';
import type { HarnessConfig } from '../../contract/index.ts';
import {
  factsSource,
  hostFacts,
  locationSource,
  npmLatest,
  probe,
  spawnRun,
} from '../../daemon/adapters/update-ports.ts';

let folder = '';

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'fy-update-ports-'));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

/** A stand-in program: a shell script, executable, in `directory` (the test folder by default). */
const standIn = async (name: string, body: string, directory = folder): Promise<string> => {
  const path = join(directory, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
};

/** The stand-ins come first on the child's PATH; the rest of the machine's PATH is behind them for `sleep` and `echo`. */
const spawnWith = (env: Record<string, string> = {}, path = `${folder}:${process.env['PATH'] ?? '/usr/bin:/bin'}`) =>
  bunSpawn({ PATH: path, ...env });

const config = (document: Partial<HarnessConfig>): HarnessConfig => ({
  searchPaths: [],
  permissionMode: 'auto',
  ...document,
});

const NIX_HASH = 'a'.repeat(32);

describe('spawnRun', () => {
  it('reports the exit code and the last lines a program printed, from both streams', async () => {
    const program = await standIn('speaks', 'echo out-line; echo err-line >&2; exit 4');

    const result = await spawnRun(spawnWith())({ program, args: [], timeoutMs: 5_000 });

    expect(result).toEqual({ kind: 'exited', code: 4, tail: ['out-line', 'err-line'] });
  });

  it('says a program that cannot start did not start, with the reason', async () => {
    const result = await spawnRun(spawnWith())({
      program: join(folder, 'no-such-program'),
      args: [],
      timeoutMs: 5_000,
    });

    expect(result.kind).toBe('not-started');
  });
});

describe('hostFacts', () => {
  it('asks for the home and the platform once each and lower-cases the platform', async () => {
    await standIn('printenv', 'echo x >> "$CALLS"; echo "$FAKE_HOME"');
    await standIn('uname', 'echo x >> "$CALLS"; echo Linux');
    const calls = join(folder, 'calls.txt');
    const host = hostFacts(spawnWith({ CALLS: calls, FAKE_HOME: '/placeholder/home/me' }));

    expect(await host.home()).toBe('/placeholder/home/me');
    expect(await host.home()).toBe('/placeholder/home/me');
    expect(await host.platform()).toBe('linux');
    expect(await host.platform()).toBe('linux');

    expect((await readFile(calls, 'utf8')).trim().split('\n')).toHaveLength(2);
  });

  it('knows neither when the programs are missing or fail', async () => {
    const empty = join(folder, 'empty');
    await mkdir(empty);
    await standIn('uname', 'exit 1');

    expect(await hostFacts(spawnWith({}, empty)).home()).toBe('');
    expect(await hostFacts(spawnWith()).platform()).toBe('');
  });
});

describe('locationSource', () => {
  const homeFacts = (home: string): ReturnType<typeof hostFacts> => ({
    home: async () => home,
    platform: async () => 'linux',
  });

  it('finds the exact file the config names when it starts', async () => {
    const claude = await standIn('claude', 'echo "2.1.220 (Claude Code)"');

    const found = await locationSource(
      spawnWith(),
      () => config({ binary: claude }),
      homeFacts('/placeholder/home'),
    ).locate();

    expect(found).toEqual({
      outcome: 'located',
      path: claude,
      rule: 'explicit path',
      declaredBy: 'config/harness-claude-code.yaml binary',
    });
  });

  it('expands a leading ~ with the host home and starts the file there', async () => {
    await standIn('claude', 'exit 0');

    const found = await locationSource(spawnWith(), () => config({ binary: '~/claude' }), homeFacts(folder)).locate();

    expect(found).toMatchObject({ outcome: 'located', path: `${folder}/claude` });
  });

  it('starts the version question in the throwaway environment, not the host’s', async () => {
    const seen = join(folder, 'seen.txt');
    const claude = await standIn('claude', 'echo "$HOME|$CLAUDE_CONFIG_DIR|$HTTPS_PROXY|$CI" > "$SEEN"');

    await locationSource(spawnWith({ SEEN: seen }), () => config({ binary: claude }), homeFacts('/x')).locate();

    expect((await readFile(seen, 'utf8')).trim()).toBe(
      '/nonexistent/fy-harness-probe|/nonexistent/fy-harness-probe/.claude|http://127.0.0.1:9|1',
    );
  });

  it('fails loudly and searches no further when the named file does not start', async () => {
    const claude = await standIn('claude', 'exit 1');
    await standIn('which', `echo ${join(folder, 'claude')}`);

    const found = await locationSource(spawnWith(), () => config({ binary: claude }), homeFacts('/x')).locate();

    expect(found).toEqual({
      outcome: 'override-absent',
      path: claude,
      declaredBy: 'config/harness-claude-code.yaml binary',
      reason: 'nothing there starts when asked for its version',
    });
  });

  it('says why a ~ cannot be expanded when the host home is unknown', async () => {
    for (const binary of ['~', '~/claude']) {
      const found = await locationSource(spawnWith(), () => config({ binary }), homeFacts('')).locate();

      expect(found).toEqual({
        outcome: 'override-absent',
        path: binary,
        declaredBy: 'config/harness-claude-code.yaml binary',
        reason: 'its ~ cannot be expanded because this daemon does not know the home directory',
      });
    }
  });

  it('takes a bare ~ as the home itself, which is not a program that starts', async () => {
    const found = await locationSource(spawnWith(), () => config({ binary: '~' }), homeFacts(folder)).locate();

    expect(found).toMatchObject({ outcome: 'override-absent', path: folder });
  });

  it('walks the search directories in order, skipping one it cannot expand and one whose claude does not start', async () => {
    const broken = join(folder, 'broken');
    const good = join(folder, 'good');
    await mkdir(broken);
    await mkdir(good);
    await standIn('claude', 'exit 1', broken);
    await standIn('claude', 'exit 0', good);

    const found = await locationSource(
      spawnWith(),
      () => config({ searchPaths: ['~/anywhere', join(folder, 'missing'), broken, `${good}/`] }),
      homeFacts(''),
    ).locate();

    expect(found).toEqual({
      outcome: 'located',
      path: `${good}/claude`,
      rule: 'search directory',
      declaredBy: 'config/harness-claude-code.yaml searchPaths[3]',
    });
  });

  it('expands a ~ in a search directory with the host home', async () => {
    await standIn('claude', 'exit 0');

    const found = await locationSource(spawnWith(), () => config({ searchPaths: ['~'] }), homeFacts(folder)).locate();

    expect(found).toMatchObject({ outcome: 'located', path: `${folder}/claude`, rule: 'search directory' });
  });

  it('falls back to the inherited PATH through which, naming the rule', async () => {
    await standIn('which', 'echo "  /placeholder/bin/claude  "');

    const found = await locationSource(spawnWith(), () => undefined, homeFacts('/x')).locate();

    expect(found).toEqual({
      outcome: 'located',
      path: '/placeholder/bin/claude',
      rule: 'inherited environment',
      declaredBy: 'PATH',
    });
  });

  it('lists every place it looked when nothing is found, ending with PATH', async () => {
    await standIn('which', 'exit 1');
    const nowhere = join(folder, 'nowhere');

    const found = await locationSource(spawnWith(), () => config({ searchPaths: [nowhere] }), homeFacts('/x')).locate();

    expect(found).toEqual({ outcome: 'absent', searched: [`${nowhere}/claude`, 'PATH'] });
  });

  it('is absent when which prints nothing', async () => {
    await standIn('which', 'exit 0');

    expect(await locationSource(spawnWith(), () => undefined, homeFacts('/x')).locate()).toEqual({
      outcome: 'absent',
      searched: ['PATH'],
    });
  });
});

describe('factsSource', () => {
  const NIX_PATH = `/nix/store/${NIX_HASH}-claude-code-2.1.220/bin/claude`;
  const HM_PATH = `/nix/store/${'b'.repeat(32)}-home-manager-path`;

  const READLINK = [
    'if [ "$1" = "-f" ]; then [ -n "$RESOLVED" ] && printf "%s\\n" "$RESOLVED" && exit 0; exit 1; fi',
    'if [ "$1" = "$LINK_FROM" ]; then printf "%s\\n" "$LINK_TO"; exit 0; fi',
    'exit 1',
  ].join('\n');

  const host = (home = '/placeholder/home/me', platform = 'linux'): ReturnType<typeof hostFacts> => ({
    home: async () => home,
    platform: async () => platform,
  });

  it('reads a plain file as itself: no link, no nix, nothing to ask the profile', async () => {
    await standIn('readlink', 'exit 1');
    await standIn('nix', 'echo asked >> "$CALLS"');
    const calls = join(folder, 'calls.txt');

    const facts = await factsSource(spawnWith({ CALLS: calls }), host()).facts('/opt/claude/bin/claude');

    expect(facts).toEqual({
      launchedPath: '/opt/claude/bin/claude',
      resolvedPath: '/opt/claude/bin/claude',
      homeDirectory: '/placeholder/home/me',
      platform: 'linux',
      nixProfileElement: undefined,
      homeManagerProfile: false,
      viaHomeManagerPath: false,
    });
    await expect(readFile(calls, 'utf8')).rejects.toThrow();
  });

  it('finds the nix profile element that holds a store path, and that the link chain went through home-manager', async () => {
    await standIn('readlink', READLINK);
    await standIn(
      'nix',
      `printf '%s' '{"elements":{"claude-code":{"storePaths":["/nix/store/${NIX_HASH}-claude-code-2.1.220"]},"home-manager-path":{"storePaths":["${HM_PATH}"]}}}'`,
    );

    const facts = await factsSource(
      spawnWith({ RESOLVED: NIX_PATH, LINK_FROM: '/home/me/.nix-profile', LINK_TO: HM_PATH }),
      host('/home/me', 'darwin'),
    ).facts('/home/me/.nix-profile/bin/claude');

    expect(facts).toMatchObject({
      launchedPath: '/home/me/.nix-profile/bin/claude',
      resolvedPath: NIX_PATH,
      homeDirectory: '/home/me',
      platform: 'darwin',
      nixProfileElement: 'claude-code',
      homeManagerProfile: true,
      viaHomeManagerPath: true,
    });
  });

  it('is no element when the profile list is not JSON', async () => {
    await standIn('readlink', READLINK);
    await standIn('nix', 'echo "this is not json"');

    const facts = await factsSource(spawnWith({ RESOLVED: NIX_PATH }), host()).facts('/x/claude');

    expect(facts).toMatchObject({ resolvedPath: NIX_PATH, nixProfileElement: undefined, homeManagerProfile: false });
  });

  it('is no element when nix exits non-zero', async () => {
    await standIn('readlink', READLINK);
    await standIn('nix', 'exit 1');

    const facts = await factsSource(spawnWith({ RESOLVED: NIX_PATH }), host()).facts('/x/claude');

    expect(facts).toMatchObject({ nixProfileElement: undefined, homeManagerProfile: false });
  });

  it('falls back to the launched path when readlink cannot resolve it', async () => {
    await standIn('readlink', READLINK);

    const facts = await factsSource(spawnWith(), host()).facts('/somewhere/claude');

    expect(facts.resolvedPath).toBe('/somewhere/claude');
  });
});

describe('probe', () => {
  it('reads the version a binary prints, in an environment that holds no login and no network', async () => {
    const seen = join(folder, 'seen.txt');
    const claude = await standIn(
      'claude',
      'echo "$HOME|$HTTP_PROXY|$DISABLE_AUTOUPDATER" > "$SEEN"; echo "2.1.220 (Claude Code)"',
    );

    const version = await probe(spawnWith({ SEEN: seen })).version(claude);

    expect(version).toEqual({ state: 'ok', version: '2.1.220' });
    expect((await readFile(seen, 'utf8')).trim()).toBe('/nonexistent/fy-harness-probe|http://127.0.0.1:9|1');
  });

  it('says a binary that exits without a version, or prints no version, is unreadable', async () => {
    const failing = await standIn('failing', 'echo "2.1.220"; exit 1');
    const silent = await standIn('silent', 'echo "hello there"');

    expect(await probe(spawnWith()).version(failing)).toEqual({
      state: 'unreadable',
      reason: 'it exited 1 without printing a version',
    });
    expect(await probe(spawnWith()).version(silent)).toEqual({
      state: 'unreadable',
      reason: 'it exited 0 without printing a version',
    });
  });

  it('says a binary that cannot start is unreadable, with the reason', async () => {
    const result = await probe(spawnWith()).version(join(folder, 'missing'));

    expect(result.state).toBe('unreadable');
    expect(result.state === 'unreadable' ? result.reason : '').not.toBe('');
  });

  it('answers whether --help runs to the end', async () => {
    const works = await standIn('works', 'exit 0');
    const fails = await standIn('fails', 'exit 2');

    expect(await probe(spawnWith()).startup(works)).toEqual({ ok: true });
    expect(await probe(spawnWith()).startup(fails)).toEqual({ ok: false, reason: '--help exited 2' });
  });

  it('says --help that cannot start is not a working start', async () => {
    const missing = await probe(spawnWith()).startup(join(folder, 'missing'));

    expect(missing.ok).toBe(false);
  });
});

describe('npmLatest', () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  let answer: () => Response = () => new Response('{}');
  const requests: { path: string; accept: string | null; agent: string | null }[] = [];

  beforeEach(() => {
    requests.length = 0;
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: request => {
        requests.push({
          path: new URL(request.url).pathname,
          accept: request.headers.get('accept'),
          agent: request.headers.get('user-agent'),
        });
        return answer();
      },
    });
  });

  afterEach(async () => {
    await server?.stop(true);
  });

  /** The registry's own path, asked of this loopback server instead. */
  const network = (): FetchPort => ({
    request: (url, init) => fetch(`http://127.0.0.1:${String(server?.port)}${new URL(String(url)).pathname}`, init),
  });

  it('names the newest stable version, asking npm once with the caller’s own name', async () => {
    answer = () => Response.json({ version: '2.3.4' });

    const result = await npmLatest(network(), 'ferretry-test/1').latest();

    expect(result).toMatchObject({ kind: 'ok', release: { version: '2.3.4' } });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ accept: 'application/json', agent: 'ferretry-test/1' });
    expect(requests[0]?.path).toEndWith('/latest');
  });

  it('says what npm answered when it is not a success', async () => {
    answer = () => new Response('gone', { status: 503 });

    expect(await npmLatest(network(), 'ua').latest()).toEqual({ kind: 'failed', reason: 'npm answered 503' });
  });

  it('says npm named no stable version for a prerelease, a body that is not JSON, or no version at all', async () => {
    for (const body of [
      () => Response.json({ version: '2.3.4-beta.1' }),
      () => new Response('<html>not json</html>'),
      () => Response.json({ name: 'a package' }),
    ]) {
      answer = body;

      expect(await npmLatest(network(), 'ua').latest()).toEqual({
        kind: 'failed',
        reason: 'npm did not name a stable version',
      });
    }
  });

  it('says it could not reach npm when the connection fails', async () => {
    const port = server?.port;
    await server?.stop(true);
    server = undefined;
    const closed: FetchPort = {
      request: (url, init) => fetch(`http://127.0.0.1:${String(port)}${new URL(String(url)).pathname}`, init),
    };

    expect(await npmLatest(closed, 'ua').latest()).toEqual({ kind: 'failed', reason: 'could not reach npm' });
  });
});
