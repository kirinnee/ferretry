import { describe, expect, test } from 'bun:test';
import { CONFIG_TOO_LARGE } from '@ferretry/std/yaml';
import { BudgetEditError, budgetInFile, withLoginBudget, withTimeZone } from '../../../cli/lib/budget.ts';
import { HOSTILE_TEXTS } from '../../support/hostile-usage-yaml.ts';

// `fy login budget` reads the `usage.yaml` text the daemon serves in the person's own process. It reads through the
// shared bounded reader (`@ferretry/std/yaml`), so a planted file is refused in one fixed sentence. One hostile text of
// each shape, through THIS half's own entry points. How fast it answers is tests/perf/cli/budget-bounds.test.ts.

/** `sentence` is what an EDIT says; an edit never expands an alias, so the alias shapes are only refused when READ. */
const SENTENCES: Readonly<Record<string, string | undefined>> = {
  'a text over the size cap': CONFIG_TOO_LARGE,
  'an alias bomb (nested anchors)': undefined,
  'a 128 KiB string aliased 18 000 times': undefined,
  'a flood of % directive lines': 'a % directive line is not one YAML knows',
};

describe('usage cli: a hostile usage.yaml is refused', () => {
  for (const [shape, text] of Object.entries(HOSTILE_TEXTS)) {
    const sentence = SENTENCES[shape];
    test(`usage cli budgetInFile, ${shape}`, () => {
      expect(budgetInFile(text(), 'login-1')).toBeNull();
    });

    test(`usage cli withLoginBudget, ${shape}`, () => {
      expect(() => withLoginBudget(text(), 'login-1', undefined)).toThrow(BudgetEditError);
    });

    test(`usage cli withTimeZone, ${shape}`, () => {
      const hostile = text();
      if (sentence === undefined) expect(withTimeZone(hostile, 'UTC')).toContain('timeZone: UTC');
      else expect(() => withTimeZone(hostile, 'UTC')).toThrow(`the file does not parse: ${sentence}`);
    });
  }
});
