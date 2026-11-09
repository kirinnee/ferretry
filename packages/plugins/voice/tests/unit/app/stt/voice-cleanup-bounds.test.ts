import { describe, expect, test } from 'bun:test';
import { CONFIG_FILE_MAX_BYTES } from '@ferretry/std/yaml';
import { readVoiceCleanup, withVoiceCleanup } from '../../../../app/lib/stt/voice-cleanup.ts';

// Dictation cleanup reads the `voice.yaml` text the daemon serves in the person's own browser, on every machine view.
// It reads through the shared bounded reader (`@ferretry/std/yaml`), so a planted file answers "no cleanup settings"
// at once instead of stalling the tab. One hostile text of each shape, through THIS app's own entry points
// (`readVoiceCleanup`, `withVoiceCleanup`).

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

const HOSTILE: Readonly<Record<string, () => string>> = {
  'a text over the size cap': () => '#'.repeat(CONFIG_FILE_MAX_BYTES + 1),
  'an alias bomb (nested anchors)': laughs,
  'a 128 KiB string aliased 18 000 times': () => `s: &s ${'x'.repeat(128 * 1024)}\nl: [${'*s, '.repeat(18_000)}*s]\n`,
  'a flood of % directive lines': () => '%\n'.repeat(131_072),
};

describe('voice app: dictation cleanup refuses a hostile voice.yaml, and answers promptly', () => {
  for (const [shape, text] of Object.entries(HOSTILE)) {
    test(`voice readVoiceCleanup, ${shape}`, () => {
      const hostile = text();
      const started = performance.now();
      expect(readVoiceCleanup(hostile)).toBeNull();
      expect(performance.now() - started).toBeLessThan(FAST_MS);
    });

    test(`voice withVoiceCleanup, ${shape}`, () => {
      const hostile = text();
      const started = performance.now();
      expect(withVoiceCleanup(hostile, { style: 'fix' })).toBeNull();
      expect(performance.now() - started).toBeLessThan(FAST_MS);
    });
  }
});
