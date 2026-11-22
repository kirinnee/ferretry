/**
 * r12 H13 — A MESSAGE OVER ONE OF DURIAN'S SIX SIZE CAPS IS SHOWN AS PLAIN TEXT, WITH THE NOTE.
 *
 * Durian 0.6.2 answers text over a YAML cap (`maxYamlChars`, `maxPageYamlChars`, `maxYamlNodes`, `maxPageYamlNodes`) or an animation
 * work cap (`maxAnimWork`, `maxPageAnimWork`) with an error block in place of the part. The chat does not draw that block
 * (`app/hypermedia/over-caps.ts`). Every case below makes the error from the REAL parser with neutral synthetic counts, never a copy of
 * its words, and finds each cap's edge by measuring (the count the parser reports passes; one less is over), so a release that
 * moves a cap or rewords its error fails here.
 */
import { describe, expect, it } from 'bun:test';
import { interact, mount } from '@ferretry/app/testing';
import { type Block, LIMITS, type Limits, parse, setYamlParser, UNTRUSTED_LIMITS } from 'durian-hypermedia';
import type { ReactNode } from 'react';
import { answer } from '../../../../app/hypermedia/durian-answer.ts';
import { HypermediaProse } from '../../../../app/hypermedia/hypermedia-prose.tsx';
import { PARSER_LIMITS } from '../../../../app/hypermedia/limits.ts';
import { hasCapErrorBlock } from '../../../../app/hypermedia/over-caps.ts';
import { readMessage } from '../../../../app/hypermedia/parse-message.ts';
import { PLAIN_TEXT_NOTE } from '../../../../app/hypermedia/plain-fallback.tsx';
import { inProcessReader, withDurianReader } from '../../../support/durian-reader.tsx';

const FENCE = '`'.repeat(3);
const fence = (info: string, ...body: readonly string[]): string => [`${FENCE}${info}`, ...body, FENCE].join('\n');

/** A chart with `values` numbers in one flow list: its YAML grows with the count. */
const chart = (values: number): string =>
  fence(
    'chart',
    'kind: line',
    'series:',
    '  - name: calls',
    `    data: [${Array.from({ length: values }, (_, n) => n).join(', ')}]`,
  );
/** A small animation. */
const animation = fence('animation', 'array a: 5 2 8 1', '@step They swap.', 'swap a.0 a.1');

/** Durian reads a chart's YAML through a parser the host gives it; the size caps are checked before it is called, so any will do. */
const withYaml = <T,>(run: () => T): T => {
  setYamlParser(() => ({}));
  try {
    return run();
  } finally {
    setYamlParser(null);
  }
};

/** Durian's parse of `text` with the chat's caps, one of them replaced. */
const parsed = (text: string, over: Partial<Limits>): readonly Block[] =>
  withYaml(() => parse(text, { frontMatter: false, limits: { ...UNTRUSTED_LIMITS, ...over } }).blocks);

/** The least value of `cap` that lets `text` through, found by measuring (more room never makes an error: the search is a halving one). */
function edgeOf(text: string, cap: keyof Limits): number {
  let high = 1;
  while (hasCapErrorBlock(parsed(text, { [cap]: high }))) high *= 2;
  let low = Math.floor(high / 2);
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (hasCapErrorBlock(parsed(text, { [cap]: middle }))) low = middle;
    else high = middle;
  }
  return high;
}

describe('each of the six caps makes an error block the chat does not draw', () => {
  const cases: readonly { readonly cap: keyof Limits; readonly text: string }[] = [
    { cap: 'maxYamlChars', text: chart(20) },
    { cap: 'maxYamlNodes', text: chart(20) },
    { cap: 'maxPageYamlChars', text: `${chart(10)}\n\n${chart(10)}` },
    { cap: 'maxPageYamlNodes', text: `${chart(10)}\n\n${chart(10)}` },
    { cap: 'maxAnimWork', text: animation },
    { cap: 'maxPageAnimWork', text: `${animation}\n\n${animation}` },
  ];

  for (const { cap, text } of cases)
    it(`${cap}: over it is an error block, at it is not`, () => {
      expect(UNTRUSTED_LIMITS[cap]).toBeGreaterThan(0);
      expect(hasCapErrorBlock(parsed(text, {}))).toBe(false);
      expect(hasCapErrorBlock(parsed(text, { [cap]: 1 }))).toBe(true);
      // THE EDGE: the least cap that lets the text through lets it through, and one less is over.
      const edge = edgeOf(text, cap);
      expect(edge).toBeGreaterThan(1);
      expect(hasCapErrorBlock(parsed(text, { [cap]: edge }))).toBe(false);
      expect(hasCapErrorBlock(parsed(text, { [cap]: edge - 1 }))).toBe(true);
    });

  it('finds the error block inside a container, not only at the top', () => {
    const inside = [':::tabs', '#### One', chart(20), '#### Two', 'second', ':::'].join('\n');
    expect(hasCapErrorBlock(parsed(inside, { maxYamlNodes: 1 }))).toBe(true);
    expect(hasCapErrorBlock(parsed(inside, {}))).toBe(false);
  });

  it('is not made by an error block of another kind', () => {
    // A mermaid diagram over ITS cap, and a fence never closed, are error blocks of their own: no one of the six, so the message is still read.
    const mermaid = parsed(fence('mermaid', 'a'.repeat(UNTRUSTED_LIMITS.maxMermaidChars + 1)), {});
    expect(mermaid.some(block => block.type === 'error')).toBe(true);
    expect(hasCapErrorBlock(mermaid)).toBe(false);
    const unclosed = parsed(`${FENCE}terminal\n$ x`, {});
    expect(unclosed.some(block => block.type === 'error')).toBe(true);
    expect(hasCapErrorBlock(unclosed)).toBe(false);
  });
});

