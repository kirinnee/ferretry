import { describe, expect, test } from 'bun:test';
import {
  applyFormat,
  formatShortcut,
  inlineRuns,
  parseLiveMarkdown,
  removeBlockMarker,
  toggleBlock,
  wrapCodeBlock,
} from '../../src/lib/live-markdown.ts';

const DRAFT = [
  '# Title',
  '## Sub',
  '#### Deep',
  'Some **bold**, *it*, `code`, ~~gone~~ and [a link](https://x.test).',
  '- bullet',
  '  * nested',
  '3. third',
  '- [x] done',
  '[ ] todo',
  '> quoted',
  '---',
  '```ts',
  'const a = 1;',
  '~~~',
  '```',
  'after',
].join('\n');

describe('parseLiveMarkdown', () => {
  test('is lossless: the lines and their pieces put the draft back together exactly', () => {
    const lines = parseLiveMarkdown(DRAFT);
    expect(lines.map(line => line.text).join('\n')).toBe(DRAFT);
    for (const line of lines) {
      expect(line.indent + line.marker + line.runs.map(run => run.text).join('')).toBe(line.text);
      expect(DRAFT.slice(line.start, line.start + line.text.length)).toBe(line.text);
      for (const run of line.runs) expect(DRAFT.slice(run.start, run.start + run.text.length)).toBe(run.text);
    }
  });

  test('reads every block kind, with its marker', () => {
    const lines = parseLiveMarkdown(DRAFT);
    expect(lines.map(line => [line.kind, line.marker])).toEqual([
      ['h1', '# '],
      ['h2', '## '],
      ['h3', '#### '],
      ['p', ''],
      ['bullet', '- '],
      ['bullet', '* '],
      ['ordered', '3. '],
      ['check', '- [x] '],
      ['check', '[ ] '],
      ['quote', '> '],
      ['hr', ''],
      ['fence', ''],
      ['code', ''],
      ['code', ''],
      ['fence', ''],
      ['p', ''],
    ]);
    expect(lines[5]?.indent).toBe('  ');
    expect(lines[7]?.checked).toBe(true);
    expect(lines[8]?.checked).toBe(false);
  });

  test('keeps a blank line inside a fence as code with nothing to show', () => {
    const lines = parseLiveMarkdown('```\n\ncode\n```');
    expect(lines.map(line => [line.kind, line.text])).toEqual([
      ['fence', '```'],
      ['code', ''],
      ['code', 'code'],
      ['fence', '```'],
    ]);
    expect(lines[1]?.runs).toEqual([]);
    expect(lines[2]?.runs.map(run => run.text)).toEqual(['code']);
  });

  test('makes code of everything after an unclosed fence', () => {
    expect(parseLiveMarkdown('```\n# not a heading').map(line => line.kind)).toEqual(['fence', 'code']);
  });
});

describe('inlineRuns', () => {
  test('marks every construct, its syntax apart from its words', () => {
    const runs = inlineRuns('**b** *i* `c` ~~s~~ __u__ [t](u)', 0);
    expect(runs.filter(run => run.style !== null).map(run => [run.style, run.mark, run.text])).toEqual([
      ['strong', true, '**'],
      ['strong', false, 'b'],
      ['strong', true, '**'],
      ['em', true, '*'],
      ['em', false, 'i'],
      ['em', true, '*'],
      ['code', true, '`'],
      ['code', false, 'c'],
      ['code', true, '`'],
      ['strike', true, '~~'],
      ['strike', false, 's'],
      ['strike', true, '~~'],
      ['strong', true, '__'],
      ['strong', false, 'u'],
      ['strong', true, '__'],
      ['link', true, '['],
      ['link', false, 't'],
      ['url', true, '](u)'],
    ]);
    expect(runs[0]).toMatchObject({ token: 0, tokenStart: 0, tokenEnd: 5 });
  });

  test('reads a code span first, so nothing inside it is emphasis, and leaves a lone star as text', () => {
    expect(inlineRuns('`**x**`', 0).map(run => run.style)).toEqual(['code', 'code', 'code']);
    expect(inlineRuns('2 * 3', 0).map(run => run.style)).toEqual([null]);
  });

  test('splits references out of plain text, offset into the draft', () => {
    const runs = inlineRuns('see @src/app.ts now', 10);
    expect(runs.map(run => [run.style, run.text, run.start])).toEqual([
      [null, 'see ', 10],
      ['reference', '@src/app.ts', 14],
      [null, ' now', 25],
    ]);
  });
});

