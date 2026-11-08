import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { FencedPath } from '../../../contract/bound.ts';
import type { RootHandle, RootName } from '../../../contract/ports.ts';
import { type HostFs, nodeFs } from '../../../host/adapters/node-fs.ts';
import { ensureInternalRootBases, RootError, rootsPortFor } from '../../../host/roots.ts';

/**
 * A remove of a folder needs descriptor reach. On a host without `/proc/self/fd` (macOS) the by-path fallback was a
 * hole: one re-proof of the parent, then `rm -r <parent>/<leaf>`, so a parent swapped for a link in between deleted an
 * OUTSIDE tree. It is refused until the descriptor bracket lands. S44 owns the row: without descriptor reach nothing
 * is removed by path.
 */

const parents: string[] = [];
afterEach(async () => {
  byPath.length = 0;
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const DECLARED: readonly RootName[] = ['fleet', 'agent-homes'];
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
  return { parent, dir, fleet };
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
    expect(byPath).toEqual([]);
    expect(refusal).toBe('no_descriptor_reach');
    expect(await readFile(`${f.parent}/outside/victim/keep`, 'utf8')).toBe('KEEP');
    expect(await gone(`${f.dir}/sub/victim`)).toBe(false);
  });

  test('S44 without descriptor reach an internal root refuses a plain file too, and the file stays', async () => {
    const f = await fresh(() => nodeFs(() => crypto.randomUUID(), { descriptorFolder: NO_DESCRIPTOR_FOLDER }));
    await writeFile(`${f.dir}/own.txt`, 'mine');
    const refusal = await refusalOf(() => f.fleet.remove(at(f.fleet, 'homes/claude-a/own.txt')));
    expect(refusal).toBe('no_descriptor_reach');
    expect(await readFile(`${f.dir}/own.txt`, 'utf8')).toBe('mine');
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
