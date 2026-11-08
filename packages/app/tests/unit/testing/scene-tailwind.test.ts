/** The scene builder's Tailwind content globs reach every app half whatever folder the builder runs in. */
import { describe, expect, test } from 'bun:test';
import { isAbsolute, resolve } from 'node:path';
import tailwindConfig from '../../../tailwind.config.ts';
import { contentFromPackage } from '../../support/browser/scene-tailwind.ts';

const packageRoot = resolve(import.meta.dir, '../../..');
const workspace = resolve(packageRoot, '../..');

const globsOf = (root: string): string[] => {
  const { content } = contentFromPackage(tailwindConfig, root);
  if (!Array.isArray(content)) throw new Error('expected a plain list of globs');
  return content.filter((entry): entry is string => typeof entry === 'string');
};

describe('scene Tailwind content', () => {
  test('makes every glob absolute under the app package, not the working directory', () => {
    const globs = globsOf(packageRoot);
    expect(globs.length).toBeGreaterThan(0);
    for (const glob of globs) {
      expect(isAbsolute(glob)).toBe(true);
      expect(glob.startsWith(workspace)).toBe(true);
    }
  });

  test("matches a plugin app half's view file, as the Vite build does", () => {
    const view = resolve(workspace, 'packages/plugins/catalogs/app/features/catalogs/catalog-review-view.tsx');
    expect(globsOf(packageRoot).some(glob => new Bun.Glob(glob).match(view))).toBe(true);
  });

  test('keeps the rest of the config as it was', () => {
    const made = contentFromPackage(tailwindConfig, packageRoot);
    expect(made.theme).toBe(tailwindConfig.theme);
    expect(made.darkMode).toEqual(tailwindConfig.darkMode);
  });
});
