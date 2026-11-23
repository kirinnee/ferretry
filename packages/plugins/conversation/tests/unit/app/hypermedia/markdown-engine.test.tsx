/**
 * r12 H13 — WHAT THE APP ASSUMES ABOUT HOW A FENCE IS READ STILL HOLDS UNDER DURIAN 0.6.2'S MARKDOWN READER.
 *
 * Durian's Markdown is read by markdown-it since 0.6.2 (marked is gone), and its CHANGELOG lists the edges where the two differ. Three
 * things of ours lean on the reader, and each is proved on the REAL pipeline here (the message read by `readMessage` as the worker
 * reads it, and drawn by `HypermediaProse` in a DOM):
 *
 *  1. WHERE A FENCE'S BODY IS. The `fy-render` slot matches the code text the reader made to the body CommonMark's tokens found
 *     (`fy-render-parse.ts`, `bodyKey`). The CHANGELOG says a tab in a fenced block inside a list item now stays a tab, and white
 *     space at a line's end is kept in code: a body with either must still be the one that draws.
 *  2. WHAT A HELD PART IS. A chart or a code walk is held as code before Durian reads it (`held-fence-parse.ts`), by Durian's OWN
 *     line scan, which the engine does not touch. Whatever the Markdown reader makes of a fence's surroundings, no `chart` or
 *     `codewalk` part may come out of any spelling of one.
 *  3. THAT A MESSAGE IS STILL READ AS BEFORE where the CHANGELOG says a line is plain text (a one-tilde pair, `<name>`): a reference
 *     beside it still becomes a reference.
 */
import { describe, expect, it } from 'bun:test';
import type { Block, MdBlock } from 'durian-hypermedia';
import { drawn, FENCE, installFyRenderDom, SQUARE } from './fy-render-draw.tsx';
import { mustRead } from './must-read.ts';

installFyRenderDom();

const OPEN = `${FENCE}fy-render`;
/** The svg block's lines with a tab BETWEEN two attributes and spaces at the end of a line. */
const WITH_TAB = ['type: svg', 'alt: A square', '---', SQUARE.replace('<svg xmlns', '<svg\txmlns')];
const WITH_TRAILING = ['type: svg', 'alt: A square', '---', `${SQUARE}   `];

const wrap = (lead: string, rest: string, lines: readonly string[]): string =>
  [`${lead}${OPEN}`, ...lines.map(line => `${rest}${line}`), `${rest}${FENCE}`].join('\n');

describe('a fy-render body with a tab or trailing white space still draws once, wherever the fence sits', () => {
  const SPELLINGS = [
    ['top level', '', ''],
    ['a list item', '- ', '  '],
    ['an ordered list item', '1. ', '   '],
    ['a quote', '> ', '> '],
    ['a quote in a list item', '- > ', '  > '],
  ] as const;
  for (const [place, lead, rest] of SPELLINGS) {
    it(`${place}: a tab inside a line`, async () => {
      const result = await drawn(wrap(lead, rest, WITH_TAB));
      expect(result).toMatchObject({ blocks: 1, images: 1, errors: 0 });
    });
    it(`${place}: white space at the end of a line`, async () => {
      const result = await drawn(wrap(lead, rest, WITH_TRAILING));
      expect(result).toMatchObject({ blocks: 1, images: 1, errors: 0 });
    });
  }
});

/** Every block of a document, containers and Markdown lists and quotes included. */
function walk(blocks: readonly Block[], visit: (block: Block) => void): void {
  for (const block of blocks) {
    visit(block);
    if (block.type === 'tabs' || block.type === 'accordion') for (const item of block.items) walk(item.body, visit);
    if (block.type === 'human') walk(block.body, visit);
  }
}
const markdownCode = (nodes: readonly MdBlock[]): number =>
  nodes.reduce((sum, node) => {
    if (node.t === 'code') return sum + 1;
    if (node.t === 'list') return sum + node.items.reduce((inner, item) => inner + markdownCode(item.c), 0);
    if (node.t === 'quote' || node.t === 'callout') return sum + markdownCode(node.c);
    return sum;
  }, 0);

describe('no spelling of a chart or code-walk fence is a part', () => {
  const body = ['kind: line', 'series:', '  - name: s', '    data: [1, 2]'];
  const SPELLINGS = [
    ['top level', '', ''],
    ['indented', '  ', '  '],
    ['in a list item', '- ', '  '],
    ['in a quote', '> ', '> '],
    ['after a paragraph line', 'text\n\n', ''],
  ] as const;
  for (const word of ['chart', 'codewalk'])
    for (const [place, lead, rest] of SPELLINGS)
      it(`${word}, ${place}`, () => {
        const text = [`${lead}${FENCE}${word}`, ...body.map(line => `${rest}${line}`), `${rest}${FENCE}`].join('\n');
        const parts: string[] = [];
        walk(mustRead(text, 'p-').doc.blocks, block => parts.push(block.type));
        expect(parts).not.toContain('chart');
        expect(parts).not.toContain('codewalk');
      });

  it('Durian reads a fence at any indent as a part, so an indented chart is the HELD host block, and one behind a list marker is Markdown code', () => {
    const held = mustRead([`  ${FENCE}chart`, '  kind: line', `  ${FENCE}`].join('\n'), 'p-');
    const hosts: string[] = [];
    walk(held.doc.blocks, block => (block.type === 'host' ? hosts.push(block.name) : undefined));
    expect(hosts).toEqual(['fy-chart-held']);
    const behindMarker = mustRead(['- item', `- ${FENCE}chart`, '  kind: line', `  ${FENCE}`].join('\n'), 'p-');
    const code = behindMarker.doc.blocks.reduce(
      (sum, block) => sum + (block.type === 'markdown' ? markdownCode(block.md) : 0),
      0,
    );
    expect(code).toBeGreaterThan(0);
    const behind: string[] = [];
    walk(behindMarker.doc.blocks, block => behind.push(block.type));
    expect(behind).not.toContain('host');
    expect(behind).not.toContain('chart');
  });
});

describe('text the CHANGELOG says is plain stays text, and a reference beside it is still a reference', () => {
  const textOf = (text: string): string =>
    JSON.stringify(mustRead(text, 'p-').doc.blocks.filter(block => block.type === 'markdown'));

  it('about ~5 of ~10 is not struck through, and &F12 after it is a reference', () => {
    const json = textOf('About ~5 of ~10 (~50%) and &F12.');
    expect(json).not.toContain('"t":"del"');
    expect(json).toContain('"t":"ref"');
  });

  it('<file_name> is one piece of text, and a reference after it is still read', () => {
    const json = textOf('Open <file_name> then &F12.');
    expect(json).toContain('<file_name>');
    expect(json).toContain('"t":"ref"');
  });
});
