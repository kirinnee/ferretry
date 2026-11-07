import { afterEach, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { defineState } from '../../../contract/define.ts';
import { createNodeHostFs } from '../../../host/state/host-fs.ts';
import { createStatePort } from '../../../host/state/state-port.ts';

const Tree = defineState({ name: 'pair-open', path: 'pair-open/*', store: 'opaque', format: 1 });
const Other = defineState({ name: 'other', path: 'other/*', store: 'opaque', format: 1 });
const Single = defineState({ name: 'single', path: 'single', store: 'opaque', format: 1 });
const Json = defineState({ name: 'json', path: 'json/*', store: 'json', format: 1 });
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function fixture() {
  const home = await mkdtemp(`${tmpdir()}/fy-opaque-tree-`);
  homes.push(home);
  const port = createStatePort({ home, pluginId: 'access', files: [Tree, Single, Json], fs: createNodeHostFs() });
  return { home, port, path: (name: string) => port.pathOf(Tree, name) };
}

test('P106 opaque tree stat uses lstat and removal refuses nonempty directories and links', async () => {
  const { port, path } = await fixture();
  expect(await port.stat(Tree, 'missing')).toBeUndefined();
  await port.createPrivateDirectory(Tree, 'one');
  expect((await lstat(path('one'))).mode & 0o777).toBe(0o700);
  await port.write(Tree, 'redirect' as never, 'one/index.html');
  expect((await lstat(path('one/index.html'))).mode & 0o777).toBe(0o600);
  await utimes(path('one/index.html'), 123, 123);
  expect(await port.stat(Tree, 'one/index.html')).toEqual({ kind: 'file', modifiedMs: 123_000 });
  expect((await port.stat(Tree, 'one'))?.kind).toBe('directory');
  await expect(port.removeEmptyDirectory(Tree, 'one')).rejects.toThrow();
  expect(await readFile(path('one/index.html'), 'utf8')).toBe('redirect');
  await symlink(path('one'), path('alias'));
  expect((await port.stat(Tree, 'alias'))?.kind).toBe('symlink');
  await expect(port.removeEmptyDirectory(Tree, 'alias')).rejects.toThrow();
  await port.remove(Tree, 'one/index.html');
  await port.removeEmptyDirectory(Tree, 'one');
  expect(await port.stat(Tree, 'one')).toBeUndefined();
});

test('P106 createPrivateDirectory is exclusive for existing directories, files and symlinks', async () => {
  const { port, path } = await fixture();
  await port.createPrivateDirectory(Tree, 'fresh');
  await expect(port.createPrivateDirectory(Tree, 'fresh')).rejects.toThrow();
  await mkdir(path('planted'));
  await expect(port.createPrivateDirectory(Tree, 'planted')).rejects.toThrow();
  await writeFile(path('file'), 'kept');
  await expect(port.createPrivateDirectory(Tree, 'file')).rejects.toThrow();
  await symlink(path('planted'), path('link'));
  await expect(port.createPrivateDirectory(Tree, 'link')).rejects.toThrow();
  expect(await readFile(path('file'), 'utf8')).toBe('kept');
});

test('P106 named-tree metadata and directory operations refuse other defs, unsafe names and symlink parents', async () => {
  const { home, port, path } = await fixture();
  for (const def of [Other, Single, Json, { ...Tree, path: 'other/*' }]) {
    await expect(port.stat(def, 'one')).rejects.toThrow();
    await expect(port.removeEmptyDirectory(def, 'one')).rejects.toThrow();
    await expect(port.createPrivateDirectory(def, 'one')).rejects.toThrow();
  }
  for (const name of ['../other', '/absolute', 'x/../other', 'x\0y']) {
    await expect(port.stat(Tree, name)).rejects.toThrow();
    await expect(port.removeEmptyDirectory(Tree, name)).rejects.toThrow();
    await expect(port.createPrivateDirectory(Tree, name)).rejects.toThrow();
  }
  await port.createPrivateDirectory(Tree, 'seed');
  await mkdir(`${home}/outside/empty`, { recursive: true });
  await symlink(`${home}/outside`, path('through'));
  await expect(port.stat(Tree, 'through/empty')).rejects.toThrow();
  await expect(port.removeEmptyDirectory(Tree, 'through/empty')).rejects.toThrow();
  await expect(port.createPrivateDirectory(Tree, 'through/new')).rejects.toThrow();
  expect((await lstat(`${home}/outside/empty`)).isDirectory()).toBe(true);
});
