/**
 * The one way the linear-time tests of the Runtimes nets measure a run: the least of five, so a single slow sample
 * under load never reads as growth. Shared by every test that holds the ratio of 256 to 128 KiB under 3.
 */
export const best = (run: () => unknown): number => {
  let least = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    run();
    least = Math.min(least, performance.now() - t0);
  }
  return Math.max(least, 0.01);
};
