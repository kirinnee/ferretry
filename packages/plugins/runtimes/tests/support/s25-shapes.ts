// The shapes that made the old redaction rules quadratic (name characters with no separator, repeated token heads, a
// separator with nothing after it, a long block, a long expansion), each with a make(n) and a generous timeout for the
// perf tier. Shared by the unit tier (small n) and the perf tier (100,000).
export const s25Shapes: readonly (readonly [string, (n: number) => string, number])[] = [
  ['a repeated', n => 'a'.repeat(n), 10_000],
  ['sk- repeated', n => 'sk-'.repeat(n / 3), 10_000],
  ['a= repeated', n => 'a='.repeat(n / 2), 15_000],
  ['a long password block', n => `password: |\n${'  x\n'.repeat(n / 4)}`, 10_000],
  ['repeated expansion heads', n => '${A-'.repeat(n / 4), 10_000],
  ['password and newline repeated', n => 'password\n'.repeat(n / 9), 10_000],
  ['a long separator then =x', n => `${'-'.repeat(n)}=x`, 10_000],
];
