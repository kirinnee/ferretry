import { describe, it } from 'bun:test';
import should from 'should';
import { utf8Length } from '../../../src/lib/transcript/utf8.ts';

describe('utf8Length', () => {
  it.each([
    ['ASCII', 'plain text'],
    ['two-byte characters', 'café ñ'],
    ['three-byte characters', '日本語 ✓'],
    ['a surrogate pair', 'emoji 🦦 here'],
    ['a lone high surrogate at the end', 'cut \uD83E'],
    ['a high surrogate before a non-surrogate', 'bad \uD83Ex'],
    ['a lone low surrogate', 'bad \uDD8A'],
    ['nothing', ''],
  ])('should count %s as the bytes UTF-8 encoding writes', (_name, text) => {
    // Act
    const actual = utf8Length(text);

    // Assert — lone surrogates encode as U+FFFD, exactly as the encoder writes them.
    should(actual).equal(new TextEncoder().encode(text).byteLength);
  });

  it('should count only the range it is given', () => {
    // Arrange
    const text = 'ab🦦cd';

    // Act
    const actual = utf8Length(text, 2, 4);

    // Assert
    should(actual).equal(4);
  });
});
