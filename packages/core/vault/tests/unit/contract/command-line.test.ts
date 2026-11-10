import { describe, expect, it } from 'bun:test';
import {
  envEntryHidden,
  firstHiddenWord,
  HIDDEN_WORD_TEXT,
  looksSecret,
  pointsElsewhere,
  SECRET_TOKEN_SOURCE,
  secretNamed,
  shownWord,
  shownWords,
} from '../../../contract/index.ts';

// Fake values only. The rule's own differential and its mutation-checked shapes are Runtimes' (the Resolved view);
// these pin the surface Catalogs and Runtimes both stand on.
describe('the one command-line rule', () => {
  it('should cut the password of a URL user, and keep the user and the host', () => {
    expect(shownWord('postgres://person:fake-pw-0000@db/x', undefined)).toEqual({
      text: `postgres://person:${HIDDEN_WORD_TEXT}@db/x`,
      hidden: true,
    });
  });

  it('should hide the word after a secret-named flag, and a header under a secret-named key', () => {
    expect(shownWords(['--token', 'fake-tok-0000'])).toEqual([
      { text: '--token', hidden: false },
      { text: HIDDEN_WORD_TEXT, hidden: true },
    ]);
    expect(shownWord('X-Api-Key: fake-key-0000', '--header').hidden).toBe(true);
    expect(shownWord('--set=a=1,client.secret=fake-0000x', undefined).text).toBe(
      `--set=a=1,client.secret=${HIDDEN_WORD_TEXT}`,
    );
  });

  it('should show a harmless flag, a pointer and a plain word as written', () => {
    expect(shownWords(['--port', '8080', '--token', '${secret:TOKEN}']).map(word => word.hidden)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it('should name the first hidden word of a command line, or -1', () => {
    expect(firstHiddenWord(['--read-only', '--token', 'fake-tok-0000'])).toBe(2);
    expect(firstHiddenWord(['fake-tok-0000'], '--token')).toBe(0);
    expect(firstHiddenWord(['--read-only', '--port', '8080'])).toBe(-1);
  });

  it('should read an environment entry as a launch flag does, a name that starts with an underscore included', () => {
    expect(envEntryHidden('PASSWORD', 'fake-pw-0000')).toBe(true);
    expect(envEntryHidden('_API_KEY', 'fake-key-0000')).toBe(true);
    expect(envEntryHidden('NOTE', 'Authorization: Bearer fake-tok-0000')).toBe(true);
    expect(envEntryHidden('MODEL', 'gpt-4o-mini')).toBe(false);
    expect(envEntryHidden('PASSWORD', '${secret:PASSWORD}')).toBe(false);
  });
});

describe('what reads as a credential', () => {
  it('should know a secret name by its words and a token by its prefix', () => {
    expect(secretNamed('OPENAI_API_KEY')).toBe(true);
    expect(secretNamed('--client-secret')).toBe(true);
    expect(secretNamed('LOG_LEVEL')).toBe(false);
    expect(looksSecret('ANYTHING', 'ghp_aaaaaaaaaaaaaaaa')).toBe(true);
    expect(looksSecret('GITHUB_TOKEN', 'abcdefghij')).toBe(true);
    expect(looksSecret('AUTH', '1')).toBe(false);
  });

  it('should treat a pointer as holding no secret', () => {
    expect(pointsElsewhere('$TOKEN')).toBe(true);
    expect(pointsElsewhere('${TOKEN}')).toBe(true);
    expect(pointsElsewhere('Bearer ${secret:TOKEN}')).toBe(true);
    expect(pointsElsewhere('plain')).toBe(false);
    expect(looksSecret('GITHUB_TOKEN', '${secret:GITHUB_TOKEN}')).toBe(false);
  });

  it('should find a whole token in a text through the one source', () => {
    expect(new RegExp(SECRET_TOKEN_SOURCE, 'u').test('<&ghp_aaaaaaaaaaaaaaaa')).toBe(true);
    expect(new RegExp(SECRET_TOKEN_SOURCE, 'u').test('no token here')).toBe(false);
  });
});
