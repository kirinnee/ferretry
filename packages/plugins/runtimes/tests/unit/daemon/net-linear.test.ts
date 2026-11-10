/**
 * CFG-LEAK (ii) the Runtimes net (the cutter, then W on what it shows) is linear at 256 KiB: the ratio of the time at
 * 256 KiB to the time at 128 KiB stays under 3, best of five. Measured alone: each test about 0.1 s.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { shownLine, writtenWithheld } from '../../../daemon/lib/service/command-line.ts';

const best = (run: () => unknown): number => {
  let least = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    run();
    least = Math.min(least, performance.now() - t0);
  }
  return Math.max(least, 0.01);
};

const SHAPES: readonly (readonly [string, (size: number) => string])[] = [
  ['keys and separators', size => 'API_KEY=,'.repeat(Math.ceil(size / 9)).slice(0, size)],
  ['pointers between keys', size => 'API_KEY=${secret:X} '.repeat(Math.ceil(size / 20)).slice(0, size)],
  ['padded base64 runs', size => 'password=Zk3pQ9vXw2LmN7rT== '.repeat(Math.ceil(size / 28)).slice(0, size)],
];

describe('CFG-LEAK (ii) the Runtimes net is linear at 256 KiB', () => {
  for (const [label, make] of SHAPES) {
    it(`should cut and check one word in linear time: ${label}`, () => {
      const small = make(128 * 1024);
      const large = make(256 * 1024);
      const ratio = best(() => shownLine([large])) / best(() => shownLine([small]));
      should(ratio).be.below(3);
    });
    it(`should judge a command shown as written in linear time: ${label}`, () => {
      const small = make(128 * 1024);
      const large = make(256 * 1024);
      const ratio = best(() => writtenWithheld('command', large)) / best(() => writtenWithheld('command', small));
      should(ratio).be.below(3);
    });
  }
});
