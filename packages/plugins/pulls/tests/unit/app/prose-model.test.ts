import { describe, expect, test } from 'bun:test';
import { type Block, type Inline, inline, parseProse, safeHref } from '../../../app/features/pr-page/prose-model.ts';

const texts = (nodes: readonly Inline[]): string =>
  nodes
    .map(n =>
      'text' in n ? n.text : 'children' in n ? texts(n.children) : `[image ${n.kind === 'image' ? n.alt : ''}]`,
    )
    .join('');
const kinds = (nodes: readonly Inline[]): string[] => nodes.map(n => n.kind);
const flat = (blocks: readonly Block[]): Inline[] =>
  blocks.flatMap(b =>
    b.kind === 'paragraph'
      ? [...b.inline]
      : b.kind === 'list'
        ? b.items.flat()
        : b.kind === 'quote'
          ? flat(b.blocks)
          : [],
  );

describe('links', () => {
  test('only http(s) without credentials is a link', () => {
    expect(safeHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    for (const bad of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html,x',
      'file:///etc/passwd',
      'fy://x',
      'https://u:p@example.com',
      ' java\nscript:x',
      '//example.com',
      'mailto:a@b.c',
      '',
    ])
      expect(safeHref(bad)).toBeUndefined();
  });
  test('http: is not a link: only https is', () => {
    expect(safeHref('http://example.com/a')).toBeUndefined();
    const nodes = inline('[plain](http://example.com) [safe](https://example.com) http://bare.example');
    expect(kinds(nodes).filter(k => k === 'link')).toEqual(['link']);
    expect(texts(nodes)).toContain('plain');
    expect(texts(nodes)).toContain('http://bare.example');
  });
  test('a javascript: link is its text, never a link', () => {
    const nodes = inline('[click](javascript:alert(1)) and [ok](https://example.com)');
    expect(kinds(nodes).filter(k => k === 'link')).toEqual(['link']);
    expect(texts(nodes)).toStartWith('click');
    expect(texts(nodes)).not.toContain('javascript');
  });
  test('a bare address and an angle address are links', () => {
    expect(kinds(inline('see https://example.com/x, and <https://example.org>'))).toEqual([
      'text',
      'link',
      'text',
      'link',
    ]);
  });
});

describe('images', () => {
  test('an image keeps its alt text and drops its address', () => {
    const nodes = inline('![a diagram](https://tracker.example/p.png?id=1)');
    expect(nodes).toEqual([{ kind: 'image', alt: 'a diagram' }]);
    expect(JSON.stringify(nodes)).not.toContain('tracker.example');
  });
});

describe('html and Ferretry syntax stay text', () => {
  test('tags are text and comments are removed', () => {
    const blocks = parseProse(
      'Hi <script>alert(1)</script><img src=x onerror=alert(1)>\n<!-- hidden template note -->\n<b>x</b>',
    );
    const text = texts(flat(blocks));
    expect(text).toContain('<script>alert(1)</script>');
    expect(text).toContain('<img src=x onerror=alert(1)>');
    expect(text).not.toContain('hidden template note');
    expect(flat(blocks).every(n => n.kind === 'text')).toBe(true);
  });
  test('references are not read: &F1, :agent, %terminal:x, ^A3, @file stay plain text', () => {
    const nodes = flat(parseProse('see &F1 and :britnee and %terminal:dev and ^A3 and @src/a.ts and /skill'));
    expect(kinds(nodes)).toEqual(['text']);
  });
  test('a fy-render fence (or any language) is code, shown as text, never read', () => {
    const blocks = parseProse(
      '```fy-render\n{"type":"svg","src":"<svg onload=alert(1)>"}\n```\n~~~html\n<script>1</script>\n~~~',
    );
    expect(blocks).toEqual([
      { kind: 'code', text: '{"type":"svg","src":"<svg onload=alert(1)>"}' },
      { kind: 'code', text: '<script>1</script>' },
    ]);
  });
  test('an unclosed fence runs to the end and stays code', () => {
    expect(parseProse('```\n<b>x')).toEqual([{ kind: 'code', text: '<b>x' }]);
  });
});

describe('structure and bounds', () => {
  test('headings are bold paragraphs; lists, tasks, quotes and rules parse', () => {
    const blocks = parseProse('# Title\n\n- [x] done\n- [ ] todo\n\n1. one\n2. two\n\n> quoted\n\n---');
    expect(blocks[0]).toEqual({
      kind: 'paragraph',
      inline: [{ kind: 'bold', children: [{ kind: 'text', text: 'Title' }] }],
    });
    expect(blocks.map(b => b.kind)).toEqual(['paragraph', 'list', 'list', 'quote', 'rule']);
    const tasks = blocks[1];
    expect(tasks?.kind === 'list' && tasks.items.map(texts)).toEqual(['☑ done', '☐ todo']);
  });
  test('a quote nests at most three deep', () => {
    const deep = parseProse('> > > > > five');
    let depth = 0;
    let at: readonly Block[] = deep;
    while (at[0]?.kind === 'quote') {
      depth += 1;
      at = at[0].blocks;
    }
    expect(depth).toBeLessThanOrEqual(3);
  });
  test('a comment is removed; an unclosed one hides the rest, in one pass', () => {
    const texts = (blocks: readonly Block[]): string =>
      blocks.map(block => (block.kind === 'paragraph' ? JSON.stringify(block.inline) : block.kind)).join('|');
    expect(texts(parseProse('a<!-- x -->b<!-- y -->c'))).toContain('abc');
    expect(texts(parseProse('keep <!-- never closed\nhidden'))).toBe(texts(parseProse('keep ')));
  });
  test('an address past the bound stays text, not a link or an image', () => {
    const long = `https://example.com/${'a'.repeat(2100)}`;
    expect(inline(`[x](${long})`).every(node => node.kind === 'text')).toBe(true);
    expect(inline(`![x](${long})`).every(node => node.kind === 'text')).toBe(true);
    expect(inline(`<${long}>`).some(node => node.kind === 'link')).toBe(false);
  });
  test('indented continuation lines stay in their list item, in order', () => {
    const [list] = parseProse('- one\n  two\n  three **x**\n- next');
    expect(list?.kind === 'list' ? list.items.length : 0).toBe(2);
    expect(list?.kind === 'list' ? texts(list.items[0] ?? []) : '').toContain('one two three');
  });
  test('a table is shown as the text it was written as; strike and italic are read', () => {
    expect(parseProse('| a | b |\n|---|---|\n| 1 | 2 |')).toEqual([
      { kind: 'code', text: '| a | b |\n|---|---|\n| 1 | 2 |' },
    ]);
    expect(inline('~~gone~~ and *lean* and _lean_').map(node => node.kind)).toEqual([
      'strike',
      'text',
      'italic',
      'text',
      'italic',
    ]);
  });
  test('a hostile input is read, not run: it parses to plain text or code', () => {
    expect(() => parseProse(`${'*'.repeat(200)}\n${'[a](b'.repeat(50)}\n${'<!--'.repeat(50)}`)).not.toThrow();
    expect(parseProse('`'.repeat(100)).length).toBeGreaterThan(0);
  });
});
