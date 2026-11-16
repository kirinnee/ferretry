/**
 * The alias-heavy texts of `agent-config.test.ts` (unit: a small text, every answer checked) and of
 * `tests/perf/host-config/agent-config-alias-bound.test.ts` (perf: the text at the size limit, every door timed).
 * This file reads no clock.
 */
const laughs = Array.from(
  { length: 10 },
  (_, level) =>
    `l${level}: &l${level} [${Array.from({ length: 9 }, () => (level === 0 ? 'lol' : `*l${level - 1}`)).join(', ')}]\n`,
).join('');

/** Each hostile shape, padded to about `maxBytes`. */
export function aliasShapes(maxBytes: number): readonly (readonly [label: string, text: string])[] {
  const fill = (head: string, line: string, tail = ''): string =>
    head + line.repeat(Math.floor((maxBytes - 64 - head.length - tail.length) / line.length)) + tail;
  return [
    ['many aliases, the last unresolved', fill('limit: 5\nnote: &a x\nmore:\n', '  - *a\n', '  - *nope\n')],
    ['an alias bomb (billion laughs), padded', fill(laughs, '# padding\n')],
    ['an anchor of an empty anchor, aliased many times', fill('e: &e []\na: &a [*e]\nb:\n', '  - *a\n')],
    ['an alias loop at the end', fill('limit: 5\nnote: &a\n  b:\n', '    - 1\n', '    - *a\n')],
  ];
}
