/**
 * THE THREE THEME AXES (style · palette · mode) AND THE ONE RULE THAT KEEPS THEM APART: a STYLE file holds no colour
 * value and a PALETTE file holds no non-colour token. `styles/themes.css` names where every token lives; this suite is the
 * thing that fails when a token wanders, when the catalogue and the files disagree, or when a stored pre-split
 * `family`, a removed palette or the removed `contrast` style stops reading as the look the migration names.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  PALETTE_IDS,
  REMOVED_PALETTE_IDS,
  STYLE_IDS,
  ThemeSchema,
  THEME_FAMILY_IDS,
} from '@ferretry/plugin-layouts/contract';
import { memoryStore } from '../../src/storage/records.ts';
import { APP_STORAGE } from '../../src/storage/names.ts';
import {
  PALETTES,
  STYLES,
  defaultPaletteOf,
  isFamilyId,
  isPaletteId,
  lookOfFamily,
  lookOfPalette,
  swatchAttributes,
  type PaletteId,
} from '../../src/theme/catalog.ts';
import { applyThemeAxes, ThemePreferenceStore } from '../../src/theme/preferences.ts';
import { applyWindowColour } from '../../src/shell/context.tsx';
import { readCssWithImports, readStyleFile, themeStylesDir } from '../../src/testing/theme-css.ts';

const withoutComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//gu, '');
const declared = (css: string): Set<string> =>
  new Set([...withoutComments(css).matchAll(/(--[\w-]+)\s*:/gu)].map(match => match[1] as string));
const files = (dir: string): string[] => readdirSync(join(themeStylesDir, dir)).sort();

/** A literal colour: a hex, or an `rgb`/`hsl`/`oklch`… call whose first argument is a NUMBER (a `var()` is a role, fine). */
const LITERAL_COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*[\d.]/iu;

const basePalette = declared(readStyleFile('tokens/base-palette.css'));
const baseStyle = declared(readStyleFile('tokens/base-style.css'));

describe('the token partition', () => {
  it('gives every token ONE owner: the two bases share no name', () => {
    expect([...basePalette].filter(name => baseStyle.has(name))).toEqual([]);
    expect(basePalette.size).toBeGreaterThan(80);
    expect(baseStyle.size).toBeGreaterThan(120);
  });

  it('keeps the new shadow, texture and motion seams where the plan put them', () => {
    for (const name of [
      '--motion-fast',
      '--motion-base',
      '--motion-slow',
      '--ease-standard',
      '--select-pop',
      '--press-translate',
    ])
      expect(baseStyle.has(name)).toBe(true);
    for (const name of ['--shadow-sm-1', '--shadow-md-3', '--shadow-lg-2', '--texture-ink'])
      expect(basePalette.has(name)).toBe(true);
    for (const name of ['--shadow-sm', '--shadow-md', '--shadow-lg', '--panel-texture'])
      expect(baseStyle.has(name)).toBe(true);
  });
});

