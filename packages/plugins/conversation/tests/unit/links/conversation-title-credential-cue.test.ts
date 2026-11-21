import { describe, expect, test } from 'bun:test';
import {
  cleanTitle,
  deriveTitle,
  fileTitle,
  hasCredentialCue,
  type ScrubText,
  UNTITLED_TITLE,
} from '../../../daemon/links/lib/conversation-title.ts';

/**
 * FAIL CLOSED (review 2289, recheck R2): a text that names a credential makes NO heuristic title, however the value is spelled
 * (compact JSON, glued multiword `token=`, after `is:`, across a line, after a word already recognised as a credential). The
 * words after a cue cannot be told from the secret, so none is used; masking stays as the second layer.
 *
 * Every secret below is FAKE (nonsense words that appear nowhere else in these texts).
 */

const NO_VAULT: ScrubText = text => text;

/** [message, every word of the secret in it]. */
const CASES: readonly (readonly [string, readonly string[]])[] = [
  ['{"password":"Horse Battery Staple"}', ['horse', 'battery', 'staple']],
  ['{"passphrase": "velvet thunder lantern"}', ['velvet', 'thunder', 'lantern']],
  ['Log in with {"password":"velvet thunder lantern","user":"kim"}', ['velvet', 'thunder', 'lantern']],
  ['token=velvet thunder lantern', ['velvet', 'thunder', 'lantern']],
  ['Deploy the app with TOKEN=velvet thunder lantern please', ['velvet', 'thunder', 'lantern']],
  ['password is: velvet thunder lantern', ['velvet', 'thunder', 'lantern']],
  ['the passphrase is: velvet thunder lantern', ['velvet', 'thunder', 'lantern']],
  ['password:\nvelvet thunder lantern', ['velvet', 'thunder', 'lantern']],
  ['Fix the login\npassword is\nvelvet thunder lantern', ['velvet', 'thunder', 'lantern']],
  [`password: ${'ghp_'}aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0dF3hJ6 velvet thunder lantern`, ['velvet', 'thunder', 'lantern']],
  ['password: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0 velvet thunder lantern', ['velvet', 'thunder', 'lantern']],
  ['my API key is velvet thunder lantern', ['velvet', 'thunder', 'lantern']],
  ['api_key = velvet thunder lantern', ['velvet', 'thunder', 'lantern']],
  ['apikey: velvet thunder lantern', ['velvet', 'thunder', 'lantern']],
  ['Authorization: Bearer velvet thunder lantern', ['velvet', 'thunder', 'lantern']],
  ['the secret is velvet thunder lantern', ['velvet', 'thunder', 'lantern']],
  ['private key: velvet thunder lantern', ['velvet', 'thunder', 'lantern']],
  ['credentials: velvet thunder lantern', ['velvet', 'thunder', 'lantern']],
  ['PASSWORD IS VELVET THUNDER LANTERN', ['velvet', 'thunder', 'lantern']],
  ['“password” — velvet thunder lantern', ['velvet', 'thunder', 'lantern']],
  ['pass​word is velvet thunder lantern', ['velvet', 'thunder', 'lantern']],
  ['passcode 4817 2951 6603', ['4817', '2951', '6603']],
  [
    'Please deploy the app. The passphrase is velvet thunder lantern. Then run the tests.',
    ['velvet', 'thunder', 'lantern'],
  ],
  ['(token: velvet thunder lantern)', ['velvet', 'thunder', 'lantern']],
  ['export DB_PASSWORD=velvet thunder lantern && deploy', ['velvet', 'thunder', 'lantern']],
  ['Fix login, the passphrase is velvet thunder lantern', ['velvet', 'thunder', 'lantern']],
];

describe('a text that names a credential makes no heuristic title', () => {
  for (const [text, words] of CASES) {
    test(`“${text.replaceAll('\n', '⏎').slice(0, 60)}” leaves no word of its secret in any title`, () => {
      expect(hasCredentialCue(text)).toBe(true);
      expect(deriveTitle(text, NO_VAULT)).toBeUndefined();
      expect(cleanTitle(text, NO_VAULT)).toBeUndefined();
      // Stored: a message that names a credential is titled by the plain fallback, a CLI name that does is dropped.
      const stored = [
        fileTitle({ firstMessage: text }, NO_VAULT),
        fileTitle({ name: text }, NO_VAULT),
        fileTitle({ name: text, firstMessage: text }, NO_VAULT),
      ];
      expect(stored).toEqual([UNTITLED_TITLE, null, UNTITLED_TITLE]);
      for (const title of stored)
        for (const word of words) expect((title ?? '').toLowerCase()).not.toContain(word.toLowerCase());
    });
  }

  test('a cue is found in any case, inside any quoting, and past invisible characters', () => {
    for (const text of ['Passphrase', '"TOKEN"', "'api-key'", 'pass_word', 'pa​ssword', 'ＰＡＳＳＷＯＲＤ'])
      expect(hasCredentialCue(text)).toBe(true);
  });

  test('a text with no cue still makes its title', () => {
    expect(hasCredentialCue('Fix the flaky login test')).toBe(false);
    expect(deriveTitle('Fix the flaky login test in packages/auth', NO_VAULT)).toBe('Fix the Flaky Login Test');
    expect(cleanTitle('Plan the release', NO_VAULT)).toBe('Plan the release');
  });

  test('a name with a cue yields to the first message when that holds none', () => {
    expect(
      fileTitle({ name: 'token=velvet thunder lantern', firstMessage: 'Fix the flaky login test' }, NO_VAULT),
    ).toBe('Fix the Flaky Login Test');
  });
});
