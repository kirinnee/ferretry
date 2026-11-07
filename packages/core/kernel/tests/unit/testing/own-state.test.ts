import { expect, test } from 'bun:test';
import { defineState } from '../../../contract/define.ts';
import type { CliContext } from '../../../manifest/implement.ts';
import type { Manifest } from '../../../manifest/types.ts';
import { MemoryStateFolder } from '../../../testing/state.ts';

const Tree = defineState({ name: 'pair-open', path: 'pair-open/*', store: 'opaque', format: 1 });
const Json = defineState({ name: 'json', path: 'json.json', store: 'json', format: 1 });
const Secret = defineState({ name: 'secret', path: 'secret', store: 'secret', format: 1 });
const Other = defineState({ name: 'other', path: 'other/*', store: 'opaque', format: 1 });

test('CLI ownState is optional and exposes only own declared opaque state operations', async () => {
  type OwnState = NonNullable<CliContext<Manifest>['ownState']>;
  const optional: {} extends Pick<CliContext<Manifest>, 'ownState'> ? true : false = true;
  const folder = new MemoryStateFolder(() => 42);
  const own: OwnState = folder.ownState([Tree, Json, Secret]);
  expect(optional).toBe(true);
  expect(Object.keys(own).sort()).toEqual([
    'createPrivateDirectory',
    'list',
    'pathOf',
    'remove',
    'removeEmptyDirectory',
    'stat',
    'write',
  ]);
  await own.createPrivateDirectory(Tree, 'one');
  await own.write(Tree, 'redirect' as never, 'one/index.html');
  expect(own.pathOf(Tree, 'one/index.html')).toBe('/memory-state/pair-open/one/index.html');
  expect(await own.stat(Tree, 'one/index.html')).toEqual({ kind: 'file', modifiedMs: 42 });
  expect(await own.list(Tree)).toEqual(['one']);
  await expect(own.removeEmptyDirectory(Tree, 'one')).rejects.toThrow();
  await own.remove(Tree, 'one/index.html');
  await own.removeEmptyDirectory(Tree, 'one');
  expect(await own.stat(Tree, 'one')).toBeUndefined();
  for (const file of [Json, Secret, Other, { ...Tree, path: 'other/*' }]) {
    await expect(own.write(file, 'refused' as never, 'name')).rejects.toThrow();
    expect(() => own.pathOf(file, 'name')).toThrow();
    await expect(own.stat(file, 'name')).rejects.toThrow();
    await expect(own.remove(file, 'name')).rejects.toThrow();
    await expect(own.list(file)).rejects.toThrow();
    await expect(own.createPrivateDirectory(file, 'name')).rejects.toThrow();
    await expect(own.removeEmptyDirectory(file, 'name')).rejects.toThrow();
  }
});
