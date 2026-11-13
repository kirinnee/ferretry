/**
 * CFG-LEAK (ii): the cutter and W are linear in the length of one word. The ratio of the time at 256 KiB to the time at
 * 128 KiB must stay under 3 (linear is 2; quadratic is 4), best of interleaved runs so one slow tick does not decide it.
 *
 * Fake only: the shapes are credential-like runs and are none.
 */
import { describe, expect, test } from 'bun:test';
import { findFlagSecrets, shownWords } from '../../src/credential-words/index.ts';

const KIB = 1024;

/**
 * The ratio of the best time on `large` to the best time on `small`, the two INTERLEAVED round by round, so a load that
 * comes and goes on the machine lands on both sides instead of on whichever batch happened to run during it. Best of
 * several rounds, so one slow tick does not decide it. The bound is unchanged; only the noise in the measurement is.
 */
const ratioOf = (large: () => void, small: () => void): number => {
  let leastLarge = Number.POSITIVE_INFINITY;
  let leastSmall = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 9; i++) {
    const t0 = performance.now();
    small();
    const t1 = performance.now();
    large();
    const t2 = performance.now();
    leastSmall = Math.min(leastSmall, t1 - t0);
    leastLarge = Math.min(leastLarge, t2 - t1);
  }
  return Math.max(leastLarge, 0.01) / Math.max(leastSmall, 0.01);
};

/** Hostile shapes: the same run of keys, separators, pointers and quotes, repeated to a length. */
const SHAPES: readonly (readonly [string, (size: number) => string])[] = [
  ['keys and separators', size => 'API_KEY=,'.repeat(Math.ceil(size / 9)).slice(0, size)],
  ['pointers between keys', size => 'API_KEY=${secret:X} '.repeat(Math.ceil(size / 20)).slice(0, size)],
  ['one long unclosed quote', size => `API_KEY="${'a1B2c3D4'.repeat(Math.ceil(size / 8))}`.slice(0, size)],
  ['padded base64 runs', size => 'password=Zk3pQ9vXw2LmN7rT== '.repeat(Math.ceil(size / 28)).slice(0, size)],
];

describe('CFG-LEAK (ii) linear time at 256 KiB', () => {
  for (const [label, make] of SHAPES) {
    test(`the cutter is linear on ${label}`, () => {
      const small = make(128 * KIB);
      const large = make(256 * KIB);
      const ratio = ratioOf(
        () => shownWords([large]),
        () => shownWords([small]),
      );
      expect(ratio).toBeLessThan(3);
    });

    test(`W is linear on ${label}`, () => {
      const small = make(128 * KIB);
      const large = make(256 * KIB);
      const ratio = ratioOf(
        () => findFlagSecrets({ args: [large] }),
        () => findFlagSecrets({ args: [small] }),
      );
      expect(ratio).toBeLessThan(3);
    });
  }
});
