import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaunchPart } from '@ferretry/core-ferrets/contract';
import { FakeGate, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import { FakeSealedDocuments } from '@ferretry/core-vault/contract/testing';
import { ghVerbs, GH_DOCTOR_ENV } from '../../cli/gh.ts';
import { gitAccountsDaemon } from '../../daemon/index.ts';
import { GH_INSTRUCTION, ghShimLaunchParts } from '../../daemon/features/gh-shim/parts.ts';
import { ghShimFolders, installGhShim, shimScript } from '../../daemon/features/gh-shim/shim.ts';
import { tmpRunFolder } from './run-folder.ts';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const undo of cleanup.splice(0)) undo();
});
const scratch = (): string => {
  const path = mkdtempSync(join(tmpdir(), 'fy-b10-'));
  cleanup.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
};
const runFolder = () => {
  const folder = tmpRunFolder();
  cleanup.push(() => folder.destroy());
  return folder;
};

describe('the gh shim file', () => {
  test('is a two-line sh script that hands every argument to `fy gh --` untouched', () => {
    expect(shimScript('fy')).toBe('#!/bin/sh\nexec fy gh -- "$@"\n');
    // A client name with an odd character is one shell word, never a command.
    expect(shimScript("f y';x")).toBe(`#!/bin/sh\nexec 'f y'\\'';x' gh -- "$@"\n`);
  });

  test('is written 0755 in a private `shims` folder, beside an empty pane config; no sign-in file exists anywhere', async () => {
    const folder = runFolder();
    const folders = await installGhShim(folder, 'fy');
    expect(folders).toEqual(ghShimFolders(folder));
    expect(folders?.shims).toBe(`${folder.path}/shims`);
    expect(statSync(`${folder.path}/shims/gh`).mode & 0o777).toBe(0o755);
    expect(statSync(`${folder.path}/shims`).mode & 0o077).toBe(0);
    expect(readdirSync(`${folder.path}/pane-gh-config`)).toEqual(['README']);
    expect(readFileSync(`${folder.path}/pane-gh-config/README`, 'utf8')).not.toMatch(/oauth_token|hosts/u);
  });

  test('is rewritten on the next boot, so an edited or stale shim never survives', async () => {
    const folder = runFolder();
    await installGhShim(folder, 'fy');
    writeFileSync(`${folder.path}/shims/gh`, '#!/bin/sh\necho hacked\n', { mode: 0o755 });
    await installGhShim(folder, 'fy');
    expect(readFileSync(`${folder.path}/shims/gh`, 'utf8')).toBe(shimScript('fy'));
  });

  test('a run folder that is not private is given nothing and nothing is written', async () => {
    const folder = runFolder();
    chmodSync(folder.path, 0o755);
    expect(await installGhShim(folder, 'fy')).toBeUndefined();
    expect(readdirSync(folder.path)).toEqual([]);
  });

  test('keeps argv intact through a real sh: spaces, newlines, quotes, globs, `--`, empty words', async () => {
    const folder = runFolder();
    const folders = await installGhShim(folder, 'fy');
    // A stand-in `fy` that prints each argument on its own line, NUL-delimited so a newline inside one is visible.
    const bin = scratch();
    writeFileSync(join(bin, 'fy'), '#!/bin/sh\nfor a in "$@"; do printf \'%s\\0\' "$a"; done\n', { mode: 0o755 });
    const args = ['pr', 'list', '--search', 'is:open label:"a b"', 'two\nlines', "it's", '*', '--', '', '$HOME', '-x'];
    const run = Bun.spawnSync([`${folders?.shims}/gh`, ...args], { env: { PATH: `${bin}:/usr/bin:/bin` } });
    expect(run.exitCode).toBe(0);
    const seen = new TextDecoder().decode(run.stdout).split('\0');
    seen.pop();
    expect(seen).toEqual(['gh', '--', ...args]);
  });

  test('a pane that puts the shim folder first finds the shim as `gh`, ahead of a host gh', async () => {
    const folder = runFolder();
    const folders = await installGhShim(folder, 'fy');
    const host = scratch();
    writeFileSync(join(host, 'gh'), '#!/bin/sh\necho host-gh\n', { mode: 0o755 });
    const found = Bun.spawnSync(['/bin/sh', '-c', 'command -v gh'], {
      env: { PATH: `${folders?.shims}:${host}:/usr/bin:/bin` },
    });
    expect(new TextDecoder().decode(found.stdout).trim()).toBe(`${folders?.shims}/gh`);
  });
});

