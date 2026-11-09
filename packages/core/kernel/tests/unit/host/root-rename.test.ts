/**
 * `RootHandle.rename` on the real disk (§7.7, ruling #52 amendment 2): an entry moves inside `fleet` or `agent-homes`
 * AS IS (a link stays a link, a folder moves whole), both ends fenced and every parent opened without following a link,
 * an existing target is refused, and a move the disk refuses is a facts-only error, never a copy.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { FencedPath } from '../../../contract/bound.ts';
import type { RootHandle, RootName } from '../../../contract/ports.ts';
import { type HostFs, nodeFs } from '../../../host/adapters/node-fs.ts';
import { ensureInternalRootBases, RootError, rootsPortFor } from '../../../host/roots.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const DECLARED: readonly RootName[] = ['fleet', 'harness-home', 'downloads', 'agent-homes', 'worktrees'];

async function fresh(fs: HostFs = nodeFs(() => crypto.randomUUID())) {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/root-rename-`));
  parents.push(parent);
  const home = `${parent}/home`;
  const owner = `${parent}/owner`;
  await mkdir(`${home}/state`, { recursive: true, mode: 0o700 });
  await mkdir(`${home}/config`, { recursive: true, mode: 0o700 });
  await mkdir(`${owner}/.claude`, { recursive: true, mode: 0o700 });
  await mkdir(`${home}-worktrees`, { recursive: true, mode: 0o700 });
  await writeFile(`${owner}/.claude/.credentials.json`, '{"planted":"credential"}\n', { mode: 0o600 });
  const port = rootsPortFor(
    fs,
    { home, plugin: 'runtimes', worktrees: `${home}-worktrees` },
    DECLARED,
    () => undefined,
    {
      setMode: true,
    },
  );
  await ensureInternalRootBases(
    nodeFs(() => crypto.randomUUID()),
    { home, plugin: 'runtimes' },
    DECLARED,
  );
  const fleet = port.root('fleet');
  const harness = port.root('harness-home', { subfolder: `${owner}/.claude` });
  await fleet.makeDirectory(at(fleet, 'homes/claude-a'));
  return { parent, home, owner, fs, port, fleet, harness, dir: `${home}/fleet/homes/claude-a` };
}

const at = (root: RootHandle, path: string): FencedPath => {
  const resolved = root.resolve(path);
  if (!resolved.ok) throw new Error(resolved.error);
  return resolved.value;
};

async function refusalOf(call: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await call();
    return undefined;
  } catch (error) {
    if (error instanceof RootError) return error.refusal;
    throw error;
  }
}

const gone = async (path: string): Promise<boolean> => (await lstat(path).catch(() => undefined)) === undefined;

describe('RootHandle.rename', () => {
  test('moves a file, then moves it back (the provisioner’s aside and undo)', async () => {
    const f = await fresh();
    await writeFile(`${f.dir}/settings.json`, '{"a":1}', { mode: 0o600 });
    await f.fleet.rename(
      at(f.fleet, 'homes/claude-a/settings.json'),
      at(f.fleet, 'homes/claude-a/settings.json.evidence'),
    );
    expect(await gone(`${f.dir}/settings.json`)).toBe(true);
    expect(await readFile(`${f.dir}/settings.json.evidence`, 'utf8')).toBe('{"a":1}');
    await f.fleet.rename(
      at(f.fleet, 'homes/claude-a/settings.json.evidence'),
      at(f.fleet, 'homes/claude-a/settings.json'),
    );
    expect(await readFile(`${f.dir}/settings.json`, 'utf8')).toBe('{"a":1}');
  });

  test('a link moves AS A LINK: its text is unchanged and what it points at is never touched or followed', async () => {
    const f = await fresh();
    const credential = `${f.owner}/.claude/.credentials.json`;
    await symlink(credential, `${f.dir}/.credentials.json`);
    await f.fleet.rename(at(f.fleet, 'homes/claude-a/.credentials.json'), at(f.fleet, 'homes/claude-a/aside'));
    expect((await lstat(`${f.dir}/aside`)).isSymbolicLink()).toBe(true);
    expect(await readlink(`${f.dir}/aside`)).toBe(credential);
    expect(await gone(`${f.dir}/.credentials.json`)).toBe(true);
    expect(await readFile(credential, 'utf8')).toBe('{"planted":"credential"}\n');
  });

  test('a dangling link moves too', async () => {
    const f = await fresh();
    await symlink(`${f.parent}/nowhere`, `${f.dir}/dangling`);
    await f.fleet.rename(at(f.fleet, 'homes/claude-a/dangling'), at(f.fleet, 'homes/claude-a/dangling2'));
    expect(await readlink(`${f.dir}/dangling2`)).toBe(`${f.parent}/nowhere`);
  });

  test('a directory moves whole, across folders of the same root', async () => {
    const f = await fresh();
    await mkdir(`${f.dir}/tree/deep`, { recursive: true, mode: 0o700 });
    await writeFile(`${f.dir}/tree/deep/a.txt`, 'a');
    await mkdir(`${f.home}/fleet/homes/claude-b`, { mode: 0o700 });
    await f.fleet.rename(at(f.fleet, 'homes/claude-a/tree'), at(f.fleet, 'homes/claude-b/moved'));
    expect(await readFile(`${f.home}/fleet/homes/claude-b/moved/deep/a.txt`, 'utf8')).toBe('a');
    expect(await gone(`${f.dir}/tree`)).toBe(true);
  });

  test('works in agent-homes too', async () => {
    const f = await fresh();
    const homes = f.port.root('agent-homes', { subfolder: 'ferret-a' });
    await homes.makeDirectory(at(homes, '.claude'));
    await homes.writeText(at(homes, '.claude/a.json'), '{}');
    await homes.rename(at(homes, '.claude/a.json'), at(homes, '.claude/b.json'));
    expect(await homes.readText(at(homes, '.claude/b.json'))).toBe('{}');
  });

  test('only inside fleet or agent-homes: a read-only root and any other root refuse, and nothing moves', async () => {
    const f = await fresh();
    expect(await refusalOf(() => f.harness.rename(at(f.harness, '.credentials.json'), at(f.harness, 'x')))).toBe(
      'read_only',
    );
    expect(await readFile(`${f.owner}/.claude/.credentials.json`, 'utf8')).toContain('planted');
    for (const name of ['downloads', 'worktrees'] as const) {
      const root = f.port.root(name);
      expect(await refusalOf(() => root.rename(at(root, 'a'), at(root, 'b')))).toBe('read_only');
    }
  });

  test('an existing target is refused and left exactly as it was: file, link, dangling link, folder', async () => {
    const f = await fresh();
    await writeFile(`${f.dir}/from`, 'from');
    await writeFile(`${f.dir}/file`, 'mine');
    await symlink(`${f.parent}/elsewhere`, `${f.dir}/dangling`);
    await symlink(`${f.owner}/.claude/.credentials.json`, `${f.dir}/linked`);
    await mkdir(`${f.dir}/folder`);
    for (const name of ['file', 'dangling', 'linked', 'folder'])
      expect(
        await refusalOf(() =>
          f.fleet.rename(at(f.fleet, 'homes/claude-a/from'), at(f.fleet, `homes/claude-a/${name}`)),
        ),
      ).toBe('outside');
    expect(await readFile(`${f.dir}/from`, 'utf8')).toBe('from');
    expect(await readFile(`${f.dir}/file`, 'utf8')).toBe('mine');
    expect(await readlink(`${f.dir}/dangling`)).toBe(`${f.parent}/elsewhere`);
    expect((await lstat(`${f.dir}/folder`)).isDirectory()).toBe(true);
  });

  test('a missing source is refused', async () => {
    const f = await fresh();
    expect(
      await refusalOf(() => f.fleet.rename(at(f.fleet, 'homes/claude-a/none'), at(f.fleet, 'homes/claude-a/x'))),
    ).toBe('outside');
  });

  test('a link on the way at EITHER end is refused, even one that stays inside the root', async () => {
    const f = await fresh();
    await mkdir(`${f.home}/fleet/homes/claude-b`, { mode: 0o700 });
    await writeFile(`${f.home}/fleet/homes/claude-b/in`, 'in');
    await writeFile(`${f.dir}/out`, 'out');
    await symlink(`${f.home}/fleet/homes/claude-b`, `${f.home}/fleet/homes/alias`);
    expect(await refusalOf(() => f.fleet.rename(at(f.fleet, 'homes/alias/in'), at(f.fleet, 'homes/claude-a/in')))).toBe(
      'link_escape',
    );
    expect(
      await refusalOf(() => f.fleet.rename(at(f.fleet, 'homes/claude-a/out'), at(f.fleet, 'homes/alias/out'))),
    ).toBe('link_escape');
    expect(await readFile(`${f.home}/fleet/homes/claude-b/in`, 'utf8')).toBe('in');
    expect(await readFile(`${f.dir}/out`, 'utf8')).toBe('out');
  });

  test('a link on the way out of the root is refused and moves nothing outside', async () => {
    const f = await fresh();
    await mkdir(`${f.parent}/outside`);
    await writeFile(`${f.parent}/outside/secret`, 'secret');
    await symlink(`${f.parent}/outside`, `${f.dir}/door`);
    await writeFile(`${f.dir}/mine`, 'mine');
    expect(
      await refusalOf(() => f.fleet.rename(at(f.fleet, 'homes/claude-a/door/secret'), at(f.fleet, 'homes/claude-a/s'))),
    ).toBe('link_escape');
    expect(
      await refusalOf(() =>
        f.fleet.rename(at(f.fleet, 'homes/claude-a/mine'), at(f.fleet, 'homes/claude-a/door/mine')),
      ),
    ).toBe('link_escape');
    expect(await readFile(`${f.parent}/outside/secret`, 'utf8')).toBe('secret');
    expect(await gone(`${f.parent}/outside/mine`)).toBe(true);
  });

  test('traversal, NUL, a path outside the root, an empty name and the same name twice are refused', async () => {
    const f = await fresh();
    await writeFile(`${f.dir}/a`, 'a');
    const a = at(f.fleet, 'homes/claude-a/a');
    for (const bad of [`${a}/../b`, '/etc/passwd', `${a}\0`, ''] as const)
      expect(await refusalOf(() => f.fleet.rename(a, bad as FencedPath))).toBeDefined();
    expect(await refusalOf(() => f.fleet.rename(a, a))).toBe('outside');
    expect(await readFile(`${f.dir}/a`, 'utf8')).toBe('a');
  });

  test('the root itself cannot be moved', async () => {
    const f = await fresh();
    const root = at(f.fleet, '');
    expect(await refusalOf(() => f.fleet.rename(root, at(f.fleet, 'homes/claude-a/self')))).toBeDefined();
    expect((await lstat(`${f.home}/fleet`)).isDirectory()).toBe(true);
  });

  test('a refused move (a folder into itself) is "changed" with no path or content in the message, and no copy is made', async () => {
    const f = await fresh();
    await mkdir(`${f.dir}/tree`);
    await writeFile(`${f.dir}/tree/secret.txt`, 'TOPSECRET');
    const error = await f.fleet
      .rename(at(f.fleet, 'homes/claude-a/tree'), at(f.fleet, 'homes/claude-a/tree/inner'))
      .then(
        () => undefined,
        (caught: unknown) => caught as Error,
      );
    expect((error as RootError).refusal).toBe('changed');
    expect(error?.message).toBe('root refused: changed');
    expect(error?.message).not.toContain('tree');
    expect(error?.message).not.toContain('TOPSECRET');
    expect(await readFile(`${f.dir}/tree/secret.txt`, 'utf8')).toBe('TOPSECRET');
    expect(await gone(`${f.dir}/tree/inner`)).toBe(true);
  });

  test('a move the disk refuses across devices is "changed" and falls back to nothing: no copy, no unlink', async () => {
    let attempts = 0;
    const base = nodeFs(() => crypto.randomUUID());
    const f = await fresh({
      ...base,
      rename: async (from, to) => {
        attempts += 1;
        throw Object.assign(new Error(`EXDEV ${from} ${to}`), { code: 'EXDEV' });
      },
    });
    await writeFile(`${f.dir}/a`, 'AAA');
    const error = await f.fleet.rename(at(f.fleet, 'homes/claude-a/a'), at(f.fleet, 'homes/claude-a/b')).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect((error as RootError).refusal).toBe('changed');
    expect(error?.message).toBe('root refused: changed');
    expect(attempts).toBe(1);
    expect(await readFile(`${f.dir}/a`, 'utf8')).toBe('AAA');
    expect(await gone(`${f.dir}/b`)).toBe(true);
  });

  test('GAP (declared): the target is looked at, then the move happens; a file planted in that window is replaced', async () => {
    let planted = false;
    const base = nodeFs(() => crypto.randomUUID());
    const f = await fresh({
      ...base,
      rename: async (from, to) => {
        if (!planted) {
          planted = true;
          await writeFile(`${f.dir}/b`, 'planted');
        }
        await base.rename(from, to);
      },
    });
    await writeFile(`${f.dir}/a`, 'AAA');
    await f.fleet.rename(at(f.fleet, 'homes/claude-a/a'), at(f.fleet, 'homes/claude-a/b'));
    expect(planted).toBe(true);
    // the honest limit: the planted file lost its name to the move; a non-empty folder would have stopped it
    expect(await readFile(`${f.dir}/b`, 'utf8')).toBe('AAA');
  });

  test('a non-empty folder planted at the target in that window is never replaced', async () => {
    let planted = false;
    const base = nodeFs(() => crypto.randomUUID());
    const f = await fresh({
      ...base,
      rename: async (from, to) => {
        if (!planted) {
          planted = true;
          await mkdir(`${f.dir}/b`);
          await writeFile(`${f.dir}/b/keep`, 'keep');
        }
        await base.rename(from, to);
      },
    });
    await writeFile(`${f.dir}/a`, 'AAA');
    expect(
      await refusalOf(() => f.fleet.rename(at(f.fleet, 'homes/claude-a/a'), at(f.fleet, 'homes/claude-a/b'))),
    ).toBe('changed');
    expect(await readFile(`${f.dir}/b/keep`, 'utf8')).toBe('keep');
    expect(await readFile(`${f.dir}/a`, 'utf8')).toBe('AAA');
  });
});

describe('RootHandle.rename needs descriptor reach', () => {
  test('a host without descriptor reach (macOS today) refuses with no_descriptor_reach and moves nothing', async () => {
    const f = await fresh(nodeFs(() => crypto.randomUUID(), { descriptorFolder: '/nonexistent-descriptor-folder' }));
    await mkdir(`${f.dir}/sub`, { mode: 0o700 });
    await writeFile(`${f.dir}/sub/a`, 'AAA');
    expect(
      await refusalOf(() => f.fleet.rename(at(f.fleet, 'homes/claude-a/sub/a'), at(f.fleet, 'homes/claude-a/sub/b'))),
    ).toBe('no_descriptor_reach');
    expect(await readFile(`${f.dir}/sub/a`, 'utf8')).toBe('AAA');
    expect(await gone(`${f.dir}/sub/b`)).toBe(true);
  });

  test('a parent swapped for a link AFTER the check cannot carry the move outside the root (the held folder is used)', async () => {
    let swapped = false;
    const base = nodeFs(() => crypto.randomUUID());
    const f = await fresh({
      ...base,
      rename: async (from, to) => {
        if (!swapped) {
          swapped = true;
          await rename(`${f.dir}/sub`, `${f.dir}/sub-moved`);
          await symlink(`${f.parent}/outside`, `${f.dir}/sub`);
        }
        await base.rename(from, to);
      },
    });
    await mkdir(`${f.parent}/outside`);
    await mkdir(`${f.dir}/sub`, { mode: 0o700 });
    await writeFile(`${f.dir}/sub/a`, 'AAA');
    await f.fleet.rename(at(f.fleet, 'homes/claude-a/sub/a'), at(f.fleet, 'homes/claude-a/sub/b'));
    expect(swapped).toBe(true);
    expect(await readFile(`${f.dir}/sub-moved/b`, 'utf8')).toBe('AAA');
    expect(await gone(`${f.parent}/outside/b`)).toBe(true);
  });
});
