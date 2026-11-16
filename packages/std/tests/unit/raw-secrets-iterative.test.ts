/**
 * The write rule's two document walkers (`findRawSecrets`, `findFlagSecrets`) read a document of ANY depth the parser
 * accepts: a hooks file nested past the call stack must not throw a RangeError out of the walk (ports-pending runtimes
 * line 22). Fake only.
 */
import { describe, expect, test } from 'bun:test';
import { findFlagSecrets, findRawSecrets } from '../../src/credential-words/index.ts';

const VALUE = 'Zk3pQ9vXw2LmN7rT';
const KEY = `ghp_${'AbCd1234'.repeat(3)}`;

/** `[` x `depth` around a leaf, as a parsed document. */
const nested = (depth: number, leaf: unknown): unknown => {
  let node: unknown = leaf;
  for (let level = 0; level < depth; level += 1) node = [node];
  return node;
};

describe('the document walkers are iterative', () => {
  test('should find a raw secret and a flag secret beside a 100,000-deep list, without throwing', () => {
    // Arrange
    const document = { command: `tool --token ${VALUE}`, apiKey: VALUE, deep: nested(100_000, 'x') };

    // Act
    const raw = findRawSecrets(document);
    const flags = findFlagSecrets(document);

    // Assert
    expect(raw.map(found => found.path)).toEqual([['apiKey']]);
    expect(flags.map(found => found.path)).toEqual([['command']]);
  });

  test('should report the path of a secret at the bottom of a deep list', () => {
    // Arrange
    const depth = 20_000;
    const document = { tokens: nested(depth, VALUE) };

    // Act
    const raw = findRawSecrets(document);

    // Assert
    expect(raw).toHaveLength(1);
    expect(raw[0]?.path).toEqual(['tokens', ...Array.from({ length: depth }, () => 0)]);
  });

  test('should name an item of a list by the nearest key above it, in order', () => {
    // Arrange
    const document = { a: VALUE, api_keys: ['short', VALUE, [VALUE]], other: [VALUE], z: { password: VALUE } };

    // Act
    const raw = findRawSecrets(document);

    // Assert
    expect(raw.map(found => found.path)).toEqual([
      ['api_keys', 1],
      ['api_keys', 2, 0],
      ['z', 'password'],
    ]);
  });

  test('should refuse a key shaped like a token at its object and walk nothing below it', () => {
    // Arrange
    const document = { outer: { [KEY]: { password: VALUE }, after: VALUE, token: VALUE } };

    // Act
    const raw = findRawSecrets(document);

    // Assert
    expect(raw).toEqual([{ path: ['outer'], atKey: ['outer', KEY] }, { path: ['outer', 'token'] }]);
  });

  test('should pair a flag with the next item of its list, and judge a lone string and a string in an object alone', () => {
    // Arrange
    const document = {
      args: ['--token', VALUE, '--model', 'x'],
      text: `--token=${VALUE}`,
      nested: { cmd: `--token ${VALUE}` },
    };

    // Act
    const paths = findFlagSecrets(document).map(found => found.path);

    // Assert
    expect(paths).toEqual([['args', 1], ['text'], ['nested', 'cmd']]);
  });

  test('should judge a string of a list whose next item is not a string alone', () => {
    // Arrange
    const document = { args: ['--token', { not: 'a word' }, [VALUE]], root: [`--api-key=${VALUE}`] };

    // Act
    const paths = findFlagSecrets(document).map(found => found.path);

    // Assert
    expect(paths).toEqual([['root', 0]]);
  });

  test('should judge a document that is one string, and one that is none', () => {
    expect(findFlagSecrets(`--token=${VALUE}`).map(found => found.path)).toEqual([[]]);
    expect(findRawSecrets(KEY).map(found => found.path)).toEqual([[]]);
    expect(findRawSecrets(null)).toEqual([]);
    expect(findFlagSecrets(42)).toEqual([]);
  });
});
