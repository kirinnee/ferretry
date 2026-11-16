import { describe, expect, test } from 'bun:test';
import { parseModelCatalogText } from '../../../daemon/lib/catalog/catalog.ts';
import { parsePresetText } from '../../../daemon/lib/presets/catalog.ts';
import { HOSTILE } from '../../support/hostile-catalog-yaml.ts';

// The catalogue and preset readers read through the shared bounded reader (`@ferretry/std/yaml`), so a text a caller
// passes with another origin than 'built-in' cannot stall or exhaust the daemon. One hostile text of each shape,
// through THIS plugin's own entry points; the full set of shapes lives with the reader's own tests. How fast they
// answer is tests/perf/credentials/yaml-bounds.test.ts.

describe('logins: the catalogue readers refuse a hostile text in one fixed sentence', () => {
  for (const [shape, { text, sentence }] of Object.entries(HOSTILE)) {
    test(`logins parseModelCatalogText, ${shape}`, () => {
      expect(parseModelCatalogText('hostile', text(), 'file')).toEqual({ ok: false, problem: sentence });
    });

    test(`logins parsePresetText, ${shape}`, () => {
      expect(parsePresetText('hostile', text(), 'file')).toEqual({ ok: false, problem: sentence });
    });
  }
});
