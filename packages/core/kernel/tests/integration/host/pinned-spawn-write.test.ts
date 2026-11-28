import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { err, ok } from '@ferretry/std';
import type { FencedPath, WorkFolders } from '../../../contract/bound.ts';
import type { FerretId } from '../../../contract/ids.ts';
import type { SpawnPort } from '../../../contract/ports.ts';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import { platformRootPinner } from '../../../host/adapters/pinned/index.ts';
import { bunSpawn } from '../../../host/adapters/process.ts';
import { restrictSpawn } from '../../../host/permissions.ts';
import { PinRegistry } from '../../../host/pins.ts';
import { rootsPortFor } from '../../../host/roots.ts';
import { HARDENED_GIT_ARGUMENTS, WORKTREE_GIT_READS } from '../../../contract/git-read-permissions.ts';
import type { ReadOnlySpawnEntry } from '../../../manifest/read-only-spawn.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

async function fixture(access: 'read' | 'write' | 'undetermined', readOnlySpawn?: readonly ReadOnlySpawnEntry[]) {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-pin-write-`));
  parents.push(parent);
  const home = `${parent}/home`;
  const folder = `${parent}/folder`;
  await mkdir(home);
  await mkdir(folder);
  await writeFile(`${folder}/kept.txt`, 'original\n');
  const pins = new PinRegistry(() => platformRootPinner());
  const work: WorkFolders = {
    folderOf: () => folder as FencedPath,
    check: (_ferret, path) => (path.startsWith(folder) ? ok(path as FencedPath) : err('outside')),
  };
  // The read-only capability declares ONLY imports, with no work or other writable root.
  const roots = rootsPortFor(
    nodeFs(() => 'fixture'),
    { home, plugin: 'ferrets', worktrees: `${parent}/worktrees` },
    access === 'write' ? ['work'] : ['imports'],
    () => work,
    { pins },
  );
  const root =
    access === 'write'
      ? roots.root('work', { ferret: 'f1' as FerretId })
      : roots.root('imports', { subfolder: folder });
  const resolved = root.resolve('.');
  if (!resolved.ok) throw new Error(resolved.error);
  const held = access === 'undetermined' ? await pins.pin('ferrets', folder) : await root.pin(resolved.value);
  const spawn = restrictSpawn(
    'ferrets',
    ['sh', 'cat', 'git'],
    bunSpawn({ PATH: process.env.PATH ?? '', HOME: home }),
    undefined,
    pins,
    undefined,
    readOnlySpawn,
  );
  return { parent, folder, held, spawn, pins };
}

const mutate = ['-c', 'printf changed > kept.txt; printf new > created.txt'];
const gitEnv = { GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' };
async function invoke(
  spawn: SpawnPort,
  method: 'run' | 'runBytes' | 'start',
  cwd: Awaited<ReturnType<typeof fixture>>['held']['policyCwd'],
) {
  if (method === 'start') {
    const child = spawn.start('sh', mutate, { cwd });
    await child.exited;
  } else {
    await spawn[method]('sh', mutate, { cwd });
  }
}

describe('SEC-K1: a pinned program needs the root’s write authority', () => {
  for (const method of ['run', 'runBytes', 'start'] as const) {
    for (const extra of ['trace', 'config'] as const) {
      test(`SEC-K1b: ${method} undeclared Git ${extra} environment refuses before a read writes`, async () => {
        const f = await fixture('read', WORKTREE_GIT_READS);
        try {
          const env = {
            ...gitEnv,
            ...(extra === 'trace'
              ? { GIT_TRACE: `${f.folder}/trace.log` }
              : { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.pager', GIT_CONFIG_VALUE_0: 'injected' }),
          };
          const call = async () => {
            const result = f.spawn[method]('git', [...HARDENED_GIT_ARGUMENTS, 'rev-parse', '--is-inside-work-tree'], {
              cwd: f.held.policyCwd,
              env,
            });
            if ('exited' in result) await result.exited;
            else await result;
          };
          const refused = await call().then(
            () => undefined,
            error => error,
          );
          expect(await readdir(f.folder)).toEqual(['kept.txt']);
          expect(refused).toMatchObject({ code: 'pin_write_required' });
        } finally {
          await f.held.close();
        }
      });
    }
  }

  test('SEC-K1b: Git global paths stay inside the pin, including after symlinks and chained -C', async () => {
    const f = await fixture('read', WORKTREE_GIT_READS);
    const setup = bunSpawn({ PATH: process.env.PATH ?? '', HOME: `${f.parent}/home` });
    try {
      const outside = `${f.parent}/folder-other`;
      const inside = `${f.folder}/repo`;
      for (const folder of [outside, inside]) {
        await mkdir(folder);
        expect((await setup.run('git', ['init', '-b', 'main', folder])).exitCode).toBe(0);
      }
      await mkdir(`${outside}/deep`);
      expect((await setup.run('git', ['init', '-b', 'main', `${outside}/repo`])).exitCode).toBe(0);
      await symlink(outside, `${f.folder}/escape`);
      await symlink(`${outside}/deep`, `${f.folder}/deep-link`);
      await symlink(inside, `${f.folder}/local`);
      const attempts = [
        { prefix: [`--git-dir=${outside}/.git`, '--work-tree=.'], allowed: false },
        { prefix: ['--git-dir=../folder-other/.git', '--work-tree=.'], allowed: false },
        { prefix: ['--git-dir=escape/.git', '--work-tree=.'], allowed: false },
        { prefix: ['--git-dir=deep-link/../repo/.git', '--work-tree=.'], allowed: false },
        { prefix: ['--git-dir=repo/.git', '--work-tree=.'], allowed: true },
        { prefix: ['--git-dir=local/.git', '--work-tree=.'], allowed: true },
        { prefix: ['--git-dir=missing/.git', '--work-tree=.'], allowed: false },
        { prefix: ['--git-dir', `${outside}/.git`, '--work-tree', '.'], allowed: false },
        { prefix: ['--git-dir=repo/.git', '--work-tree', outside], allowed: false },
        { prefix: ['--git-dir=repo/.git', '--work-tree=escape'], allowed: false },
        { prefix: ['-C', outside], allowed: false },
        { prefix: ['-Cescape'], allowed: false },
        { prefix: ['-C', 'repo', '-C', '../../folder-other'], allowed: false },
        { prefix: ['-C', 'repo'], allowed: true },
        { prefix: ['--git-dir=.git', '-C', 'repo'], allowed: true },
      ];
      for (const { prefix, allowed } of attempts) {
        // Exact declarations ensure denial proves path confinement, rather than an argv mismatch.
        const args = [...HARDENED_GIT_ARGUMENTS, ...prefix, 'rev-parse', '--absolute-git-dir'];
        const port = restrictSpawn('ferrets', ['git'], setup, undefined, f.pins, undefined, [
          { program: 'git', args, env: gitEnv },
        ]);
        const result = await port.run('git', args, { cwd: f.held.policyCwd, env: gitEnv }).then(
          value => value,
          error => error,
        );
        if (allowed) expect(result).toMatchObject({ exitCode: 0, stdout: `${inside}/.git\n` });
        else expect(result).toMatchObject({ code: 'pin_write_required' });
      }
      // Exercise the shipped wildcard declaration too, so narrowing that declaration alone cannot hide the hole.
      await expect(
        f.spawn.run(
          'git',
          [...HARDENED_GIT_ARGUMENTS, `--git-dir=${outside}/.git`, '--work-tree=.', 'rev-parse', '--absolute-git-dir'],
          { cwd: f.held.policyCwd, env: gitEnv },
        ),
      ).rejects.toMatchObject({ code: 'pin_write_required' });
      const escaped = [
        ...HARDENED_GIT_ARGUMENTS,
        `--git-dir=${outside}/.git`,
        '--work-tree=.',
        'rev-parse',
        '--absolute-git-dir',
      ];
      await expect(f.spawn.runBytes('git', escaped, { cwd: f.held.policyCwd, env: gitEnv })).rejects.toMatchObject({
        code: 'pin_write_required',
      });
      expect(() => f.spawn.start('git', escaped, { cwd: f.held.policyCwd, env: gitEnv })).toThrow();
    } finally {
      await f.held.close();
    }
  });

  for (const method of ['run', 'runBytes', 'start'] as const) {
    test(`${method}: read-only-only capability cannot mutate through its pin; disk stays unchanged`, async () => {
      const f = await fixture('read');
      try {
        const refused = await invoke(f.spawn, method, f.held.policyCwd).then(
          () => undefined,
          error => error,
        );
        // Inspect disk even on the vulnerable base, where the command actually runs.
        expect(await readFile(`${f.folder}/kept.txt`, 'utf8')).toBe('original\n');
        expect(await readdir(f.folder)).toEqual(['kept.txt']);
        expect(refused).toMatchObject({ name: 'PermissionError', code: 'pin_write_required' });
      } finally {
        await f.held.close();
      }
    });

    test(`${method}: the same mutating program works with write authority`, async () => {
      const f = await fixture('write');
      try {
        await invoke(f.spawn, method, f.held.policyCwd);
        expect(await readFile(`${f.folder}/kept.txt`, 'utf8')).toBe('changed');
        expect(await readFile(`${f.folder}/created.txt`, 'utf8')).toBe('new');
      } finally {
        await f.held.close();
      }
    });
  }

  test('an explicitly declared read-only program works on a read-only pin', async () => {
    const f = await fixture('read', ['cat']);
    try {
      expect(await f.spawn.run('cat', ['kept.txt'], { cwd: f.held.policyCwd })).toMatchObject({
        exitCode: 0,
        stdout: 'original\n',
      });
      expect(await readdir(f.folder)).toEqual(['kept.txt']);
    } finally {
      await f.held.close();
    }
  });

  test('undetermined pin authority refuses before the program writes', async () => {
    const f = await fixture('undetermined');
    try {
      const refused = await invoke(f.spawn, 'run', f.held.policyCwd).then(
        () => undefined,
        error => error,
      );
      expect(await readFile(`${f.folder}/kept.txt`, 'utf8')).toBe('original\n');
      expect(await readdir(f.folder)).toEqual(['kept.txt']);
      expect(refused).toMatchObject({ name: 'PermissionError', code: 'pin_write_required' });
    } finally {
      await f.held.close();
    }
  });

  test('write authority supports Git worktree create, move and remove through the admitted pin', async () => {
    const f = await fixture('write');
    try {
      const git = async (...args: string[]) => {
        const result = await f.spawn.run('git', args, { cwd: f.held.policyCwd });
        expect(result.exitCode).toBe(0);
        return result;
      };
      await git('init', '-b', 'main');
      await git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '--allow-empty',
        '-m',
        'fixture',
      );
      await git('worktree', 'add', '-b', 'feature', `${f.folder}/checkout`);
      expect(await readdir(`${f.folder}/checkout`)).toContain('.git');
      await git('worktree', 'move', `${f.folder}/checkout`, `${f.folder}/moved`);
      expect(await readdir(f.folder)).not.toContain('checkout');
      expect(await readdir(`${f.folder}/moved`)).toContain('.git');
      await git('worktree', 'remove', `${f.folder}/moved`);
      expect(await readdir(f.folder)).not.toContain('moved');
    } finally {
      await f.held.close();
    }
  });

  test('even a declared read-only program refuses when pin authority is undetermined', async () => {
    const f = await fixture('undetermined', ['cat']);
    try {
      await expect(f.spawn.run('cat', ['kept.txt'], { cwd: f.held.policyCwd })).rejects.toMatchObject({
        code: 'pin_write_required',
      });
    } finally {
      await f.held.close();
    }
  });

  test('exact Git read shapes work, while mutating argv and missing lock suppression on the SAME read pin refuse', async () => {
    const f = await fixture('read', WORKTREE_GIT_READS);
    const setup = bunSpawn({ PATH: process.env.PATH ?? '', HOME: f.folder });
    const prep = async (...args: string[]) => {
      expect((await setup.run('git', args, { cwd: f.folder as FencedPath })).exitCode).toBe(0);
    };
    try {
      await prep('init', '-b', 'main');
      await prep('add', 'kept.txt');
      await prep('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture');
      const before = await readFile(`${f.folder}/.git/index`);
      const mtime = (await stat(`${f.folder}/.git/index`, { bigint: true })).mtimeNs;
      const config = await readFile(`${f.folder}/.git/config`, 'utf8');
      const env = { GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' };
      const run = (args: string[], givenEnv: Record<string, string> = env) =>
        f.spawn.run('git', [...HARDENED_GIT_ARGUMENTS, ...args], {
          cwd: f.held.policyCwd,
          env: givenEnv,
        });
      for (const readsGlobal of [false, true]) {
        for (const literal of [false, true]) {
          const safe = {
            ...env,
            GIT_CONFIG_SYSTEM: '/dev/null',
            ...(readsGlobal ? {} : { GIT_CONFIG_GLOBAL: '/dev/null' }),
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_TERMINAL_PROMPT: '0',
            GIT_PAGER: 'cat',
            GIT_ASKPASS: '',
            ...(literal ? { GIT_LITERAL_PATHSPECS: '1' } : {}),
          };
          expect((await run(['rev-parse', '--is-inside-work-tree'], safe)).exitCode).toBe(0);
          await expect(
            run(['rev-parse', '--is-inside-work-tree'], { ...safe, GIT_PAGER: 'injected' }),
          ).rejects.toMatchObject({ code: 'pin_write_required' });
        }
      }
      for (const args of [
        ['rev-parse', '--is-inside-work-tree'],
        ['for-each-ref', '--format=%(refname)', 'refs/remotes'],
        ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none'],
      ])
        expect((await run(args)).exitCode).toBe(0);
      for (const args of [
        ['update-ref', 'refs/heads/injected', 'HEAD'],
        ['branch', '-D', 'main'],
        ['config', '--add', 'core.pager', 'injected'],
        ['worktree', 'add', `${f.folder}/injected`],
        ['symbolic-ref', '--quiet', 'HEAD', 'refs/heads/injected'],
        ['diff', '--output=written.txt', 'HEAD'],
      ])
        await expect(run(args)).rejects.toMatchObject({ code: 'pin_write_required' });
      await expect(
        run(['rev-parse', '--is-inside-work-tree'], { GIT_OPTIONAL_LOCKS: '1', GIT_NO_LAZY_FETCH: '1' }),
      ).rejects.toMatchObject({ code: 'pin_write_required' });
      expect(await readFile(`${f.folder}/.git/index`)).toEqual(before);
      expect((await stat(`${f.folder}/.git/index`, { bigint: true })).mtimeNs).toBe(mtime);
      expect(await readFile(`${f.folder}/.git/config`, 'utf8')).toBe(config);
      expect(await readdir(`${f.folder}/.git/refs/heads`)).toEqual(['main']);
      expect(await readdir(f.folder)).toEqual(['.git', 'kept.txt']);
    } finally {
      await f.held.close();
    }
  });

  for (const declaration of [undefined, ['*'], ['$daemon'], 'sh', [true], ['sh', true], ['sh', '*'], { sh: true }]) {
    test(`missing or malformed read-only declaration ${JSON.stringify(declaration)} grants no exemption`, async () => {
      const f = await fixture('read', declaration as readonly string[] | undefined);
      try {
        const refused = await invoke(f.spawn, 'run', f.held.policyCwd).then(
          () => undefined,
          error => error,
        );
        expect(await readFile(`${f.folder}/kept.txt`, 'utf8')).toBe('original\n');
        expect(refused).toMatchObject({ code: 'pin_write_required' });
      } finally {
        await f.held.close();
      }
    });
  }
});
