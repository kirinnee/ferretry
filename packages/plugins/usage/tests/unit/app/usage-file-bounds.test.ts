import { describe, expect, test } from 'bun:test';
import { CONFIG_FILE_MAX_BYTES } from '@ferretry/std/yaml';
import { readMachineTimeZone, withLoginBudget, withMachineTimeZone } from '../../../app/lib/usage-file.ts';

// The budget editor runs in the person's own browser on the `usage.yaml` text the daemon serves, and the daemon serves a
// file the kernel itself refused. The editor reads through the shared bounded reader (`@ferretry/std/yaml`), so a
// planted file answers "cannot be edited here" at once instead of stalling the tab. One hostile text of each shape,
// through THIS half's own entry points; the fixed sentences are asserted where the reader's refusal is visible (the
// shared module's own tests and the CLI half, which says them aloud).

const FAST_MS = 2000;

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

/** `editsRefused`: an edit never expands an alias, so the alias shapes are only refused where the text is READ. */
const HOSTILE: Readonly<Record<string, { readonly text: () => string; readonly editsRefused: boolean }>> = {
  'a text over the size cap': { text: () => '#'.repeat(CONFIG_FILE_MAX_BYTES + 1), editsRefused: true },
  'an alias bomb (nested anchors)': { text: laughs, editsRefused: false },
  'a 128 KiB string aliased 18 000 times': {
    text: () => `s: &s ${'x'.repeat(128 * 1024)}\nl: [${'*s, '.repeat(18_000)}*s]\n`,
    editsRefused: false,
  },
  'a flood of % directive lines': { text: () => '%\n'.repeat(131_072), editsRefused: true },
};

describe('usage app: the budget editor cannot edit a hostile usage.yaml, and answers promptly', () => {
  for (const [shape, { text, editsRefused }] of Object.entries(HOSTILE)) {
    test(`usage app readMachineTimeZone, ${shape}`, () => {
      const hostile = text();
      const started = performance.now();
      expect(readMachineTimeZone(hostile)).toBeNull();
      expect(performance.now() - started).toBeLessThan(FAST_MS);
    });

    test(`usage app withLoginBudget, ${shape}`, () => {
      const hostile = text();
      const started = performance.now();
      expect(withLoginBudget(hostile, 'login-1', undefined)).toBeNull();
      expect(performance.now() - started).toBeLessThan(FAST_MS);
    });

    test(`usage app withMachineTimeZone, ${shape}`, () => {
      const hostile = text();
      const started = performance.now();
      const edited = withMachineTimeZone(hostile, 'UTC');
      if (editsRefused) expect(edited).toBeNull();
      else expect(edited).toContain('timeZone: UTC');
      expect(performance.now() - started).toBeLessThan(FAST_MS);
    });
  }
});