describe('every ferret’s launch gets the shim, and never a token', () => {
  const folders = { shims: '/fy/downloads/shims', paneConfig: '/fy/downloads/pane-gh-config' };
  const spec = { folder: '/anywhere' } as never;

  test('a folder first on PATH, an empty GH_CONFIG_DIR, one instruction: for any folder, linked project or not', async () => {
    const parts = await ghShimLaunchParts(async () => folders).parts(spec);
    expect(parts).toEqual([
      {
        kind: 'pane-env',
        plugin: 'git-accounts',
        env: { GH_CONFIG_DIR: '/fy/downloads/pane-gh-config' },
        pathPrepend: ['/fy/downloads/shims'],
      },
      { kind: 'instruction', id: 'git-accounts-gh', text: GH_INSTRUCTION },
    ] satisfies LaunchPart[]);
  });

  test('no GitHub token name and no PATH/HOME in the env it contributes; the sentence says what is refused', async () => {
    const parts = await ghShimLaunchParts(async () => folders).parts(spec);
    const env = parts.flatMap(part => (part.kind === 'pane-env' ? Object.keys(part.env) : []));
    expect(env).toEqual(['GH_CONFIG_DIR']);
    expect(JSON.stringify(parts)).not.toMatch(/GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|ghp_|gho_/u);
    for (const word of ['auth', 'config', 'extensions', 'aliases', 'codespaces', 'git'])
      expect(GH_INSTRUCTION).toContain(word);
  });

  test('a shim that could not be written adds nothing (a PATH entry that is not there would be worse)', async () => {
    expect(await ghShimLaunchParts(async () => undefined).parts(spec)).toEqual([]);
  });
});

type Calls = { route: string; body: unknown }[];
function cli(
  answer: unknown,
  options: {
    env?: Record<string, string>;
    read?: Record<string, string>;
    exists?: string[];
    texts?: Record<string, string>;
  } = {},
) {
  const calls: Calls = [];
  const out: string[] = [];
  const err: string[] = [];
  let read = false;
  const context = {
    client: {
      call: async (route: string, request?: { body?: unknown }) => {
        calls.push({ route, body: request?.body });
        return answer;
      },
    },
    io: { out: (text: string) => void out.push(text), err: (text: string) => void err.push(text), isTty: false },
    env: options.env ?? { PWD: '/work/app' },
    readEnvironment: (names: readonly string[]) =>
      Object.fromEntries(
        names.flatMap(name => (options.read?.[name] === undefined ? [] : [[name, options.read[name]]])),
      ),
    exists: async (path: string) => options.exists?.includes(path) ?? false,
    // `fy gh` reads no file and no stdin: touching either fails the test.
    readText: async (path: string) => {
      if (options.texts?.[path] !== undefined) return options.texts[path];
      read = true;
      return '';
    },
    readBytes: async () => {
      read = true;
      return new Uint8Array();
    },
    stdin: () => {
      read = true;
      throw new Error('stdin');
    },
  };
  const verbs = ghVerbs(context as never);
  return { verbs, calls, out, err, read: () => read };
}
const typed = (words: string[], options: Record<string, string | boolean> = {}) => ({ args: words, words, options });