describe('toggleBlock', () => {
  test('turns lines into a block, replacing any marker rather than stacking it, and keeps the caret in the words', () => {
    expect(toggleBlock('# one\ntwo', 7, 7, 'bullet')).toEqual({ value: '# one\n- two', caret: 9 });
    expect(toggleBlock('# one\ntwo', 0, 9, 'ordered')).toEqual({ value: '1. one\n2. two', caret: 3 });
    expect(toggleBlock('one', 2, 2, 'h2')).toEqual({ value: '## one', caret: 5 });
    expect(toggleBlock('one', 0, 0, 'check')).toEqual({ value: '- [ ] one', caret: 6 });
    expect(toggleBlock('one', 0, 0, 'quote')).toEqual({ value: '> one', caret: 2 });
  });

  test('turns the lines back into paragraphs when every one already is that block', () => {
    expect(toggleBlock('- a\n- b', 0, 7, 'bullet')).toEqual({ value: 'a\nb', caret: 0 });
    expect(toggleBlock('# a', 3, 3, 'h1')).toEqual({ value: 'a', caret: 1 });
  });

  test('reads a code line whole rather than as a marker', () => {
    expect(toggleBlock('```\n- x', 4, 4, 'h1')).toEqual({ value: '```\n# - x', caret: 6 });
  });
});

describe('wrapCodeBlock', () => {
  test('fences the lines the selection touches, with the caret at the end of the code', () => {
    expect(wrapCodeBlock('a\nb\nc', 2, 3)).toEqual({ value: 'a\n```\nb\n```\nc', caret: 7 });
    expect(wrapCodeBlock('', 0, 0)).toEqual({ value: '```\n\n```', caret: 4 });
  });
});

describe('removeBlockMarker', () => {
  test('at the start of a block’s words takes the whole marker off; anywhere else it is not its key', () => {
    expect(removeBlockMarker('x\n## Title', 5)).toEqual({ value: 'x\nTitle', caret: 2 });
    expect(removeBlockMarker('  - item', 4)).toEqual({ value: 'item', caret: 0 });
    expect(removeBlockMarker('## Title', 4)).toBeNull();
    expect(removeBlockMarker('plain', 0)).toBeNull();
  });
});

describe('formatShortcut and applyFormat', () => {
  const key = (init: Partial<Parameters<typeof formatShortcut>[0]> & { readonly key: string }) =>
    formatShortcut({ shiftKey: false, altKey: false, ...init });

  test('maps each documented shortcut, and nothing else', () => {
    expect(key({ key: 'B' })).toEqual({ kind: 'wrap', marker: '**' });
    expect(key({ key: 'i' })).toEqual({ kind: 'wrap', marker: '*' });
    expect(key({ key: 'e' })).toEqual({ kind: 'wrap', marker: '`' });
    expect(key({ key: 'X', shiftKey: true })).toEqual({ kind: 'wrap', marker: '~~' });
    expect(key({ key: '&', code: 'Digit7', shiftKey: true })).toEqual({ kind: 'block', target: 'ordered' });
    expect(key({ key: '*', code: 'Digit8', shiftKey: true })).toEqual({ kind: 'block', target: 'bullet' });
    expect(key({ key: '(', code: 'Digit9', shiftKey: true })).toEqual({ kind: 'block', target: 'quote' });
    expect(key({ key: '™', code: 'Digit2', altKey: true })).toEqual({ kind: 'block', target: 'h2' });
    expect(key({ key: 'ç', code: 'KeyC', altKey: true })).toEqual({ kind: 'codeBlock' });
    expect(key({ key: 'k' })).toBeNull();
    expect(key({ key: '!', shiftKey: true })).toBeNull();
    expect(key({ key: 'x', altKey: true })).toBeNull();
    expect(key({ key: 'x', shiftKey: true, altKey: true })).toBeNull();
  });

  test('applies each kind of command to the draft', () => {
    expect(applyFormat('ab', 0, 2, { kind: 'wrap', marker: '**' })).toEqual({ value: '**ab**', caret: 6 });
    expect(applyFormat('ab', 0, 0, { kind: 'block', target: 'h1' })).toEqual({ value: '# ab', caret: 2 });
    expect(applyFormat('ab', 0, 0, { kind: 'codeBlock' })).toEqual({ value: '```\nab\n```', caret: 6 });
  });
});
