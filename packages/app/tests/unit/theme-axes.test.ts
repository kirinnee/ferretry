/**
 * THE THREE THEME AXES (style · palette · mode) AND THE ONE RULE THAT KEEPS THEM APART: a STYLE pack
 * (`theme/packs/style/<id>/style.css`) holds no colour value and a PALETTE pack (`theme/packs/palette/<id>/palette.ts`) holds no non-colour token. `styles/themes.css` names where every token lives; this suite is the
 * thing that fails when a token wanders, when the catalogue and the files disagree, or when a stored id with no pack
 * stops reading as the default. The ids are the pack folders the generator found: no test here (or anywhere in the
 * app) lists them.
 */
import { describe, expect, it } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ThemeSchema } from '@ferretry/plugin-layouts/contract';
import { THEME_PACKS_DIR, THEME_PACKS_TS, themePackFiles } from '../../../../scripts/gen/lib/theme-packs.ts';
import { memoryStore } from '../../src/storage/records.ts';
import { APP_STORAGE } from '../../src/storage/names.ts';
import {
  DEFAULT_PALETTE,
  DEFAULT_STYLE,
  PALETTES,
  STYLES,
  defaultPaletteOf,
  isPaletteId,
  isStyleId,
  swatchAttributes,
} from '../../src/theme/catalog.ts';
import { PALETTE_IDS, PALETTE_PACKS, STYLE_IDS, STYLE_PACKS } from '../../src/generated/theme-packs.ts';
import { ThemePreferenceStore } from '../../src/theme/preferences.ts';
import {
  readPaletteCss,
  readStyleFile,
  readStylePackCss,
  readThemeCss,
  themeStylesDir,
} from '../../src/testing/theme-css.ts';

const repoRoot = resolve(import.meta.dir, '../../../..');
const SCRATCH_STYLE = 'zz-scratch-style';
const SCRATCH_PALETTE = 'zz-scratch-palette';
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

