/**
 * S6 CFG-LEAK-R: the fail-closed NET under the read mask. Every raw flag secret the write rule (W, `findFlagSecrets`)
 * finds is cut by the mask; if the mask is ever made to MISS one (here: the cutter is replaced by one that cuts nothing),
 * the read still never shows it, because `shownConfigText` withholds a text whose masked value W still refuses.
 *
 * `mock.module` replaces a module for the whole bun process, and the unit tier runs every file in ONE process, so the
 * real exports are copied before anything is mocked and put back when this file is done: every file after it reads
 * the real cutter.
 *
 * Fake only: every value is shaped like a credential and is none.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test';
import * as realWords from '@ferretry/std/credential-words';
import { fileDef, flagForms, VALUE } from './masked-support.ts';

const SECRET_WORDS = '@ferretry/std/credential-words';
const real: object = { ...realWords };

mock.module(SECRET_WORDS, () => ({
  ...real,
  // A cutter that misses everything: the shape of "the mask was changed and no longer knows a name".
  shownWord: (word: string) => ({ text: word, hidden: false }),
  shownWords: (words: readonly string[]) => words.map(word => ({ text: word, hidden: false })),
  looksSecretShown: () => false,
}));

afterAll(() => {
  mock.module(SECRET_WORDS, () => real);
});

const { shownConfigText } = await import('../../../host/config/shown-text.ts');

const listOf = (words: readonly string[]): string =>
  `args:\n${words.map(word => `  - ${JSON.stringify(word)}\n`).join('')}`;

describe('the net under the mask', () => {
  test('S6 CFG-LEAK-R a text the mask missed, that W still calls a raw flag secret, is withheld whole: unmaskable', () => {
    for (const name of ['token', 'ssh-key', 'tokens']) {
      for (const words of flagForms(name, VALUE)) {
        const result = shownConfigText(fileDef, 'servers.yaml', listOf(words), 'fy');
        expect([words, result]).toEqual([words, { kind: 'withheld', reason: 'unmaskable' }]);
      }
    }
  });

  test('S6 CFG-LEAK-R a text W finds nothing in is shown as written, whatever the mask does', () => {
    const text = listOf(['--verbose', '--token', '${secret:GH_TOKEN}']);
    expect(shownConfigText(fileDef, 'servers.yaml', text, 'fy')).toEqual({ kind: 'shown', text, hidden: [] });
  });
});
