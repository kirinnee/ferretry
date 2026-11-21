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
    for (const text of [
      'Passphrase: x',
      '"TOKEN": "x"',
      "'token': 'x'",
      "'api-key' = x",
      'pass_word=x',
      'pa​ssword is x',
      'ＰＡＳＳＷＯＲＤ=x',
      'token => x',
      'token -> x',
      'the secret was x',
      'rotate it to the new secret to x',
    ])
      expect(hasCredentialCue(text)).toBe(true);
  });

  test('a text with no cue still makes its title', () => {
    expect(hasCredentialCue('Fix the flaky login test')).toBe(false);
    expect(deriveTitle('Fix the flaky login test in packages/auth', NO_VAULT)).toBe('Fix the Flaky Login Test');
    expect(cleanTitle('Plan the release', NO_VAULT)).toBe('Plan the release');
  });

  // A bare mention is a topic, not a cue (review 2289, lead decision R3): dev titles name tokens and passwords all the time.
  const MENTIONS: readonly (readonly [message: string, title: string])[] = [
    ['Fix token refresh', 'Fix Token Refresh'],
    ['Rotate the API secret', 'Rotate the API Secret'],
    ['password reset flow', 'Password Reset Flow'],
  ];

  for (const [text, title] of MENTIONS) {
    test(`“${text}” is a topic: it keeps its title on every path`, () => {
      expect(hasCredentialCue(text)).toBe(false);
      expect(deriveTitle(text, NO_VAULT)).toBe(title);
      expect(cleanTitle(text, NO_VAULT)).toBe(text);
      expect(fileTitle({ name: text }, NO_VAULT)).toBe(text);
      expect(fileTitle({ firstMessage: text }, NO_VAULT)).toBe(title);
    });
  }

  // An owner's own name (`/rename`) is the owner's data: the caller says so, and it never goes through the cue filter.
  test('an owner /rename keeps its words verbatim, a generated title with the same words is dropped', () => {
    const value = 'token: velvet thunder lantern';
    expect(cleanTitle('Fix token refresh', NO_VAULT, 'owner')).toBe('Fix token refresh');
    expect(fileTitle({ name: 'Fix token refresh', nameBy: 'owner' }, NO_VAULT)).toBe('Fix token refresh');
    expect(fileTitle({ name: 'Rotate the API secret', nameBy: 'owner' }, NO_VAULT)).toBe('Rotate the API secret');
    // The same cue-shaped words from the CLI (or with no author said) are dropped.
    expect(cleanTitle(value, NO_VAULT, 'generated')).toBeUndefined();
    expect(cleanTitle(value, NO_VAULT)).toBeUndefined();
    expect(fileTitle({ name: value, nameBy: 'generated' }, NO_VAULT)).toBeNull();
    // An owner name is still MASKED: a credential-shaped word in it never survives.
    expect(cleanTitle(`Use ${'ghp_'}aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0dF3hJ6 today`, NO_VAULT, 'owner')).toBe('Use today');
  });

  test('a name with a cue yields to the first message when that holds none', () => {
    expect(
      fileTitle({ name: 'token=velvet thunder lantern', firstMessage: 'Fix the flaky login test' }, NO_VAULT),
    ).toBe('Fix the Flaky Login Test');
  });
});
