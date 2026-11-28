import { afterEach, expect, test } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { FencedPath, RootHandle } from '../../../contract/index.ts';
import { nodeFs, type HostFs } from '../../../host/adapters/node-fs.ts';
import { rootsPortFor } from '../../../host/roots.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});
const at = (root: RootHandle, relative: string): FencedPath => {
  const path = root.resolve(relative);
  if (!path.ok) throw new Error('invalid fixture path');
  return path.value;
};
async function create(root: RootHandle, path: FencedPath) {
  if (root.createDirectory === undefined) throw new Error('the creating handle is missing');
  return await root.createDirectory(path);
}
async function fresh(wrap: (fs: HostFs, parent: string) => HostFs = fs => fs) {
  const parent = await mkdtemp(`${tmpdir()}/root-create-directory-`);
  parents.push(parent);
  await mkdir(`${parent}/home`, { mode: 0o700 });
  await mkdir(`${parent}/worktrees`, { mode: 0o700 });
  const root = rootsPortFor(
    wrap(
      nodeFs(() => crypto.randomUUID()),
      parent,
    ),
    { home: `${parent}/home`, worktrees: `${parent}/worktrees`, plugin: 'relocate' },
    ['worktrees'],
    () => undefined,
    {},
  ).root('worktrees');
  return { parent, root, path: at(root, 'move') };
}

test('exclusive private directory creation returns its descriptor identity and refuses existing entries', async () => {
  const f = await fresh();
  const identity = await create(f.root, f.path);
  const stat = await lstat(f.path, { bigint: true });
  expect(identity).toEqual({ device: stat.dev, inode: stat.ino });
  expect(Number(stat.mode & 0o7777n)).toBe(0o700);
  await writeFile(`${f.path}/keep`, 'owned entry');
  await expect(create(f.root, f.path)).rejects.toMatchObject({ refusal: 'changed' });
  expect(await readFile(`${f.path}/keep`, 'utf8')).toBe('owned entry');
});

test('the receipt is captured before the creating parent is released; a swapped replacement is never removed', async () => {
  let swapped = false;
  const f = await fresh((fs, parent) => ({
    ...fs,
    openDirectory: async path => {
      const folder = await fs.openDirectory(path);
      const close = folder.close;
      return {
        ...folder,
        close: async () => {
          const made = await fs.identity(`${parent}/worktrees/move`);
          if (!swapped && path === `${parent}/worktrees` && made !== undefined) {
            swapped = true;
            await rename(`${parent}/worktrees/move`, `${parent}/worktrees/original`);
            await mkdir(`${parent}/worktrees/move`, { mode: 0o700 });
            await writeFile(`${parent}/worktrees/move/keep`, 'replacement');
          }
          await close();
        },
      };
    },
  }));
  const receipt = await create(f.root, f.path);
  expect(swapped).toBe(true);
  const original = await f.root.fileIdentity(at(f.root, 'original'));
  expect(original?.device === receipt.device && original.inode === receipt.inode).toBe(true);
  expect(receipt.inode === (await f.root.fileIdentity(f.path))?.inode).toBe(false);
  await expect(f.root.remove(f.path, { expectedIdentity: receipt })).rejects.toMatchObject({ refusal: 'changed' });
  expect(await readFile(`${f.path}/keep`, 'utf8')).toBe('replacement');
});

test('creation refuses a parent that other users can write without changing its permissions', async () => {
  const f = await fresh();
  await chmod(`${f.parent}/worktrees`, 0o777);
  await expect(create(f.root, f.path)).rejects.toMatchObject({ refusal: 'changed' });
  expect((await lstat(`${f.parent}/worktrees`)).mode & 0o777).toBe(0o777);
  expect(await f.root.lstat(f.path)).toBeUndefined();
});

test('an owner root refuses exclusive directory creation even in a private owner folder', async () => {
  const f = await fresh();
  const folder = `${f.parent}/owner`;
  await mkdir(folder, { mode: 0o700 });
  const owner = rootsPortFor(
    nodeFs(() => crypto.randomUUID()),
    { home: `${f.parent}/home`, worktrees: `${f.parent}/worktrees`, plugin: 'relocate' },
    ['project-files'],
    () => undefined,
    { projectFiles: ['move/**'] },
  ).root('project-files', { subfolder: folder });
  const path = at(owner, 'move');
  await expect(create(owner, path)).rejects.toMatchObject({ refusal: 'read_only' });
  expect(await owner.lstat(path)).toBeUndefined();
});
