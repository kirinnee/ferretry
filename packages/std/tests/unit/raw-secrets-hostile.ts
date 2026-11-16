/**
 * The hostile lines `rawTextSecretLine` must scan in one linear pass. This helper reads NO clock: the unit tier scans
 * them small and checks the answer; the perf tier (`tests/perf/raw-secrets-bound.test.ts`) scans them at 256 KiB and
 * holds the time.
 */

/** A value that is random-looking to the entropy test: 20 distinct characters. */
export const RANDOM_LOOKING = 'q7Zk2PxV9mLw4TnR8sBd';

const KIB = 1024;

/** The size of a hostile line in the perf tier. */
export const FULL_KIB = 256;

/** Every line at `kib` KiB; `FULL_KIB` is the size the perf budget is held at. */
export const hostileLines = (kib: number): readonly (readonly [string, string])[] => {
  const size = kib * KIB;
  const part = (perFull: number): number => Math.floor((kib * perFull * KIB) / FULL_KIB);
  let nested = '';
  for (let depth = 0; nested.length < (kib - 2) * KIB; depth += 1) nested += `${' '.repeat(depth)}k:\n`;
  return [
    [`one ${String(kib)} KiB line of spaces`, ' '.repeat(size)],
    [`a value padded with ${String(kib)} KiB of spaces`, `a: x${' '.repeat(size - 8)}y`],
    [`a key padded with ${String(kib)} KiB of spaces`, `token${' '.repeat(size - 12)}: x`],
    ['block indentation', nested],
    [`${String(kib)} KiB of quotes, colons and blanks`, '" : \' '.repeat(part(43))],
    [`${String(kib)} KiB of key prefixes`, 'sk-'.repeat(part(85))],
    [`a ${String(kib)} KiB credential value`, `token: ${RANDOM_LOOKING.repeat(part(13))}`],
  ];
};
