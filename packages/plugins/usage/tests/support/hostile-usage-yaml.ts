// The hostile `usage.yaml` texts both halves of the usage plugin (app, cli) refuse. The unit tier proves the refusal;
// the perf tier (tests/perf) proves it comes at once. No clock here: the bounds live in the perf files.
import { CONFIG_FILE_MAX_BYTES } from '@ferretry/std/yaml';

/** A nest of anchors, each aliasing the previous ten times: a million nodes from six short lines. */
const laughs = (): string => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f'];
  return names
    .map((name, index) => {
      const previous = names[index - 1];
      const items = previous === undefined ? 'x' : `*${previous}`;
      return `${name}: &${name} [${Array.from({ length: 10 }, () => items).join(', ')}]`;
    })
    .join('\n');
};

/** One hostile text of each shape, keyed by the name the tests print. */
export const HOSTILE_TEXTS: Readonly<Record<string, () => string>> = {
  'a text over the size cap': () => '#'.repeat(CONFIG_FILE_MAX_BYTES + 1),
  'an alias bomb (nested anchors)': laughs,
  'a 128 KiB string aliased 18 000 times': () => `s: &s ${'x'.repeat(128 * 1024)}\nl: [${'*s, '.repeat(18_000)}*s]\n`,
  'a flood of % directive lines': () => '%\n'.repeat(131_072),
};

const FAST_MS = 2000;
// A flood of bare `%` lines parses in about a second when its guard is gone, so the flood shape is held to a tighter
// bound: with the guard it answers in a few milliseconds.
const FLOOD_FAST_MS = 250;
export const boundFor = (shape: string): number => (shape.includes('% directive') ? FLOOD_FAST_MS : FAST_MS);
