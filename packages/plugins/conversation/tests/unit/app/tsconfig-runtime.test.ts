/**
 * THE tsconfig BUN READS AT RUNTIME NEVER POINTS A PACKAGE AT A DECLARATION FILE (U1 review, item 1).
 *
 * Bun reads `tsconfig.json` `paths` when it RESOLVES an import, in a test, in a scene build and in the Chromium security gate. Bun 1.3.13
 * follows an entry to a `.d.ts`, so `import('durian-markdown')` was the declaration: no `parse`, no `Blocks`, and the gate failed before its
 * first assertion (Bun 1.4.4 skips declaration targets and hid it). The declaration-only mapping the type checker needs lives in
 * `tsconfig.typecheck.json`, which `scripts/validate/typecheck.sh` and the projects that extend it read, and Bun does not.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dir, '../../../../../..');
const conversation = resolve(import.meta.dir, '../../..');

/** A tsconfig is JSON with comments: whole-line `//` comments are dropped (the repo's own gates read it this way). */
const paths = (file: string): Record<string, string[]> => {
  const text = readFileSync(join(repo, file), 'utf8').replace(/^\s*\/\/.*$/gmu, '');
  return (JSON.parse(text) as { compilerOptions?: { paths?: Record<string, string[]> } }).compilerOptions?.paths ?? {};
};

describe('the root tsconfig.json (what Bun reads)', () => {
  it('maps no specifier to a declaration file', () => {
    const declarations = Object.entries(paths('tsconfig.json')).filter(([, targets]) =>
      targets.some(target => /\.d\.(?:ts|mts|cts)$/u.test(target)),
    );
    expect(declarations).toEqual([]);
  });

  it('maps only the stylesheet stand-in of `durian-markdown`: the package ships no dist/, and a test that imports it needs the empty file', () => {
    const mapped = paths('tsconfig.json');
    expect(Object.keys(mapped).filter(name => name.startsWith('durian-markdown'))).toEqual([
      'durian-markdown/styles.css',
    ]);
    expect(mapped['durian-markdown/styles.css']?.every(target => target.endsWith('.css'))).toBe(true);
  });

  it('resolves `durian-markdown` and every entry we import to the package source, not to a declaration', () => {
    for (const specifier of [
      'durian-markdown',
      'durian-markdown/react/document',
      'durian-markdown/react/terminal',
      'durian-markdown/react/codewalk',
    ]) {
      const found = Bun.resolveSync(specifier, conversation);
      expect(found).toContain(`${join('durian-markdown', 'src')}`);
      expect(found.endsWith('.d.ts')).toBe(false);
    }
  });
});

describe('tsconfig.typecheck.json (what the type checker reads)', () => {
  const mapped = paths('tsconfig.typecheck.json');

  it('holds the declaration-only mapping of every entry of the package we import, and the root’s own mapping', () => {
    expect(mapped['playwright-core']).toEqual(paths('tsconfig.json')['playwright-core']);
    for (const name of [
      'durian-markdown',
      'durian-markdown/react/strict',
      'durian-markdown/react/document',
      'durian-markdown/react/terminal',
      'durian-markdown/react/filetree',
      'durian-markdown/react/editor',
      'durian-markdown/react/codewalk',
      'durian-markdown/react/animation',
      'durian-markdown/react/tierlist',
      'durian-markdown/react/alignment',
      'durian-markdown/react/containers',
      'durian-markdown/styles.css',
    ])
      expect(mapped[name]?.length).toBe(1);
  });

  it('points every mapping at a file that exists', () => {
    for (const [name, targets] of Object.entries(mapped))
      for (const target of targets) {
        const file = join(repo, target);
        expect(existsSync(file), `${name} → ${target}`).toBe(true);
      }
  });
});