/** What is wrong with a style pack's stylesheet: a colour literal, a token a palette owns, or a rule not keyed by the pack's own id. */
function styleViolations(style: string, css: string): string[] {
  const bare = withoutComments(css);
  const problems: string[] = [];
  const colour = bare.match(LITERAL_COLOUR);
  if (colour !== null) problems.push(`colour literal ${colour[0]}`);
  for (const name of declared(css)) if (!baseStyle.has(name)) problems.push(`not a style-owned token: ${name}`);
  const selectors = [...bare.matchAll(/(?:^|[{}])([^{}]+)\{/gu)].map(match => (match[1] as string).trim());
  // At-rules (`@media`, `@keyframes`) and a keyframe's own stops (`from`, `to`, `40%`) are not selectors to key.
  const keyed = selectors.filter(selector => !selector.startsWith('@') && !/^(?:from|to|\d+%)$/u.test(selector));
  for (const selector of keyed) {
    if (!selector.includes(`[data-style='${style}']`)) problems.push(`unscoped selector: ${selector}`);
    if (selector.includes('data-palette')) problems.push(`selector reads a palette: ${selector}`);
  }
  return problems;
}

describe('style packs are non-colour only', () => {
  for (const style of STYLE_IDS)
    it(`${style}: no colour value, no palette-owned token, and every rule keyed by its own style (and optionally the mode)`, () => {
      expect(styleViolations(style, readStylePackCss(style))).toEqual([]);
    });

  it('refuses a style pack with a colour literal, a palette token or an unscoped selector', () => {
    const scoped = ":root[data-style='x'],\n[data-swatch][data-style='x'] { --radius-md: 4px; }";
    expect(styleViolations('x', scoped)).toEqual([]);
    expect(styleViolations('x', ":root[data-style='x'] { --radius-md: 4px; color: #fff; }")).toEqual([
      'colour literal #fff',
    ]);
    expect(styleViolations('x', ":root[data-style='x'] { --accent: red; }")).toEqual([
      'not a style-owned token: --accent',
    ]);
    expect(styleViolations('x', '.btn { --radius-md: 4px; }')).toEqual(['unscoped selector: .btn']);
    expect(styleViolations('x', ":root[data-style='y'] { --radius-md: 4px; }")).toEqual([
      "unscoped selector: :root[data-style='y']",
    ]);
  });
});

describe('palette packs are colour only', () => {
  for (const palette of PALETTE_IDS) {
    const css = readPaletteCss(palette);
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
  it('has a style pack folder per id and a palette pack folder per id, and nothing else', () => {
    expect(readdirSync(join(themeStylesDir, '../theme/packs/style')).sort()).toEqual([...STYLE_IDS].sort());
    expect(STYLE_PACKS.map(pack => pack.id)).toEqual([...STYLE_IDS]);
    expect(existsSync(join(themeStylesDir, 'style'))).toBe(false);
    expect(readdirSync(join(themeStylesDir, '../theme/packs/palette')).sort()).toEqual([...PALETTE_IDS].sort());
    expect(PALETTE_PACKS.map(pack => pack.id)).toEqual([...PALETTE_IDS]);
  });

  it('imports every file themes.css lists, floors last', () => {
    const imports = [...readStyleFile('themes.css').matchAll(/^@import '([^']+)';/gmu)].map(
      match => match[1] as string,
    );
    // A style is not listed here: its pack's `style.css` arrives through the generated stylesheet below.
    expect(imports.filter(each => each.includes('style/'))).toEqual([]);
    expect(imports.at(-1)).toBe('./tokens/floors.css');
    const generated = readStyleFile('../generated/theme-packs.css');
    for (const id of STYLE_IDS) expect(generated).toContain(`@import '../theme/packs/style/${id}/style.css';`);
    // Every style and palette arrives through the ONE generated stylesheet, which themes.css imports once, AFTER the bases and
    // BEFORE the floors: a base block (`:root[data-mode='dark']`, the `max-width: 640px` sizes) is as specific as a style block, so a
    // base that came after a style would win over it, and a floor must come after every style.
    expect(imports.filter(each => each === '../generated/theme-packs.css')).toHaveLength(1);
    expect(imports.indexOf('../generated/theme-packs.css')).toBeGreaterThan(
      imports.indexOf('./tokens/base-palette.css'),
    );
    expect(imports.indexOf('../generated/theme-packs.css')).toBeLessThan(imports.indexOf('./tokens/floors.css'));
    const index = [...readStyleFile('index.css').matchAll(/^@import '([^']+)';/gmu)].map(match => match[1] as string);
    expect(index).not.toContain('../generated/theme-packs.css');
    // The resolved text really contains each block, so a typo in an import path cannot hide.
    for (const id of STYLE_IDS) expect(readThemeCss()).toContain(`[data-style='${id}']`);
    for (const id of PALETTE_IDS) expect(readThemeCss()).toContain(`[data-palette='${id}']`);
  });

  it('lists in the catalogue exactly the packs the generator found, in the same order', () => {
    expect(STYLES.map(entry => entry.id)).toEqual([...STYLE_IDS]);
    expect(PALETTES.map(entry => entry.id)).toEqual([...PALETTE_IDS]);
    // Every style comes with a palette that exists.
    for (const style of STYLES) expect(PALETTE_IDS).toContain(style.defaultPalette);
    for (const id of STYLE_IDS) expect(isStyleId(id)).toBe(true);
    for (const id of PALETTE_IDS) expect(isPaletteId(id)).toBe(true);
  });

  it('has 12 palettes, each with its own proper name from its pack, and none a plain colour word', () => {
    expect(PALETTES.map(entry => entry.label)).toEqual([
      'Inkwell',
      'Skyline',
      'Sonar',
      'Pop Art',
      'Terminal',
      'Rustbelt',
      'Vaporwave',
      'Gradient mesh',
      'Aurora',
      'Afterglow',
      'Briefing',
      'High contrast',
    ]);
    // The pack is the one owner of its name: the catalogue reads every label from it, so a rename is an edit to that pack alone.
    expect(PALETTES.map(entry => [entry.id, entry.label])).toEqual(PALETTE_PACKS.map(pack => [pack.id, pack.label]));
    expect(new Set(PALETTES.map(entry => entry.label)).size).toBe(PALETTES.length);
    const COLOUR_WORDS = [
      'indigo',
      'blue',
      'teal',
      'pop',
      'green',
      'rust',
      'magenta',
      'red',
      'orange',
      'purple',
      'pink',
    ];
    for (const palette of PALETTES) expect(COLOUR_WORDS).not.toContain(palette.label.toLowerCase());
    // No palette is named after a style, except Briefing (the owner asked for the Briefing palette beside the Briefing style).
    const styleNames = STYLES.map(entry => entry.label.toLowerCase());
    for (const palette of PALETTES)
      if (palette.id !== 'briefing') expect(styleNames).not.toContain(palette.label.toLowerCase());
  });

  it('gives every style the default palette the plan names', () => {
    expect(Object.fromEntries(STYLES.map(entry => [entry.id, entry.defaultPalette]))).toEqual({
      studio: 'studio',
      geist: 'geist',
      swiss: 'geist',
      briefing: 'briefing',
      retro: 'geist',
      mission: 'mission',
      hud: 'mission',
      neo: 'neo',
      raw: 'neo',
      exaggerated: 'hacker',
      lucid: 'mesh',
      glass: 'aurora',
      neumorphism: 'afterglow',
      pixel: 'hacker',
      genz: 'vaporwave',
      antiposh: 'vintage',
    });
  });

  it('names no style after a trademark and bundles no font for Lucid', () => {
    expect(STYLES.map(entry => `${entry.id} ${entry.label}`.toLowerCase()).join(' ')).not.toContain('aqua');
    const css = readStylePackCss('lucid');
    expect(css).not.toMatch(/\bInter\b|JetBrains/u);
  });

  it('reads the catalogue from the style packs: their order, their labels, and the one default', () => {
    expect(STYLES.map(entry => [entry.id, entry.label, entry.blurb, entry.defaultPalette])).toEqual(
      STYLE_PACKS.map(pack => [pack.id, pack.label, pack.blurb, pack.defaultPalette]),
    );
    expect(STYLE_PACKS.filter(pack => 'default' in pack).map(pack => pack.id)).toEqual(['studio']);
    expect(DEFAULT_STYLE).toBe('studio');
  });

  it('lets a style declare it fights the readability rules, and only a style', () => {
    for (const style of STYLES) expect(['undefined', 'boolean']).toContain(typeof style.loud);
    // The loud ones are named here, so a style cannot become loud (contrast misses only warn) without somebody saying so.
    expect(STYLES.filter(style => style.loud === true).map(style => style.id)).toEqual(['antiposh', 'genz']);
    for (const palette of PALETTES) expect(Object.keys(palette)).not.toContain('loud');
  });
});

describe('an id with no pack reads as the default and is never rewritten', () => {
  const stored = (value: unknown) => memoryStore({ [APP_STORAGE.theme]: JSON.stringify({ format: 1, value }) });

  for (const gone of ['contrast-style', 'zz', 'nope-id']) {
    it(`a stored style and palette "${gone}" read as the default look`, () => {
      const read = new ThemePreferenceStore(
        stored({ style: gone, palette: gone, mode: 'dark', textScale: 'large' }),
      ).snapshot();
      expect({ style: read.style, palette: read.palette }).toEqual({ style: DEFAULT_STYLE, palette: DEFAULT_PALETTE });
      // Every other field still reads on its own.
      expect(read.mode).toBe('dark');
      expect(read.textScale).toBe('large');
    });
  }

  it('reads one field on its own: a good palette beside a style with no pack stays', () => {
    const read = new ThemePreferenceStore(
      stored({ style: 'nope', palette: 'hacker', mode: 'light', textScale: 'default' }),
    ).snapshot();
    expect({ style: read.style, palette: read.palette }).toEqual({ style: DEFAULT_STYLE, palette: 'hacker' });
  });

  it('a `family` that is not a pre-split family id is an unknown key: ignored, not read', () => {
    const read = new ThemePreferenceStore(stored({ family: 'hacker', mode: 'dark', textScale: 'default' })).snapshot();
    expect({ style: read.style, palette: read.palette }).toEqual({ style: DEFAULT_STYLE, palette: DEFAULT_PALETTE });
    expect(Object.keys(read)).not.toContain('family');
  });

  it('keeps the stored record byte for byte until the next explicit change', () => {
    const store = stored({ style: 'ghost', palette: 'ghost', mode: 'dark', textScale: 'default' });
    const before = store.entries()[APP_STORAGE.theme];
    const themes = new ThemePreferenceStore(store);
    themes.snapshot();
    themes.adopt();
    expect(store.entries()[APP_STORAGE.theme]).toBe(before);
    themes.setMode('light');
    expect(JSON.parse(store.entries()[APP_STORAGE.theme] ?? '').value).toEqual({
      style: DEFAULT_STYLE,
      palette: DEFAULT_PALETTE,
      keepPalette: false,
      mode: 'light',
      textScale: 'default',
    });
  });
});

describe('the style → palette direction', () => {
  it('picking a style brings its default palette; picking a palette leaves the style alone', () => {
    const themes = new ThemePreferenceStore(memoryStore());
    themes.setStyle('neo');
    expect(themes.snapshot()).toMatchObject({ style: 'neo', palette: 'neo' });
    themes.setPalette('vintage');
    expect(themes.snapshot()).toMatchObject({ style: 'neo', palette: 'vintage' });
  });

  it('a style default applies only until a palette is picked; a picked palette survives every later style change (C-5)', () => {
    const store = memoryStore();
    const themes = new ThemePreferenceStore(store);
    themes.setStyle('neo');
    expect(themes.snapshot().palette).toBe(defaultPaletteOf('neo'));
    themes.setStyle('genz');
    expect(themes.snapshot().palette).toBe(defaultPaletteOf('genz'));
    // The owner's pick: Terminal (hacker), then a different style.
    themes.setPalette('hacker');
    themes.setStyle('geist');
    expect(themes.snapshot()).toMatchObject({ style: 'geist', palette: 'hacker' });
    themes.setStyle('neo');
    expect(themes.snapshot()).toMatchObject({ style: 'neo', palette: 'hacker' });
    expect(new ThemePreferenceStore(store).snapshot()).toMatchObject({ style: 'neo', palette: 'hacker' });
    // Turning the keep switch off hands the colours back to the style.
    themes.setKeepPalette(false);
    themes.setStyle('geist');
    expect(themes.snapshot()).toMatchObject({ style: 'geist', palette: defaultPaletteOf('geist') });
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

describe('a theme item names a style and a palette by pack id', () => {
  const item = { id: 'dusk', label: 'Dusk' };

  it('accepts any well-formed id, so a pack folder needs no edit to the Layouts contract', () => {
    for (const style of STYLE_IDS) expect(ThemeSchema.parse({ ...item, style }).style).toBe(style);
    for (const palette of PALETTE_IDS) expect(ThemeSchema.parse({ ...item, palette }).palette).toBe(palette);
    // an id with no pack still parses (the app falls back to the default look and the saved item is left as it is)
    expect(ThemeSchema.parse({ ...item, style: 'zz-gone', palette: 'zz-none' })).toMatchObject({
      style: 'zz-gone',
      palette: 'zz-none',
    });
    expect(ThemeSchema.safeParse(item).success).toBe(true);
  });

  it('refuses an id that is not shaped like a pack id', () => {
    for (const bad of ['', 'A', 'x', '9lives', 'two words', 'a'.repeat(33), 'a;b', 'url(x)'])
      expect(ThemeSchema.safeParse({ ...item, style: bad }).success).toBe(false);
    expect(ThemeSchema.safeParse({ ...item, palette: 7 }).success).toBe(false);
  });

  it('ignores a top-level key it does not name (the old `base`), and still refuses an unknown token or value', () => {
    expect(ThemeSchema.parse({ ...item, base: 'phosphor', note: 'x' })).toEqual({ ...item, light: {}, dark: {} });
    expect(ThemeSchema.safeParse({ ...item, light: { unknown: '#123456' } }).success).toBe(false);
    expect(ThemeSchema.safeParse({ ...item, dark: { bg: 'url(https://example.invalid/x)' } }).success).toBe(false);
  });

  it('round-trips a scratch style and palette that exist only as two folders in a private tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'fy-theme-item-ids-'));
    try {
      // A private copy of the shipped packs plus two scratch folders: the checkout is only read, never written.
      cpSync(join(repoRoot, THEME_PACKS_DIR), join(root, THEME_PACKS_DIR), { recursive: true });
      const palette = join(root, THEME_PACKS_DIR, 'palette', SCRATCH_PALETTE);
      const style = join(root, THEME_PACKS_DIR, 'style', SCRATCH_STYLE);
      mkdirSync(palette, { recursive: true });
      mkdirSync(style, { recursive: true });
      writeFileSync(
        join(palette, 'palette.ts'),
        `export default { id: '${SCRATCH_PALETTE}', label: 'Scratch Palette', blurb: 'Only a folder.', order: 9999, light: { bg: '#102030' }, dark: { bg: '#403020' } } as const;\n`,
      );
      writeFileSync(
        join(style, 'style.ts'),
        `export default { id: '${SCRATCH_STYLE}', label: 'Scratch Style', blurb: 'Only a folder.', order: 9999, defaultPalette: 'studio', fonts: { text: ['inter'], code: ['jetbrains-mono'] } } as const;\n`,
      );
      writeFileSync(join(style, 'style.css'), `:root[data-style='${SCRATCH_STYLE}'] { --radius-md: 3px; }\n`);
      const generated = themePackFiles(root).get(THEME_PACKS_TS) ?? '';
      const ids = (name: string): string[] =>
        [
          ...(new RegExp(`export const ${name} = \\[([^\\]]*)\\]`).exec(generated)?.[1] ?? '').matchAll(/"([^"]+)"/g),
        ].map(match => match[1] as string);
      // The generator found both folders (this is the id set the app builds with) ...
      expect(ids('STYLE_IDS')).toContain(SCRATCH_STYLE);
      expect(ids('PALETTE_IDS')).toContain(SCRATCH_PALETTE);
      // ... and a layout theme item naming them parses, with both ids intact.
      const parsed = ThemeSchema.parse({ ...item, style: SCRATCH_STYLE, palette: SCRATCH_PALETTE });
      expect(parsed).toMatchObject({ style: SCRATCH_STYLE, palette: SCRATCH_PALETTE });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
    // The checkout itself holds no scratch pack.
    expect(STYLE_IDS as readonly string[]).not.toContain(SCRATCH_STYLE);
    expect(PALETTE_IDS as readonly string[]).not.toContain(SCRATCH_PALETTE);
  });
});