describe('fy gh -- <args>', () => {
  test('sends the argv after `--` and the folder, prints the streams and exits with gh’s code', async () => {
    const run = cli({ exitCode: 3, stdout: '#12 fix\n', stderr: 'warn\n' });
    const code = await run.verbs.gh(typed(['--', 'pr', 'list', '--json', 'number', '--help', '--']));
    expect(code).toBe(3);
    expect(run.calls).toEqual([
      {
        route: 'POST /v1/git-accounts/gh/run',
        body: { argv: ['pr', 'list', '--json', 'number', '--help', '--'], cwd: '/work/app' },
      },
    ]);
    expect(run.out).toEqual(['#12 fix\n']);
    expect(run.err).toEqual(['warn\n']);
  });

  test('sends bytes of nothing: no file named in the argv and no stdin is read; the daemon refuses those forms', async () => {
    const run = cli({ refused: 'gh is not run that way: --body-file is not allowed' });
    const code = await run.verbs.gh(typed(['--', 'pr', 'comment', '1', '--body-file', '/home/me/.ssh/id_ed25519']));
    expect(code).toBe(1);
    expect(run.read()).toBe(false);
    expect(run.calls[0]?.body).toEqual({
      argv: ['pr', 'comment', '1', '--body-file', '/home/me/.ssh/id_ed25519'],
      cwd: '/work/app',
    });
    expect(run.err).toEqual(['gh is not run that way: --body-file is not allowed\n']);
    expect(run.out).toEqual([]);
  });

  test('a refusal is a sentence on stderr and exit 1; a run ended by a signal exits 124', async () => {
    const refused = cli({ refused: 'Ferretry’s gh never shows its token' });
    expect(await refused.verbs.gh(typed(['--', 'auth', 'token']))).toBe(1);
    expect(refused.err).toEqual(['Ferretry’s gh never shows its token\n']);
    const timeout = cli({ exitCode: null, stdout: '', stderr: '' });
    expect(await timeout.verbs.gh(typed(['--', 'run', 'watch', '9']))).toBe(124);
  });

  test('--account is forwarded for the daemon to judge (it refuses a ferret that names one)', async () => {
    const run = cli({ exitCode: 0, stdout: '', stderr: '' });
    await run.verbs.gh(typed(['--', 'pr', 'list'], { account: 'other' }));
    expect(run.calls[0]?.body).toEqual({ argv: ['pr', 'list'], cwd: '/work/app', account: 'other' });
  });

  test('nothing to run, or no folder to judge by, asks nothing of the daemon', async () => {
    const none = cli({});
    expect(await none.verbs.gh(typed(['--']))).toBe(2);
    const lost = cli({}, { env: {} });
    expect(await lost.verbs.gh(typed(['--', 'pr', 'list']))).toBe(1);
    expect(none.calls).toEqual([]);
    expect(lost.calls).toEqual([]);
  });

  test('an answer that is neither a result nor a refusal is an error, never printed', async () => {
    const run = cli({ stdout: 'x', token: 'ghp_FAKEFAKEFAKEFAKEFAKE' });
    await expect(run.verbs.gh(typed(['--', 'pr', 'list']))).rejects.toThrow();
    expect(run.out).toEqual([]);
  });
});

describe('gh pr create names the ferret’s branch (the daemon runs in an empty folder and cannot see it)', () => {
  const HEAD = '/work/app/.git/HEAD';
  const create = ['--', 'pr', 'create', '--title', 't', '--body', 'b'];
  const bodyOf = (run: ReturnType<typeof cli>) => (run.calls[0] as { body: { argv: string[] } }).body.argv;

  test('adds --head from .git/HEAD, read as text, when the argv names none', async () => {
    const run = cli(
      { exitCode: 0, stdout: '', stderr: '' },
      { exists: [HEAD], texts: { [HEAD]: 'ref: refs/heads/feat/shim\n' } },
    );
    await run.verbs.gh(typed(create));
    expect(bodyOf(run)).toEqual(['pr', 'create', '--title', 't', '--body', 'b', '--head', 'feat/shim']);
  });

  test('finds the repository above the folder', async () => {
    const run = cli(
      { exitCode: 0, stdout: '', stderr: '' },
      { env: { PWD: '/work/app/src/deep' }, exists: [HEAD], texts: { [HEAD]: 'ref: refs/heads/main' } },
    );
    await run.verbs.gh(typed(create));
    expect(bodyOf(run).slice(-2)).toEqual(['--head', 'main']);
  });

  test.each([[['--head', 'x']], [['--head=x']], [['-H', 'x']]])(
    'an argv that already names a head (%j) is left alone',
    async (head: string[]) => {
      const run = cli(
        { exitCode: 0, stdout: '', stderr: '' },
        { exists: [HEAD], texts: { [HEAD]: 'ref: refs/heads/main' } },
      );
      await run.verbs.gh(typed([...create, ...head]));
      expect(bodyOf(run)).toEqual(['pr', 'create', '--title', 't', '--body', 'b', ...head]);
    },
  );

  test.each([
    '0123456789abcdef0123456789abcdef01234567',
    'ref: refs/heads/-x',
    'ref: refs/heads/a b',
    'ref: refs/heads/a;rm',
  ])('a detached HEAD or an odd branch name (%j) adds nothing: the daemon asks for --head', async content => {
    const run = cli({ refused: 'pass --head' }, { exists: [HEAD], texts: { [HEAD]: content } });
    await run.verbs.gh(typed(create));
    expect(bodyOf(run)).toEqual(['pr', 'create', '--title', 't', '--body', 'b']);
  });

  test('no repository, or any other command, reads nothing', async () => {
    const none = cli({ exitCode: 0, stdout: '', stderr: '' });
    await none.verbs.gh(typed(create));
    expect(bodyOf(none)).toEqual(['pr', 'create', '--title', 't', '--body', 'b']);
    const list = cli(
      { exitCode: 0, stdout: '', stderr: '' },
      { exists: [HEAD], texts: { [HEAD]: 'ref: refs/heads/main' } },
    );
    await list.verbs.gh(typed(['--', 'pr', 'list']));
    expect(bodyOf(list)).toEqual(['pr', 'list']);
  });
});

