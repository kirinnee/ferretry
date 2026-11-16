/**
 * CFG-LEAK (ii) the text of an instructions or hooks file (`content`) is cut and netted in linear time to 256 KiB.
 * What is withheld is tests/unit/daemon/net-component-text.test.ts; this file holds only the time. Fake values only.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { ratioOf } from '@ferretry/std/testing/linear-time';
import { shownFor } from '../../unit/daemon/redact-support.ts';

const LONG40 = 'Zk3pQ9vXw2LmN7rTHy8cBt4Fg6SdJ1uEqW5eR0tY';

describe('CFG-LEAK (ii) the netted text of a component file is linear', () => {
  // One test per shape. The timeout is the shape's local time (0.6, 5.7 and 1.2 s, in the order below) with at least
  // four times the headroom; it is a margin for a loaded runner, not a speed claim.
  const shapes: readonly (readonly [string, (size: number) => string, number])[] = [
    ['one very long line', size => `key: ${'a1B2'.repeat(size / 4)}`, 10_000],
    ['many short lines', size => 'ab\n'.repeat(size / 3), 30_000],
    ['many lines each holding a long value', size => `key: ${LONG40}\n`.repeat(Math.ceil(size / 47)), 15_000],
  ];
  for (const [name, make, timeoutMs] of shapes) {
    it(
      `should stay linear to 256 KiB on a very long line, many short lines and many lines of one key: ${name}`,
      () => {
        // Arrange
        shownFor(make(16 * 1024));
        const small = make(128 * 1024);
        const large = make(256 * 1024);

        // Act: the ratio of 256 to 128 KiB stays under 3 (a quadratic rule would give about 4).
        const ratio = ratioOf(
          () => shownFor(large),
          () => shownFor(small),
          { floorMs: 1 },
        );

        // Assert
        should(ratio).be.below(3, name);
      },
      timeoutMs,
    );
  }
});