describe('readMessage is given Durian’s UNTRUSTED_LIMITS, never its default', () => {
  it('hands the parser the untrusted caps, with the fixed input budget laid over them', () => {
    let seen: unknown;
    const spy = ((text: string, options?: { readonly limits?: unknown }) => {
      seen = options?.limits;
      return parse(text, { frontMatter: false });
    }) as typeof parse;
    readMessage('# A message', 'p-', false, false, spy);
    expect(seen).toEqual({ ...UNTRUSTED_LIMITS, ...PARSER_LIMITS });
  });

  it('is tighter than the default (authored pages) on the page-wide YAML and animation caps', () => {
    expect(UNTRUSTED_LIMITS.maxPageYamlNodes).toBeLessThan(LIMITS.maxPageYamlNodes);
    expect(UNTRUSTED_LIMITS.maxYamlNodes).toBeLessThan(LIMITS.maxYamlNodes);
    expect(UNTRUSTED_LIMITS.maxPageYamlChars).toBeLessThan(LIMITS.maxPageYamlChars);
    expect(UNTRUSTED_LIMITS.maxAnimWork).toBeLessThan(LIMITS.maxAnimWork);
    expect(UNTRUSTED_LIMITS.maxPageAnimWork).toBeLessThan(LIMITS.maxPageAnimWork);
  });
});

/**
 * The reader of {@link readMessage} with a parser that answers as if `text` were over `cap`: what the page would be told. The message
 * the caller gives is held and parsed as always; only the parser's document is the over-cap one (the real parser's, under a cap of 1).
 */
const capped =
  (text: string, cap: keyof Limits): typeof readMessage =>
  (source, idPrefix, arriving) =>
    readMessage(source, idPrefix, arriving, false, ((_held: string, options?: Parameters<typeof parse>[1]) =>
      withYaml(() => parse(text, { ...options, limits: { ...options?.limits, [cap]: 1 } }))) as typeof parse);

describe('a message over a cap is plain text through the worker and on the page', () => {
  const source = `# Heading\n\n${chart(20)}\n\nAfter.`;

  it('readMessage answers null', () => {
    expect(capped(chart(20), 'maxYamlNodes')(source, 'p-')).toBeNull();
    expect(capped(animation, 'maxAnimWork')(source, 'p-')).toBeNull();
    expect(capped(chart(20), 'maxYamlNodes')('# only a heading', 'p-')).toBeNull();
  });

  it('the worker says "show the text", never "read" or "failed"', () => {
    const answered = answer(
      { kind: 'read', id: 3, source, idPrefix: 'p-', arriving: false },
      capped(chart(20), 'maxYamlNodes'),
    );
    expect(answered).toEqual({ kind: 'text', id: 3 });
  });

  const draw = async (text: string) => {
    const tree = withDurianReader(<HypermediaProse text={text} />, inProcessReader(capped(chart(20), 'maxYamlNodes')));
    const mounted = await mount(tree as ReactNode as never);
    await interact(() => Promise.resolve());
    await interact(() => Promise.resolve());
    return mounted;
  };

  it('the page draws the whole message as text, with the note, and no error block', async () => {
    const { container, unmount } = await draw(source);
    expect(container.querySelector('pre.fy-hm-plain')?.textContent).toBe(source);
    expect(container.querySelector('[data-fy-plain-note]')?.textContent).toBe(PLAIN_TEXT_NOTE);
    expect(container.querySelector('.dh-doc, h1, [data-dh-part="error"]')).toBeNull();
    await unmount();
  });
});
