import { describe, expect, test } from 'bun:test';
import { plainPreview } from '../../src/lib/plain-label.ts';

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
