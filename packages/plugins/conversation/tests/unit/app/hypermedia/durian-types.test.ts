/**
 * r12 H1 — THE DECLARATIONS ARE EXACT. `app/hypermedia/types/*.d.ts` stand in for durian-markdown's source for the type
 * checker (the source does not compile under this workspace's flags), so they must refuse what Durian would silently
 * ignore: a misspelled cap, an unknown part key, a renderer needing a prop Durian never passes. Each `@ts-expect-error`
 * below is a probe that FAILS THE TYPECHECK if the declaration loosens (an unused directive is an error), so `tsc` is
 * what holds this file; the runtime asserts hold the declared cap names against the installed package.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { FORMAT_VERSION, LIMITS, parse, type ParseOptions, UNTRUSTED_LIMITS, VERSION } from 'durian-markdown';
import { HELD_FOLDER_PARTS } from '../../../../app/hypermedia/held-fence-parse.ts';
import type { ChartBlock, TerminalBlock } from 'durian-markdown';
import type { Components, DocumentProps } from 'durian-markdown/react/strict'; // types only: erased, never bundled

const root = dirname(
  createRequire(join(import.meta.dir, '../../../../package.json')).resolve('durian-markdown/package.json'),
);

/** The declarations file: the one this test holds to the installed package. */
const declarations = readFileSync(
  join(import.meta.dir, '../../../../app/hypermedia/types/durian-markdown.d.ts'),
  'utf8',
);

/** The `name: number;` keys of one declared interface. */
const declaredCaps = (name: string): string[] => {
  const block = new RegExp(`export interface ${name}[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(declarations)?.[1] ?? '';
  return [...block.matchAll(/^\s+(\w+):\s*number;/gm)].map(m => m[1] ?? '');
};

describe('the Durian declarations are exact (types)', () => {
  it('limits takes only the real cap names', () => {
    const ok: ParseOptions = { limits: { maxInputBytes: 1 } };
    // @ts-expect-error `maxInputByte` is not a cap (it is `maxInputBytes`): at runtime Durian would ignore it
    const typo: ParseOptions = { limits: { maxInputByte: 1 } };
    // @ts-expect-error a cap is a number
    const wrongType: ParseOptions = { limits: { maxInputBytes: '1' } };
    // @ts-expect-error a misspelled option of `parse` is not one either
    const typoOption: ParseOptions = { frontmatter: false };
    expect([ok, typo, wrongType, typoOption].length).toBe(4);
  });

  it('a component is keyed by a real part name and takes only `{ block }`', () => {
    const chart = (_: { block: ChartBlock }) => null;
    const terminal = (_: { block: TerminalBlock }) => null;
    const ok: Components = { chart, terminal };
    const props: Pick<DocumentProps, 'components'> = { components: ok };
    // @ts-expect-error `chrat` is not a part
    const unknownKey: Components = { chrat: chart };
    // @ts-expect-error a chart renderer that needs a field Durian never supplies
    const needsMore: Components = { chart: (_: { block: ChartBlock; palette: string }) => null };
    // @ts-expect-error a terminal renderer cannot draw the chart key's block
    const wrongBlock: Components = { chart: terminal };
    // @ts-expect-error `components` on the document is the same closed map
    const onDocument: DocumentProps['components'] = { chrat: chart };
    expect([props, unknownKey, needsMore, wrongBlock, onDocument].length).toBe(5);
  });
});

describe('the Durian declarations match the installed v0.7.0 (runtime)', () => {
  it("declares exactly the caps `src/safety.ts` has: its own and every folder part's", () => {
    const declared = [...declaredCaps('Limits'), ...declaredCaps('PartLimits')].sort();
    expect(declared).toEqual(Object.keys(LIMITS).sort());
    expect(Object.keys(UNTRUSTED_LIMITS).sort()).toEqual(declared);
  });

  it('declares the version and the format number of the installed release', () => {
    expect(VERSION).toBe('0.7.0');
    expect(FORMAT_VERSION).toBe(11);
  });

  it('declares exactly the folder parts the installed release has', () => {
    const registry = readFileSync(join(root, 'src/parts/generated/registry.ts'), 'utf8');
    const real = [
      ...(/export const FOLDER_PART_NAMES = \[([^\]]*)\]/u.exec(registry)?.[1] ?? '').matchAll(/"([^"]+)"/gu),
    ]
      .map(m => m[1] ?? '')
      .sort();
    const union = /export type FolderPartName =([\s\S]*?);\n/u.exec(declarations)?.[1] ?? '';
    expect([...union.matchAll(/'([^']+)'/gu)].map(m => m[1] ?? '').sort()).toEqual(real);
    expect(Object.keys(HELD_FOLDER_PARTS).sort()).toEqual(real);
  });

  it('applies a real cap and ignores a misspelled one (why the type must refuse it)', () => {
    const real = parse('Hello world', { frontMatter: false, limits: { maxInputBytes: 1 } });
    expect(real.problems.length).toBeGreaterThan(0);
    const typo = parse('Hello world', {
      frontMatter: false,
      limits: { maxInputByte: 1 } as unknown as ParseOptions['limits'],
    });
    expect(typo.problems.length).toBe(0);
  });

  it('declares exactly the block types `src/types.ts` has', () => {
    const source = readFileSync(join(root, 'src/types.ts'), 'utf8');
    const union = /export type Block =([\s\S]*?);\n/.exec(source)?.[1] ?? '';
    const names = [...union.matchAll(/\b(\w+)Block\b/g)].map(m => m[1] ?? '').sort();
    expect(names).toEqual(
      [
        'Markdown',
        'Toc',
        'Terminal',
        'FileTree',
        'Editor',
        'CodeWalk',
        'Chart',
        'Animation',
        'Diagram',
        'TierList',
        'Alignment',
        'Tabs',
        'Accordion',
        'Human',
        'Error',
        'Host',
        'Folder',
        'Reference',
        'Svg',
        'Interactive',
      ].sort(),
    );
  });
});