describe('style files are non-colour only', () => {
  for (const style of STYLE_IDS) {
    const css = readStyleFile(`style/${style}.css`);
    it(`${style}: no colour value and no palette-owned token`, () => {
      expect(withoutComments(css)).not.toMatch(LITERAL_COLOUR);
      const stray = [...declared(css)].filter(name => !baseStyle.has(name));
      expect(stray).toEqual([]);
    });
    it(`${style}: every rule is keyed by its own style (and optionally the mode)`, () => {
      const selectors = [...withoutComments(css).matchAll(/(?:^|[{}])([^{}]+)\{/gu)].map(match =>
        (match[1] as string).trim(),
      );
      // At-rules (`@media`, `@keyframes`) and a keyframe's own stops (`from`, `to`, `40%`) are not selectors to key.
      const keyed = selectors.filter(selector => !selector.startsWith('@') && !/^(?:from|to|\d+%)$/u.test(selector));
      for (const selector of keyed) {
        expect(selector).toContain(`[data-style='${style}']`);
        expect(selector).not.toContain('data-palette');
      }
    });
  }
});

describe('palette files are colour only', () => {
  for (const palette of PALETTE_IDS) {
    const css = readStyleFile(`palette/${palette}.css`);
    it(`${palette}: no token that is not a colour role, and no \`color-scheme\``, () => {
      const stray = [...declared(css)].filter(name => !basePalette.has(name));
      expect(stray).toEqual([]);
      expect(withoutComments(css)).not.toContain('color-scheme');
    });
    it(`${palette}: every rule is keyed by its own palette (and optionally the mode)`, () => {
      const selectors = [...withoutComments(css).matchAll(/(?:^|[{}])([^{}]+)\{/gu)].map(match =>
        (match[1] as string).trim(),
      );
      for (const selector of selectors) {
        expect(selector).toContain(`[data-palette='${palette}']`);
        expect(selector).not.toContain('data-style');
      }
    });
  }

  it("the compact palettes' derived roles are gone with the palettes that needed them", () => {
    expect(files('tokens')).not.toContain('derived.css');
  });
});

describe('the catalogue, the files and themes.css agree', () => {
  it('has a style file and a palette file per id, and nothing else', () => {
    expect(files('style')).toEqual(STYLE_IDS.map(id => `${id}.css`).sort());
    expect(files('palette')).toEqual(PALETTE_IDS.map(id => `${id}.css`).sort());
  });

  it('imports every file themes.css lists, floors last', () => {
    const imports = [...readStyleFile('themes.css').matchAll(/^@import '([^']+)';/gmu)].map(
      match => match[1] as string,
    );
    for (const id of STYLE_IDS) expect(imports).toContain(`./style/${id}.css`);
    for (const id of PALETTE_IDS) expect(imports).toContain(`./palette/${id}.css`);
    expect(imports.at(-1)).toBe('./tokens/floors.css');
    expect(imports.indexOf('./tokens/floors.css')).toBeGreaterThan(
      imports.indexOf(`./palette/${PALETTE_IDS.at(-1)}.css`),
    );
    // The resolved text really contains each block, so a typo in an import path cannot hide.
    const css = readCssWithImports(join(themeStylesDir, 'themes.css'));
    for (const id of STYLE_IDS) expect(css).toContain(`[data-style='${id}']`);
    for (const id of PALETTE_IDS) expect(css).toContain(`[data-palette='${id}']`);
  });

  it('lists the same ids in the catalogue as in the Layouts contract, in the same order', () => {
    expect(STYLES.map(entry => entry.id)).toEqual([...STYLE_IDS]);
    expect(PALETTES.map(entry => entry.id)).toEqual([...PALETTE_IDS]);
    // Every style comes with a palette that exists; the removed ones map onto kept ones.
    for (const style of STYLES) expect(PALETTE_IDS).toContain(style.defaultPalette);
    for (const kept of Object.values(REMOVED_PALETTE_IDS)) expect(PALETTE_IDS).toContain(kept);
    for (const removed of Object.keys(REMOVED_PALETTE_IDS))
      expect(PALETTE_IDS as readonly string[]).not.toContain(removed);
    expect(STYLE_IDS as readonly string[]).not.toContain('contrast');
  });

  it('has 8 palettes, each named for a colour, and none named after a style', () => {
    expect(PALETTES.map(entry => entry.label)).toEqual([
      'Indigo',
      'Blue',
      'Teal',
      'Pop',
      'Green',
      'Rust',
      'Magenta',
      'High contrast',
    ]);
    const styleWords = STYLES.flatMap(entry => [entry.id, ...entry.label.toLowerCase().split(/\s+/u)]);
    for (const palette of PALETTES) expect(styleWords).not.toContain(palette.label.toLowerCase());
  });

  it('gives every style the default palette the plan names', () => {
    expect(Object.fromEntries(STYLES.map(entry => [entry.id, entry.defaultPalette]))).toEqual({
      studio: 'studio',
      geist: 'geist',
      swiss: 'geist',
      briefing: 'geist',
      retro: 'geist',
      mission: 'mission',
      hud: 'mission',
      neo: 'neo',
      raw: 'neo',
      exaggerated: 'studio',
      lucid: 'studio',
      glass: 'studio',
      neumorphism: 'studio',
      pixel: 'hacker',
      genz: 'vaporwave',
      antiposh: 'vintage',
    });
  });

  it('names no style after a trademark and bundles no font for Lucid', () => {
    expect(STYLES.map(entry => `${entry.id} ${entry.label}`.toLowerCase()).join(' ')).not.toContain('aqua');
    const css = readStyleFile('style/lucid.css');
    expect(css).not.toMatch(/\bInter\b|JetBrains/u);
  });

  it('lets a style declare it fights the readability rules, and only a style', () => {
    for (const style of STYLES) expect(['undefined', 'boolean']).toContain(typeof style.loud);
    // The loud ones are named here, so a style cannot become loud (contrast misses only warn) without somebody saying so.
    expect(STYLES.filter(style => style.loud === true).map(style => style.id)).toEqual(['antiposh', 'genz']);
    for (const palette of PALETTES) expect(Object.keys(palette)).not.toContain('loud');
  });
});

describe('a stored pre-split family reads as the palette it names, on the style that comes with it', () => {
  for (const family of THEME_FAMILY_IDS) {
    it(`${family}`, () => {
      const store = memoryStore({
        [APP_STORAGE.theme]: JSON.stringify({ format: 1, value: { family, mode: 'dark', textScale: 'large' } }),
      });
      const read = new ThemePreferenceStore(store).snapshot();
      expect({ style: read.style, palette: read.palette }).toEqual(
        lookOfFamily((REMOVED_PALETTE_IDS as Record<string, PaletteId>)[family] ?? (family as PaletteId)),
      );
      expect(read.keepPalette).toBe(false);
      expect(read.mode).toBe('dark');
      expect(read.textScale).toBe('large');
    });
  }

  it('an explicit style or palette beside a family wins, field by field', () => {
    const store = memoryStore({
      [APP_STORAGE.theme]: JSON.stringify({
        format: 1,
        value: { family: 'phosphor', style: 'neo', palette: 'nope', mode: 'light', textScale: 'default' },
      }),
    });
    const read = new ThemePreferenceStore(store).snapshot();
    expect({ style: read.style, palette: read.palette }).toEqual({ style: 'neo', palette: 'hacker' });
  });

  it('writes the new shape on the next change, so the old one is gone after one write', () => {
    const store = memoryStore({
      [APP_STORAGE.theme]: JSON.stringify({
        format: 1,
        value: { family: 'ledger', mode: 'dark', textScale: 'default' },
      }),
    });
    new ThemePreferenceStore(store).setMode('light');
    expect(JSON.parse(store.entries()[APP_STORAGE.theme] ?? '').value).toEqual({
      style: 'pixel',
      palette: 'hacker',
      keepPalette: false,
      mode: 'light',
      textScale: 'default',
    });
  });

  it('a single-pick look sets both axes', () => {
    const themes = new ThemePreferenceStore(memoryStore());
    themes.setFamily('hacker');
    expect(themes.snapshot()).toMatchObject({ style: 'pixel', palette: 'hacker', family: 'hacker' });
    themes.setFamily('contrast');
    expect(themes.snapshot()).toMatchObject({ style: 'studio', palette: 'contrast' });
  });
});

describe('the style → palette direction', () => {
  it('picking a style brings its default palette; picking a palette leaves the style alone', () => {
    const themes = new ThemePreferenceStore(memoryStore());
    themes.setStyle('neo');
    expect(themes.snapshot()).toMatchObject({ style: 'neo', palette: 'neo' });
    themes.setPalette('vintage');
    expect(themes.snapshot()).toMatchObject({ style: 'neo', palette: 'vintage' });
    themes.setStyle('genz');
    expect(themes.snapshot()).toMatchObject({ style: 'genz', palette: defaultPaletteOf('genz') });
  });

  it('with keepPalette on, a style change leaves the colours alone, and the flag is stored', () => {
    const store = memoryStore();
    const themes = new ThemePreferenceStore(store);
    themes.setPalette('vintage');
    themes.setKeepPalette(true);
    themes.setStyle('neo');
    expect(themes.snapshot()).toMatchObject({ style: 'neo', palette: 'vintage', keepPalette: true });
    expect(new ThemePreferenceStore(store).snapshot()).toMatchObject({ palette: 'vintage', keepPalette: true });
    themes.setKeepPalette(false);
    themes.setStyle('pixel');
    expect(themes.snapshot()).toMatchObject({ style: 'pixel', palette: 'hacker', keepPalette: false });
  });

  it('a stored {style:"contrast"} is Studio in the High contrast palette', () => {
    const store = memoryStore({
      [APP_STORAGE.theme]: JSON.stringify({
        format: 1,
        value: { style: 'contrast', palette: 'neo', mode: 'light', textScale: 'default' },
      }),
    });
    expect(new ThemePreferenceStore(store).snapshot()).toMatchObject({ style: 'studio', palette: 'contrast' });
  });

  for (const [removed, kept] of Object.entries(REMOVED_PALETTE_IDS)) {
    it(`a stored palette "${removed}" reads as "${kept}"`, () => {
      const store = memoryStore({
        [APP_STORAGE.theme]: JSON.stringify({
          format: 1,
          value: { style: 'neo', palette: removed, mode: 'light', textScale: 'default' },
        }),
      });
      expect(new ThemePreferenceStore(store).snapshot()).toMatchObject({ style: 'neo', palette: kept });
    });
  }
});

describe('a new palette needs no edit outside its own files', () => {
  // The seam's claim, exercised: register a scratch palette in PALETTE_IDS ALONE (THEME_FAMILY_IDS untouched) and
  // read it through the theme code. The signatures are pinned at compile time: window colour and the swatch take a
  // PALETTE, so a widened PaletteId typechecks without a frozen family entry.
  const windowColourTakesAPalette: (
    d: Parameters<typeof applyWindowColour>[0],
    p: PaletteId,
    r: 'light' | 'dark',
  ) => void = applyWindowColour;
  const swatchTakesAnyPalette: (palette: PaletteId) => unknown = lookOfPalette;
  const scratch = 'scratch-zz' as PaletteId;
  const ids = PALETTE_IDS as unknown as string[];
  beforeAll(() => ids.push(scratch));
  afterAll(() => ids.splice(ids.indexOf(scratch), 1));

  it('is a palette, not a legacy family', () => {
    expect(windowColourTakesAPalette).toBe(applyWindowColour);
    expect(swatchTakesAnyPalette).toBe(lookOfPalette);
    expect(isPaletteId(scratch)).toBe(true);
    expect(isFamilyId(scratch)).toBe(false);
    expect((THEME_FAMILY_IDS as readonly string[]).includes(scratch)).toBe(false);
  });

  it('is stored, read back and published on the root as its own palette', () => {
    const store = memoryStore();
    const themes = new ThemePreferenceStore(store);
    themes.setPalette(scratch);
    const read = new ThemePreferenceStore(store).snapshot();
    expect(read.palette).toBe(scratch);
    expect(read.family).toBe(scratch);
    const root = { dataset: {} as Record<string, string>, style: { setProperty() {} } } as unknown as HTMLElement;
    applyThemeAxes(root, read, 'dark');
    expect(root.dataset.palette).toBe(scratch);
  });

  it('previews as itself, and moves the window colour on its own manifest name', () => {
    expect(swatchAttributes(`${scratch}-dark`)).toMatchObject({ 'data-palette': scratch, 'data-mode': 'dark' });
    const attributes: Record<string, string> = { href: '/manifest-studio-light.abc.webmanifest' };
    const link = {
      getAttribute: (name: string) => attributes[name],
      setAttribute: (name: string, v: string) => (attributes[name] = v),
    };
    const document = { getElementById: () => link } as unknown as Parameters<typeof applyWindowColour>[0];
    applyWindowColour(document, scratch, 'dark');
    expect(attributes.href).toBe(`/manifest-${scratch}-dark.abc.webmanifest`);
  });
});

describe('a swatch wears the three axes', () => {
  it('turns the picker’s "<family>-<mode>" into style, palette and mode, keeping the legacy value', () => {
    expect(swatchAttributes('mission-dark')).toEqual({
      'data-swatch': 'mission-dark',
      'data-style': 'mission',
      'data-palette': 'mission',
      'data-mode': 'dark',
    });
    expect(swatchAttributes('hacker-light')).toMatchObject({
      'data-style': 'pixel',
      'data-palette': 'hacker',
      'data-mode': 'light',
    });
  });
});

describe('a theme item may name a style and a palette', () => {
  it('accepts them, still accepts the legacy `base`, and refuses an unknown id', () => {
    const item = { id: 'dusk', label: 'Dusk' };
    expect(ThemeSchema.safeParse({ ...item, style: 'neo', palette: 'vintage' }).success).toBe(true);
    expect(ThemeSchema.safeParse({ ...item, base: 'neo' }).success).toBe(true);
    expect(ThemeSchema.safeParse({ ...item, base: 'phosphor' }).success).toBe(true);
    expect(ThemeSchema.safeParse(item).success).toBe(true);
    expect(ThemeSchema.safeParse({ ...item, style: 'ma' }).success).toBe(false);
    expect(ThemeSchema.safeParse({ ...item, palette: 'nope' }).success).toBe(false);
  });

  it('reads a removed palette and the removed contrast style as the ones the migration names', () => {
    const item = { id: 'dusk', label: 'Dusk' };
    expect(ThemeSchema.parse({ ...item, palette: 'phosphor' }).palette).toBe('hacker');
    expect(ThemeSchema.parse({ ...item, palette: 'mesh', style: 'contrast' })).toMatchObject({
      palette: 'studio',
      style: 'studio',
    });
  });
});
