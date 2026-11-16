import { describe, expect, test } from 'bun:test';
import { matchLine } from '../../../daemon/search/lib/text.ts';

describe('matchLine', () => {
  test('returns the first line that holds a word beginning with one of the tokens', () => {
    expect(matchLine('nothing here\n  the relay carrier  \nrelay again', ['relay'])).toBe('the relay carrier');
    expect(matchLine('nothing here', ['relay'])).toBeUndefined();
  });

  test('cuts a long line around the word, marking each side it cut', () => {
    const filler = 'lorem ipsum '.repeat(30);
    const middle = matchLine(`${filler}relay${filler}`, ['relay']) ?? '';
    expect(middle.startsWith('…')).toBe(true);
    expect(middle.endsWith('…')).toBe(true);
    expect(middle).toContain('relay');

    const head = matchLine(`relay ${filler}`, ['relay']) ?? '';
    expect(head.startsWith('…')).toBe(false);
    expect(head.endsWith('…')).toBe(true);

    const tail = matchLine(`${filler}relay`, ['relay']) ?? '';
    expect(tail.startsWith('…')).toBe(true);
    expect(tail.endsWith('…')).toBe(false);
  });
});
