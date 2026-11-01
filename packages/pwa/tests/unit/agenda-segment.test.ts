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
