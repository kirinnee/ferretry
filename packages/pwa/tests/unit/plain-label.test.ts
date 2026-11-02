import { describe, expect, test } from 'bun:test';
import { plainLabel, plainPreview } from '../../src/lib/plain-label.ts';

describe('plainLabel', () => {
  test.each([
    ['**Send now**', 'Send now'],
    ['A **Send now**', 'A Send now'],
    ['B **Wait**', 'B Wait'],
    ['__Wait__', 'Wait'],
    ['*Later*', 'Later'],
    ['_Later_', 'Later'],
    ['`ci` rename', 'ci rename'],
    ['[Spec](https://example.test/spec)', 'Spec'],
    ['~~Old~~ New', 'Old New'],
    ['**Keep** the *old* name', 'Keep the old name'],
  ])('%s reads as %s', (marked, plain) => {
    expect(plainLabel(marked)).toBe(plain);
  });

  test.each(['Send now', 'snake_case_name', '2 * 3', 'Yes', 'Rename to build'])('leaves %s alone', words => {
    expect(plainLabel(words)).toBe(words);
  });

  test.each([
    ['A **Send now**', 'A', 'Send now'],
    ['B **Wait**', 'B', 'Wait'],
    ['B Wait', 'B', 'Wait'],
    ['A: Send now', 'A', 'Send now'],
    ['A. Send now', 'A', 'Send now'],
    ['C) Keep both', 'C', 'Keep both'],
    ['**A** Send now', 'A', 'Send now'],
    ['A - Send now', 'A', 'Send now'],
  ])('%s drops its own letter %s: %s', (marked, letter, plain) => {
    expect(plainLabel(marked, letter)).toBe(plain);
  });

  test.each([
    ['A new approach', 'A'],
    ['A', 'A'],
    ['B Wait', 'A'],
    ['Apples', 'A'],
    ['A2 plan', 'A'],
    ['Send now', 'A'],
  ])('keeps %s as its own words under letter %s', (words, letter) => {
    expect(plainLabel(words, letter)).toBe(words);
  });

  test('never turns a label into nothing', () => {
    expect(plainLabel('****')).toBe('****');
  });
});

describe('plainPreview', () => {
  test('flattens a Markdown summary to one line: heading, list markers, quote bars, emphasis, code, links', () => {
    const text = '## Setup\n- **Open** `fy` → see [docs](https://x.test)\n4. Run it\n> quoted\n\nlast';
    expect(plainPreview(text)).toBe('Setup Open fy → see docs Run it quoted last');
  });

  test('leaves out the fences of a code block but keeps its words, and a table rule line', () => {
    const fence = '`'.repeat(3);
    expect(plainPreview(`before\n${fence}ts\n  const a = 1;\n${fence}\n| a | b |\n| - | - |\n| 1 | 2 |`)).toBe(
      'before const a = 1; a b 1 2',
    );
  });

  test('is empty for empty text, and keeps a lone pipe or dash line that is not a rule', () => {
    expect(plainPreview('')).toBe('');
    expect(plainPreview('  \n ')).toBe('');
    expect(plainPreview('a - b')).toBe('a - b');
    expect(plainPreview('-')).toBe('-');
  });
});
