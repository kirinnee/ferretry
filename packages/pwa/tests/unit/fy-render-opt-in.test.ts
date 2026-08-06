import { describe, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Glob } from 'bun';
import should from 'should';

/**
 * The cheapest guard in the whole design, and the only one that can fail for a
 * file this feature never touches.
 *
 * `enableFyRender` defaults to `false`, so every Markdown surface in the product
 * is inert unless it names the capability. That is a structural property, not a
 * documented rule — but it is only worth anything while the number of surfaces
 * naming it stays at one. A second call site is how "conversation-only" becomes
 * "wherever somebody found it convenient", and it would arrive in a diff that
 * looks like it is about something else entirely. So the count is asserted here
 * rather than trusted, against the real source tree.
 *
 * This is a source-text test on purpose. The property is "no OTHER file does
 * this", and no amount of rendering the files that exist can prove something
 * about a file somebody adds later.
 */

const packageDir = join(import.meta.dir, '../..');
const sourceDir = join(packageDir, 'src');

const productionSources = (): readonly string[] =>
  [...new Glob('**/*.{ts,tsx}').scanSync(sourceDir)].map(path => relative(packageDir, join(sourceDir, path))).sort();

const mentioning = (token: string): readonly string[] =>
  productionSources().filter(path => readFileSync(join(packageDir, path), 'utf8').includes(token));

describe('fy-render opt-in', () => {
  test('should be named by exactly one production surface, plus the renderer that declares it', () => {
    // Act
    const files = mentioning('enableFyRender');

    // Assert — `markdown.tsx` DECLARES the prop; `transcript-row.tsx` is the one
    // surface that PASSES it. Anything else in this list is a new execution
    // surface and needs the threat model re-read, not a test update.
    should(files).eql(['src/components/markdown.tsx', 'src/components/transcript-row.tsx']);
  });

  test('should default the capability off where it is declared', () => {
    // Arrange
    const renderer = readFileSync(join(packageDir, 'src/components/markdown.tsx'), 'utf8');

    // Assert — the default is what makes every other surface inert for free.
    should(renderer).containEql('enableFyRender = false');
  });

  test('should render an illustration from exactly one component', () => {
    // Act — the component that turns a parsed payload into DOM, and the modules
    // that legitimately name it: the grammar (its type shares the noun), the
    // renderer that mounts it, and the package barrel.
    const files = mentioning('FyRenderBlock');

    // Assert — a fourth mounting site is a fourth thing to threat-model.
    should(files).eql([
      'src/components/fy-render-block.tsx',
      'src/components/markdown.tsx',
      'src/lib/fy-render.ts',
      'src/lib/index.ts',
    ]);
  });
});

/**
 * NOT TESTED HERE, deliberately: that the feature contains no
 * `dangerouslySetInnerHTML`, `srcdoc`, `iframe`, `eval` or `Function`. Grepping
 * the source for those words cannot distinguish the primitive from the
 * paragraph explaining why it is absent, and both files carry that paragraph.
 * The honest form of that assertion is against the tree the component actually
 * renders, and it lives in `fy-render-block.test.tsx`.
 */
