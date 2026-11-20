/**
 * `public/pre-paint.js` must resolve the stored theme preference to exactly what
 * `src/theme/preferences.ts` resolves it to.
 *
 * The two implementations exist on purpose — one runs before first paint, one
 * runs in React — and the module says in its own header that they MUST stay in
 * step. That is a claim no component test can check: the bootstrap is a
 * hand-written classic script served unbundled from `public/`, so nothing
 * imports it and nothing typechecks it. This suite is the only thing standing
 * between "they agree" and "they agreed when they were written".
 *
 * So it runs the REAL FILE. The script is read from disk and executed with
 * `localStorage`, `window` and `document` supplied as parameters — which shadow
 * the globals the script reaches for — and its answer is compared against the
 * module's answer for the same stored value. No happy-dom, no globals mutated,
 * and `prefers-color-scheme` is a value this suite chooses rather than one the
 * host environment happens to have.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REMOVED_PALETTE_IDS, THEME_FAMILY_IDS } from '@ferretry/plugin-layouts/contract';
import { PALETTES, STYLES } from '../../src/theme/catalog.ts';
import { memoryStore } from '../../src/storage/records.ts';
import {
  resolveThemeMode,
  TEXT_SCALE_FACTORS,
  THEME_PREFERENCES_KEY,
  ThemePreferenceStore,
  themeAttribute,
} from '../../src/theme/preferences.ts';

/** The definition's reading of one stored value: the store's own load. */
const parseThemePreference = (raw: string | null) =>
  new ThemePreferenceStore(memoryStore(raw === null ? {} : { [THEME_PREFERENCES_KEY]: raw })).snapshot();
const record = (value: unknown, format: unknown = 1): string => JSON.stringify({ format, value });

const source = readFileSync(join(import.meta.dir, '../../public/pre-paint.js'), 'utf8');

interface Published {
  readonly attributes: Record<string, string>;
  readonly properties: Record<string, string>;
}

/**
 * Run the bootstrap against one stored value and one OS answer.
 *
 * `storage` is deliberately allowed to throw: blocked storage is an ordinary
 * browser condition (private mode, a hardened profile), and a bootstrap that
 * propagated it would take the whole app down before React ever loaded.
 */
const runBootstrap = (
  raw: string | null,
  systemDark: boolean,
  storage: { getItem: (key: string) => string | null } = { getItem: () => raw },
): Published => {
  const attributes: Record<string, string> = {};
  const properties: Record<string, string> = {};
  const documentElement = {
    setAttribute: (name: string, value: string) => {
      attributes[name] = value;
    },
    style: {
      setProperty: (name: string, value: string) => {
        properties[name] = value;
      },
    },
  };

  const bootstrap = new Function('localStorage', 'window', 'document', source) as (
    localStorage: unknown,
    window: unknown,
    document: unknown,
  ) => void;

  bootstrap(
    storage,
    { matchMedia: (query: string) => ({ matches: systemDark && query.includes('dark') }) },
    { documentElement },
  );

  return { attributes, properties };
};

/** What `theme-preferences.ts` — the definition — says the same input resolves to. */
const expectedAttribute = (raw: string | null, systemDark: boolean): string => {
  const preference = parseThemePreference(raw);
  return themeAttribute(preference.palette, resolveThemeMode(preference.mode, systemDark));
};

const STORED_VALUES: readonly (string | null)[] = [
  // Nothing stored at all, and the shapes an empty-ish value can take.
  null,
  '',
  '   ',
  // The record shape (style + palette), including per-field fallback for bad fields.
  record({ style: 'neo', palette: 'geist', mode: 'dark', textScale: 'large' }),
  record({ style: 'geist', palette: 'phosphor', mode: 'light', textScale: 'default' }),
  record({ style: 'nope', palette: 'ledger', mode: 'dark', textScale: 'default' }),
  record({ style: 'mission', palette: 'nope', mode: 'system', textScale: 'larger' }),
  // The removed `contrast` style is Studio in the High contrast palette; every removed palette reads as its kept one.
  record({ style: 'contrast', palette: 'studio', mode: 'light', textScale: 'default' }),
  record({ style: 'contrast', palette: 'neo', mode: 'dark', textScale: 'default' }),
  record({ style: 'contrast', mode: 'dark', textScale: 'default' }),
  ...Object.keys(REMOVED_PALETTE_IDS).map(palette =>
    record({ style: 'neo', palette, mode: 'light', textScale: 'default' }),
  ),
  ...THEME_FAMILY_IDS.map(family => record({ family, mode: 'dark', textScale: 'default' })),
  // A `keepPalette` the painter has no use for must not disturb it.
  record({ style: 'neo', palette: 'geist', keepPalette: true, mode: 'dark', textScale: 'default' }),
  // The pre-split record shape: a family is a palette with the style it was drawn for; an explicit axis beside it wins.
  record({ family: 'phosphor', mode: 'dark', textScale: 'default' }),
  record({ family: 'ma', mode: 'light', textScale: 'default' }),
  record({ family: 'neo', style: 'studio', mode: 'light', textScale: 'default' }),
  record({ family: 'mission', mode: 'dark', textScale: 'large' }),
  record({ family: 'notebook', mode: 'system', textScale: 'larger' }),
  record({ family: 'geist', mode: 'light', textScale: 'default' }),
  record({ family: 'nope', mode: 'dark', textScale: 'huge' }),
  // Another format, or no format: read as absent (clean slate, no converter).
  record({ family: 'mission', mode: 'dark', textScale: 'large' }, 2),
  JSON.stringify({ family: 'mission', mode: 'dark' }),
  // Corrupt JSON, and JSON that is not a record.
  '{"format":',
  '{oops}',
  'dark',
  'neo-light',
  '[1,2]',
  'null',
];

