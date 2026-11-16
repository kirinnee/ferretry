import { describe, expect, test } from 'bun:test';
import { parseModelCatalogText } from '../../../daemon/lib/catalog/catalog.ts';
import { parsePresetText } from '../../../daemon/lib/presets/catalog.ts';
import { HOSTILE } from '../../support/hostile-catalog-yaml.ts';

// The catalogue and preset readers refuse a hostile text promptly. The sentence is
// tests/unit/credentials/yaml-bounds.test.ts; this file holds only the time.

const FAST_MS = 2000;

describe('logins: the catalogue readers answer a hostile text promptly', () => {
  for (const [shape, { text }] of Object.entries(HOSTILE)) {
    test(`logins parseModelCatalogText, ${shape}`, () => {
      const hostile = text();
      const started = performance.now();
      parseModelCatalogText('hostile', hostile, 'file');
      expect(performance.now() - started).toBeLessThan(FAST_MS);
    });

    test(`logins parsePresetText, ${shape}`, () => {
      const hostile = text();
      const started = performance.now();
      parsePresetText('hostile', hostile, 'file');
      expect(performance.now() - started).toBeLessThan(FAST_MS);
    });
  }
});
