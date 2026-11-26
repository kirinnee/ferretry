/** r12 H2 — `withReferences`: our grammar over Durian's parsed tree, never Durian's tokenizer. */
import { describe, expect, it } from 'bun:test';
import { parse } from 'durian-markdown';
import { configureDurian } from '../../../../app/hypermedia/durian.ts';
import { REFERENCE_INLINE, withReferences } from '../../../../app/hypermedia/with-references.ts';

configureDurian();

type Node = { t: string; v?: string; text?: string; c?: Node[]; data?: { reference: { kind: string } } };
const inlinesOf = (md: string): Node[] => {
  const doc = withReferences(parse(md, { frontMatter: false }));
  const block = doc.blocks[0] as unknown as { md: { c: Node[] }[] };
  return block.md[0]?.c ?? [];
};
const flat = (nodes: Node[]): Node[] => nodes.flatMap(n => [n, ...flat(n.c ?? [])]);
const refs = (md: string): string[] =>
  flat(inlinesOf(md))
    .filter(n => n.t === 'ref')
    .map(n => `${n.data?.reference.kind}:${n.text}`);

describe('withReferences', () => {
  it('splits a text node at each lexical reference and names it for our chip', () => {
    const out = inlinesOf('ping :zelda about &F12.');
    expect(out.map(n => n.t)).toEqual(['text', 'ref', 'text', 'ref', 'text']);
    expect(
      out.filter(n => n.t === 'ref').every(n => (n as unknown as { name: string }).name === REFERENCE_INLINE),
    ).toBe(true);
    expect(out.map(n => (n.t === 'ref' ? n.text : n.v)).join('')).toBe('ping :zelda about &F12.');
  });

  it('keeps an address, a percentage and a shell word as text', () => {
    expect(refs('bob@example.com 50% $HOME')).toEqual([]);
  });

  it('reads an escaped sigil as prose, and an unescaped one beside it as a reference', () => {
    expect(refs('\\:zelda names :zelda')).toEqual(['agent::zelda']);
  });

  it('never rewrites inside code or a link', () => {
    expect(refs('`:zelda` [&F12](https://example.com)')).toEqual([]);
  });

  it('reaches lists, tables, callouts and emphasis', () => {
    expect(refs('**:zelda**')).toEqual(['agent::zelda']);
    const table = withReferences(parse('| a |\n| - |\n| &F12 |', { frontMatter: false }));
    expect(JSON.stringify(table.blocks)).toContain('"t":"ref"');
    const list = withReferences(parse('- &F12\n- ^A3', { frontMatter: false }));
    expect(JSON.stringify(list.blocks).match(/"t":"ref"/g)?.length).toBe(2);
    const callout = withReferences(parse('> **Note:** see &F12', { frontMatter: false }));
    expect(JSON.stringify(callout.blocks)).toContain('"t":"ref"');
  });

  it('does not change the document it was given', () => {
    const doc = parse('ping :zelda', { frontMatter: false });
    const before = JSON.stringify(doc.blocks);
    withReferences(doc);
    expect(JSON.stringify(doc.blocks)).toBe(before);
  });
});
