/**
 * r12 H4 review R1 — S1 (a chart's formulas are unbounded work, so no chart is evaluated), G1 (a held code walk keeps its
 * source and notes beside the `:::llm` disclosure). CORRECTNESS, at a small size: the charts here have the shape of the
 * reviewer's two (user functions calling user functions; a fill nested in a fill) but would evaluate in microseconds, so
 * what is asserted is that the evaluator is never reached (the block is a host block, with no `initial` data). The SPEED
 * claim (the reviewer's own charts, 3.2 s and 27 million values on the unguarded pin, read in under 50 ms) is measured
 * in real Chromium: `tests/integration/app/hypermedia-csp.visual.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import { ReferenceSurfaceProvider } from '@ferretry/app';
import { interact, mount } from '@ferretry/app/testing';
import type { ReactNode } from 'react';
import { HypermediaProse } from '../../../../app/hypermedia/hypermedia-prose.tsx';
import { holdFences } from '../../../../app/hypermedia/held-fences.tsx';
import { readMessage } from '../../../../app/hypermedia/parse-message.ts';
import { fixture, inShell } from './surface-fixture.tsx';

const FENCE = '`'.repeat(3);
const fence = (info: string, ...body: readonly string[]): string => [`${FENCE}${info}`, ...body, FENCE].join('\n');
const llm = (...body: readonly string[]): string => [':::llm', ...body, ':::'].join('\n');
const disclosures = (root: ParentNode): Element[] => [...root.querySelectorAll('details[data-fy-llm-only]')];

/** The shape of the reviewer's first chart: user functions calling user functions over a list (small here). */
const nestedFunctions = (): string =>
  fence(
    'chart',
    'kind: line',
    'let:',
    '  a: range(1,4)',
    '  h0(x): x+x',
    '  h1(x): h0(x)+h0(x)',
    '  b: h1(a)',
    'x: a',
    'series:',
    '  - name: s',
    '    data: b',
  );

/** The shape of the reviewer's second chart: a fill nested in a fill (small here). */
const nestedFill = (): string =>
  fence(
    'chart',
    'kind: line',
    'let:',
    '  big: fill(fill(fill(1,2),2),2)+1',
    'x: [1]',
    'series:',
    '  - name: s',
    '    data: big',
  );

const CHARTS = { 'nested user functions': nestedFunctions(), 'nested fill': nestedFill() };

const draw = async (text: string) => {
  const tree = inShell(
    <ReferenceSurfaceProvider surface={fixture().surface}>
      <HypermediaProse text={text} />
    </ReferenceSurfaceProvider>,
  ) as ReactNode;
  const mounted = await mount(tree as never);
  await interact(() => Promise.resolve());
  return mounted;
};

