import { describe, it } from 'bun:test';
import should from 'should';
import { parseLegacyRef } from '../../../src/lib/board-import/index.ts';

describe('parseLegacyRef', () => {
  for (const [input, expected] of [
    ['lead:F12', 'lead:F12'],
    ['lead:&F12', 'lead:F12'],
    ['lead:#f12', 'lead:F12'],
    [' lead : F12 ', 'lead:F12'],
    ['a:b:F3', 'a:b:F3'],
  ] as const) {
    it(`should read "${input}" as ${expected}`, () => {
      // Act
      const ref = parseLegacyRef(input);

      // Assert
      should(ref).equal(expected);
    });
  }

  for (const input of ['F12', ':F12', 'lead:', 'lead:nonsense', 'two words:F12', ' :F12']) {
    it(`should refuse "${input}"`, () => {
      // Act
      const ref = parseLegacyRef(input);

      // Assert
      should(ref).be.undefined();
    });
  }
});
