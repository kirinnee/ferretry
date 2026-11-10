import { describe, expect, test } from 'bun:test';
import { CONFIG_FILE_MAX_BYTES, CONFIG_TOO_LARGE } from '@ferretry/std/yaml';
import { BudgetEditError, budgetInFile, withLoginBudget, withTimeZone } from '../../../cli/lib/budget.ts';

// `fy login budget` reads the `usage.yaml` text the daemon serves in the person's own process. It reads through the
// shared bounded reader (`@ferretry/std/yaml`), so a planted file is refused in one fixed sentence and the command
// finishes at once. One hostile text of each shape, through THIS half's own entry points.

const FAST_MS = 2000;
// A flood of bare `%` lines parses in about a second when its guard is gone, so the flood shape is held to a tighter
// bound: with the guard it answers in a few milliseconds.
const FLOOD_FAST_MS = 250;
const boundFor = (shape: string): number => (shape.includes('% directive') ? FLOOD_FAST_MS : FAST_MS);

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

/** `sentence` is what an EDIT says; an edit never expands an alias, so the alias shapes are only refused when READ. */
const HOSTILE: Readonly<Record<string, { readonly text: () => string; readonly sentence: string | undefined }>> = {
  'a text over the size cap': { text: () => '#'.repeat(CONFIG_FILE_MAX_BYTES + 1), sentence: CONFIG_TOO_LARGE },
  'an alias bomb (nested anchors)': { text: laughs, sentence: undefined },
  'a 128 KiB string aliased 18 000 times': {
    text: () => `s: &s ${'x'.repeat(128 * 1024)}\nl: [${'*s, '.repeat(18_000)}*s]\n`,
    sentence: undefined,
  },
  'a flood of % directive lines': {
    text: () => '%\n'.repeat(131_072),
    sentence: 'a % directive line is not one YAML knows',
  },
};

describe('usage cli: a hostile usage.yaml is refused, and the command answers promptly', () => {
  for (const [shape, { text, sentence }] of Object.entries(HOSTILE)) {
    test(`usage cli budgetInFile, ${shape}`, () => {
      const hostile = text();
      const started = performance.now();
      expect(budgetInFile(hostile, 'login-1')).toBeNull();
      expect(performance.now() - started).toBeLessThan(boundFor(shape));
    });

    test(`usage cli withLoginBudget, ${shape}`, () => {
      const hostile = text();
      const started = performance.now();
      expect(() => withLoginBudget(hostile, 'login-1', undefined)).toThrow(BudgetEditError);
      expect(performance.now() - started).toBeLessThan(boundFor(shape));
    });

    test(`usage cli withTimeZone, ${shape}`, () => {
      const hostile = text();
      const started = performance.now();
      if (sentence === undefined) expect(withTimeZone(hostile, 'UTC')).toContain('timeZone: UTC');
      else expect(() => withTimeZone(hostile, 'UTC')).toThrow(`the file does not parse: ${sentence}`);
      expect(performance.now() - started).toBeLessThan(boundFor(shape));
    });
  }
});
