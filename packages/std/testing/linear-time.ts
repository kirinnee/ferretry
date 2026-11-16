/**
 * The one way a test measures how a run grows with its input: the large and the small run are INTERLEAVED round by
 * round, so a load that comes and goes on the machine lands on both sides instead of on whichever batch happened to be
 * running during it, and the least of several rounds is kept, so one slow tick does not decide it. A quadratic run is
 * slow in every round, a busy moment is slow in one. Only the noise in the measurement is removed: the sizes and the
 * bound a test holds stay the test's own.
 */

/** Rounds of one small run then one large run. */
export const LINEAR_TIME_ROUNDS = 9;

/** The least time on `large` and on `small`, in milliseconds, each floored at `floorMs`, the two interleaved. */
export interface InterleavedBest {
  readonly large: number;
  readonly small: number;
}

/** What a measurement can be told: how many rounds, and the smallest time a side may read as (the clock's own tick). */
export interface InterleavedOptions {
  readonly rounds?: number;
  readonly floorMs?: number;
}

const DEFAULT_FLOOR_MS = 0.01;

/** The least time of `rounds` interleaved rounds on each side (the small run first in a round, so it warms the code). */
export const interleavedBest = (
  large: () => unknown,
  small: () => unknown,
  options: InterleavedOptions = {},
): InterleavedBest => {
  const rounds = options.rounds ?? LINEAR_TIME_ROUNDS;
  const floorMs = options.floorMs ?? DEFAULT_FLOOR_MS;
  let leastLarge = Number.POSITIVE_INFINITY;
  let leastSmall = Number.POSITIVE_INFINITY;
  for (let i = 0; i < rounds; i++) {
    const t0 = performance.now();
    small();
    const t1 = performance.now();
    large();
    const t2 = performance.now();
    leastSmall = Math.min(leastSmall, t1 - t0);
    leastLarge = Math.min(leastLarge, t2 - t1);
  }
  return { large: Math.max(leastLarge, floorMs), small: Math.max(leastSmall, floorMs) };
};

/** The ratio of the best time on `large` to the best time on `small`, the two interleaved round by round. */
export const ratioOf = (large: () => unknown, small: () => unknown, options: InterleavedOptions = {}): number => {
  const least = interleavedBest(large, small, options);
  return least.large / least.small;
};
