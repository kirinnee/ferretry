import { describe, expect, test } from 'bun:test';
import { endHasLastWords, LAST_WORDS_CHARS, lastWordsOf } from '../../contract/index.ts';

describe('lastWordsOf', () => {
  test('keeps the last non-empty lines of a screen, trailing blanks and padding gone', () => {
    expect(lastWordsOf('a   \n\n\nb\n\n   \nc  \n\n\n')).toBe('a\nb\nc');
  });

  test('at most the last 8 lines', () => {
    const screen = Array.from({ length: 12 }, (_, at) => `line ${at + 1}`).join('\n');
    expect(lastWordsOf(screen)).toBe(Array.from({ length: 8 }, (_, at) => `line ${at + 5}`).join('\n'));
  });

  test('at most the last 600 characters, counted from the end', () => {
    const lines = lastWordsOf(`${'x'.repeat(500)}\n${'y'.repeat(500)}`);
    expect(lines?.length).toBeLessThanOrEqual(LAST_WORDS_CHARS);
    expect(lines?.endsWith('y'.repeat(500))).toBe(true);
  });

  test('a cut never splits a surrogate pair', () => {
    const words = lastWordsOf(`a${'😀'.repeat(700)}`) ?? '';
    expect(Array.from(words)).toHaveLength(LAST_WORDS_CHARS);
    expect(words).toBe('😀'.repeat(LAST_WORDS_CHARS));
    expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(words)).toBe(false);
  });

  test('a screen that shows nothing says nothing', () => {
    expect(lastWordsOf('\n  \n\n')).toBeUndefined();
  });
});

describe('endHasLastWords', () => {
  test('only an end nobody chose, other than a crashed terminal server, has a screen worth reading', () => {
    expect(endHasLastWords({ kind: 'signal', signal: 9 })).toBe(true);
    expect(endHasLastWords({ kind: 'agent_crashed', exitCode: 1 })).toBe(true);
    expect(endHasLastWords({ kind: 'clean_exit' })).toBe(true);
    expect(endHasLastWords({ kind: 'terminal_gone' })).toBe(true);
    for (const kind of ['tmux_crashed', 'stopped', 'completed', 'start_failed'] as const)
      expect(endHasLastWords({ kind })).toBe(false);
    expect(endHasLastWords(undefined)).toBe(false);
  });
});
