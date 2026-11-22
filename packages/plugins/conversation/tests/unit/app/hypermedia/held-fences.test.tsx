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
import { loadAnimationEngine } from '../../../../app/hypermedia/animation-engine.ts';
import { ANIMATION_DRAWS, holdFences } from '../../../../app/hypermedia/held-fence-parse.ts';
import { mustRead } from './must-read.ts';
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
      const { doc } = mustRead(chart, 'p-');
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
    const { doc } = mustRead(text, 'p-');
    expect(JSON.stringify(doc.blocks)).not.toContain('"type":"chart"');
    expect(JSON.stringify(doc.blocks)).not.toContain('"initial"');
    // A chart in a held container is inside the container's own text, not a second block: three charts, two held containers.
    expect(JSON.stringify(doc.blocks).match(/"name":"fy-chart-held"/gu)?.length).toBe(3);
    expect(JSON.stringify(doc.blocks).match(/"name":"fy-tabs-held"/gu)?.length).toBe(1);
    expect(JSON.stringify(doc.blocks).match(/"name":"fy-accordion-held"/gu)?.length).toBe(1);
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

const TABS = [
  ':::tabs',
  '',
  '#### npm',
  '',
  'Run `npm install`.',
  '',
  '#### pip',
  '',
  'Run `pip install`.',
  ':::',
].join('\n');

