import { describe, expect, test } from 'bun:test';
import { readMachineTimeZone, withLoginBudget, withMachineTimeZone } from '../../../app/lib/usage-file.ts';
import { HOSTILE_TEXTS } from '../../support/hostile-usage-yaml.ts';

// The budget editor runs in the person's own browser on the `usage.yaml` text the daemon serves, and the daemon serves a
// file the kernel itself refused. The editor reads through the shared bounded reader (`@ferretry/std/yaml`), so a
// planted file answers "cannot be edited here". One hostile text of each shape, through THIS half's own entry points;
// the fixed sentences are asserted where the reader's refusal is visible (the shared module's own tests and the CLI
// half, which says them aloud). How fast it answers is tests/perf/app/usage-file-bounds.test.ts.

/** `editsRefused`: an edit never expands an alias, so the alias shapes are only refused where the text is READ. */
const EDITS_REFUSED: Readonly<Record<string, boolean>> = {
  'a text over the size cap': true,
  'an alias bomb (nested anchors)': false,
  'a 128 KiB string aliased 18 000 times': false,
  'a flood of % directive lines': true,
};

describe('usage app: the budget editor cannot edit a hostile usage.yaml', () => {
  for (const [shape, text] of Object.entries(HOSTILE_TEXTS)) {
    const editsRefused = EDITS_REFUSED[shape];
    test(`usage app readMachineTimeZone, ${shape}`, () => {
      expect(readMachineTimeZone(text())).toBeNull();
    });

    test(`usage app withLoginBudget, ${shape}`, () => {
      expect(withLoginBudget(text(), 'login-1', undefined)).toBeNull();
    });

    test(`usage app withMachineTimeZone, ${shape}`, () => {
      const edited = withMachineTimeZone(text(), 'UTC');
      if (editsRefused) expect(edited).toBeNull();
      else expect(edited).toContain('timeZone: UTC');
    });
  }
});
