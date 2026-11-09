import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { FencedPath } from '../../../contract/bound.ts';
import type { RootHandle, RootName } from '../../../contract/ports.ts';
import { type HostFs, nodeFs } from '../../../host/adapters/node-fs.ts';
import { ensureInternalRootBases, RootError, rootsPortFor } from '../../../host/roots.ts';

/**
 * A remove of a FOLDER needs descriptor reach. On a host without `/proc/self/fd` (macOS) the by-path fallback was a
 * hole: one re-proof of the parent, then `rm -r <parent>/<leaf>`, so a parent swapped for a link in between deleted an
 * OUTSIDE tree. On a host that loaded neither the C library's descriptor calls nor the working-directory bracket a
 * folder is refused (BG-002 owns the host that loaded both: `root-remove-bracket.test.ts`). A file or link leaf of an
 * internal root is still unlinked by path (the sessions root's markers, tidy's reclaim): `unlink` never removes a tree,
 * so the worst a swapped parent costs is ONE same-named file outside the root (declared GAP). An owner root removes
 * nothing. S44 owns the row.
 */

const parents: string[] = [];
afterEach(async () => {
  byPath.length = 0;
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const DECLARED: readonly RootName[] = ['fleet', 'agent-homes', 'worktrees'];
const NO_DESCRIPTOR_FOLDER = '/nonexistent-descriptor-folder';
const DESCRIPTOR_FOLDER = '/proc/self/fd';

const at = (root: RootHandle, path: string): FencedPath => {
  const resolved = root.resolve(path);
  if (!resolved.ok) throw new Error(resolved.error);
  return resolved.value;
};

async function fresh(make: (f: { dir: string; parent: string }) => HostFs) {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-remove-reach-`));
  parents.push(parent);
  const home = `${parent}/home`;
  await mkdir(`${home}/state`, { recursive: true, mode: 0o700 });
  await mkdir(`${home}/config`, { recursive: true, mode: 0o700 });
  await mkdir(`${parent}/outside`, { mode: 0o700 });
  const layout = { home, plugin: 'runtimes', worktrees: `${home}-worktrees` };
  const dir = `${home}/fleet/homes/claude-a`;
  const fs = make({ dir, parent });
  const port = rootsPortFor(fs, layout, DECLARED, () => undefined, {});
  await ensureInternalRootBases(
    nodeFs(() => crypto.randomUUID()),
    layout,
    DECLARED,
  );
  const fleet = port.root('fleet');
  await fleet.makeDirectory(at(fleet, 'homes/claude-a'));
  await mkdir(`${dir}/sub`, { mode: 0o700 });
  return { parent, dir, fleet, port, home };
}

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

const byPath: string[] = [];

/** Just before the remove runs, `homes/claude-a/sub` becomes a link to `<parent>/outside`. */
const swappingBeforeRemove =
  (descriptorFolder: string) =>
  (f: { dir: string; parent: string }): HostFs => {
    const base = nodeFs(() => crypto.randomUUID(), { descriptorFolder });
    let swapped = false;
    return {
      ...base,
      remove: async path => {
        byPath.push(path);
        if (!swapped) {
          swapped = true;
          await rename(`${f.dir}/sub`, `${f.dir}/sub-moved`);
          await symlink(`${f.parent}/outside`, `${f.dir}/sub`);
        }
        await base.remove(path);
      },
    };
  };

describe('remove without descriptor reach', () => {
  test('S44 a host without descriptor reach refuses to remove a folder of an internal root by path', async () => {
    const f = await fresh(swappingBeforeRemove(NO_DESCRIPTOR_FOLDER));
    await mkdir(`${f.dir}/sub/victim`);
    await mkdir(`${f.parent}/outside/victim`);
    await writeFile(`${f.parent}/outside/victim/keep`, 'KEEP');
    const refusal = await refusalOf(() => f.fleet.remove(at(f.fleet, 'homes/claude-a/sub/victim')));
    expect(await readFile(`${f.parent}/outside/victim/keep`, 'utf8')).toBe('KEEP');
    expect(byPath).toEqual([]);
    expect(refusal).toBe('no_descriptor_reach');
    expect(await gone(`${f.dir}/sub/victim`)).toBe(false);
  });

  test('S44 without descriptor reach an internal root still removes a plain file by path', async () => {
    const f = await fresh(() => nodeFs(() => crypto.randomUUID(), { descriptorFolder: NO_DESCRIPTOR_FOLDER }));
    await writeFile(`${f.dir}/done.marker`, 'mine');
    await writeFile(`${f.dir}/keep.txt`, 'kept');
    await f.fleet.remove(at(f.fleet, 'homes/claude-a/done.marker'));
    expect(await gone(`${f.dir}/done.marker`)).toBe(true);
    expect(await readFile(`${f.dir}/keep.txt`, 'utf8')).toBe('kept');
  });

  test('S44 without descriptor reach a folder of an internal root refuses even when nothing swaps it', async () => {
    const f = await fresh(() => nodeFs(() => crypto.randomUUID(), { descriptorFolder: NO_DESCRIPTOR_FOLDER }));
    await mkdir(`${f.dir}/tree/deep`, { recursive: true });
    await writeFile(`${f.dir}/tree/deep/a.txt`, 'a');
    const refusal = await refusalOf(() => f.fleet.remove(at(f.fleet, 'homes/claude-a/tree')));
    expect(refusal).toBe('no_descriptor_reach');
    expect(await readFile(`${f.dir}/tree/deep/a.txt`, 'utf8')).toBe('a');
  });

  test('S44 without descriptor reach removing a name that is not there is a no-op', async () => {
    const f = await fresh(() => nodeFs(() => crypto.randomUUID(), { descriptorFolder: NO_DESCRIPTOR_FOLDER }));
    await f.fleet.remove(at(f.fleet, 'homes/claude-a/absent.marker'));
    expect(await gone(`${f.dir}/sub`)).toBe(false);
  });

  test('S44 without descriptor reach a file is unlinked, never removed as a tree (rm -r is not used)', async () => {
    const f = await fresh(() => {
      const base = nodeFs(() => crypto.randomUUID(), { descriptorFolder: NO_DESCRIPTOR_FOLDER });
      return {
        ...base,
        remove: async path => {
          byPath.push(path);
          await base.remove(path);
        },
      };
    });
    await writeFile(`${f.dir}/done.marker`, 'mine');
    await f.fleet.remove(at(f.fleet, 'homes/claude-a/done.marker'));
    expect(await gone(`${f.dir}/done.marker`)).toBe(true);
    expect(byPath).toEqual([]);
  });

  test('S44 without descriptor reach the worktrees root (tidy reclaim) still removes a file child and refuses a folder child', async () => {
    const f = await fresh(() => nodeFs(() => crypto.randomUUID(), { descriptorFolder: NO_DESCRIPTOR_FOLDER }));
    const worktrees = f.port.root('worktrees');
    const folder = `${f.home}-worktrees/f1`;
    await mkdir(`${folder}/out`, { recursive: true });
    await writeFile(`${folder}/notes.txt`, 'n');
    await writeFile(`${folder}/out/a.bin`, 'a');
    await worktrees.remove(at(worktrees, 'f1/notes.txt'));
    expect(await gone(`${folder}/notes.txt`)).toBe(true);
    expect(await refusalOf(() => worktrees.remove(at(worktrees, 'f1/out')))).toBe('no_descriptor_reach');
    expect(await readFile(`${folder}/out/a.bin`, 'utf8')).toBe('a');
  });

  test.skipIf(process.platform !== 'linux')(
    'S44 a host with descriptor reach still removes a folder tree of an internal root',
    async () => {
      const f = await fresh(() => nodeFs(() => crypto.randomUUID(), { descriptorFolder: DESCRIPTOR_FOLDER }));
      await mkdir(`${f.dir}/tree/deep`, { recursive: true });
      await writeFile(`${f.dir}/tree/deep/a.txt`, 'a');
      await f.fleet.remove(at(f.fleet, 'homes/claude-a/tree'));
      expect(await gone(`${f.dir}/tree`)).toBe(true);
      expect(await gone(`${f.dir}/sub`)).toBe(false);
    },
  );
});
