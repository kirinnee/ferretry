/**
 * CFG-LEAK (ii): the cutter and W are linear in the length of one word. The ratio of the time at 256 KiB to the time at
 * 64 KiB must stay under 8 (linear is 4; quadratic is 16), best of several runs so one slow tick does not decide it. A
 * fourfold step keeps a factor of two between the bound and either answer, so a loaded CI runner cannot fail a linear
 * cutter (a twofold step against a bound of 3 did: 3.09) and a quadratic one still fails by the same margin.
 *
 * Fake only: the shapes are credential-like runs and are none.
 */
import { describe, expect, test } from 'bun:test';
import { findFlagSecrets, shownWords } from '../../src/credential-words/index.ts';

const KIB = 1024;

const best = (run: () => void): number => {
  let least = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    run();
    least = Math.min(least, performance.now() - t0);
  }
  return Math.max(least, 0.01);
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
      const small = make(64 * KIB);
      const large = make(256 * KIB);
      const ratio = best(() => shownWords([large])) / best(() => shownWords([small]));
      expect(ratio).toBeLessThan(8);
    });

    test(`W is linear on ${label}`, () => {
      const small = make(64 * KIB);
      const large = make(256 * KIB);
      const ratio = best(() => findFlagSecrets({ args: [large] })) / best(() => findFlagSecrets({ args: [small] }));
      expect(ratio).toBeLessThan(8);
    });
  }
});
