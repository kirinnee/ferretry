import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { FencedPath } from '../../../contract/bound.ts';
import type { RootHandle, RootName } from '../../../contract/ports.ts';
import { type HostFs, nodeFs } from '../../../host/adapters/node-fs.ts';
import { ensureInternalRootBases, RootError, rootsPortFor } from '../../../host/roots.ts';

/**
 * `RootHandle.remove` on the real disk: the LEAF is never followed (the parent is resolved and judged inside the root,
 * then the entry goes by its own name, so a planted link goes as a link and its target stays), and `onlyIfEmpty` is
 * `rmdir`: one syscall that both looks and removes, refused `not_empty` when an entry is inside, never recursing.
 * Without descriptor reach the remove-refuse rules (S44, `remove-without-reach.test.ts`) still decide a folder.
 */

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const DECLARED: readonly RootName[] = ['fleet', 'harness-home', 'agent-homes'];
const NO_DESCRIPTOR_FOLDER = '/nonexistent-descriptor-folder';
const DESCRIPTOR_FOLDER = '/proc/self/fd';
const onLinux = process.platform === 'linux';

const at = (root: RootHandle, path: string): FencedPath => {
  const resolved = root.resolve(path);
  if (!resolved.ok) throw new Error(resolved.error);
  return resolved.value;
};

