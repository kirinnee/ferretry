import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  openSync,
  symlinkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaunchPart } from '@ferretry/core-ferrets/contract';
import { FakeGate, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import { FakeSealedDocuments } from '@ferretry/core-vault/contract/testing';
import { ghVerbs, GH_DOCTOR_ENV } from '../../cli/gh.ts';
import { gitAccountsDaemon } from '../../daemon/index.ts';
import {
  CLOSED_CONFIG,
  GH_INSTRUCTION,
  GH_UNAVAILABLE,
  ghShimLaunchParts,
} from '../../daemon/features/gh-shim/parts.ts';
import { ghShimFolders, installGhShim, shimScript } from '../../daemon/features/gh-shim/shim.ts';
import { tmpRunFolder } from './run-folder.ts';
import { ghHost } from './gh-host.ts';

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

  test('is written 0755 in a private `shims` folder, beside an EMPTY 0500 pane config; no file of any kind is in it', async () => {
    const folder = runFolder();
    const folders = await installGhShim(folder, 'fy');
    expect(folders).toEqual(ghShimFolders(folder));
    expect(folders?.shims).toBe(`${folder.path}/shims`);
    expect(statSync(`${folder.path}/shims/gh`).mode & 0o777).toBe(0o755);
    expect(statSync(`${folder.path}/shims`).mode & 0o077).toBe(0);
    expect(readdirSync(`${folder.path}/pane-gh-config`)).toEqual([]);
    expect(statSync(`${folder.path}/pane-gh-config`).mode & 0o777).toBe(0o500);
  });

  test('anything found in the pane config at install is removed, and the folder is narrowed again', async () => {
    const folder = runFolder();
    await installGhShim(folder, 'fy');
    chmodSync(`${folder.path}/pane-gh-config`, 0o700);
    writeFileSync(`${folder.path}/pane-gh-config/hosts.yml`, 'oauth_token: x\n');
    mkdirSync(`${folder.path}/pane-gh-config/extensions`);
    writeFileSync(`${folder.path}/pane-gh-config/extensions/README`, 'x');
    await installGhShim(folder, 'fy');
    expect(readdirSync(`${folder.path}/pane-gh-config`)).toEqual([]);
    expect(statSync(`${folder.path}/pane-gh-config`).mode & 0o777).toBe(0o500);
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

  test('a shim that could not be written FAILS CLOSED: no PATH entry, a config nothing can read or write, and a sentence', async () => {
    const parts = await ghShimLaunchParts(async () => undefined).parts(spec);
    expect(parts).toEqual([
      { kind: 'pane-env', plugin: 'git-accounts', env: { GH_CONFIG_DIR: CLOSED_CONFIG } },
      { kind: 'instruction', id: 'git-accounts-gh', text: GH_UNAVAILABLE },
    ] satisfies LaunchPart[]);
    // Nothing can be read from, or written under, that path: `/dev/null` is not a folder.
    expect(existsSync(CLOSED_CONFIG)).toBe(false);
    expect(() => mkdirSync(CLOSED_CONFIG, { recursive: true })).toThrow();
    expect(GH_UNAVAILABLE).toContain('not available');
    expect(JSON.stringify(parts)).not.toMatch(/GH_TOKEN|pathPrepend/u);
  });
});

type Calls = { route: string; body: unknown; timeoutMs?: number }[];
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
      call: async (route: string, request?: { body?: unknown; timeoutMs?: number }) => {
        calls.push({
          route,
          body: request?.body,
          ...(request?.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        });
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
  // The made-up paths here are not on the disk: a path is a regular file when the test says it holds text.
  const verbs = ghVerbs(context as never, {
    isRegularFile: async path => options.exists?.includes(path) === true || options.texts?.[path] !== undefined,
  });
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
        // The daemon lets a followed `pr checks --watch` run 5 minutes: the CLI waits for that, plus a margin.
        timeoutMs: 330_000,
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

  test('--account is forwarded for the daemon to judge (it refuses a ferret that names one), and is never gh’s argv', async () => {
    const spaced = cli({ exitCode: 0, stdout: '', stderr: '' });
    await spaced.verbs.gh(typed(['--account', 'other', '--', 'pr', 'list']));
    expect(spaced.calls[0]?.body).toEqual({ argv: ['pr', 'list'], cwd: '/work/app', account: 'other' });
    const joined = cli({ exitCode: 0, stdout: '', stderr: '' });
    await joined.verbs.gh(typed(['--account=other', 'pr', 'list']));
    expect(joined.calls[0]?.body).toEqual({ argv: ['pr', 'list'], cwd: '/work/app', account: 'other' });
    const bare = cli({ exitCode: 0, stdout: '', stderr: '' });
    await bare.verbs.gh(typed(['--account', 'other', 'pr', 'list']));
    expect(bare.calls[0]?.body).toEqual({ argv: ['pr', 'list'], cwd: '/work/app', account: 'other' });
  });

  test('past the first `--` every word is gh’s, even one that looks like fy’s own option; words before it that are not --account go nowhere', async () => {
    const run = cli({ exitCode: 0, stdout: '', stderr: '' });
    await run.verbs.gh(typed(['stray', '--', 'pr', 'list', '--account', 'x', '--', '--account=y']));
    expect(run.calls[0]?.body).toEqual({
      argv: ['pr', 'list', '--account', 'x', '--', '--account=y'],
      cwd: '/work/app',
    });
  });

  test('an empty --account, or one with no value, names no account; a handler given no raw words reads the parsed ones', async () => {
    const empty = cli({ exitCode: 0, stdout: '', stderr: '' });
    await empty.verbs.gh(typed(['--account', '', '--', 'pr', 'list']));
    await empty.verbs.gh(typed(['--account=', '--', 'pr', 'list']));
    await empty.verbs.gh(typed(['--account', '--', 'pr', 'list']));
    for (const call of empty.calls) expect(call.body).toEqual({ argv: ['pr', 'list'], cwd: '/work/app' });
    const parsed = cli({ exitCode: 0, stdout: '', stderr: '' });
    await parsed.verbs.gh({ args: ['pr', 'list'], options: { account: 'other' } });
    await parsed.verbs.gh({ args: ['pr', 'list'], options: { account: true } });
    expect(parsed.calls.map(call => call.body)).toEqual([
      { argv: ['pr', 'list'], cwd: '/work/app', account: 'other' },
      { argv: ['pr', 'list'], cwd: '/work/app' },
    ]);
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

  test('a linked WORKTREE (its .git is a file) names the worktree’s own branch, never the main checkout’s', async () => {
    const root = scratch();
    const git = (cwd: string, ...args: string[]) => {
      const run = Bun.spawnSync(['git', ...args], {
        cwd,
        env: {
          PATH: process.env['PATH'] ?? '',
          HOME: root,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
        },
      });
      expect(run.exitCode).toBe(0);
    };
    const main = join(root, 'main');
    mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    git(main, '-c', 'user.name=t', '-c', 'user.email=t@e.x', 'commit', '-q', '--allow-empty', '-m', 'one');
    const tree = join(root, 'tree');
    git(main, 'worktree', 'add', '-q', '-b', 'feat/mine', tree);
    mkdirSync(join(tree, 'src', 'deep'), { recursive: true });
    expect(statSync(join(tree, '.git')).isFile()).toBe(true);
    const files = {
      exists: async (path: string) => existsSync(path),
      texts: (path: string): string => {
        try {
          return readFileSync(path, 'utf8');
        } catch {
          return '';
        }
      },
    };
    const make = (cwd: string) => {
      const run = cli({ exitCode: 0, stdout: '', stderr: '' }, { env: { PWD: cwd } });
      const context = {
        client: {
          call: async (_route: string, request?: { body?: unknown }) => {
            run.calls.push({ route: _route, body: request?.body });
            return { exitCode: 0, stdout: '', stderr: '' };
          },
        },
        io: { out: () => undefined, err: () => undefined, isTty: false },
        env: { PWD: cwd },
        exists: files.exists,
        readText: async (path: string) => {
          if (!existsSync(path)) throw new Error('ENOENT');
          return files.texts(path);
        },
      };
      return { run, verbs: ghVerbs(context as never) };
    };
    for (const [cwd, branch] of [
      [tree, 'feat/mine'],
      [join(tree, 'src', 'deep'), 'feat/mine'],
      [main, 'main'],
    ] as const) {
      const made = make(cwd);
      await made.verbs.gh(typed(create));
      expect(bodyOf(made.run).slice(-2)).toEqual(['--head', branch]);
    }
  });

  test('a worktree .git file that points at nothing readable, or is no pointer at all, adds nothing and does not climb to the parent', async () => {
    const parentHead = '/work/.git/HEAD';
    const gone = cli(
      { exitCode: 0, stdout: '', stderr: '' },
      {
        exists: [parentHead],
        texts: { [parentHead]: 'ref: refs/heads/main', '/work/app/.git': 'gitdir: /main/.git/worktrees/app\n' },
      },
    );
    await gone.verbs.gh(typed(create));
    expect(bodyOf(gone)).toEqual(['pr', 'create', '--title', 't', '--body', 'b']);
    // A relative pointer is read from the folder it is in; a detached HEAD there still adds nothing.
    const relative = cli(
      { exitCode: 0, stdout: '', stderr: '' },
      {
        texts: {
          '/work/app/.git': 'gitdir: ../main/.git/worktrees/app/\n',
          '/work/app/../main/.git/worktrees/app/HEAD': '0123456789abcdef0123456789abcdef01234567',
        },
      },
    );
    await relative.verbs.gh(typed(create));
    expect(bodyOf(relative)).toEqual(['pr', 'create', '--title', 't', '--body', 'b']);
    const named = cli(
      { exitCode: 0, stdout: '', stderr: '' },
      {
        texts: {
          '/work/app/.git': 'gitdir: ../main/.git/worktrees/app\n',
          '/work/app/../main/.git/worktrees/app/HEAD': 'ref: refs/heads/feat/rel\n',
        },
      },
    );
    await named.verbs.gh(typed(create));
    expect(bodyOf(named).slice(-2)).toEqual(['--head', 'feat/rel']);
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

/** A real FIFO named like the git file it stands in for: reading one blocks until a writer opens it, so nothing may. */
describe('gh pr create never blocks on a .git file a ferret made into a FIFO (L52)', () => {
  const create = ['--', 'pr', 'create', '--title', 't', '--body', 'b'];
  const PLAIN = ['pr', 'create', '--title', 't', '--body', 'b'];

  /** The real reads (`Bun.file`, the disk), as `fy` gives a verb, so only the verb's own caution can keep it from hanging. */
  function realCli(cwd: string) {
    const bodies: unknown[] = [];
    const context = {
      client: {
        call: async (_route: string, request?: { body?: unknown }) => {
          bodies.push(request?.body);
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      },
      io: { out: () => undefined, err: () => undefined, isTty: false },
      env: { PWD: cwd },
      exists: async (path: string) => existsSync(path),
      readText: async (path: string) => await Bun.file(path).text(),
    };
    return { verbs: ghVerbs(context as never), bodies };
  }
  const fifo = (path: string) => expect(Bun.spawnSync(['mkfifo', path]).exitCode).toBe(0);
  /** Opens the write end of a FIFO and closes it, so a reader that DID block ends (a failing run must not leak). */
  const release = (path: string) => closeSync(openSync(path, constants.O_RDWR));

  // (The 100 ms bound is the perf tier's: tests/perf/cli/gh-head-fifo.test.ts.)
  test('a .git/HEAD FIFO returns the argv unchanged, and the verb is not left waiting on it', async () => {
    const root = scratch();
    mkdirSync(join(root, '.git'));
    const head = join(root, '.git', 'HEAD');
    fifo(head);
    const { verbs, bodies } = realCli(root);
    const code = await Promise.race([
      verbs.gh(typed(create)),
      new Promise<'hung'>(resolve => setTimeout(() => resolve('hung'), 2_000)),
    ]);
    release(head);
    expect(code).toBe(0);
    expect(bodies).toEqual([{ argv: PLAIN, cwd: root }]);
  });

  test('a worktree .git pointer that is a FIFO, or whose HEAD is one, adds nothing and never blocks', async () => {
    const root = scratch();
    // `.git` itself a FIFO (it would be read for its `gitdir:` line).
    const pointerFifo = join(root, 'a');
    mkdirSync(pointerFifo);
    fifo(join(pointerFifo, '.git'));
    // `.git` a real pointer, whose target's HEAD is a FIFO.
    const linked = join(root, 'b');
    const gitdir = join(root, 'b-gitdir');
    mkdirSync(linked);
    mkdirSync(gitdir);
    writeFileSync(join(linked, '.git'), `gitdir: ${gitdir}\n`);
    fifo(join(gitdir, 'HEAD'));
    for (const cwd of [pointerFifo, linked]) {
      const { verbs, bodies } = realCli(cwd);
      const code = await Promise.race([
        verbs.gh(typed(create)),
        new Promise<'hung'>(resolve => setTimeout(() => resolve('hung'), 2_000)),
      ]);
      if (code === 'hung') {
        release(join(pointerFifo, '.git'));
        release(join(gitdir, 'HEAD'));
      }
      expect(code).toBe(0);
      expect(bodies).toEqual([{ argv: PLAIN, cwd }]);
    }
  });

  test('a regular HEAD, and a symlink to one, still name the branch; a symlink to a FIFO does not', async () => {
    const root = scratch();
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/feat/real\n');
    const direct = realCli(root);
    await direct.verbs.gh(typed(create));
    expect(direct.bodies).toEqual([{ argv: [...PLAIN, '--head', 'feat/real'], cwd: root }]);

    const linked = join(root, 'link');
    mkdirSync(join(linked, '.git'), { recursive: true });
    symlinkSync(join(root, '.git', 'HEAD'), join(linked, '.git', 'HEAD'));
    const viaLink = realCli(linked);
    await viaLink.verbs.gh(typed(create));
    expect(viaLink.bodies).toEqual([{ argv: [...PLAIN, '--head', 'feat/real'], cwd: linked }]);

    const trap = join(root, 'trap');
    mkdirSync(join(trap, '.git'), { recursive: true });
    const target = join(root, 'the-fifo');
    fifo(target);
    symlinkSync(target, join(trap, '.git', 'HEAD'));
    const viaFifo = realCli(trap);
    const code = await Promise.race([
      viaFifo.verbs.gh(typed(create)),
      new Promise<'hung'>(resolve => setTimeout(() => resolve('hung'), 2_000)),
    ]);
    release(target);
    expect(code).toBe(0);
    expect(viaFifo.bodies).toEqual([{ argv: PLAIN, cwd: trap }]);
  });
});

describe('fy gh-doctor (inside a pane)', () => {
  const CONFIG = '/fy/state/git-accounts/downloads/pane-gh-config';
  const SHIM = '/fy/state/git-accounts/downloads/shims/gh';
  const healthy = { PATH: '/fy/state/git-accounts/downloads/shims:/usr/bin', GH_CONFIG_DIR: CONFIG };

  test('reads only the names the manifest declares', () => {
    expect([...GH_DOCTOR_ENV]).toEqual(['PATH', 'GH_CONFIG_DIR', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN']);
  });

  test('the shim is first on PATH and no token is set: OK', async () => {
    const run = cli({}, { read: healthy, exists: [SHIM, '/usr/bin/gh'] });
    expect(await run.verbs['gh-doctor'](typed([]))).toBe(0);
    expect(run.out.join('')).toContain('OK');
    expect(run.err).toEqual([]);
  });

  test('a host gh ahead of the shim (a shell rc moved PATH) is a warning that names where it is', async () => {
    const run = cli({}, { read: { ...healthy, PATH: `/opt/bin:${healthy.PATH}` }, exists: ['/opt/bin/gh', SHIM] });
    expect(await run.verbs['gh-doctor'](typed([]))).toBe(1);
    expect(run.err.join('')).toContain('/opt/bin/gh');
    expect(run.err.join('')).toContain(SHIM);
  });

  test('a GitHub token in the pane is a warning that names the variable and never prints a value', async () => {
    const run = cli({}, { read: { ...healthy, GITHUB_TOKEN: 'ghp_FAKEFAKEFAKEFAKEFAKE' }, exists: [SHIM] });
    expect(await run.verbs['gh-doctor'](typed([]))).toBe(1);
    expect(run.err.join('')).toContain('GITHUB_TOKEN');
    expect(run.err.join('') + run.out.join('')).not.toContain('ghp_');
  });

  test('no gh at all on PATH, with Ferretry’s config in place, says the shim cannot be used', async () => {
    const run = cli({}, { read: { PATH: '/nowhere', GH_CONFIG_DIR: CONFIG }, exists: [] });
    expect(await run.verbs['gh-doctor'](typed([]))).toBe(1);
    expect(run.err.join('')).toContain('No `gh` is first on PATH');
  });

  test('a pane started without the shim says so', async () => {
    const run = cli({}, { read: { PATH: '/usr/bin' }, exists: ['/usr/bin/gh'] });
    expect(await run.verbs['gh-doctor'](typed([]))).toBe(1);
    expect(run.err.join('')).toContain('not started with Ferretry');
  });
});

describe('the daemon half', () => {
  type Item = { id: string; item: { parts(spec: object): Promise<readonly LaunchPart[]> } };
  async function boot(
    folder: ReturnType<typeof tmpRunFolder>,
    clients: readonly string[] = ['/preview/bin/fy'],
    clientName = 'fy',
  ) {
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
      identity: {
        daemonId: 'synthetic-daemon',
        daemonName: 'test-daemon',
        binaries: { client: clientName, daemon: 'fyd' },
      },
      ...ghHost(clients.map(path => path.slice(0, path.lastIndexOf('/'))).join(':') || '/preview/bin', clients),
      stateHomeHolding: async path => (path.startsWith('/synthetic-state/') ? '/synthetic-state' : undefined),
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
    expect(readFileSync(`${folder.path}/shims/gh`, 'utf8')).toBe(shimScript('/preview/bin/fy'));
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

  test('E75: the next launch repairs a modified or removed shim without restarting the daemon', async () => {
    const folder = runFolder();
    const { host, held } = await boot(folder);
    try {
      const gh = held.items.find(entry => entry.id === 'git-accounts-gh');
      await gh?.item.parts({ folder: '/anywhere' });
      writeFileSync(`${folder.path}/shims/gh`, '#!/bin/sh\necho edited\n');
      await gh?.item.parts({ folder: '/anywhere' });
      expect(readFileSync(`${folder.path}/shims/gh`, 'utf8')).toBe(shimScript('/preview/bin/fy'));
      rmSync(`${folder.path}/shims/gh`);
      await gh?.item.parts({ folder: '/anywhere' });
      expect(readFileSync(`${folder.path}/shims/gh`, 'utf8')).toBe(shimScript('/preview/bin/fy'));
    } finally {
      await host.stop();
    }
  });

  test('E76: the launch pins the daemon-discovered client even when the pane PATH has no client', async () => {
    const folder = runFolder();
    const bin = scratch();
    const client = join(bin, 'fy-preview');
    writeFileSync(client, '#!/bin/sh\nprintf \'%s\\n\' "$@"\n', { mode: 0o755 });
    const { host, held } = await boot(folder, [client], 'fy-preview');
    try {
      await held.items.find(entry => entry.id === 'git-accounts-gh')?.item.parts({ folder: '/anywhere' });
      const run = Bun.spawnSync([`${folder.path}/shims/gh`, 'pr', 'list'], { env: { PATH: '/nonexistent' } });
      expect(run.exitCode).toBe(0);
      expect(new TextDecoder().decode(run.stdout)).toBe('gh\n--\npr\nlist\n');
    } finally {
      await host.stop();
    }
  });

  test('missing client discovery closes GH config and can recover on a later launch', async () => {
    const folder = runFolder();
    const clients: string[] = [];
    const { host, held } = await boot(folder, clients);
    try {
      const gh = held.items.find(entry => entry.id === 'git-accounts-gh');
      expect(await gh?.item.parts({ folder: '/anywhere' })).toEqual([
        { kind: 'pane-env', plugin: 'git-accounts', env: { GH_CONFIG_DIR: CLOSED_CONFIG } },
        { kind: 'instruction', id: 'git-accounts-gh', text: GH_UNAVAILABLE },
      ]);
      expect(existsSync(`${folder.path}/shims/gh`)).toBe(false);
      clients.push('/preview/bin/fy');
      expect((await gh?.item.parts({ folder: '/anywhere' }))?.[0]).toHaveProperty('pathPrepend');
      expect(readFileSync(`${folder.path}/shims/gh`, 'utf8')).toBe(shimScript('/preview/bin/fy'));
    } finally {
      await host.stop();
    }
  });

  test('a client discovered inside a state home is refused rather than pinned into a pane', async () => {
    const folder = runFolder();
    const { host, held } = await boot(folder, ['/synthetic-state/bin/fy']);
    try {
      const parts = await held.items.find(entry => entry.id === 'git-accounts-gh')?.item.parts({ folder: '/anywhere' });
      expect(parts).toEqual([
        { kind: 'pane-env', plugin: 'git-accounts', env: { GH_CONFIG_DIR: CLOSED_CONFIG } },
        { kind: 'instruction', id: 'git-accounts-gh', text: GH_UNAVAILABLE },
      ]);
      expect(existsSync(`${folder.path}/shims/gh`)).toBe(false);
    } finally {
      await host.stop();
    }
  });

  test('overlapping launches share one repair and all receive a ready shim', async () => {
    const folder = runFolder();
    const publish = folder.publish;
    let barrier: Promise<void> | undefined;
    let writes = 0;
    const { host, held } = await boot({
      ...folder,
      publish: async (...args) => {
        writes += 1;
        await barrier;
        await publish(...args);
      },
    });
    const release = Promise.withResolvers<void>();
    try {
      const gh = held.items.find(entry => entry.id === 'git-accounts-gh');
      await gh?.item.parts({ folder: '/anywhere' });
      writes = 0;
      barrier = release.promise;
      const launches = Array.from({ length: 4 }, () => gh?.item.parts({ folder: '/anywhere' }));
      for (let tick = 0; writes === 0 && tick < 1000; tick += 1) await Bun.sleep(1);
      expect(writes).toBe(1);
      release.resolve();
      for (const parts of await Promise.all(launches)) expect(parts?.[0]).toHaveProperty('pathPrepend');
      expect(writes).toBe(1);
    } finally {
      release.resolve();
      await host.stop();
    }
  });

  test('a run folder that is not private starts the daemon and gives launches the closed config, never the host’s', async () => {
    const folder = runFolder();
    chmodSync(folder.path, 0o755);
    const { held } = await boot(folder);
    expect(await held.items[1]?.item.parts({ folder: '/anywhere' })).toEqual([
      { kind: 'pane-env', plugin: 'git-accounts', env: { GH_CONFIG_DIR: CLOSED_CONFIG } },
      { kind: 'instruction', id: 'git-accounts-gh', text: GH_UNAVAILABLE },
    ]);
  });
});
