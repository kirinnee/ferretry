/**
 * `folderRegistries` is the one helper behind every generated "list of a folder" file. These tests pin its rules on a temp
 * dir: no match, no file; sorted by plain string order; a file that misses the glob is ignored; and `emit` alone decides
 * what the file says (an import list, an `extends` list).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type FolderRegistrySpec, folderRegistries, ident, importPath } from '../lib/folder-registry.ts';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const pkgWith = (files: readonly string[]) => {
  const dir = mkdtempSync(join(tmpdir(), 'folder-registry-'));
  roots.push(dir);
  for (const file of files) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), '');
  }
  return [{ dir, rel: 'packages/alpha' }];
};

const imports: FolderRegistrySpec = {
  dir: 'things',
  glob: '*.thing.ts',
  out: 'generated/things.ts',
  prefix: 'thing',
  emit: ({ entries }) =>
    [
      ...entries.map(e => `import ${e.name} from '${e.importPath}';`),
      `export default [${entries.map(e => e.name).join(', ')}];`,
      '',
    ].join('\n'),
};

describe('folderRegistries', () => {
  test('a package without the folder, or with an empty one, gets no file', () => {
    expect([...folderRegistries(pkgWith(['other/x.ts']), imports).keys()]).toEqual([]);
    expect([...folderRegistries(pkgWith(['things/.keep']), imports).keys()]).toEqual([]);
  });

  test('entries are sorted by code-unit order (capitals first, `-` before `.`), whatever order the disk lists them', () => {
    const files = ['things/b.thing.ts', 'things/B.thing.ts', 'things/a-two.thing.ts', 'things/a.thing.ts'];
    const text = folderRegistries(pkgWith(files), imports).get('packages/alpha/generated/things.ts');
    expect(text).toContain('export default [thing_B, thing_a_two, thing_a, thing_b];');
    expect([...(text ?? '').matchAll(/from '([^']+)'/g)].map(m => m[1])).toEqual([
      '../things/B.thing.ts',
      '../things/a-two.thing.ts',
      '../things/a.thing.ts',
      '../things/b.thing.ts',
    ]);
  });

  test('a file that does not match the glob, or sits in a sub-folder, is not listed', () => {
    const text = folderRegistries(
      pkgWith(['things/a.thing.ts', 'things/types.ts', 'things/sub/b.thing.ts']),
      imports,
    ).get('packages/alpha/generated/things.ts');
    expect(text).toContain('thing_a');
    expect(text).not.toContain('types');
    expect(text).not.toContain('sub');
  });

  test('emit alone shapes the file: an extends list instead of an import list', () => {
    const extendsList: FolderRegistrySpec = {
      ...imports,
      out: 'generated/api.ts',
      emit: ({ entries }) =>
        [
          ...entries.map(e => `import type { ${e.name} } from '${e.importPath}';`),
          `export interface Api extends ${entries.map(e => e.name).join(', ')} {}`,
          '',
        ].join('\n'),
    };
    const text = folderRegistries(pkgWith(['things/two.thing.ts', 'things/one.thing.ts']), extendsList).get(
      'packages/alpha/generated/api.ts',
    );
    expect(text).toBe(
      [
        "import type { thing_one } from '../things/one.thing.ts';",
        "import type { thing_two } from '../things/two.thing.ts';",
        'export interface Api extends thing_one, thing_two {}',
        '',
      ].join('\n'),
    );
  });

  test('a registry is written per package that has matches', () => {
    const a = pkgWith(['things/a.thing.ts']);
    const b = pkgWith(['things/b.thing.ts']).map(pkg => ({ ...pkg, rel: 'packages/beta' }));
    expect([...folderRegistries([...a, ...b], imports).keys()]).toEqual([
      'packages/alpha/generated/things.ts',
      'packages/beta/generated/things.ts',
    ]);
  });
});

describe('naming helpers', () => {
  test('ident replaces every non-alphanumeric run character with an underscore', () => {
    expect(ident('feature', 'alpha-one.v2')).toBe('feature_alpha_one_v2');
  });
  test('importPath is `/`-separated and always starts with a dot', () => {
    expect(importPath('/r/p/generated/x.ts', '/r/p/things/a.ts')).toBe('../things/a.ts');
    expect(importPath('/r/p/x.ts', '/r/p/a.ts')).toBe('./a.ts');
  });
});
