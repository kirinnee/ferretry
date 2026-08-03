/**
 * `public/pre-paint.js` must resolve the stored theme preference to exactly what
 * `lib/theme-preferences.ts` resolves it to.
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
import {
  parseThemePreference,
  resolveThemeMode,
  TEXT_SCALE_FACTORS,
  THEME_PREFERENCES_KEY,
  themeAttribute,
} from '../../src/lib/theme-preferences.ts';

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
  return themeAttribute(preference.family, resolveThemeMode(preference.mode, systemDark));
};

const STORED_VALUES: readonly (string | null)[] = [
  // Nothing stored at all, and the shapes an empty-ish value can take.
  null,
  '',
  '   ',
  // The current JSON shape, including per-field fallback for bad fields.
  '{"family":"mission","mode":"dark","textScale":"large"}',
  '{"family":"notebook","mode":"system","textScale":"larger"}',
  '{"family":"geist","mode":"light","textScale":"default"}',
  '{"family":"nope","mode":"dark","textScale":"huge"}',
  '{"mode":"light"}',
  '{}',
  // Corrupt JSON, and JSON that is not an object.
  '{"family":',
  '{oops}',
  // A bare mode.
  'dark',
  'light',
  'system',
  '  dark  ',
  // A bare resolved attribute, e.g. what `<html data-theme>` itself carries.
  'neo-light',
  'contrast-dark',
  'ember-system',
  'nope-dark',
  '-dark',
  // Values that resemble nothing.
  'purple',
  '[1,2]',
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

  it('publishes the text scale and the same adjustment percentage the module applies', () => {
    for (const raw of STORED_VALUES) {
      const { attributes, properties } = runBootstrap(raw, false);
      const scale = parseThemePreference(raw).textScale;
      const percent = `${TEXT_SCALE_FACTORS[scale] * 100}%`;
      expect(attributes['data-text-scale']).toBe(scale);
      expect(properties['text-size-adjust']).toBe(percent);
      expect(properties['-webkit-text-size-adjust']).toBe(percent);
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
