/**
 * Two things the word cutter once showed (ports-pending runtimes line 18), now cut: a password stuck to a one-letter
 * flag that means "password" (`-p<password>`), and the strings of a JSON document passed inside a word
 * (`--settings '{"env":{"API_KEY":"v"}}'`), whose keys are quoted and so were no `NAME=value` text.
 *
 * Fake only: every value is shaped like a credential and is none.
 */
import { describe, expect, test } from 'bun:test';
import { HIDDEN_VALUE_TEXT, shownWord, shownWords } from '../../src/credential-words/index.ts';

const VALUE = 'Zk3pQ9vXw2LmN7rT';
const POINTER = '${secret:X}';
const HIDDEN = HIDDEN_VALUE_TEXT;

const shown = (word: string, before?: string): string => shownWord(word, before).text;

describe('a password stuck to a one-letter flag that means "password"', () => {
  test('should cut the value of -p and keep the flag when the value is long enough to be a credential', () => {
    expect(shownWord(`-p${VALUE}`, undefined)).toEqual({ text: `-p${HIDDEN}`, hidden: true });
  });

  test('should cut it when a command line reads it after another word', () => {
    expect(shownWords(['mysql', '-u', 'root', `-p${VALUE}`, 'db']).map(word => word.text)).toEqual([
      'mysql',
      '-u',
      'root',
      `-p${HIDDEN}`,
      'db',
    ]);
  });

  test('should show a value too short to be a credential, a pointer, and a letter that names no password', () => {
    // Arrange
    const words = ['-p8080', '-p$DB_PASSWORD', `-p${POINTER}`, `-k${VALUE}`, '-pfoo'];

    // Act
    const actual = words.map(word => shown(word));

    // Assert — `-k` is no password: the letter decides, not the value
    expect(actual).toEqual(words);
  });
});

describe('a one-letter flag name is read only when the value is stuck to the letter', () => {
  test('should leave a longer single-dash flag glued to its value as it always was, and -P a port', () => {
    // Arrange
    const words = ['-password=$DB_PASSWORD', '-password short', '-port=8080808080', `-P${VALUE}`, '-pabc=defghijkl'];

    // Act
    const actual = words.map(word => shown(word));

    // Assert — `-pabc=defghijkl` is a plain `=` in the value: the gap the header names
    expect(actual).toEqual(words);
  });

  test('should cut a quoted value with blanks in it stuck to -p', () => {
    expect(shown(`-p"${VALUE} and more"`)).toBe(`-p${HIDDEN}`);
  });
});

describe('a JSON document inside a word', () => {
  const doc = (inner: string): string => `{${inner}}`;

  test('should cut a string under a secret-named key, at any depth, and keep every other value', () => {
    // Arrange
    const word = doc(`"env":{"API_KEY":"${VALUE}","LOG_LEVEL":"debug-level-1"},"model":"opus"`);

    // Act
    const actual = shownWord(word, '--settings');

    // Assert
    expect(actual).toEqual({
      text: doc(`"env":{"API_KEY":"${HIDDEN}","LOG_LEVEL":"debug-level-1"},"model":"opus"`),
      hidden: true,
    });
  });

  test('should cut it when the JSON is glued to its flag with =, or inside one pair of quotes', () => {
    expect(shown(`--settings={"password": "${VALUE}"}`)).toBe(`--settings={"password": "${HIDDEN}"}`);
    expect(shown(`'{"token":"${VALUE}"}'`)).toBe(`'{"token":"${HIDDEN}"}'`);
  });

  test('should cut every string of a list under a secret-named key, named by the key the list is under', () => {
    // Arrange
    const word = `{"tokens":["${VALUE}",["${VALUE}x"],"short"],"other":["${VALUE}"]}`;

    // Act
    const actual = shown(word);

    // Assert — the nearest key names a string: `tokens` for the first three, `other` (no secret name) for the last
    expect(actual).toBe(`{"tokens":["${HIDDEN}",["${HIDDEN}"],"short"],"other":["${VALUE}"]}`);
  });

  test('should name a string by its own key, not by a secret-named key further up', () => {
    expect(shown(`{"credentials":{"user":"${VALUE}"}}`)).toBe(`{"credentials":{"user":"${VALUE}"}}`);
  });

  test('should leave a pointer, a short value, a number and a key alone', () => {
    // Arrange
    const word = `{"apiKey":"${POINTER}","password":"short","token":12345678,"API_KEY_VALUE":null}`;

    // Act
    const actual = shownWord(word, undefined);

    // Assert
    expect(actual).toEqual({ text: word, hidden: false });
  });

  test('should read a string with an escaped quote in it as one string', () => {
    expect(shown(`{"password":"${VALUE}\\"${VALUE}","k":"v"}`)).toBe(`{"password":"${HIDDEN}","k":"v"}`);
  });

  test('should read a string whose escape does not parse as written', () => {
    expect(shown(`{"password":"${VALUE}\\q"}`)).toBe(`{"password":"${HIDDEN}"}`);
  });

  test('should read a document that does not parse as far as it goes, and one with stray marks', () => {
    // Arrange: an unclosed object, a stray close, a colon and a comma outside an object, an array at the root
    const words = [
      `{"password":"${VALUE}"`,
      `{}}]{"password":"${VALUE}"}`,
      `[:,"${VALUE}",{"secret":"${VALUE}"}]`,
      `  [{"token":"${VALUE}"}]`,
    ];

    // Act
    const actual = words.map(word => shown(word));

    // Assert
    expect(actual).toEqual([
      `{"password":"${HIDDEN}"`,
      `{}}]{"password":"${HIDDEN}"}`,
      `[:,"${VALUE}",{"secret":"${HIDDEN}"}]`,
      `  [{"token":"${HIDDEN}"}]`,
    ]);
  });

  test('should not read a word that is not a JSON document', () => {
    expect(shown(`note "password":"${VALUE}"`)).toBe(`note "password":"${VALUE}"`);
  });

  test('should read a deeply nested document without recursion, in time that follows its length', () => {
    // Arrange
    const depth = 50_000;
    const word = `${'['.repeat(depth)}{"password":"${VALUE}"}${']'.repeat(depth)}`;

    // Act
    const actual = shown(word);

    // Assert
    expect(actual).toBe(`${'['.repeat(depth)}{"password":"${HIDDEN}"}${']'.repeat(depth)}`);
  });
});