async function fresh(fs: HostFs) {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-root-remove-`));
  parents.push(parent);
  const home = `${parent}/home`;
  const owner = `${parent}/owner`;
  await mkdir(`${home}/state`, { recursive: true, mode: 0o700 });
  await mkdir(`${home}/config`, { recursive: true, mode: 0o700 });
  await mkdir(`${owner}/.claude`, { recursive: true, mode: 0o700 });
  await mkdir(`${parent}/outside/folder`, { recursive: true, mode: 0o700 });
  await writeFile(`${parent}/outside/file.txt`, 'OUTSIDE-FILE');
  await writeFile(`${parent}/outside/folder/keep.txt`, 'OUTSIDE-KEEP');
  await writeFile(`${owner}/.claude/mine.txt`, 'OWNER-FILE');
  const layout = { home, plugin: 'runtimes', worktrees: `${home}-worktrees` };
  const port = rootsPortFor(fs, layout, DECLARED, () => undefined, {});
  await ensureInternalRootBases(
    nodeFs(() => crypto.randomUUID()),
    layout,
    DECLARED,
  );
  const fleet = port.root('fleet');
  const harness = port.root('harness-home', { subfolder: `${owner}/.claude` });
  await fleet.makeDirectory(at(fleet, 'homes/claude-a'));
  const dir = `${home}/fleet/homes/claude-a`;
  await mkdir(`${dir}/inside-folder`, { mode: 0o700 });
  await writeFile(`${dir}/inside-file.txt`, 'INSIDE-FILE');
  await writeFile(`${dir}/inside-folder/keep.txt`, 'INSIDE-KEEP');
  return { parent, home, owner, dir, fleet, harness };
}

const withReach = () => nodeFs(() => crypto.randomUUID(), { descriptorFolder: DESCRIPTOR_FOLDER });
const withoutReach = () => nodeFs(() => crypto.randomUUID(), { descriptorFolder: NO_DESCRIPTOR_FOLDER });

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
const isLink = async (path: string): Promise<boolean> =>
  (await lstat(path).catch(() => undefined))?.isSymbolicLink() === true;

describe.skipIf(!onLinux)('RootHandle.remove does not follow the leaf', () => {
  test('a planted link to a file OUTSIDE the root is removed as a link and the file survives', async () => {
    const f = await fresh(withReach());
    await symlink(`${f.parent}/outside/file.txt`, `${f.dir}/planted`);
    await f.fleet.remove(at(f.fleet, 'homes/claude-a/planted'));
    expect(await gone(`${f.dir}/planted`)).toBe(true);
    expect(await readFile(`${f.parent}/outside/file.txt`, 'utf8')).toBe('OUTSIDE-FILE');
  });

  test('a planted link to a FOLDER outside the root is removed as a link and the folder keeps its files', async () => {
    const f = await fresh(withReach());
    await symlink(`${f.parent}/outside/folder`, `${f.dir}/planted`);
    await f.fleet.remove(at(f.fleet, 'homes/claude-a/planted'));
    expect(await gone(`${f.dir}/planted`)).toBe(true);
    expect(await readFile(`${f.parent}/outside/folder/keep.txt`, 'utf8')).toBe('OUTSIDE-KEEP');
  });

  test('a planted link to a file INSIDE the root is removed as a link and the file survives', async () => {
    const f = await fresh(withReach());
    await symlink(`${f.dir}/inside-file.txt`, `${f.dir}/planted`);
    await f.fleet.remove(at(f.fleet, 'homes/claude-a/planted'));
    expect(await gone(`${f.dir}/planted`)).toBe(true);
    expect(await readFile(`${f.dir}/inside-file.txt`, 'utf8')).toBe('INSIDE-FILE');
  });

  test('a planted link to a FOLDER inside the root is removed as a link and the folder keeps its files', async () => {
    const f = await fresh(withReach());
    await symlink(`${f.dir}/inside-folder`, `${f.dir}/planted`);
    await f.fleet.remove(at(f.fleet, 'homes/claude-a/planted'));
    expect(await gone(`${f.dir}/planted`)).toBe(true);
    expect(await readFile(`${f.dir}/inside-folder/keep.txt`, 'utf8')).toBe('INSIDE-KEEP');
  });

  test('a dangling link is removed as a link', async () => {
    const f = await fresh(withReach());
    await symlink(`${f.parent}/outside/not-there`, `${f.dir}/planted`);
    await f.fleet.remove(at(f.fleet, 'homes/claude-a/planted'));
    expect(await gone(`${f.dir}/planted`)).toBe(true);
  });

  test('a link leaf is removed as a link with onlyIfEmpty too, and a link to a folder is not rmdir-ed', async () => {
    const f = await fresh(withReach());
    await mkdir(`${f.parent}/outside/empty`);
    await symlink(`${f.parent}/outside/empty`, `${f.dir}/planted`);
    await f.fleet.remove(at(f.fleet, 'homes/claude-a/planted'), { onlyIfEmpty: true });
    expect(await gone(`${f.dir}/planted`)).toBe(true);
    expect((await lstat(`${f.parent}/outside/empty`)).isDirectory()).toBe(true);
  });

  test('a link at a leaf that points at a link is removed alone (the second link and its target stay)', async () => {
    const f = await fresh(withReach());
    await symlink(`${f.parent}/outside/file.txt`, `${f.dir}/second`);
    await symlink(`${f.dir}/second`, `${f.dir}/first`);
    await f.fleet.remove(at(f.fleet, 'homes/claude-a/first'));
    expect(await gone(`${f.dir}/first`)).toBe(true);
    expect(await readlink(`${f.dir}/second`)).toBe(`${f.parent}/outside/file.txt`);
    expect(await readFile(`${f.parent}/outside/file.txt`, 'utf8')).toBe('OUTSIDE-FILE');
  });

  test('the PARENT is judged: a folder reached through a link that leaves the root removes nothing', async () => {
    const f = await fresh(withReach());
    await symlink(`${f.parent}/outside/folder`, `${f.dir}/escape`);
    const refusal = await refusalOf(() => f.fleet.remove(at(f.fleet, 'homes/claude-a/escape/keep.txt')));
    expect(refusal).toBe('link_escape');
    expect(await readFile(`${f.parent}/outside/folder/keep.txt`, 'utf8')).toBe('OUTSIDE-KEEP');
    expect(await isLink(`${f.dir}/escape`)).toBe(true);
  });

  test('the PARENT is judged: a parent link that stays inside the root removes the entry behind it', async () => {
    const f = await fresh(withReach());
    await symlink(`${f.dir}/inside-folder`, `${f.dir}/route`);
    await f.fleet.remove(at(f.fleet, 'homes/claude-a/route/keep.txt'));
    expect(await gone(`${f.dir}/inside-folder/keep.txt`)).toBe(true);
    expect(await isLink(`${f.dir}/route`)).toBe(true);
  });

  test('a read-only root refuses read_only and removes nothing', async () => {
    const f = await fresh(withReach());
    expect(await refusalOf(() => f.harness.remove(at(f.harness, 'mine.txt')))).toBe('read_only');
    expect(await readFile(`${f.owner}/.claude/mine.txt`, 'utf8')).toBe('OWNER-FILE');
  });

  test('a path outside the root refuses outside', async () => {
    const f = await fresh(withReach());
    const refusal = await refusalOf(() => f.fleet.remove(`${f.parent}/outside/file.txt` as FencedPath));
    expect(refusal).toBe('outside');
    expect(await readFile(`${f.parent}/outside/file.txt`, 'utf8')).toBe('OUTSIDE-FILE');
  });

  test('a folder is still removed whole without the option, and the folder next to it stays', async () => {
    const f = await fresh(withReach());
    await mkdir(`${f.dir}/tree/deep`, { recursive: true });
    await writeFile(`${f.dir}/tree/deep/a.txt`, 'a');
    await f.fleet.remove(at(f.fleet, 'homes/claude-a/tree'));
    expect(await gone(`${f.dir}/tree`)).toBe(true);
    expect(await readFile(`${f.dir}/inside-folder/keep.txt`, 'utf8')).toBe('INSIDE-KEEP');
  });

  test('onlyIfEmpty: false removes a folder whole, as no option does', async () => {
    const f = await fresh(withReach());
    await f.fleet.remove(at(f.fleet, 'homes/claude-a/inside-folder'), { onlyIfEmpty: false });
    expect(await gone(`${f.dir}/inside-folder`)).toBe(true);
  });
});

describe.skipIf(!onLinux)('RootHandle.remove with onlyIfEmpty is rmdir', () => {
  test('an empty folder is removed', async () => {
    const f = await fresh(withReach());
    await mkdir(`${f.dir}/empty`);
    await f.fleet.remove(at(f.fleet, 'homes/claude-a/empty'), { onlyIfEmpty: true });
    expect(await gone(`${f.dir}/empty`)).toBe(true);
  });

  test('a folder holding a file is refused not_empty and keeps the file', async () => {
    const f = await fresh(withReach());
    const refusal = await refusalOf(() =>
      f.fleet.remove(at(f.fleet, 'homes/claude-a/inside-folder'), { onlyIfEmpty: true }),
    );
    expect(refusal).toBe('not_empty');
    expect(await readFile(`${f.dir}/inside-folder/keep.txt`, 'utf8')).toBe('INSIDE-KEEP');
  });

  test('a folder holding only a link is refused not_empty and keeps the link', async () => {
    const f = await fresh(withReach());
    await mkdir(`${f.dir}/only-link`);
    await symlink(`${f.parent}/outside/file.txt`, `${f.dir}/only-link/planted`);
    const refusal = await refusalOf(() =>
      f.fleet.remove(at(f.fleet, 'homes/claude-a/only-link'), { onlyIfEmpty: true }),
    );
    expect(refusal).toBe('not_empty');
    expect(await isLink(`${f.dir}/only-link/planted`)).toBe(true);
  });

  test('a folder holding only an empty folder is refused not_empty (it never recurses)', async () => {
    const f = await fresh(withReach());
    await mkdir(`${f.dir}/outer/inner`, { recursive: true });
    const refusal = await refusalOf(() => f.fleet.remove(at(f.fleet, 'homes/claude-a/outer'), { onlyIfEmpty: true }));
    expect(refusal).toBe('not_empty');
    expect(await gone(`${f.dir}/outer/inner`)).toBe(false);
  });

  test('a name that is not there is a no-op', async () => {
    const f = await fresh(withReach());
    await f.fleet.remove(at(f.fleet, 'homes/claude-a/absent'), { onlyIfEmpty: true });
    expect(await gone(`${f.dir}/inside-folder`)).toBe(false);
  });

  test('a file leaf is removed as without the option', async () => {
    const f = await fresh(withReach());
    await f.fleet.remove(at(f.fleet, 'homes/claude-a/inside-file.txt'), { onlyIfEmpty: true });
    expect(await gone(`${f.dir}/inside-file.txt`)).toBe(true);
  });

  test('the empty-check and the removal are ONE rmdir: nothing is listed, and an entry that lands first is kept', async () => {
    const calls: string[] = [];
    let late: string | undefined;
    // The folder being removed, by identity: the remove reaches it through a descriptor path
    // (`/proc/self/fd/N/empty`), whatever its spelling, so a call is also counted when its path IS that folder.
    let folderKey: string | undefined;
    const base = withReach();
    const isFolder = async (path: string): Promise<boolean> => {
      const found = folderKey === undefined ? undefined : await base.identity(path);
      return found !== undefined && `${found.device}:${found.inode}` === folderKey;
    };
    const spy: HostFs = {
      ...base,
      list: async path => {
        calls.push(`list ${path}`);
        if (await isFolder(path)) calls.push(`list the folder ${path}`);
        return await base.list(path);
      },
      remove: async path => {
        calls.push(`remove ${path}`);
        if (await isFolder(path)) calls.push(`remove the folder ${path}`);
        await base.remove(path);
      },
      rmdir: async path => {
        calls.push('rmdir');
        // The window a list-then-remove would leave: an entry arrives right before the removal.
        if (late !== undefined) await writeFile(late, 'LATE');
        await base.rmdir(path);
      },
    };
    const f = await fresh(spy);
    await mkdir(`${f.dir}/empty`);
    const emptied = await base.identity(`${f.dir}/empty`);
    folderKey = `${emptied?.device}:${emptied?.inode}`;
    late = `${f.dir}/empty/late.txt`;
    calls.length = 0;
    const refusal = await refusalOf(() => f.fleet.remove(at(f.fleet, 'homes/claude-a/empty'), { onlyIfEmpty: true }));
    expect(refusal).toBe('not_empty');
    expect(await readFile(`${f.dir}/empty/late.txt`, 'utf8')).toBe('LATE');
    // What the claim is about is the FOLDER being removed: it is never listed and never emptied entry by entry. The
    // private-places index (§7.7) legitimately lists the home's own `state` folder (a fresh test home's is racy, so it
    // is read again), which is not this folder, so only calls that reach the removed folder count: by name (as the root
    // spells it, or through a descriptor: any path ending in or running through `/empty`) or by identity.
    const named = (call: string): boolean =>
      call.endsWith('/empty') || call.includes('/empty/') || call.includes('the folder');
    expect(calls.filter(call => (call.startsWith('list') || call.startsWith('remove')) && named(call))).toEqual([]);
    expect(calls.filter(call => call === 'rmdir')).toEqual(['rmdir']);
  });
});

describe('RootHandle.remove with onlyIfEmpty without descriptor reach follows the remove-refuse rules (S44)', () => {
  test('S44 a folder is refused no_descriptor_reach even when it is empty, and stays', async () => {
    const f = await fresh(withoutReach());
    await mkdir(`${f.dir}/empty`);
    const refusal = await refusalOf(() => f.fleet.remove(at(f.fleet, 'homes/claude-a/empty'), { onlyIfEmpty: true }));
    expect(refusal).toBe('no_descriptor_reach');
    expect(await gone(`${f.dir}/empty`)).toBe(false);
  });

  test('S44 a file leaf of an internal root is still unlinked by path with the option', async () => {
    const f = await fresh(withoutReach());
    await f.fleet.remove(at(f.fleet, 'homes/claude-a/inside-file.txt'), { onlyIfEmpty: true });
    expect(await gone(`${f.dir}/inside-file.txt`)).toBe(true);
  });

  test('S44 a planted link leaf of an internal root is unlinked as a link, its target untouched', async () => {
    const f = await fresh(withoutReach());
    await symlink(`${f.parent}/outside/file.txt`, `${f.dir}/planted`);
    await f.fleet.remove(at(f.fleet, 'homes/claude-a/planted'));
    expect(await gone(`${f.dir}/planted`)).toBe(true);
    expect(await readFile(`${f.parent}/outside/file.txt`, 'utf8')).toBe('OUTSIDE-FILE');
  });
});

describe.skipIf(!onLinux)('BG-006 a forged spelling of a name never follows the leaf, and a NUL is outside', () => {
  /** The forged spellings of the link `homes/claude-a/planted`, each one a cast a plugin could make. */
  const FORGED = ['homes/claude-a/planted/', 'homes/claude-a/planted/.', 'homes/claude-a/./planted/'] as const;

  test('BG-006 m1 a trailing slash or a trailing dot names the LINK, which goes alone: the folder it points at stays whole', async () => {
    for (const forged of FORGED) {
      const f = await fresh(withReach());
      await symlink(`${f.dir}/inside-folder`, `${f.dir}/planted`);
      await f.fleet.remove(`${f.home}/fleet/${forged}` as FencedPath);
      expect(await gone(`${f.dir}/planted`)).toBe(true);
      expect(await readFile(`${f.dir}/inside-folder/keep.txt`, 'utf8')).toBe('INSIDE-KEEP');
    }
  });

  test('BG-006 m1 the same with onlyIfEmpty: a link to a folder is never rmdir-ed through a forged spelling', async () => {
    const f = await fresh(withReach());
    await mkdir(`${f.dir}/empty-folder`);
    await symlink(`${f.dir}/empty-folder`, `${f.dir}/planted`);
    await f.fleet.remove(`${f.home}/fleet/homes/claude-a/planted/.` as FencedPath, { onlyIfEmpty: true });
    expect(await gone(`${f.dir}/planted`)).toBe(true);
    expect((await lstat(`${f.dir}/empty-folder`)).isDirectory()).toBe(true);
  });

  test('BG-006 m1 a single relative name is read from the root and names the LINK there, not the folder it points at', async () => {
    const f = await fresh(withReach());
    await symlink(`${f.dir}/inside-folder`, `${f.home}/fleet/top-alias`);
    await f.fleet.remove('top-alias' as FencedPath);
    expect(await gone(`${f.home}/fleet/top-alias`)).toBe(true);
    expect(await readFile(`${f.dir}/inside-folder/keep.txt`, 'utf8')).toBe('INSIDE-KEEP');
  });

  test('BG-006 m2 a NUL in the leaf is refused outside (a RootError), never a raw TypeError, and nothing is removed', async () => {
    const f = await fresh(withReach());
    expect(await refusalOf(() => f.fleet.remove(`${f.dir}/inside-file.tx\0t` as FencedPath))).toBe('outside');
    expect(await refusalOf(() => f.fleet.remove(`${f.dir}\0/inside-file.txt` as FencedPath))).toBe('outside');
    expect(await readFile(`${f.dir}/inside-file.txt`, 'utf8')).toBe('INSIDE-FILE');
  });

  test('BG-006 a forged spelling that leaves the root is still refused, and the root itself is still judged as itself', async () => {
    const f = await fresh(withReach());
    expect(await refusalOf(() => f.fleet.remove(`${f.home}/fleet/homes/claude-a/../../../x/` as FencedPath))).toBe(
      'outside',
    );
    expect(await refusalOf(() => f.fleet.remove(`${f.parent}/outside/folder/` as FencedPath))).toBe('outside');
    expect(await readFile(`${f.parent}/outside/folder/keep.txt`, 'utf8')).toBe('OUTSIDE-KEEP');
  });
});
