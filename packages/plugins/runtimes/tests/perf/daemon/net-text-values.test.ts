/**
 * CFG-LEAK (ii) fix 3: the instructions and hooks nets stay linear to 256 KiB. What they withhold is
 * tests/unit/daemon/net-text-values.test.ts; this file holds only the time. Fake values only.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { ratioOf } from '@ferretry/std/testing/linear-time';
import { hook, hooksShown, instructionsShown } from '../../support/text-values-support.ts';

const V = 'Zk3pQ9vXw2LmN7rT';

describe('CFG-LEAK (ii) fix 3: the text and hooks nets are linear', () => {
  // One test per shape. The timeout is the shape's local time (0.6, 6.0, 2.8, 1.0, 1.9 and 2.2 s, in the order below)
  // with at least four times the headroom; it is a margin for a loaded runner, not a speed claim.
  const shapes: readonly (readonly [string, (size: number) => string, number])[] = [
    ['one very long instructions line', size => `key: ${'a1B2'.repeat(size / 4)}`, 10_000],
    ['many short instructions lines', size => 'ab\n'.repeat(size / 3), 30_000],
    [
      'many instructions lines each holding a flag secret',
      size => `run --token ${V}\n`.repeat(Math.ceil(size / 23)),
      15_000,
    ],
    [
      'one very long hooks command',
      size => JSON.stringify(hook(`tool ${'a1B2 '.repeat(size / 5)} --token ${V}`), undefined, 2),
      10_000,
    ],
    [
      'a hooks args list of 50,000 words',
      size =>
        JSON.stringify(
          hook('tool', ['--token', V, ...Array.from({ length: size / 8 }, () => 'ab'), '--x']),
          undefined,
          2,
        ),
      15_000,
    ],
    [
      'many hooks each holding a flag secret',
      size =>
        JSON.stringify(
          Array.from({ length: Math.ceil(size / 40) }, () => ({ command: `t --token ${V}` })),
          undefined,
          2,
        ),
      15_000,
    ],
  ];
  for (const [name, make, timeoutMs] of shapes) {
    it(
      `should stay linear to 256 KiB on every shape of text and of document: ${name}`,
      () => {
        // Arrange
        const shown = (text: string): void => {
          if (name.includes('hooks')) hooksShown(text);
          else instructionsShown(text, true);
        };
        const small128 = make(128 * 1024);
        const large256 = make(256 * 1024);

        // Act: the ratio of 256 to 128 KiB stays under 3 (a quadratic net would give about 4).
        const ratio = ratioOf(
          () => shown(large256),
          () => shown(small128),
        );

        // Assert
        should(ratio).be.below(3, name);
      },
      timeoutMs,
    );
  }
});
