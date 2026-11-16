/**
 * CFG-LEAK (ii): the cutter and W are linear in the length of one word. The ratio of the time at 256 KiB to the time at
 * 64 KiB (a 4x input) must stay under 8: linear is 4, quadratic is 16, and 8 sits a factor of two from each, so a busy
 * runner's noise cannot reach it while a quadratic regression cannot hide under it. Best of interleaved runs, so one
 * slow tick does not decide it. There is no wall-clock bound: only the ratio is held.
 *
 * Fake only: the shapes are credential-like runs and are none.
 */
import { describe, expect, test } from 'bun:test';
import { findFlagSecrets, shownWords } from '../../src/credential-words/index.ts';
import { ratioOf } from '../../testing/linear-time.ts';

const KIB = 1024;

/** The small and the large input, 4x apart: linear growth reads about 4, quadratic about 16. */
const SMALL = 64 * KIB;
const LARGE = 256 * KIB;

/** Half way, as a factor, between linear (4) and quadratic (16). */
const MAX_RATIO = 8;

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
      const small = make(SMALL);
      const large = make(LARGE);
      const ratio = ratioOf(
        () => shownWords([large]),
        () => shownWords([small]),
      );
      expect(ratio).toBeLessThan(MAX_RATIO);
    });

    test(`W is linear on ${label}`, () => {
      const small = make(SMALL);
      const large = make(LARGE);
      const ratio = ratioOf(
        () => findFlagSecrets({ args: [large] }),
        () => findFlagSecrets({ args: [small] }),
      );
      expect(ratio).toBeLessThan(MAX_RATIO);
    });
  }
});
