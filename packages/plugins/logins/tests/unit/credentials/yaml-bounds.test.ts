import { describe, expect, test } from 'bun:test';
import { CONFIG_FILE_MAX_BYTES, CONFIG_TOO_LARGE } from '@ferretry/std/yaml';
import { parseModelCatalogText } from '../../../daemon/lib/catalog/catalog.ts';
import { parsePresetText } from '../../../daemon/lib/presets/catalog.ts';

// The catalogue and preset readers read through the shared bounded reader (`@ferretry/std/yaml`), so a text a caller
// passes with another origin than 'built-in' cannot stall or exhaust the daemon. One hostile text of each shape,
// through THIS plugin's own entry points; the full set of shapes lives with the reader's own tests.

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

const HOSTILE: Readonly<Record<string, { readonly text: () => string; readonly sentence: string }>> = {
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

describe('logins: the catalogue readers refuse a hostile text in one fixed sentence, promptly', () => {
  for (const [shape, { text, sentence }] of Object.entries(HOSTILE)) {
    test(`logins parseModelCatalogText, ${shape}`, () => {
      const hostile = text();
      const started = performance.now();
      const parsed = parseModelCatalogText('hostile', hostile, 'file');
      expect(performance.now() - started).toBeLessThan(FAST_MS);
      expect(parsed).toEqual({ ok: false, problem: sentence });
    });

    test(`logins parsePresetText, ${shape}`, () => {
      const hostile = text();
      const started = performance.now();
      const parsed = parsePresetText('hostile', hostile, 'file');
      expect(performance.now() - started).toBeLessThan(FAST_MS);
      expect(parsed).toEqual({ ok: false, problem: sentence });
    });
  }
});
