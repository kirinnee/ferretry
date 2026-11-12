/**
 * `RootHandle.unlinkFile` on the real disk: removes ONE regular file inside `fleet` or `agent-homes` that is still the
 * file the caller looked at (device and inode), with `unlink(2)` and never a walk. A folder, a link or any other object
 * at the name is refused and left whole; a name that now reaches another file is "changed"; a second name of the file
 * loses only the named one.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { link, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { FencedPath } from '../../../contract/bound.ts';
import type { RootHandle, RootIdentity, RootName } from '../../../contract/ports.ts';
import { type HostFs, nodeFs } from '../../../host/adapters/node-fs.ts';
import { ensureInternalRootBases, RootError, rootsPortFor } from '../../../host/roots.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const DECLARED: readonly RootName[] = ['fleet', 'harness-home', 'downloads', 'agent-homes', 'worktrees'];

async function fresh(fs: HostFs = nodeFs(() => crypto.randomUUID())) {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/root-unlink-file-`));
  parents.push(parent);
  const home = `${parent}/home`;
  const owner = `${parent}/owner`;
  await mkdir(`${home}/state`, { recursive: true, mode: 0o700 });
  await mkdir(`${home}/config`, { recursive: true, mode: 0o700 });
  await mkdir(`${owner}/.claude`, { recursive: true, mode: 0o700 });
  await mkdir(`${home}-worktrees`, { recursive: true, mode: 0o700 });
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
  return { parent, home, owner, port, fleet, harness, dir: `${home}/fleet/homes/claude-a` };
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

const identityOf = async (root: RootHandle, path: FencedPath): Promise<RootIdentity> => {
  const found = await root.fileIdentity(path);
  if (found === undefined) throw new Error('fixture file is missing');
  return found;
};

describe('RootHandle.unlinkFile', () => {
  test('removes the regular file it was told about, and only that name', async () => {
    const f = await fresh();
    await writeFile(`${f.dir}/note`, 'bytes');
    await writeFile(`${f.dir}/neighbour`, 'stays');
    const path = at(f.fleet, 'homes/claude-a/note');

    await f.fleet.unlinkFile(path, await identityOf(f.fleet, path));

    expect(await gone(`${f.dir}/note`)).toBe(true);
    expect(await readFile(`${f.dir}/neighbour`, 'utf8')).toBe('stays');
  });

  test('a name that is already gone is a no-op', async () => {
    const f = await fresh();
    await writeFile(`${f.dir}/note`, 'bytes');
    const path = at(f.fleet, 'homes/claude-a/note');
    const identity = await identityOf(f.fleet, path);
    await rm(`${f.dir}/note`);

    expect(await refusalOf(() => f.fleet.unlinkFile(path, identity))).toBeUndefined();
  });

  test('a FOLDER at the name is refused "not_a_file" and neither it nor anything inside it is touched', async () => {
    const f = await fresh();
    await writeFile(`${f.dir}/note`, 'bytes');
    const path = at(f.fleet, 'homes/claude-a/note');
    const identity = await identityOf(f.fleet, path);
    await rm(`${f.dir}/note`);
    await mkdir(`${f.dir}/note/inner`, { recursive: true });
    await writeFile(`${f.dir}/note/inner/keep`, 'keep');

    expect(await refusalOf(() => f.fleet.unlinkFile(path, identity))).toBe('not_a_file');
    expect(await readFile(`${f.dir}/note/inner/keep`, 'utf8')).toBe('keep');
  });

  test('a LINK at the name is refused and its target is untouched', async () => {
    const f = await fresh();
    await writeFile(`${f.parent}/target`, 'target');
    await writeFile(`${f.dir}/note`, 'bytes');
    const path = at(f.fleet, 'homes/claude-a/note');
    const identity = await identityOf(f.fleet, path);
    await rm(`${f.dir}/note`);
    await symlink(`${f.parent}/target`, `${f.dir}/note`);

    expect(await refusalOf(() => f.fleet.unlinkFile(path, identity))).toBe('not_a_file');
    expect(await readlink(`${f.dir}/note`)).toBe(`${f.parent}/target`);
    expect(await readFile(`${f.parent}/target`, 'utf8')).toBe('target');
  });

  test('another file now at the name is "changed" and stays', async () => {
    const f = await fresh();
    await writeFile(`${f.dir}/note`, 'first');
    const path = at(f.fleet, 'homes/claude-a/note');
    const identity = await identityOf(f.fleet, path);
    await rm(`${f.dir}/note`);
    await writeFile(`${f.dir}/other`, 'second');
    await link(`${f.dir}/other`, `${f.dir}/note`);
    await rm(`${f.dir}/other`);
    await writeFile(`${f.dir}/pad`, 'pad');

    expect(await refusalOf(() => f.fleet.unlinkFile(path, { ...identity, inode: identity.inode + 1000n }))).toBe(
      'changed',
    );
    expect(await readFile(`${f.dir}/note`, 'utf8')).toBe('second');
  });

  test('a file with a second name loses only this name: the other name and the bytes stay', async () => {
    const f = await fresh();
    await writeFile(`${f.dir}/note`, 'shared');
    await link(`${f.dir}/note`, `${f.parent}/alias`);
    const path = at(f.fleet, 'homes/claude-a/note');

    await f.fleet.unlinkFile(path, await identityOf(f.fleet, path));

    expect(await gone(`${f.dir}/note`)).toBe(true);
    expect(await readFile(`${f.parent}/alias`, 'utf8')).toBe('shared');
  });

  test('works in agent-homes too', async () => {
    const f = await fresh();
    const homes = f.port.root('agent-homes', { subfolder: 'ferret-a' });
    await homes.makeDirectory(at(homes, '.claude'));
    await writeFile(`${f.home}/state/runtimes/agent-homes/ferret-a/.claude/note`, 'n');
    const path = at(homes, '.claude/note');

    await homes.unlinkFile(path, await identityOf(homes, path));

    expect(await gone(`${f.home}/state/runtimes/agent-homes/ferret-a/.claude/note`)).toBe(true);
  });

  test('only inside fleet or agent-homes: a read-only root and any other root refuse, and nothing is removed', async () => {
    const f = await fresh();
    await writeFile(`${f.owner}/.claude/note`, 'mine');
    const path = at(f.harness, 'note');
    expect(await refusalOf(() => f.harness.unlinkFile(path, { device: 0n, inode: 0n }))).toBe('read_only');
    expect(await readFile(`${f.owner}/.claude/note`, 'utf8')).toBe('mine');
    for (const name of ['downloads', 'worktrees'] as const) {
      const root = f.port.root(name);
      expect(await refusalOf(() => root.unlinkFile(at(root, 'a'), { device: 0n, inode: 0n }))).toBe('read_only');
    }
  });

  test('a link on the way is refused, even one that stays inside the root, and the file behind it stays', async () => {
    const f = await fresh();
    await mkdir(`${f.home}/fleet/homes/claude-b`, { mode: 0o700 });
    await writeFile(`${f.home}/fleet/homes/claude-b/inner`, 'inner');
    await symlink(`${f.home}/fleet/homes/claude-b`, `${f.home}/fleet/homes/alias`);
    const identity = await identityOf(f.fleet, at(f.fleet, 'homes/claude-b/inner'));

    expect(await refusalOf(() => f.fleet.unlinkFile(at(f.fleet, 'homes/alias/inner'), identity))).toBe('link_escape');
    expect(await readFile(`${f.home}/fleet/homes/claude-b/inner`, 'utf8')).toBe('inner');
  });

  test('traversal, NUL and an empty name are refused', async () => {
    const f = await fresh();
    await writeFile(`${f.dir}/note`, 'bytes');
    const note = at(f.fleet, 'homes/claude-a/note');
    for (const bad of [`${note}/../note`, `${note}\0`, ''] as const)
      expect(await refusalOf(() => f.fleet.unlinkFile(bad as FencedPath, { device: 0n, inode: 0n }))).toBeDefined();
    expect(await readFile(`${f.dir}/note`, 'utf8')).toBe('bytes');
  });

  test('a removal the disk refuses is "changed" with no path in the message', async () => {
    const base = nodeFs(() => crypto.randomUUID());
    const f = await fresh({
      ...base,
      unlink: async path => {
        throw Object.assign(new Error(`EPERM ${path}`), { code: 'EPERM' });
      },
    });
    await writeFile(`${f.dir}/note`, 'bytes');
    const path = at(f.fleet, 'homes/claude-a/note');

    const error = await f.fleet.unlinkFile(path, await identityOf(f.fleet, path)).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );

    expect((error as RootError).refusal).toBe('changed');
    expect(error?.message).toBe('root refused: changed');
    expect(await readFile(`${f.dir}/note`, 'utf8')).toBe('bytes');
  });

  test('a FOLDER swapped in between the look and the syscall is not walked: unlink(2) refuses a directory', async () => {
    let swapped = false;
    const base = nodeFs(() => crypto.randomUUID());
    const f = await fresh({
      ...base,
      unlink: async path => {
        if (!swapped) {
          swapped = true;
          await rm(`${f.dir}/note`);
          await mkdir(`${f.dir}/note`);
          await writeFile(`${f.dir}/note/keep`, 'keep');
        }
        await base.unlink(path);
      },
    });
    await writeFile(`${f.dir}/note`, 'bytes');
    const path = at(f.fleet, 'homes/claude-a/note');

    expect(await refusalOf(async () => f.fleet.unlinkFile(path, await identityOf(f.fleet, path)))).toBe('changed');
    expect(swapped).toBe(true);
    expect(await readFile(`${f.dir}/note/keep`, 'utf8')).toBe('keep');
  });
});
