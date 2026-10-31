#!/usr/bin/env bun
/**
 * Splits a test group's files into N process shares that each keep a PACKAGE whole.
 *
 * Usage: `partition-files.ts <count> <file>...`. Prints one line per file: `<share> <file>`.
 *
 * WHY BY PACKAGE. coverage-ledger.sh passes a source file only when ONE run covers it to 100%, because Bun
 * reports a function a run never called coarsely and line sets from different runs do not add up. Splitting
 * by test directory was measured and failed that: a module is covered by tests from several areas of its own
 * package. A package's sources are covered by that package's tests, so a package is never split across
 * processes. Packages are dealt largest first to the share with the fewest files, ties to the lower share,
 * so the split is the same on every run.
 */
const [countArg, ...files] = process.argv.slice(2);
const count = Number(countArg);
if (!Number.isInteger(count) || count < 1) {
  console.error('usage: partition-files.ts <count> <file>...');
  process.exit(2);
}

/** `packages/<pkg>`, the unit a share keeps whole. */
const areaOf = (file: string): string => /^(?:\.\/)?(packages\/[^/]+)\//u.exec(file)?.[1] ?? file;

const areas = new Map<string, string[]>();
for (const file of files) {
  const area = areaOf(file);
  areas.set(area, [...(areas.get(area) ?? []), file]);
}
const shares = Array.from({ length: count }, () => [] as string[]);
const ordered = [...areas].sort(([a, left], [b, right]) => right.length - left.length || a.localeCompare(b));
for (const [, members] of ordered) {
  let target = 0;
  for (let index = 1; index < count; index++) if (shares[index]!.length < shares[target]!.length) target = index;
  shares[target]!.push(...members);
}
for (const [index, share] of shares.entries()) for (const file of share.sort()) console.log(`${index} ${file}`);
