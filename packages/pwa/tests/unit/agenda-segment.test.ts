import { describe, expect, test } from 'bun:test';
import { segmentMarkdown } from '../../src/lib/agenda-segment.ts';

describe('segmentMarkdown', () => {
  test('keeps a line the ferret broke: a hard break ends every line that another line follows', () => {
    expect(segmentMarkdown('Yes, by design.\nOne plan.\nOne model.')).toBe(
      'Yes, by design.  \nOne plan.  \nOne model.',
    );
  });

  test('leaves a single line, blank lines and a lone paragraph untouched', () => {
    expect(segmentMarkdown('One line.')).toBe('One line.');
    expect(segmentMarkdown('First.\n\nSecond.')).toBe('First.\n\nSecond.');
  });

  test('a bold lead above bullets stays a lead above a list, with no break forced before the list', () => {
    expect(segmentMarkdown('**Yes, by design.**\n- one plan\n- one model')).toBe(
      '**Yes, by design.**\n- one plan\n- one model',
    );
  });

  test('turns • into a bullet Markdown knows, in a mix as well', () => {
    expect(segmentMarkdown('Lead\n• one\n  • nested')).toBe('Lead\n- one\n  - nested');
  });

  test('never touches numbered lists, headings, tables, quotes or fenced code', () => {
    const text = '1. first\n2. second\n\n# Title\n| a | b |\n| - | - |\n> quoted\n```\nline one\nline two\n```';
    expect(segmentMarkdown(text)).toBe(text);
  });

  test('does not double a break that is already there', () => {
    expect(segmentMarkdown('a  \nb\\\nc')).toBe('a  \nb\\\nc');
  });

  test('is idempotent', () => {
    const once = segmentMarkdown('Lead\nmore\n• one\n• two');
    expect(segmentMarkdown(once)).toBe(once);
  });
});

describe('segmentMarkdown, a label directly above a numbered list', () => {
  test('gives a list that starts at 4 the blank line Markdown needs, and nothing more', () => {
    expect(segmentMarkdown('2FA codes\n4. Run it\n5. Enter it')).toBe('2FA codes\n\n4. Run it\n5. Enter it');
    expect(segmentMarkdown('2FA codes\n4) Run it')).toBe('2FA codes\n\n4) Run it');
  });

  test('leaves a list that starts at 1, a bullet list, and a list after a blank line, a heading or a table as written', () => {
    expect(segmentMarkdown('Label\n1. one')).toBe('Label\n1. one');
    expect(segmentMarkdown('Label\n- one')).toBe('Label\n- one');
    expect(segmentMarkdown('Label\n\n4. four')).toBe('Label\n\n4. four');
    expect(segmentMarkdown('## Heading\n4. four')).toBe('## Heading\n4. four');
    expect(segmentMarkdown('| a |\n4. four')).toBe('| a |\n4. four');
  });

  test('does not split a list: a later item, its continuation and a lazy line stay together', () => {
    expect(segmentMarkdown('3. three\n4. four')).toBe('3. three\n4. four');
    expect(segmentMarkdown('1. one\n   more\n4. four')).toBe('1. one  \n   more\n4. four');
    expect(segmentMarkdown('1. one\nlazy\n4. four')).toBe('1. one  \nlazy\n4. four');
    expect(segmentMarkdown('1. one\n\n   second paragraph\n4. four')).toBe('1. one\n\n   second paragraph\n4. four');
  });

  test('starts a new label after a list that ended with a blank line', () => {
    expect(segmentMarkdown('1. one\n\nNext label\n4. four')).toBe('1. one\n\nNext label\n\n4. four');
  });

  test('separates a quote from a list that starts at 4, but never touches fenced code', () => {
    expect(segmentMarkdown('> quoted\n4. four')).toBe('> quoted\n\n4. four');
    const fence = '`'.repeat(3);
    const code = `${fence}\ntext\n4. four\n${fence}`;
    expect(segmentMarkdown(code)).toBe(code);
    expect(segmentMarkdown(`${code}\n4. four`)).toBe(`${code}\n4. four`);
  });

  test('keeps a step’s own lines as lines under the label', () => {
    expect(segmentMarkdown('2FA codes\n4. Run it\ncarry on\n5. Done')).toBe(
      '2FA codes\n\n4. Run it  \ncarry on\n5. Done',
    );
  });
});
