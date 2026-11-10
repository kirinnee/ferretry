/**
 * CFG-LEAK-R: the one word cutter, on the hard cases its header names — a quoted value that holds the
 * separator, a pointer beside a secret on either side, base64 padding, a user password inside a secret-named value, a
 * flag whose value has a pointer in it. Each case is one command-line word (or a flag and its value), and what a
 * person must see of it: the key, the flag and the pointer stay, the value goes.
 *
 * The whole generated family is held by `credential-words-corpus.test.ts`; these cases hold the cutter's own branches.
 *
 * Fake only: every value is shaped like a credential and is none.
 */
import { describe, expect, test } from 'bun:test';
import { HIDDEN_VALUE_TEXT, shownWord, shownWords } from '../../src/credential-words/index.ts';

/** A fake credential-shaped value (no real secret scanner hit). */
const VALUE = 'Zk3pQ9vXw2LmN7rT';

const POINTER = '${secret:X}';

const shown = (...words: readonly string[]): readonly string[] => shownWords(words).map(word => word.text);

describe('CFG-LEAK-R the cutter, case by case', () => {
  const HIDE: readonly (readonly [label: string, words: readonly string[], seen: readonly string[]])[] = [
    ['a quoted value that holds the separator', [`API_KEY="${VALUE},${VALUE}"`], [`API_KEY=${HIDDEN_VALUE_TEXT}`]],
    ['a single-quoted value after a part', [`API_KEY=a:'${VALUE},x'`], [`API_KEY=${HIDDEN_VALUE_TEXT}`]],
    ['a quote that never closes', [`API_KEY="${VALUE}`], [`API_KEY=${HIDDEN_VALUE_TEXT}`]],
    ['a secret, then a pointer', [`API_KEY=${VALUE} ${POINTER}`], [`API_KEY=${HIDDEN_VALUE_TEXT}`]],
    ['a pointer, then padded base64', [`API_KEY=${POINTER} ${VALUE}==`], [`API_KEY=${HIDDEN_VALUE_TEXT}`]],
    [
      'a pointer, then another key whose value is the secret',
      [`API_KEY=${POINTER} API_KEY=${VALUE}`],
      [`API_KEY=${POINTER} API_KEY=${HIDDEN_VALUE_TEXT}`],
    ],
    [
      'two keys that share one value',
      [`API_KEY=${VALUE} ${POINTER} API_KEY=${VALUE}`],
      [`API_KEY=${HIDDEN_VALUE_TEXT} API_KEY=${HIDDEN_VALUE_TEXT}`],
    ],
    [
      'a scheme and padded base64 before a pointer',
      [`Authorization: Basic ${VALUE}== X=${POINTER}`],
      [`Authorization: ${HIDDEN_VALUE_TEXT} X=${POINTER}`],
    ],
    [
      'user:password before a pointer',
      [`Authorization: user:${VALUE} ${POINTER}`],
      [`Authorization: ${HIDDEN_VALUE_TEXT} ${POINTER}`],
    ],
    [
      // Changed by CFG-LEAK-R (ii): text glued to a pointer cuts the whole value, the glued query included.
      'a pointer, then a query parameter with the secret: the glued text is cut with it',
      [`PASSWORD=${POINTER}?password:${VALUE}`],
      [`PASSWORD=${HIDDEN_VALUE_TEXT}`],
    ],
    [
      'a variable reference that runs on into other characters',
      ['API_KEY=$FOO-bar-baz-qux ${secret:X}'],
      [`API_KEY=${HIDDEN_VALUE_TEXT}`],
    ],
    [
      'an unclosed brace reference beside a pointer',
      ['API_KEY=${FOO_BAR ${secret:X}'],
      [`API_KEY=${HIDDEN_VALUE_TEXT}`],
    ],
    ['a scheme with a fragment pointer', [`password=Basic ${VALUE}#${POINTER}`], [`password=${HIDDEN_VALUE_TEXT}`]],
    [
      'a user password and a query parameter in one URL',
      [`https://u:${VALUE}@h.example/?token=${VALUE}x`],
      [`https://u:${HIDDEN_VALUE_TEXT}@h.example/?token=${HIDDEN_VALUE_TEXT}`],
    ],
    [
      'a raw @ inside a URL password',
      ['https://u:p@ss@h.example/path'],
      [`https://u:${HIDDEN_VALUE_TEXT}@h.example/path`],
    ],
    [
      'a URL password beside a pointer',
      [`API_KEY=${POINTER} https://u:${VALUE}@h.example/p`],
      [`API_KEY=${POINTER} https://u:${HIDDEN_VALUE_TEXT}@h.example/p`],
    ],
    [
      'a URL as the value of a secret key',
      [`PASSWORD=https://u:${VALUE}@h.example/p`],
      [`PASSWORD=${HIDDEN_VALUE_TEXT}`],
    ],
    ['a flag then a secret and a pointer', ['--token', `${VALUE} ${POINTER}`], ['--token', HIDDEN_VALUE_TEXT]],
    ['a flag then a pointer and a secret', ['--token', `${POINTER} ${VALUE}`], ['--token', HIDDEN_VALUE_TEXT]],
    [
      'a flag then a scheme and a fragment pointer',
      ['--password', `Basic ${VALUE}#${POINTER}`],
      ['--password', HIDDEN_VALUE_TEXT],
    ],
    ['a key in a glued flag’s own part', [`--hdr,api_key:${VALUE} more`], [`--hdr,api_key:${HIDDEN_VALUE_TEXT}`]],
    [
      'keys stuck to a one-letter flag',
      [`-cAPI_KEY:${VALUE},PASSWORD=${VALUE}x`],
      [`-cAPI_KEY:${HIDDEN_VALUE_TEXT},PASSWORD=${HIDDEN_VALUE_TEXT}`],
    ],
  ];

  for (const [label, words, seen] of HIDE) {
    test(`CFG-LEAK-R ${label}: the value is cut, the key, the flag and the pointer stay`, () => {
      const out = shown(...words);
      expect(out).toEqual(seen);
      expect(out.join(' ')).not.toContain(VALUE);
    });
  }

  test('CFG-LEAK-R a variable reference or a braced one beside a pointer is no secret, and is shown', () => {
    expect(shown('API_KEY=$FOO_BAR_BAZ ${secret:X}', 'API_KEY=${FOO_BAR_BAZ} ${secret:X}')).toEqual([
      'API_KEY=$FOO_BAR_BAZ ${secret:X}',
      'API_KEY=${FOO_BAR_BAZ} ${secret:X}',
    ]);
  });

  test('CFG-LEAK-R a word that points elsewhere, or is too short to be a secret, is shown as it is', () => {
    expect(shown(`API_KEY=${POINTER}`, 'API_KEY=$HOME_KEY', 'API_KEY=${HOME_KEY}', 'AUTH=1', 'password=short')).toEqual(
      [`API_KEY=${POINTER}`, 'API_KEY=$HOME_KEY', 'API_KEY=${HOME_KEY}', 'AUTH=1', 'password=short'],
    );
  });

  test('CFG-LEAK-R a token in a secret-named flag’s own part is cut with the word, not shown beside the cut value', () => {
    expect(shown(`--verbose;AKIAABCDEFGHIJKLMNOP,tokens ${VALUE}`, `--x;ghp_AbCdEfGh12345678,token=${VALUE}`)).toEqual([
      HIDDEN_VALUE_TEXT,
      HIDDEN_VALUE_TEXT,
    ]);
  });

  test('CFG-LEAK-R a word reports whether it was cut', () => {
    expect(shownWord(`--token=${VALUE}`, undefined)).toEqual({ text: `--token=${HIDDEN_VALUE_TEXT}`, hidden: true });
    expect(shownWord('--verbose', undefined)).toEqual({ text: '--verbose', hidden: false });
    expect(shownWords(['--token', VALUE]).map(word => word.hidden)).toEqual([false, true]);
    // `first` is the word before the first: a command's own flag.
    expect(shownWords([VALUE], '--token').map(word => word.hidden)).toEqual([true]);
    expect(shownWords([VALUE]).map(word => word.hidden)).toEqual([false]);
  });
});
