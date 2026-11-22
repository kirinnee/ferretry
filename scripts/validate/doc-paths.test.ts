import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CONTRACT_DOCS, missingPaths } from './doc-paths.ts';

const root = join(import.meta.dir, '../..');

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { force: true, recursive: true });
});

/** A throwaway git repo holding `files`, all tracked. */
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'fy-doc-paths-'));
  scratch.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['add', '-A'], { cwd: dir });
  return dir;
}

describe('the doc-paths check', () => {
  test('finds every path the contract documents name in the tree', () => {
    expect(missingPaths(root)).toEqual([]);
  });

  test('names the contract documents it holds to the tree', () => {
    expect(CONTRACT_DOCS).toEqual(['docs/fy-render.md', 'docs/reference-standard.md']);
  });

  test('is red on a fake path in a code span, naming the document, the line and the path', () => {
    const dir = repo({
      'packages/app/src/real.ts': 'export {};\n',
      'docs/a.md': 'Code lives in `packages/app/src/real.ts`.\nAnd in `packages/app/src/ghost.ts`.\n',
    });
    expect(missingPaths(dir, ['docs/a.md'])).toEqual([
      { doc: 'docs/a.md', line: 2, path: 'packages/app/src/ghost.ts' },
    ]);
  });

  test('is red on a fake relative link and on a deleted package, and green on a real directory', () => {
    const dir = repo({
      'docs/board.md': '# Board\n',
      'packages/app/src/real.ts': 'export {};\n',
      'docs/a.md': [
        'See [board](board.md#top), [gone](gone.md), [handover](../handover.md).',
        'The directory `packages/app/src/` is real; `packages/pwa/src/lib/grants.ts` is not.',
      ].join('\n'),
    });
    expect(missingPaths(dir, ['docs/a.md']).map(found => found.path)).toEqual([
      'docs/gone.md',
      'handover.md',
      'packages/pwa/src/lib/grants.ts',
    ]);
  });

  test('is red on a test whose top-level directory left the tree, a package-relative path and a bare test name', () => {
    const dir = repo({
      'packages/app/tests/unit/real.test.ts': 'export {};\n',
      'docs/a.md': [
        'The test is `tests/e2e/ghost.e2e.test.ts`, the code `lib/ghost.ts`, and `ghost.test.tsx` by name.',
        'These are real: `real.test.ts` by name and `packages/app/tests/unit/real.test.ts`.',
        'A link in a span is an example, not a link: `![](url)`.',
      ].join('\n'),
    });
    expect(missingPaths(dir, ['docs/a.md']).map(found => found.path)).toEqual([
      'tests/e2e/ghost.e2e.test.ts',
      'lib/ghost.ts',
      'ghost.test.tsx',
    ]);
  });

  test('cuts a line suffix and an anchor, and skips globs, placeholders, URLs and fenced examples', () => {
    const dir = repo({
      'packages/app/src/real.ts': 'export {};\n',
      'docs/a.md': [
        '`packages/app/src/real.ts:120-140` and `packages/app/src/real.ts#x` are real.',
        '`packages/app/src/*.ts`, `packages/<name>/src`, `packages/app/…` name a family, not a path.',
        '[web](https://example.com/packages/nope.ts) and [here](#top) are not repository paths.',
        '```text',
        'packages/app/src/ghost.ts',
        '```',
        'A reference example, `@src/ghost.ts`, starts with a sigil.',
      ].join('\n'),
    });
    expect(missingPaths(dir, ['docs/a.md'])).toEqual([]);
  });

  test('reads a path as tracked, not as present: an untracked file does not make a document pass', () => {
    const dir = repo({ 'docs/a.md': 'See `packages/app/src/later.ts`.\n', 'packages/app/src/real.ts': 'export {};\n' });
    writeFileSync(join(dir, 'packages/app/src/later.ts'), 'export {};\n');
    expect(missingPaths(dir, ['docs/a.md']).map(found => found.path)).toEqual(['packages/app/src/later.ts']);
  });
});