describe('a chart is held as code, never evaluated (S1)', () => {
  for (const [name, chart] of Object.entries(CHARTS)) {
    it(`${name}: is read as a host block that holds the source, never a chart part`, () => {
      const { doc } = readMessage(chart, 'p-');
      expect(doc.blocks.map(block => block.type)).toEqual(['host']);
      expect(doc.blocks[0]).toMatchObject({ type: 'host', name: 'fy-chart-held' });
      expect(JSON.stringify(doc.blocks)).not.toContain('"initial"');
    });

    it(`${name}: is drawn as readable code, with no chart and no error`, async () => {
      const { container, unmount } = await draw(chart);
      const [block, ...rest] = [...container.querySelectorAll('.dh-doc .code-block')];
      expect(rest).toEqual([]);
      expect(block?.querySelector('.code-lang')?.textContent).toBe('chart');
      expect(block?.querySelector('pre')?.textContent).toBe(chart.split('\n').slice(1, -1).join('\n'));
      expect(container.querySelector('.dh-doc [data-dh-part="chart"], .dh-doc .chart')).toBeNull();
      expect(container.querySelector('.dh-error')).toBeNull();
      await unmount();
    });
  }

  it('holds a chart at every depth Durian reads one: in tabs, in an accordion, in a :::human segment, in a tilde fence', () => {
    const body = ['kind: line', 'let:', '  b: fill(fill(1,2),2)+1', 'x: [1]'];
    const text = [
      [':::tabs', '#### One', fence('chart', ...body), '#### Two', 'plain', ':::'].join('\n'),
      [':::accordion', '#### One', fence('chart', ...body), ':::'].join('\n'),
      [':::human', fence('chart', ...body), ':::'].join('\n'),
      ['~~~chart title=x', ...body, '~~~'].join('\n'),
      `  ${FENCE}chart{x}\n${body.join('\n')}\n  ${FENCE}`,
    ].join('\n\n');
    const { doc } = readMessage(text, 'p-');
    expect(JSON.stringify(doc.blocks)).not.toContain('"type":"chart"');
    expect(JSON.stringify(doc.blocks)).not.toContain('"initial"');
    expect(JSON.stringify(doc.blocks).match(/"name":"fy-chart-held"/gu)?.length).toBe(5);
  });

  it('renames only a fence Durian reads as a chart: not a longer word, not a fence inside another fence, not fy-render', () => {
    const text = [
      fence('charts', 'a'),
      fence('Chart', 'b'),
      fence('fy-render', 'type: chart', '---', 'c'),
      // A closed four-backtick fence holding a ```chart pair: the chart is that fence's text, not a part.
      ['````markdown', fence('chart', 'd'), '````'].join('\n'),
      'prose ```chart inline```',
    ].join('\n\n');
    const held = holdFences(text);
    expect(held.match(/fy-chart-held/gu)).toBeNull();
    expect(held).toBe(text);
  });

  it('keeps an author’s :::llm text after a held chart as the disclosure beside the code, and the whole message readable', async () => {
    const { container, unmount } = await draw(
      [nestedFill(), '', llm('About the chart.'), '', 'After the chart.'].join('\n'),
    );
    const [only, ...rest] = disclosures(container);
    expect(rest).toEqual([]);
    expect((only as HTMLDetailsElement).open).toBe(false);
    expect(only?.querySelector('summary')?.textContent).toBe('LLM-only text');
    expect(only?.querySelector('pre')?.textContent).toBe('About the chart.');
    expect(container.textContent).toContain('After the chart.');
    expect(container.querySelector('.dh-error')).toBeNull();
    await unmount();
  });

  it('leaves a chart that fy-render draws (our own bounded reader) alone', () => {
    const text = fence('fy-render', 'type: chart', 'alt: Throughput', '---', 'kind: bar');
    expect(holdFences(text)).toBe(text);
  });
});

describe('a code walk keeps its source and notes beside the :::llm disclosure (G1)', () => {
  const walk = fence('codewalk', '- file: src/api.ts', '  note: the entry point');

  it('draws the walk’s own text as code AND the author’s text as the disclosure', async () => {
    const { container, unmount } = await draw([walk, '', llm('Walks the entry point.')].join('\n'));
    const [block, ...rest] = [...container.querySelectorAll('.dh-doc .code-block')];
    expect(rest).toEqual([]);
    expect(block?.querySelector('.code-lang')?.textContent).toBe('codewalk');
    expect(block?.querySelector('pre')?.textContent).toBe('- file: src/api.ts\n  note: the entry point');
    const [only, ...others] = disclosures(container);
    expect(others).toEqual([]);
    expect(only?.querySelector('pre')?.textContent).toBe('Walks the entry point.');
    expect(container.querySelector('.cw, [data-dh-part="codewalk"]')).toBeNull();
    expect(container.querySelector('.dh-error')).toBeNull();
    await unmount();
  });

  it('draws the walk’s own text as code when the author wrote no :::llm text, and no disclosure', async () => {
    const { container, unmount } = await draw(walk);
    expect(container.querySelector('.dh-doc .code-block pre')?.textContent).toBe(
      '- file: src/api.ts\n  note: the entry point',
    );
    expect(disclosures(container)).toEqual([]);
    await unmount();
  });
});