describe('the pre-paint bootstrap and the theme module resolve identically', () => {
  it('publishes the same data-theme for every stored value, in both OS modes', () => {
    for (const raw of STORED_VALUES) {
      for (const systemDark of [true, false]) {
        const { attributes } = runBootstrap(raw, systemDark);
        expect(attributes['data-theme']).toBe(expectedAttribute(raw, systemDark));
      }
    }
  });

  it('publishes the same style, palette and resolved mode for every stored value', () => {
    for (const raw of STORED_VALUES) {
      for (const systemDark of [true, false]) {
        const { attributes } = runBootstrap(raw, systemDark);
        const preference = parseThemePreference(raw);
        expect(attributes['data-style']).toBe(preference.style);
        expect(attributes['data-palette']).toBe(preference.palette);
        expect(attributes['data-mode']).toBe(resolveThemeMode(preference.mode, systemDark));
      }
    }
  });

  it('accepts exactly the styles and palettes the catalogue lists', () => {
    const ids = (list: { readonly id: string }[]) => list.map(entry => entry.id);
    expect(source).toContain(
      `var STYLES = [${ids([...STYLES])
        .map(id => `'${id}'`)
        .join(', ')}];`,
    );
    for (const palette of ids([...PALETTES])) expect(source).toContain(`'${palette}',`);
    for (const style of ids([...STYLES])) {
      const { attributes } = runBootstrap(
        record({ style, palette: 'studio', mode: 'light', textScale: 'default' }),
        false,
      );
      expect(attributes['data-style']).toBe(style);
    }
    for (const palette of ids([...PALETTES])) {
      const { attributes } = runBootstrap(
        record({ style: 'studio', palette, mode: 'light', textScale: 'default' }),
        false,
      );
      expect(attributes['data-palette']).toBe(palette);
    }
  });

  it('publishes the text scale and the same factor the module applies', () => {
    for (const raw of STORED_VALUES) {
      const { attributes, properties } = runBootstrap(raw, false);
      const scale = parseThemePreference(raw).textScale;
      expect(attributes['data-text-scale']).toBe(scale);
      expect(properties['--fy-text-scale']).toBe(String(TEXT_SCALE_FACTORS[scale]));
    }
  });

  it('restates the removed-palette table the contract owns', () => {
    for (const [removed, kept] of Object.entries(REMOVED_PALETTE_IDS)) {
      expect(source).toContain(`${removed}: '${kept}',`);
      const { attributes } = runBootstrap(
        record({ style: 'studio', palette: removed, mode: 'light', textScale: 'default' }),
        false,
      );
      expect(attributes['data-palette']).toBe(kept);
    }
  });

  it('reads the one key the module owns, and no other', () => {
    const keys: string[] = [];
    runBootstrap(null, false, {
      getItem: (key: string) => {
        keys.push(key);
        return null;
      },
    });
    expect(keys).toEqual([THEME_PREFERENCES_KEY]);
  });

  it('falls back to the house theme when storage itself throws', () => {
    const { attributes } = runBootstrap(null, true, {
      getItem: () => {
        throw new Error('storage is blocked');
      },
    });
    expect(attributes['data-theme']).toBe(expectedAttribute(null, true));
  });

  it('resolves light when the OS cannot be asked at all', () => {
    // `window.matchMedia` is absent in some embedded webviews; the module's own
    // `osPrefersDark` guards for it the same way.
    const attributes: Record<string, string> = {};
    const bootstrap = new Function('localStorage', 'window', 'document', source) as (
      localStorage: unknown,
      window: unknown,
      document: unknown,
    ) => void;
    bootstrap(
      { getItem: () => null },
      {},
      {
        documentElement: {
          setAttribute: (name: string, value: string) => {
            attributes[name] = value;
          },
          style: { setProperty: () => undefined },
        },
      },
    );
    expect(attributes['data-theme']).toBe('studio-light');
  });
});