describe('fy gh doctor (inside a pane)', () => {
  const CONFIG = '/fy/state/git-accounts/downloads/pane-gh-config';
  const SHIM = '/fy/state/git-accounts/downloads/shims/gh';
  const healthy = { PATH: '/fy/state/git-accounts/downloads/shims:/usr/bin', GH_CONFIG_DIR: CONFIG };

  test('reads only the names the manifest declares', () => {
    expect([...GH_DOCTOR_ENV]).toEqual(['PATH', 'GH_CONFIG_DIR', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN']);
  });

  test('the shim is first on PATH and no token is set: OK', async () => {
    const run = cli({}, { read: healthy, exists: [SHIM, '/usr/bin/gh'] });
    expect(await run.verbs['gh doctor'](typed([]))).toBe(0);
    expect(run.out.join('')).toContain('OK');
    expect(run.err).toEqual([]);
  });

  test('a host gh ahead of the shim (a shell rc moved PATH) is a warning that names where it is', async () => {
    const run = cli({}, { read: { ...healthy, PATH: `/opt/bin:${healthy.PATH}` }, exists: ['/opt/bin/gh', SHIM] });
    expect(await run.verbs['gh doctor'](typed([]))).toBe(1);
    expect(run.err.join('')).toContain('/opt/bin/gh');
    expect(run.err.join('')).toContain(SHIM);
  });

  test('a GitHub token in the pane is a warning that names the variable and never prints a value', async () => {
    const run = cli({}, { read: { ...healthy, GITHUB_TOKEN: 'ghp_FAKEFAKEFAKEFAKEFAKE' }, exists: [SHIM] });
    expect(await run.verbs['gh doctor'](typed([]))).toBe(1);
    expect(run.err.join('')).toContain('GITHUB_TOKEN');
    expect(run.err.join('') + run.out.join('')).not.toContain('ghp_');
  });

  test('a pane started without the shim says so', async () => {
    const run = cli({}, { read: { PATH: '/usr/bin' }, exists: ['/usr/bin/gh'] });
    expect(await run.verbs['gh doctor'](typed([]))).toBe(1);
    expect(run.err.join('')).toContain('not started with Ferretry');
  });
});

describe('the daemon half', () => {
  type Item = { id: string; item: { parts(spec: object): Promise<readonly LaunchPart[]> } };
  async function boot(folder: ReturnType<typeof tmpRunFolder>) {
    const held: { items: readonly Item[] } = { items: [] };
    const impl = gitAccountsDaemon({ runFolder: folder });
    const wrapped = {
      ...impl,
      build: (ctx: never) => {
        const half = (impl.build as (ctx: never) => unknown)(ctx) as {
          hooks: { 'launch.parts': () => readonly Item[] };
        };
        held.items = half.hooks['launch.parts']();
        return half;
      },
    } as unknown as ReturnType<typeof gitAccountsDaemon>;
    const gate = new FakeGate();
    const host = await testHost({
      plugins: [wrapped],
      gate: new StandInAdmission(() => ownerStanding()),
      fakes: { sealed: new FakeSealedDocuments(), gate },
      uses: { projects: { list: async () => [] } },
      spawn: () => ({ exitCode: 1, signal: null, stdout: '', stderr: '' }),
    });
    return { host, held };
  }

  test('writes the shim at boot, and every launch (no project at all) is handed it', async () => {
    const folder = runFolder();
    const { held } = await boot(folder);
    const gh = held.items.find(entry => entry.id === 'git-accounts-gh');
    const parts = await gh?.item.parts({ folder: '/anywhere' });
    expect(readFileSync(`${folder.path}/shims/gh`, 'utf8')).toBe('#!/bin/sh\nexec fy gh -- "$@"\n');
    expect(parts).toEqual([
      {
        kind: 'pane-env',
        plugin: 'git-accounts',
        env: { GH_CONFIG_DIR: `${folder.path}/pane-gh-config` },
        pathPrepend: [`${folder.path}/shims`],
      },
      { kind: 'instruction', id: 'git-accounts-gh', text: GH_INSTRUCTION },
    ]);
  });

  test('the account source stays first (B4) and the shim is a second, separate source', async () => {
    const { held } = await boot(runFolder());
    expect(held.items.map(entry => entry.id)).toEqual(['git-accounts', 'git-accounts-gh']);
  });

  test('a run folder that is not private starts the daemon and gives launches nothing', async () => {
    const folder = runFolder();
    chmodSync(folder.path, 0o755);
    const { held } = await boot(folder);
    expect(await held.items[1]?.item.parts({ folder: '/anywhere' })).toEqual([]);
  });
});
