import { describe, expect, test } from 'bun:test';
import type { PullFile } from '../../../contract/index.ts';
import { languageOf } from '../../../app/features/diff/language.ts';
import { buildTree, filterFiles, type TreeFolder } from '../../../app/features/diff/tree-model.ts';
import { describeFailure } from '../../../app/features/diff/use-pull-files.ts';
import {
  readTicks,
  tickStorageKey,
  viewedKey,
  writeTicks,
  type TickStorage,
} from '../../../app/features/diff/viewed.ts';

const file = (path: string, extra: Partial<PullFile> = {}): PullFile => ({
  path,
  status: 'modified',
  additions: 1,
  deletions: 0,
  ...extra,
});

describe('file tree', () => {
  const files = [
    file('src/app/a.ts'),
    file('src/app/b.ts'),
    file('src/lib/c.ts'),
    file('README.md'),
    file('deep/er/est/x.ts'),
  ];

  test('folders first, then files, alphabetical; a chain of single-child folders reads as one row', () => {
    const tree = buildTree(files);
    expect(tree.children.map(n => [n.kind, n.kind === 'folder' ? n.name : n.path])).toEqual([
      ['folder', 'deep/er/est'],
      ['folder', 'src'],
      ['file', 'README.md'],
    ]);
    const src = tree.children[1] as TreeFolder;
    expect(src.files).toBe(3);
    expect(src.children.map(n => n.kind === 'folder' && n.name)).toEqual(['app', 'lib']);
  });

  test('an empty list is an empty tree', () => {
    expect(buildTree([]).children).toEqual([]);
  });

  test('a filter needs every word in the path or the path it was renamed from, in any case', () => {
    expect(filterFiles(files, '').length).toBe(5);
    expect(filterFiles(files, 'SRC ts').map(f => f.path)).toEqual(['src/app/a.ts', 'src/app/b.ts', 'src/lib/c.ts']);
    expect(filterFiles(files, 'nothing')).toEqual([]);
    expect(filterFiles([file('new.ts', { status: 'renamed', previousPath: 'old/name.ts' })], 'old').length).toBe(1);
  });
});

describe('viewed ticks', () => {
  const memory = (): TickStorage & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: k => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
  };

  test('a tick belongs to the file as it was: a changed diff reads as unviewed again', () => {
    const a = file('a.ts', { patch: '@@ -1 +1 @@\n-a\n+b' });
    expect(viewedKey(a)).toBe(viewedKey({ ...a }));
    expect(viewedKey(a)).not.toBe(viewedKey({ ...a, patch: '@@ -1 +1 @@\n-a\n+c' }));
    expect(viewedKey(a)).not.toBe(viewedKey({ ...a, additions: 2 }));
  });

  test('written and read back per PR; another PR has none', () => {
    const storage = memory();
    writeTicks(storage, 'm.p.o.r.1', new Set(['x', 'y']));
    expect([...readTicks(storage, 'm.p.o.r.1')]).toEqual(['x', 'y']);
    expect(readTicks(storage, 'm.p.o.r.2').size).toBe(0);
  });

  test('a store that is missing, full, or holds rubbish is an empty set, never a throw', () => {
    expect(readTicks(undefined, 's').size).toBe(0);
    const rubbish = memory();
    rubbish.data.set(tickStorageKey('s'), '{not json');
    expect(readTicks(rubbish, 's').size).toBe(0);
    rubbish.data.set(tickStorageKey('s'), JSON.stringify([1, 'ok', null]));
    expect([...readTicks(rubbish, 's')]).toEqual(['ok']);
    expect(() =>
      writeTicks(
        {
          getItem: () => null,
          setItem: () => {
            throw new Error('full');
          },
        },
        's',
        new Set(['a']),
      ),
    ).not.toThrow();
    expect(() => writeTicks(undefined, 's', new Set(['a']))).not.toThrow();
  });

  test('the store is bounded: the oldest ticks go first', () => {
    const storage = memory();
    writeTicks(storage, 's', new Set(Array.from({ length: 3005 }, (_, i) => `k${i}`)));
    const read = [...readTicks(storage, 's')];
    expect(read).toHaveLength(3000);
    expect(read[0]).toBe('k5');
  });
});

describe('language by path', () => {
  test('from the extension or the file name, and nothing otherwise', () => {
    expect(languageOf('src/a.tsx')).toBe('typescript');
    expect(languageOf('Dockerfile')).toBe('dockerfile');
    expect(languageOf('a/b/Config.YAML')).toBe('yaml');
    expect(languageOf('LICENSE')).toBeUndefined();
    expect(languageOf('x.unknownext')).toBeUndefined();
  });
});

describe('describeFailure', () => {
  test('a pause says the one sentence every screen says, with the local time', () => {
    expect(describeFailure({ code: 'pulls_paused', body: { pausedUntilMs: 1 } }, () => '9:05 AM')).toBe(
      "Paused until 9:05 AM to stay inside GitHub's limit",
    );
    expect(describeFailure({ code: 'pulls_paused' }, () => 'x')).toContain('the limit resets');
  });
  test('anything else is the daemon’s own sentence, or a plain one', () => {
    expect(
      describeFailure({ code: 'pulls_no_account', message: 'link a GitHub account to this project first' }, () => ''),
    ).toBe('link a GitHub account to this project first');
    expect(describeFailure(null, () => '')).toBe('The files could not be loaded.');
  });
});
