import { describe, expect, it } from 'bun:test';
import { environmentDifferences } from '../../src/lib/fleet-environment.ts';

describe('environmentDifferences', () => {
  it('names every key either side publishes, sorted, with how the sides disagree', () => {
    // Act
    const found = environmentDifferences(
      { KEEP: 'same', CHANGE: 'old', HERE: 't' },
      { KEEP: 'same', CHANGE: 'new', THERE: 's' },
    );

    // Assert
    expect(found).toEqual([
      { key: 'CHANGE', kind: 'differs', target: 'old', source: 'new' },
      { key: 'HERE', kind: 'target-only', target: 't' },
      { key: 'THERE', kind: 'source-only', source: 's' },
    ]);
  });

  it('reads only what each side publishes, never what every object inherits', () => {
    // Arrange: `constructor` is "in" every plain object, so an `in` check read a key published by one
    // side as published by both — and reported it as differing from a function.
    const found = environmentDifferences({}, { constructor: 'x' });

    // Assert
    expect(found).toEqual([{ key: 'constructor', kind: 'source-only', source: 'x' }]);
  });
});
