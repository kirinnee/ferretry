import { afterEach, describe, expect, test } from 'bun:test';
import { link, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { err, ok } from '@ferretry/std';
import type { FencedPath, WorkFolders } from '../../../contract/bound.ts';
import type { FerretId } from '../../../contract/ids.ts';
import type { RootHandle, RootName } from '../../../contract/ports.ts';
import { type HostFs, nodeFs } from '../../../host/adapters/node-fs.ts';
import { resolveInRoot, RootError, rootsPortFor } from '../../../host/roots.ts';

/**
 * The fence on every read a root offers (S40, S41, S49, S50): the home judged by its real path, a hard-linked file
 * refused, and a name swapped INSIDE the window between the check and the open refused as `changed` — for the whole
 * read, a window, a tail and a tree copy alike.
 */

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const SECRET = 'protected-fixture';
const fs = nodeFs(() => 'r');

async function layout() {
  const parent = await mkdtemp(`${tmpdir()}/fy-roots-fence-`);
  parents.push(parent);
  const home = `${parent}/home`;
  const work = `${parent}/work`;
  await mkdir(`${home}/state/vault`, { recursive: true });
  await writeFile(`${home}/state/vault/vault.key`, SECRET);
  await mkdir(work, { recursive: true });
  await writeFile(`${work}/notes.md`, 'ordinary-notes');
  return { parent, home, work };
}

const workFolders = (folder: string): WorkFolders => ({
  folderOf: () => folder as FencedPath,
  check: (_ferret, path) => (path.startsWith(folder) ? ok(path as FencedPath) : err('outside')),
});

function rootOf(home: string, name: RootName, work: string, disk: HostFs = fs, plugin = 'codex'): RootHandle {
  return rootsPortFor(disk, { home, plugin, worktrees: `${home}-worktrees` }, [name], () => workFolders(work), {
    random: () => 'r',
  }).root(name, name === 'work' ? { ferret: 'F1' as FerretId } : {});
}

const at = (root: RootHandle, relative: string): FencedPath => {
  const resolved = root.resolve(relative);
  if (!resolved.ok) throw new Error(resolved.error);
  return resolved.value;
};

/** What a read through `root` came to: its text, or the refusal it threw. */
async function outcome(read: () => Promise<Uint8Array | string>): Promise<string> {
  try {
    const value = await read();
    return typeof value === 'string' ? value : new TextDecoder().decode(value);
  } catch (error) {
    return error instanceof RootError ? `refused:${error.refusal}` : `error:${String(error)}`;
  }
}

/** The test seam: a disk that runs `between` once, AFTER the check and just before the open it guards. */
function swapInsideWindow(between: () => Promise<void>): HostFs {
  let armed = true;
  return {
    ...fs,
    openRead: async path => {
      if (armed) {
        armed = false;
        await between();
      }
      return await fs.openRead(path);
    },
  };
}

const reads = (root: RootHandle, path: FencedPath) =>
  [
    ['readText', () => root.readText(path)],
    ['readBytes', () => root.readBytes(path)],
    ['readBytes window', () => root.readBytes(path, { offset: 0, length: 64 })],
    ['readTail', async () => (await root.readTail(path, 64)).bytes],
  ] as const;

describe('S50 the home is judged by its real path', () => {
  test('S50 a home named through a symlinked parent is fenced at its real path, by name and by identity', async () => {
    const { parent } = await layout();
    // real/home holds the protected file; alias -> real; the daemon is told its home is alias/home.
    await mkdir(`${parent}/real`);
    await rm(`${parent}/work`, { recursive: true });
    await rm(`${parent}/home`, { recursive: true });
    await mkdir(`${parent}/real/home/state/vault`, { recursive: true });
    await writeFile(`${parent}/real/home/state/vault/vault.key`, SECRET);
    await symlink(`${parent}/real`, `${parent}/alias`);
    const home = `${parent}/alias/home`;
    expect(await resolveInRoot(fs, home, `${parent}/real`, true, 'home/state/vault/vault.key')).toEqual({
      ok: false,
      error: 'fenced',
    });
    const imports = rootsPortFor(
      fs,
      { home, plugin: 'skills', worktrees: `${home}-worktrees` },
      ['imports'],
      () => undefined,
    ).root('imports', { subfolder: `${parent}/real` });
    for (const [, read] of reads(imports, `${parent}/real/home/state/vault/vault.key` as FencedPath))
      expect(await outcome(read)).toBe('refused:fenced');
  });

  test('S50 a home that cannot be resolved fails closed: an owner root reaches nothing', async () => {
    const { parent, work } = await layout();
    const missingHome = `${parent}/no-such-home`;
    const root = rootOf(missingHome, 'work', work);
    for (const [, read] of reads(root, at(root, 'notes.md'))) expect(await outcome(read)).toBe('refused:fenced');
  });
});

describe('S49 a hard-linked file is never read through a root', () => {
  test('S49 a home file hard-linked into a work folder is refused by every read', async () => {
    const { home, work } = await layout();
    await link(`${home}/state/vault/vault.key`, `${work}/planted`);
    const root = rootOf(home, 'work', work);
    for (const [, read] of reads(root, at(root, 'planted'))) expect(await outcome(read)).toBe('refused:hard_link');
    expect(await outcome(() => root.readText(at(root, 'notes.md')))).toBe('ordinary-notes');
  });
});

describe('S41 the opened descriptor is re-checked', () => {
  for (const kind of ['readText', 'readBytes', 'readBytes window', 'readTail'] as const)
    test(`S41 ${kind}: the file swapped for a link to the home INSIDE the window is refused as changed`, async () => {
      const { home, work } = await layout();
      await writeFile(`${work}/swap.txt`, 'ordinary');
      const disk = swapInsideWindow(async () => {
        await rm(`${work}/swap.txt`);
        await symlink(`${home}/state/vault/vault.key`, `${work}/swap.txt`);
      });
      const root = rootOf(home, 'work', work, disk);
      const read = reads(root, at(root, 'swap.txt')).find(([name]) => name === kind)?.[1];
      expect(await outcome(read as () => Promise<string | Uint8Array>)).toBe('refused:changed');
    });

  test('S41 copyTree: a source file swapped for a link INSIDE the window is refused; nothing of the home lands', async () => {
    const { home } = await layout();
    const downloads = `${home}/state/skills/downloads`;
    await mkdir(`${downloads}/skill`, { recursive: true });
    await writeFile(`${downloads}/skill/SKILL.md`, '# skill');
    await mkdir(`${home}/state/skills/agent-homes/f1`, { recursive: true });
    const disk = swapInsideWindow(async () => {
      await rm(`${downloads}/skill/SKILL.md`);
      await symlink(`${home}/state/vault/vault.key`, `${downloads}/skill/SKILL.md`);
    });
    const roots = rootsPortFor(
      disk,
      { home, plugin: 'skills', worktrees: `${home}-worktrees` },
      ['downloads', 'agent-homes'],
      () => undefined,
    );
    const source = roots.root('downloads');
    const target = roots.root('agent-homes', { subfolder: 'f1' });
    await expect(target.copyTree(source, at(source, 'skill'), at(target, 'skill'))).rejects.toEqual(
      new RootError('changed'),
    );
    expect(await readdir(`${home}/state/skills/agent-homes/f1/skill`)).toEqual([]);
  });
});
