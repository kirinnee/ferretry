import { describe, expect, test } from 'bun:test';
import { spokenLines, splitVoice } from '../../contract/index.ts';

/** The `<voice>` grammar (`contract/voice-tag.ts`): what is a spoken line, and what is only text about one. */

const FENCE = '```';
const shape = (source: string): string[] =>
  splitVoice(source).map(piece =>
    piece.kind === 'text' ? `text:${piece.text.trim()}` : `${piece.open ? 'open' : 'voice'}:${piece.text}`,
  );

describe('a closed line', () => {
  test('is a spoken line between its text', () => {
    expect(shape('Checking.\n\n<voice>Let me check.</voice>\n\nDone.')).toEqual([
      'text:Checking.',
      'voice:Let me check.',
      'text:Done.',
    ]);
  });

  test('folds its white space and keeps only the words', () => {
    expect(shape('<voice>  two\n lines   here </voice>')).toEqual(['voice:two lines here']);
  });

  test('drops an empty line, tags and all', () => {
    expect(shape('a <voice> \n </voice> b')).toEqual(['text:a', 'text:b']);
  });

  test('keeps offsets of the source', () => {
    const source = 'ab <voice>hi</voice> cd';
    const [, line] = splitVoice(source);
    expect(line).toMatchObject({ kind: 'voice', start: 3, end: 20, contentStart: 10, open: false });
    expect(source.slice(10, 12)).toBe('hi');
  });

  test('is found by spokenLines, in order, closed only', () => {
    expect(spokenLines('<voice>one</voice> x <voice>two</voice> <voice>three').map(line => line.text)).toEqual([
      'one',
      'two',
    ]);
  });
});

describe('code is text, never a spoken line', () => {
  test.each([
    ['a fenced block', `${FENCE}\n<voice>no</voice>\n${FENCE}`],
    ['a tilde fence', '~~~md\n<voice>no</voice>\n~~~'],
    ['a fence never closed', `${FENCE}\n<voice>no</voice>`],
    ['an inline code span', 'write `<voice>no</voice>` to speak'],
    ['a double-backtick span', 'write ``<voice>no</voice>`` to speak'],
    ['an indented block', 'Example:\n\n    <voice>no</voice>\n'],
  ])('%s', (_name, source) => {
    expect(spokenLines(source)).toEqual([]);
    expect(splitVoice(source).every(piece => piece.kind === 'text')).toBe(true);
  });

  test('a line beside a fence is still a line', () => {
    const source = `${FENCE}\n<voice>no</voice>\n${FENCE}\n\n<voice>yes</voice>`;
    expect(spokenLines(source).map(line => line.text)).toEqual(['yes']);
  });

  test('a lone backtick does not hide a later line', () => {
    expect(spokenLines('it`s <voice>yes</voice>').map(line => line.text)).toEqual(['yes']);
  });
});

describe('what ends or breaks a line', () => {
  test('a blank line before the closing tag leaves the opener unclosed (text)', () => {
    expect(spokenLines('<voice>one\n\ntwo</voice>')).toEqual([]);
    expect(shape('<voice>one\n\ntwo</voice>')[0]).toContain('<voice>one');
  });

  test('a fence before the closing tag leaves the opener unclosed', () => {
    expect(spokenLines(`<voice>one\n${FENCE}\nx\n${FENCE}\n</voice>`)).toEqual([]);
  });

  test('nested openers are one line: the first closer ends it, inner openers go', () => {
    expect(shape('<voice>a <voice>b</voice> c</voice>')).toEqual(['voice:a b', 'text:c</voice>']);
  });

  test('a stray closing tag is text', () => {
    expect(shape('hello </voice> there')).toEqual(['text:hello </voice> there']);
  });

  test('an unclosed opener mid-message is text', () => {
    expect(spokenLines('<voice>one\n\nmore words')).toEqual([]);
    expect(splitVoice('<voice>one\n\nmore words').every(piece => piece.kind === 'text')).toBe(true);
  });

  test('an unclosed opener at the very end is an OPEN line, never a spoken one', () => {
    const pieces = splitVoice('Working.\n\n<voice>Let me chec');
    expect(pieces.at(-1)).toMatchObject({ kind: 'voice', open: true, text: 'Let me chec' });
    expect(spokenLines('Working.\n\n<voice>Let me chec')).toEqual([]);
  });

  test('a later unclosed opener leaves the earlier closed line alone', () => {
    expect(shape('<voice>done</voice>\n\n<voice>wor')).toEqual(['voice:done', 'open:wor']);
  });
});

describe('total and linear', () => {
  test.each([
    ['empty', ''],
    ['a lone tag', '<voice>'],
    ['a lone closer', '</voice>'],
    ['lone surrogates', '<voice>\ud800</voice>\udc00'],
    ['a non-string', undefined as unknown as string],
  ])('never throws on %s', (_name, source) => {
    expect(() => splitVoice(source)).not.toThrow();
  });

  test('returns the text untouched when there is no tag', () => {
    expect(splitVoice('just words')).toEqual([{ kind: 'text', text: 'just words', start: 0, end: 10 }]);
  });

  test.each([
    ['backticks', '`'.repeat(1_000)],
    ['alternating backtick runs', '`a``b```'.repeat(200)],
    ['open tags', '<voice>'.repeat(200)],
    ['closed lines', '<voice>x</voice>'.repeat(200)],
    ['open tags in code', '`<voice>`'.repeat(200)],
  ])('returns on %s', (_name, body) => {
    expect(() => splitVoice(`<voice>${body}`)).not.toThrow();
  });

  test('a long run of closed lines is that many lines', () => {
    expect(spokenLines('<voice>x</voice>'.repeat(200))).toHaveLength(200);
  });
});
