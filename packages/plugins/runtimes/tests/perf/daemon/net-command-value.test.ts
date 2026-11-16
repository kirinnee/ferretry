/**
 * CFG-LEAK (ii) fix 3 (I): the one rule for an MCP server's `command` stays linear to 256 KiB. What it shows and
 * withholds is tests/unit/daemon/net-command-value.test.ts; this file holds only the time. Fake values only.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { ratioOf } from '@ferretry/std/testing/linear-time';
import { commandWithheld } from '../../../daemon/lib/service/command-line.ts';

const V = 'Zk3pQ9vXw2LmN7rT';

describe('CFG-LEAK (ii) fix 3 (I): the command rule is linear', () => {
  // One test per shape. The timeout is the shape's local time (words 1.5 s, pointers 3.6 s, header pairs 1.8 s) with at
  // least four times the headroom; it is a margin for a loaded runner, not a speed claim.
  const shapes: readonly (readonly [string, (size: number) => string, number])[] = [
    ['a long command of words', size => `srv ${'ab '.repeat(size / 3)}`, 15_000],
    ['a long command of pointers', size => `env ${'K=$K '.repeat(size / 5)}srv`, 20_000],
    ['a long command of header pairs', size => `curl ${`-H "X: ${V}" `.repeat(size / 24)}`, 15_000],
  ];
  for (const [name, make, timeoutMs] of shapes) {
    it(
      `should stay linear to 256 KiB on a long command of blanks and words and of pointers: ${name}`,
      () => {
        // Act: the ratio of 256 to 128 KiB stays under 3 (a quadratic rule would give about 4).
        const ratio = ratioOf(
          () => commandWithheld(make(256 * 1024)),
          () => commandWithheld(make(128 * 1024)),
        );

        // Assert
        should(ratio).be.below(3, name);
      },
      timeoutMs,
    );
  }
});
