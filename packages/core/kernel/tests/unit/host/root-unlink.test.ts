/**
 * `RootHandle.unlink` on the real disk (§7.7, ruling #52 amendment 3): removes a SYMLINK LEAF inside `fleet` or
 * `agent-homes` and nothing else. The link is never followed, its target is never touched (inside or outside the
 * root), a file, a folder or a missing name is refused, and every refusal is facts-only.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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
  const parent = await realpath(await mkdtemp(`${tmpdir()}/root-unlink-`));
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

describe('RootHandle.unlink', () => {
  test('removes a link and leaves its target exactly as it was (inside the root)', async () => {
    const f = await fresh();
    await writeFile(`${f.dir}/real.txt`, 'REAL');
    await symlink(`${f.dir}/real.txt`, `${f.dir}/skill`);
    await f.fleet.unlink(at(f.fleet, 'homes/claude-a/skill'));
    expect(await gone(`${f.dir}/skill`)).toBe(true);
    expect(await readFile(`${f.dir}/real.txt`, 'utf8')).toBe('REAL');
  });

  test('a link whose target is OUTSIDE the root is still removable, and the target is untouched', async () => {
    const f = await fresh();
    const credential = `${f.owner}/.claude/.credentials.json`;
    await symlink(credential, `${f.dir}/.credentials.json`);
    // the existing remove follows the leaf and refuses this one: that is why unlink exists
    expect(await refusalOf(() => f.fleet.remove(at(f.fleet, 'homes/claude-a/.credentials.json')))).toBeDefined();
    await f.fleet.unlink(at(f.fleet, 'homes/claude-a/.credentials.json'));
    expect(await gone(`${f.dir}/.credentials.json`)).toBe(true);
    expect(await readFile(credential, 'utf8')).toBe('{"planted":"credential"}\n');
  });

  test('a link to a folder removes only the link: the folder and its content stay', async () => {
    const f = await fresh();
    await mkdir(`${f.parent}/pack`);
    await writeFile(`${f.parent}/pack/a.txt`, 'a');
    await symlink(`${f.parent}/pack`, `${f.dir}/pack`);
    await f.fleet.unlink(at(f.fleet, 'homes/claude-a/pack'));
    expect(await gone(`${f.dir}/pack`)).toBe(true);
    expect(await readFile(`${f.parent}/pack/a.txt`, 'utf8')).toBe('a');
  });

  test('a dangling link is removable', async () => {
    const f = await fresh();
    await symlink(`${f.parent}/nowhere`, `${f.dir}/dangling`);
    await f.fleet.unlink(at(f.fleet, 'homes/claude-a/dangling'));
    expect(await gone(`${f.dir}/dangling`)).toBe(true);
  });

  test('works in agent-homes too', async () => {
    const f = await fresh();
    const homes = f.port.root('agent-homes', { subfolder: 'ferret-a' });
    await homes.makeDirectory(at(homes, '.claude'));
    await writeFile(`${f.parent}/t.txt`, 't');
    await symlink(`${f.parent}/t.txt`, `${f.home}/state/runtimes/agent-homes/ferret-a/.claude/skill`);
    await homes.unlink(at(homes, '.claude/skill'));
    expect(await gone(`${f.home}/state/runtimes/agent-homes/ferret-a/.claude/skill`)).toBe(true);
    expect(await readFile(`${f.parent}/t.txt`, 'utf8')).toBe('t');
  });

  test('a file, a folder and a missing name are refused "outside" and left as they were', async () => {
    const f = await fresh();
    await writeFile(`${f.dir}/file`, 'mine');
    await mkdir(`${f.dir}/folder`);
    await writeFile(`${f.dir}/folder/keep`, 'keep');
    for (const name of ['file', 'folder', 'none'])
      expect(await refusalOf(() => f.fleet.unlink(at(f.fleet, `homes/claude-a/${name}`)))).toBe('outside');
    expect(await readFile(`${f.dir}/file`, 'utf8')).toBe('mine');
    expect(await readFile(`${f.dir}/folder/keep`, 'utf8')).toBe('keep');
  });

  test('only inside fleet or agent-homes: a read-only root and any other root refuse, and nothing is removed', async () => {
    const f = await fresh();
    expect(await refusalOf(() => f.harness.unlink(at(f.harness, '.credentials.json')))).toBe('read_only');
    expect(await readFile(`${f.owner}/.claude/.credentials.json`, 'utf8')).toContain('planted');
    for (const name of ['downloads', 'worktrees'] as const) {
      const root = f.port.root(name);
      expect(await refusalOf(() => root.unlink(at(root, 'a')))).toBe('read_only');
    }
  });

  test('a link on the way is refused, even one that stays inside the root, and the link behind it stays', async () => {
    const f = await fresh();
    await mkdir(`${f.home}/fleet/homes/claude-b`, { mode: 0o700 });
    await symlink(`${f.parent}/x`, `${f.home}/fleet/homes/claude-b/inner`);
    await symlink(`${f.home}/fleet/homes/claude-b`, `${f.home}/fleet/homes/alias`);
    expect(await refusalOf(() => f.fleet.unlink(at(f.fleet, 'homes/alias/inner')))).toBe('link_escape');
    expect(await readlink(`${f.home}/fleet/homes/claude-b/inner`)).toBe(`${f.parent}/x`);
  });

  test('a link on the way out of the root is refused and removes nothing outside', async () => {
    const f = await fresh();
    await mkdir(`${f.parent}/outside`);
    await symlink(`${f.parent}/y`, `${f.parent}/outside/secret`);
    await symlink(`${f.parent}/outside`, `${f.dir}/door`);
    expect(await refusalOf(() => f.fleet.unlink(at(f.fleet, 'homes/claude-a/door/secret')))).toBe('link_escape');
    expect(await readlink(`${f.parent}/outside/secret`)).toBe(`${f.parent}/y`);
  });

  test('traversal, NUL, a path outside the root and an empty name are refused', async () => {
    const f = await fresh();
    await symlink(`${f.parent}/t`, `${f.dir}/l`);
    const l = at(f.fleet, 'homes/claude-a/l');
    for (const bad of [`${l}/../l`, '/etc/passwd', `${l}\0`, ''] as const)
      expect(await refusalOf(() => f.fleet.unlink(bad as FencedPath))).toBeDefined();
    expect(await readlink(`${f.dir}/l`)).toBe(`${f.parent}/t`);
  });

  test('the root itself cannot be unlinked', async () => {
    const f = await fresh();
    expect(await refusalOf(() => f.fleet.unlink(at(f.fleet, '')))).toBeDefined();
    expect((await lstat(`${f.home}/fleet`)).isDirectory()).toBe(true);
  });

  test('a removal the disk refuses is "changed" with no path or content in the message', async () => {
    const base = nodeFs(() => crypto.randomUUID());
    const f = await fresh({
      ...base,
      unlink: async path => {
        throw Object.assign(new Error(`EPERM ${path}`), { code: 'EPERM' });
      },
    });
    await symlink(`${f.parent}/TOPSECRET`, `${f.dir}/skill`);
    const error = await f.fleet.unlink(at(f.fleet, 'homes/claude-a/skill')).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect((error as RootError).refusal).toBe('changed');
    expect(error?.message).toBe('root refused: changed');
    expect(error?.message).not.toContain('skill');
    expect(error?.message).not.toContain('TOPSECRET');
    expect(await readlink(`${f.dir}/skill`)).toBe(`${f.parent}/TOPSECRET`);
  });

  test('GAP (declared): a file swapped in for the link between the look and the removal is removed', async () => {
    let swapped = false;
    const base = nodeFs(() => crypto.randomUUID());
    const f = await fresh({
      ...base,
      unlink: async path => {
        if (!swapped) {
          swapped = true;
          await rm(`${f.dir}/skill`);
          await writeFile(`${f.dir}/skill`, 'planted');
        }
        await base.unlink(path);
      },
    });
    await symlink(`${f.parent}/t`, `${f.dir}/skill`);
    await f.fleet.unlink(at(f.fleet, 'homes/claude-a/skill'));
    expect(swapped).toBe(true);
    expect(await gone(`${f.dir}/skill`)).toBe(true);
  });
});
