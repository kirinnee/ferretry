// The hostile catalogue/preset texts the logins readers refuse. The unit tier proves the refusal's sentence; the perf
// tier (tests/perf) proves it comes at once. No clock here: the bound lives in the perf file.
import { CONFIG_FILE_MAX_BYTES, CONFIG_TOO_LARGE } from '@ferretry/std/yaml';

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

export const HOSTILE: Readonly<Record<string, { readonly text: () => string; readonly sentence: string }>> = {
  'a text over the size cap': { text: () => '#'.repeat(CONFIG_FILE_MAX_BYTES + 1), sentence: CONFIG_TOO_LARGE },
  'an alias bomb (nested anchors)': {
    text: laughs,
    sentence: 'the aliases (*name) in this file expand too far to read',
  },
  'a 128 KiB string aliased 18 000 times': {
    text: () => `s: &s ${'x'.repeat(128 * 1024)}\nl: [${'*s, '.repeat(18_000)}*s]\n`,
    sentence: 'the aliases (*name) in this file expand too far to read',
  },
  'a flood of % directive lines': {
    text: () => '%\n'.repeat(131_072),
    sentence: 'a % directive line is not one YAML knows',
  },
};
