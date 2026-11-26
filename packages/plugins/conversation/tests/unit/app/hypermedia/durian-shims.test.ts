/**
 * THE STAND-INS THE BUILD PUTS IN PLACE OF A FEW DURIAN IMPORTS (`app/vite-durian.ts` `redirectedImport`, `app/hypermedia/durian-shims/`),
 * held to the installed release. A stand-in is only honest if it answers every name the module it replaces is asked for, and a one-function
 * copy only if it agrees with the original; both are checked here, on the real installed source, so a release that adds an import or changes
 * a function fails here and not in a bundle.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { redirectedImport } from '../../../../app/vite-durian.ts';
import { inlineText } from '../../../../app/hypermedia/durian-shims/inline-text.ts';

const root = dirname(
  createRequire(join(import.meta.dir, '../../../../package.json')).resolve('durian-markdown/package.json'),
);
const src = join(root, 'src');

/** Every `import { a, type B, c as d } from "spec"` of a source file that is not type-only: the spec and the VALUE names it takes. */
function importsOf(text: string): { readonly spec: string; readonly names: readonly string[] }[] {
  const found: { spec: string; names: string[] }[] = [];
  for (const match of text.matchAll(/^(?:import|export)\s+(type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/gmu)) {
    if (match[1] !== undefined) continue;
    const names = (match[2] ?? '')
      .split(',')
      .map(part => part.trim())
      .filter(part => part !== '' && !part.startsWith('type '))
      .map(part => part.split(/\s+as\s+/u)[0] as string);
    found.push({ spec: match[3] as string, names });
  }
  return found;
}

const filesOf = (dir: string): string[] =>
  readdirSync(dir)
    .filter(name => /\.tsx?$/u.test(name))
    .map(name => join(dir, name));

describe('every import the build redirects is answered by its stand-in', () => {
  const importers = [join(src, 'document.ts'), join(src, 'react/markdown.tsx'), ...filesOf(join(src, 'core'))];
  const cases = importers.flatMap(importer =>
    importsOf(readFileSync(importer, 'utf8')).flatMap(({ spec, names }) => {
      const to = redirectedImport(spec, importer, root);
      return to === null ? [] : [{ importer: importer.slice(src.length + 1), spec, names, to }];
    }),
  );

  it('redirects what it is meant to: the chart reader, the scene compiler, the composed stage, the chip width and `inlineText`', () => {
    const redirected = new Set(cases.map(each => `${each.importer} ${each.spec}`));
    for (const wanted of [
      'core/dh-lib.ts ./chart',
      'core/dh-lib.ts ./chart-llm',
      'core/dh-lib.ts ./chart11',
      'core/dh-lib.ts ./scene',
      'core/dh-lib.ts ./stage-part',
      'core/chart11.ts ./chart',
      'core/pagecharts.ts ./chart',
      'core/doccheck.ts ./chart11',
      'core/doccheck.ts ./stage-part',
      'core/diagram.ts ./scene',
      'core/chipw.ts ./scene',
      'document.ts ./core/scene',
      'document.ts ./core/stage',
      'document.ts ./core/stage-part',
      'react/markdown.tsx ../markdown',
    ])
      expect(redirected.has(wanted)).toBe(true);
  });

  for (const each of cases)
    it(`${each.importer} ← ${each.spec}: the stand-in has ${each.names.join(', ') || 'no names'}`, async () => {
      const shim = (await import(each.to)) as Record<string, unknown>;
      expect(each.names.filter(name => !(name in shim))).toEqual([]);
    });
});

describe('inline-text.ts is Durian’s `inlineText`', () => {
  it('reads every kind of inline node as the installed function does', async () => {
    const real = ((await import(['durian-markdown'].join('/'))) as { inlineText: typeof inlineText }).inlineText;
    const { parse } = (await import(['durian-markdown'].join('/'))) as typeof import('durian-markdown');
    const doc = parse(
      [
        'Plain **strong _both_** ~~gone~~ `code` and a [link](https://example.com) with ![an image](https://example.com/a.png).',
        '',
        'Keys :kbd[Ctrl+K, Ctrl+S] and :mouse[double-click index.ts], a ref [[svg:abc "A label"]] and [[map:xyz]].',
        '',
        'Line one  ',
        'line two $x^2$ and a [@key] cite.',
      ].join('\n'),
      { frontMatter: false },
    );
    const inlines = doc.blocks.flatMap(block =>
      block.type === 'markdown' ? block.md.flatMap(md => ('c' in md ? [md.c as never] : [])) : [],
    );
    expect(inlines.length).toBeGreaterThan(1);
    for (const nodes of inlines) expect(inlineText(nodes)).toBe(real(nodes));
    expect(inlines.map(nodes => inlineText(nodes)).join(' ')).toContain('A label');
  });
});
