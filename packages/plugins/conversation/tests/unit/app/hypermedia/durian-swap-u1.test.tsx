/**
 * U1 OF THE DURIANMARKDOWN SWAP (Durian 0.7.0): the two risks of the plan's §2 that this unit owns and a unit test can hold, R2 and R11.
 * (R1, hostile and format fixtures with 0 violations, is `tests/integration/app/hypermedia-csp.visual.test.ts`; R12, no font or CDN
 * load, is the same test's request ledger; R13, the weather part writes `localStorage`, is that the part is held as code.)
 *
 *  - R2: Durian's DEFAULT policy lets an https image through (`src/safety.ts`: a tracking pixel). Ours never does, and the reference
 *    chip `[[svg:name "label"]]`, new in 0.7.0, is a chip with a label: no image and no request while no resolver answers for it.
 *  - R11: Durian's registry of host blocks is process-wide (`registerBlock`) and a parser's own part table is changed while a
 *    parse runs (`withHostParts`). The app passes its blocks per parse and never registers one, so a block of one message is not
 *    a part of the next, and two messages read one after the other are each read as written.
 */
import { describe, expect, it } from 'bun:test';
import { ReferenceSurfaceProvider } from '@ferretry/app';
import { interact, mount } from '@ferretry/app/testing';
import { parse } from 'durian-markdown';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import { HypermediaProse } from '../../../../app/hypermedia/hypermedia-prose.tsx';
import { mustRead } from './must-read.ts';
import { fixture, inShell } from './surface-fixture.tsx';

const FENCE = '`'.repeat(3);
const fence = (info: string, ...body: readonly string[]): string => [`${FENCE}${info}`, ...body, FENCE].join('\n');

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

describe('R2: an image an agent writes is never drawn', () => {
  const IMAGES = [
    '![pixel](https://tracker.example/p.gif)',
    '![pixel](http://tracker.example/p.gif)',
    '![local](a.png)',
    '![data](data:image/png;base64,AAAA)',
    '![ref]( //tracker.example/p.gif )',
  ];

  for (const image of IMAGES)
    it(`${image}: the document holds no image URL, and the page draws no <img>`, async () => {
      const text = `Before\n\n${image}\n\nAfter`;
      const { doc } = mustRead(text, 'p-');
      expect(JSON.stringify(doc.blocks)).not.toMatch(/"t":"img","src":"[^n]/u);
      const { container, unmount } = await draw(text);
      expect(container.querySelector('.dh-doc img')).toBeNull();
      expect(container.textContent).toContain('Before');
      await unmount();
    });

  it('Durian’s own default policy WOULD have let the https one through (why the host policy exists)', () => {
    const doc = parse('![pixel](https://tracker.example/p.gif)', { frontMatter: false });
    expect(JSON.stringify(doc.blocks)).toContain('https://tracker.example/p.gif');
  });

  it('a reference on its own line and in a sentence is a chip with its label, and no image, frame or request', async () => {
    const text = [
      '[[svg:7k2m9q "Login flow, browser to daemon"]]',
      '',
      'See [[interactive:x1y2z3 "A slider"]] in a sentence.',
      '',
      '[[map:abc "A map"]]',
    ].join('\n');
    const { doc } = mustRead(text, 'p-');
    expect(doc.blocks.map(block => block.type)).toContain('reference');
    expect(doc.blocks.map(block => block.type)).not.toContain('svg');
    expect(doc.blocks.map(block => block.type)).not.toContain('interactive');
    const { container, unmount } = await draw(text);
    expect(container.textContent).toContain('Login flow, browser to daemon');
    expect(container.textContent).toContain('A slider');
    expect(
      container.querySelector('.dh-doc img, .dh-doc iframe, .dh-doc object, .dh-doc embed, .dh-doc canvas'),
    ).toBeNull();
    expect(container.querySelector('.dh-doc a[href]')).toBeNull();
    await unmount();
  });
});

describe('R11: no state is shared between messages', () => {
  const HOSTED = `${fence('fy-render', 'type: mermaid', 'alt: x', '---', 'flowchart TB')}\n\n${fence('mermaid', 'flowchart TB', '  A --> B')}\n\n${fence('chart', 'kind: bar')}`;
  const PLAIN = `${fence('fy-render', 'type: mermaid', 'alt: x', '---', 'flowchart TB')}\n\n${fence('mermaid', 'flowchart TB', '  A --> B')}`;

  it('the app never registers a block: no source of the Conversation plugin calls registerBlock or unregisterBlock', () => {
    const folder = join(import.meta.dir, '../../../../app');
    const scan = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
        entry.isDirectory()
          ? scan(join(dir, entry.name))
          : /\.(?:tsx?)$/u.test(entry.name)
            ? [join(dir, entry.name)]
            : [],
      );
    const found = scan(folder).filter(path => /\b(?:un)?registerBlock\b/u.test(readFileSync(path, 'utf8')));
    expect(found).toEqual([]);
  });

  it('after the app read a message with its host blocks, Durian’s plain parse still reads those fences as code', () => {
    mustRead(HOSTED, 'a-');
    const plain = parse(PLAIN, { frontMatter: false });
    expect(plain.blocks.map(block => block.type)).toEqual(['markdown']);
    const another = parse(fence('fy-chart-held', 'x'), { frontMatter: false });
    expect(another.blocks.map(block => block.type)).toEqual(['markdown']);
  });

  it('two messages read one after the other, and again in the other order, each come out the same', () => {
    const first = (): string => JSON.stringify(mustRead(HOSTED, 'p-').doc.blocks);
    const second = (): string => JSON.stringify(mustRead(PLAIN, 'p-').doc.blocks);
    const a1 = first();
    const b1 = second();
    const b2 = second();
    const a2 = first();
    expect(a2).toBe(a1);
    expect(b2).toBe(b1);
    // The mermaid host block of the first is not in the second's reading of the plain fence at the end: it is a host block in both,
    // because the app names it in each parse; a parse that does not name it reads plain code.
    expect(a1).toContain('"name":"mermaid"');
    expect(JSON.stringify(parse(PLAIN, { frontMatter: false }).blocks)).not.toContain('"name":"mermaid"');
  });

  it('a throw inside a host block’s parse does not leave the part table changed for the next message', () => {
    const throwing = {
      name: 'fy-boom',
      parse: (): never => {
        throw new Error('boom');
      },
    };
    const boom = parse(fence('fy-boom', 'x'), { frontMatter: false, blocks: [throwing] });
    expect(boom.blocks.some(block => block.type === 'error')).toBe(true);
    const after = parse(fence('fy-boom', 'x'), { frontMatter: false });
    expect(after.blocks.map(block => block.type)).toEqual(['markdown']);
  });
});
