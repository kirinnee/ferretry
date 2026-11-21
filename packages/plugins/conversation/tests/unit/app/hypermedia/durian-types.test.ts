/**
 * r12 H1 — THE DECLARATIONS ARE EXACT. `app/hypermedia/types/*.d.ts` stand in for durian-hypermedia's source for the type
 * checker (the source does not compile under this workspace's flags), so they must refuse what Durian would silently
 * ignore: a misspelled cap, an unknown part key, a renderer needing a prop Durian never passes. Each `@ts-expect-error`
 * below is a probe that FAILS THE TYPECHECK if the declaration loosens (an unused directive is an error), so `tsc` is
 * what holds this file; the runtime asserts hold the declared cap names against the installed package.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parse, type Limits, type ParseOptions } from 'durian-hypermedia';
import type { ChartBlock, TerminalBlock } from 'durian-hypermedia';
import type { Components, DocumentProps } from 'durian-hypermedia/react/strict';

const root = dirname(
  createRequire(join(import.meta.dir, '../../../../package.json')).resolve('durian-hypermedia/package.json'),
);

/** Every cap Durian v0.5.1 has: adding or dropping a key in `Limits` breaks this object's type. */
const CAPS = {
  maxInputBytes: true,
  maxBlocks: true,
  maxDepth: true,
  maxAnimEntities: true,
  maxAnimSteps: true,
  maxAnimChars: true,
  maxChartPoints: true,
  maxItems: true,
  maxMermaidChars: true,
  maxSteps: true,
} as const satisfies Record<keyof Limits, true>;

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

describe('the Durian declarations match the installed v0.5.1 (runtime)', () => {
  it('declares exactly the caps `src/safety.ts` has', () => {
    const source = readFileSync(join(root, 'src/safety.ts'), 'utf8');
    const block = /export interface Limits \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
    const real = [...block.matchAll(/^\s+(\w+):\s*number;/gm)].map(m => m[1] ?? '').sort();
    expect(real.length).toBe(10);
    expect(Object.keys(CAPS).sort()).toEqual(real);
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
        'Mermaid',
        'Animation',
        'TierList',
        'Alignment',
        'Tabs',
        'Accordion',
        'Human',
        'Error',
        'Host',
      ].sort(),
    );
  });
});
