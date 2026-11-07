import { expect, test } from 'bun:test';
import { defineState } from '../../../contract/define.ts';
import { MemoryStateFolder } from '../../../testing/state.ts';

const Tree = defineState({ name: 'pair-open', path: 'pair-open/*', store: 'opaque', format: 1 });
const Other = defineState({ name: 'other', path: 'other/*', store: 'opaque', format: 1 });

test('P106 memory named trees mirror metadata, exclusive private directories, list and empty-only removal', async () => {
  const folder = new MemoryStateFolder(() => 123);
  const port = folder.port([Tree]);
  expect(await port.stat(Tree, 'missing')).toBeUndefined();
  await port.createPrivateDirectory(Tree, 'one');
  expect(folder.directories.get('pair-open/one')).toEqual({ mode: 0o700, modifiedMs: 123 });
  expect(await port.stat(Tree, 'one')).toEqual({ kind: 'directory', modifiedMs: 123 });
  await expect(port.createPrivateDirectory(Tree, 'one')).rejects.toThrow();
  await port.write(Tree, 'redirect' as never, 'one/index.html');
  expect(await port.stat(Tree, 'one/index.html')).toEqual({ kind: 'file', modifiedMs: 123 });
  expect(await port.list(Tree)).toEqual(['one']);
  await expect(port.removeEmptyDirectory(Tree, 'one')).rejects.toThrow();
  folder.symlinks.set('pair-open/link', 'one');
  expect((await port.stat(Tree, 'link'))?.kind).toBe('symlink');
  await expect(port.createPrivateDirectory(Tree, 'link')).rejects.toThrow();
  await expect(port.removeEmptyDirectory(Tree, 'link')).rejects.toThrow();
  await expect(port.stat(Tree, 'link/index.html')).rejects.toThrow();
  await expect(port.createPrivateDirectory(Tree, 'link/nested')).rejects.toThrow();
  await expect(port.removeEmptyDirectory(Tree, 'link/nested')).rejects.toThrow();
  await port.remove(Tree, 'one/index.html');
  await port.removeEmptyDirectory(Tree, 'one');
  expect(await port.stat(Tree, 'one')).toBeUndefined();
  await expect(port.stat(Other, 'one')).rejects.toThrow();
  await expect(port.stat({ ...Tree, path: 'other/*' }, 'one')).rejects.toThrow();
  for (const name of ['../other', '/absolute', 'x/../other', 'x\0y']) {
    await expect(port.stat(Tree, name)).rejects.toThrow();
    await expect(port.createPrivateDirectory(Tree, name)).rejects.toThrow();
    await expect(port.removeEmptyDirectory(Tree, name)).rejects.toThrow();
  }
});
