import { describe, expect, it } from 'bun:test';
import { cleanText, MAX_QUOTE_CHARS, quoteOf, whereText, withQuote } from '../../../app/features/compose/quote.ts';

describe('cleanText', () => {
  it('takes out bidirectional controls, zero-width characters and control characters, and keeps line breaks and tabs', () => {
    expect(cleanText('a‮b⁦c​d\u0000e\u001Bf\tg\r\nh')).toBe('abcdef\tg\nh');
  });
});

describe('quoteOf', () => {
  it('puts every line behind "> " and keeps blank lines in the quote', () => {
    expect(quoteOf('one\n\ntwo')).toBe('> one\n>\n> two');
  });

  it('is empty for a blank selection', () => {
    expect(quoteOf(' \n\t ')).toBe('');
  });

  it('heads a diff selection with its file and lines, on the side it is', () => {
    expect(quoteOf('x', { path: 'src/a.ts', side: 'right', startLine: 10, line: 12 })).toBe(
      '> `src/a.ts:10-12`\n>\n> x',
    );
    expect(quoteOf('x', { path: 'src/a.ts', side: 'left', startLine: 4, line: 4 })).toBe(
      '> `src/a.ts:4 (old side)`\n>\n> x',
    );
  });

  it('cleans the path too: no backtick can end the code span, no bidi control can reorder it', () => {
    const where = whereText({ path: 'src/`x`‮.ts\n', side: 'right', startLine: 1, line: 1 });
    expect(where).toBe("src/'x'.ts:1");
    expect(quoteOf('x', { path: 'a`b', side: 'right', startLine: 1, line: 1 })).toContain("`a'b:1`");
  });

  it('cuts a very long selection and says so, and never leaves half of a character', () => {
    const text = `${'a'.repeat(MAX_QUOTE_CHARS - 1)}😀${'b'.repeat(100)}`;
    const quote = quoteOf(text);
    expect(quote).toContain('…(quote shortened)');
    expect(quote).not.toMatch(/[\ud800-\udbff]\n/u);
    expect(quote.length).toBeLessThan(MAX_QUOTE_CHARS + 60);
    // A selection of a whole huge page is never read whole.
    expect(quoteOf('z'.repeat(5_000_000)).length).toBeLessThan(MAX_QUOTE_CHARS + 60);
  });

  it('cleans the quoted words themselves', () => {
    expect(quoteOf('ok‮ evil')).toBe('> ok evil');
  });
});

describe('withQuote', () => {
  it('adds a quote after what is written, with a blank line between, and leaves room to type', () => {
    expect(withQuote('', '> a')).toBe('> a\n\n');
    expect(withQuote('hello  \n', '> a')).toBe('hello\n\n> a\n\n');
    expect(withQuote('keep', '')).toBe('keep');
  });
});