describe('a :::tabs container is held as code (r12 H11a)', () => {
  it('is read as ONE host block, never a tabs part, with line numbers unmoved', () => {
    const text = ['Intro.', '', TABS, '', 'After.'].join('\n');
    const held = holdFences(text);
    expect(held.split('\n')).toHaveLength(text.split('\n').length);
    expect(held).toContain(`${FENCE}fy-tabs-held`);
    const { doc } = mustRead(text, 'p-');
    expect(doc.blocks.map(block => block.type)).toEqual(['markdown', 'host', 'markdown']);
    expect(doc.blocks[1]).toMatchObject({ type: 'host', name: 'fy-tabs-held' });
    expect(doc.problems).toEqual([]);
  });

  it('is drawn as readable code (its own :::tabs lines included), with no tab and no error', async () => {
    const { container, unmount } = await draw(TABS);
    const [block, ...rest] = [...container.querySelectorAll('.dh-doc .code-block')];
    expect(rest).toEqual([]);
    expect(block?.querySelector('.code-lang')?.textContent).toBe('md');
    expect(block?.querySelector('pre')?.textContent).toBe(TABS);
    expect(container.querySelector('.dh-doc .tabs, .dh-doc [role="tab"]')).toBeNull();
    expect(container.querySelector('.dh-error')).toBeNull();
    await unmount();
  });

  it('keeps what follows the name, and what is inside it as written (a longer fence, a chart, a ```` run)', async () => {
    const inner = ['#### A', fence('chart', 'kind: line'), '````', 'x', '````', '#### B', 'b'];
    const text = [':::tabs id=pick', ...inner, ':::'].join('\n');
    const { container, unmount } = await draw(text);
    expect(container.querySelector('.dh-doc .code-block pre')?.textContent).toBe(text);
    expect(container.querySelectorAll('.dh-doc .code-block')).toHaveLength(1);
    expect(mustRead(text, 'p-').doc.blocks.map(block => block.type)).toEqual(['host']);
    await unmount();
  });

  it('keeps an author’s :::llm text after it as the disclosure beside the code', async () => {
    const { container, unmount } = await draw([TABS, '', llm('Two install commands.')].join('\n'));
    const [only, ...rest] = disclosures(container);
    expect(rest).toEqual([]);
    expect(only?.querySelector('pre')?.textContent).toBe('Two install commands.');
    expect(container.querySelector('.dh-error')).toBeNull();
    await unmount();
  });

  it('holds every container in a message, tabs and accordion: not a :::human segment or a longer name', () => {
    const accordion = [':::accordion', '#### One', 'x', ':::'].join('\n');
    const human = [':::human', 'for people', ':::'].join('\n');
    const longer = [':::tabs-x', '#### One', 'x', ':::'].join('\n');
    const text = [TABS, accordion, human, longer, TABS].join('\n\n');
    const held = holdFences(text);
    expect(held.match(/fy-tabs-held/gu)).toHaveLength(2);
    expect(held.match(/fy-accordion-held/gu)).toHaveLength(1);
    expect(holdFences([human, longer].join('\n\n'))).toBe([human, longer].join('\n\n'));
  });

  it('holds an accordion as the code it is: one host block, its own lines shown, no row drawn', async () => {
    const accordion = [':::accordion', '#### One', 'first', '#### Two', 'second', ':::'].join('\n');
    expect(mustRead(accordion, 'p-').doc.blocks.map(block => block.type)).toEqual(['host']);
    const { container, unmount } = await draw(accordion);
    expect(container.querySelector('.dh-doc .code-block pre')?.textContent).toBe(accordion);
    expect(container.querySelector('.dh-doc .accordion, .dh-error')).toBeNull();
    await unmount();
  });

  it('holds a container whose name follows spaces after the colons, tabs and accordion alike', async () => {
    for (const name of ['tabs', 'accordion']) {
      for (const gap of [' ', '   ', '\t']) {
        const text = [`:::${gap}${name}`, '#### One', 'x', ':::'].join('\n');
        expect(holdFences(text)).toContain(`${FENCE}fy-${name}-held`);
        expect(mustRead(text, 'p-').doc.blocks.map(block => block.type)).toEqual(['host']);
      }
    }
    const { container, unmount } = await draw(['::: accordion', '#### One', 'x', ':::'].join('\n'));
    expect(container.querySelector('.dh-doc .code-block pre')?.textContent).toBe(':::accordion\n#### One\nx\n:::');
    expect(container.querySelector('.dh-doc .accordion, .dh-doc .tabs')).toBeNull();
    await unmount();
  });

  it('reads containers the way Durian does: a fence holds a :::tabs line as text, a container with a fence in it still closes', () => {
    const quoted = fence('md', ':::tabs', '#### A', ':::');
    expect(holdFences(quoted)).toBe(quoted);
    const withFence = [':::tabs', '#### A', fence('ts', ':::', 'x'), '#### B', 'b', ':::'].join('\n');
    expect(holdFences(withFence).match(/fy-tabs-held/gu)).toHaveLength(1);
    expect(mustRead(withFence, 'p-').doc.blocks.map(block => block.type)).toEqual(['host']);
  });

  it('leaves a container Durian refuses to Durian: never closed, nested in another, or after a fence never closed', () => {
    const unclosed = [':::tabs', '#### A', 'x'].join('\n');
    expect(holdFences(unclosed)).toBe(unclosed);
    const nested = [':::tabs', '#### A', ':::human', 'x', ':::', ':::'].join('\n');
    expect(holdFences(nested)).toBe(nested);
    const openFence = [`${FENCE}ts`, 'x', ':::tabs', '#### A', ':::'].join('\n');
    expect(holdFences(openFence)).toBe(openFence);
    const stray = [':::human', 'x', ':::', '', ':::tabs', '#### A', ':::', `${FENCE}ts`, 'open'].join('\n');
    expect(holdFences(stray).match(/fy-tabs-held/gu)).toHaveLength(1);
    // A fence inside a container that never closes does not close it either.
    const inside = [':::tabs', `${FENCE}ts`, 'x'].join('\n');
    expect(holdFences(inside)).toBe(inside);
  });
});

describe('an animation is held as code, even once its engine has arrived (r12 H11a)', () => {
  const animation = fence('animation', 'array a: 5 2 8 1', '@step 5 and 2 swap.', 'swap a.0 a.1');

  it('is a host block that shows the source', async () => {
    expect(ANIMATION_DRAWS).toBe(false);
    await loadAnimationEngine();
    expect(mustRead(animation, 'p-', false, true).doc.blocks.map(block => block.type)).toEqual(['host']);
    const { container, unmount } = await draw(animation);
    expect(container.querySelector('.dh-doc .code-block .code-lang')?.textContent).toBe('animation');
    expect(container.querySelector('[data-fy-animation], .scn')).toBeNull();
    await unmount();
  });
});
