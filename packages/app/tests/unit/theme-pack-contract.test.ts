/**
 * The pack schemas are the one thing the generator and the app share about a style, palette or font pack. They accept the
 * shapes the plan names, and refuse every colour that could fetch something, every token name that could escape its
 * declaration, and every unknown field.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RENDER_PALETTE_TOKENS, RENDER_STYLE_TOKENS } from '../../src/theme/render-contract.ts';
import {
  AccentRgbSchema,
  isPaletteToken,
  isStyleToken,
  PALETTE_TOKENS,
  STYLE_TOKENS,
  FontPackSchema,
  PackIdSchema,
  PalettePackSchema,
  StylePackSchema,
  TokenNameSchema,
} from '../../src/theme/pack-contract.ts';

const palette = (light: Record<string, string> = { bg: '#fff' }) => ({
  id: 'ink',
  label: 'Ink',
  blurb: 'Quiet',
  order: 1,
  light,
  dark: { bg: '#000' },
});

describe('pack ids and token names', () => {
  it('takes a lowercase kebab id of 2 to 32 characters, and nothing else', () => {
    for (const ok of ['ink', 'studio-2', 'a1']) expect(PackIdSchema.safeParse(ok).success).toBe(true);
    for (const bad of ['', 'a', 'Ink', '1ink', 'in k', 'in_k', '../x', 'a'.repeat(33)])
      expect(PackIdSchema.safeParse(bad).success).toBe(false);
  });

  it('takes a custom-property name without its dashes, never a declaration', () => {
    for (const ok of ['bg', 'surface-2', 'viz-1']) expect(TokenNameSchema.safeParse(ok).success).toBe(true);
    for (const bad of ['--bg', 'Bg', 'bg;x', 'bg: red', 'color-scheme: dark; --x', ''])
      expect(TokenNameSchema.safeParse(bad).success).toBe(false);
  });
});

describe('a palette pack', () => {
  it('accepts hex, rgb, hsl, oklch, transparent, var() and color-mix colours', () => {
    const light = {
      bg: '#abc',
      fg: '#aabbccdd',
      surface: 'rgba(167, 139, 250, 0.6)',
      muted: 'hsl(210 40% 90%)',
      faint: 'oklch(0.7 0.1 250 / 0.5)',
      scrim: 'transparent',
      ring: 'var(--accent)',
      'tool-generic': 'color-mix(in srgb, var(--tool-bash), var(--tool-edit))',
      'tool-plan': 'color-mix(in oklch, var(--tool-bash) 40%, var(--tool-edit))',
    };
    expect(PalettePackSchema.safeParse(palette(light)).success).toBe(true);
  });

  it('refuses a colour that fetches, runs or escapes', () => {
    for (const bad of [
      'url(https://x.test/a.png)',
      'url(data:image/svg+xml;base64,AA)',
      'image-set(x)',
      'expression(alert(1))',
      'color-mix(in srgb, url(x) 50%, red)',
      'color-mix(in srgb, red) ) (',
      'red',
      '#fff; background: url(x)',
      '#fff } body { x: y',
      'var(--a) /* x */',
    ])
      expect(PalettePackSchema.safeParse(palette({ bg: bad })).success).toBe(false);
  });

  it('refuses an unknown field, a bad mesh and a default that is not `true`', () => {
    expect(PalettePackSchema.safeParse({ ...palette(), extra: 1 }).success).toBe(false);
    expect(PalettePackSchema.safeParse({ ...palette(), default: false }).success).toBe(false);
    const glow = { w: 70, h: 60, x: 8, y: 6, colour: '#7c3aed', fade: 72 };
    expect(PalettePackSchema.safeParse({ ...palette(), mesh: { light: [glow], dark: [] } }).success).toBe(true);
    expect(
      PalettePackSchema.safeParse({ ...palette(), mesh: { light: [{ ...glow, colour: 'var(--x)' }], dark: [] } })
        .success,
    ).toBe(false);
    expect(PalettePackSchema.safeParse({ ...palette(), mesh: { light: Array(7).fill(glow), dark: [] } }).success).toBe(
      false,
    );
  });
});

describe('a style pack and a font pack', () => {
  const style = {
    id: 'studio',
    label: 'Studio',
    blurb: 'Plain',
    order: 1,
    defaultPalette: 'ink',
    fonts: { text: ['inter'], code: ['mono'] },
  };
  it('takes the style meta, with `loud` only as `true`', () => {
    expect(StylePackSchema.safeParse(style).success).toBe(true);
    expect(StylePackSchema.safeParse({ ...style, loud: true }).success).toBe(true);
    expect(StylePackSchema.safeParse({ ...style, loud: false }).success).toBe(false);
    expect(StylePackSchema.safeParse({ ...style, fonts: { text: [], code: ['a', 'b', 'c'] } }).success).toBe(false);
    expect(StylePackSchema.safeParse({ ...style, css: 'x' }).success).toBe(false);
  });

  const font = {
    id: 'inter',
    family: 'Inter',
    licence: 'OFL-1.1',
    range: 'latin',
    faces: [{ file: './inter.woff2', weight: '100 900', style: 'normal' }],
  };
  it('takes a family and faces whose files sit beside the pack file', () => {
    expect(FontPackSchema.safeParse(font).success).toBe(true);
    for (const file of ['inter.woff2', '../inter.woff2', './dir/inter.woff2', './inter.ttf', 'https://x.test/a.woff2'])
      expect(FontPackSchema.safeParse({ ...font, faces: [{ ...font.faces[0], file }] }).success).toBe(false);
    expect(FontPackSchema.safeParse({ ...font, faces: [] }).success).toBe(false);
    expect(FontPackSchema.safeParse({ ...font, family: "Inter'; x" }).success).toBe(false);
    expect(FontPackSchema.safeParse({ ...font, range: 'cyrillic' }).success).toBe(false);
  });

  it('takes a weight or a range of weights from 1 to 1000, as CSS does', () => {
    const accepts = (weight: string) =>
      FontPackSchema.safeParse({ ...font, faces: [{ ...font.faces[0], weight }] }).success;
    for (const weight of ['1', '400', '950', '1000', '200 1000', '1 1000']) expect(accepts(weight)).toBe(true);
    for (const weight of ['0', '1001', '2000', '200 1001', '0 900', '', 'bold', '400 ', '400  700'])
      expect(accepts(weight)).toBe(false);
  });
});

describe('the token partition: a pack writes only what its kind owns', () => {
  const both = (token: string, value: string) => ({
    ...palette(),
    light: { [token]: value },
    dark: { [token]: value },
  });

  it('refuses a palette that declares a style-owned token, in either mode', () => {
    for (const token of ['motion-fast', 'radius-xs', 'font-prose', 'weight-strong', 'hm-shape', 'md-h1-size'])
      for (const mode of ['light', 'dark'] as const)
        expect(PalettePackSchema.safeParse({ ...palette(), [mode]: { [token]: 'var(--accent)' } }).success).toBe(false);
  });

  it('refuses a palette token nobody owns', () => {
    expect(PalettePackSchema.safeParse(palette({ 'made-up': '#fff' })).success).toBe(false);
  });

  it('refuses a palette that reads a style-owned token (var() or color-mix)', () => {
    expect(PalettePackSchema.safeParse(both('ring', 'var(--motion-slow)')).success).toBe(false);
    expect(PalettePackSchema.safeParse(both('ring', 'var(--radius-xs)')).success).toBe(false);
    expect(
      PalettePackSchema.safeParse(both('tool-plan', 'color-mix(in srgb, var(--accent), var(--motion-slow))')).success,
    ).toBe(false);
    expect(PalettePackSchema.safeParse(both('ring', 'var(--accent)')).success).toBe(true);
  });

  it('answers which kind owns a name', () => {
    expect([isPaletteToken('accent'), isStyleToken('accent')]).toEqual([true, false]);
    expect([isPaletteToken('motion-fast'), isStyleToken('motion-fast')]).toEqual([false, true]);
    expect([isPaletteToken('made-up'), isStyleToken('made-up')]).toEqual([false, false]);
  });

  it('takes the renderer-read tokens from render-contract.ts, one owner each', () => {
    for (const name of RENDER_PALETTE_TOKENS) expect([isPaletteToken(name), isStyleToken(name)]).toEqual([true, false]);
    for (const name of RENDER_STYLE_TOKENS) expect([isPaletteToken(name), isStyleToken(name)]).toEqual([false, true]);
  });

  it('owns every name in exactly one list, and the two lists share none', () => {
    expect(PALETTE_TOKENS.filter(name => (STYLE_TOKENS as readonly string[]).includes(name))).toEqual([]);
    expect(PALETTE_TOKENS).toContain('accent-rgb');
    expect(STYLE_TOKENS).toContain('motion-fast');
  });

  it("matches the base token files' partition until the packs replace them", () => {
    const declared = (file: string): string[] => {
      const css = readFileSync(join(import.meta.dir, '../../src/styles/tokens', file), 'utf8').replace(
        /\/\*[\s\S]*?\*\//gu,
        '',
      );
      return [...new Set([...css.matchAll(/(?<![\w-])--([a-z0-9-]+)\s*:/gu)].map(match => match[1] as string))].sort();
    };
    expect([...PALETTE_TOKENS].sort() as string[]).toEqual(declared('base-palette.css'));
    expect([...STYLE_TOKENS].sort() as string[]).toEqual(declared('base-style.css'));
  });
});

describe('the accent-rgb channel triplet', () => {
  const rgb = (light: unknown, extra: Record<string, unknown> = {}) => ({
    ...palette(),
    light: { 'accent-rgb': light, ...extra },
    dark: { 'accent-rgb': [127, 212, 255] },
  });

  it('takes three integers 0-255 on accent-rgb, and nothing else', () => {
    expect(AccentRgbSchema.safeParse([1, 2, 3]).success).toBe(true);
    expect(AccentRgbSchema.safeParse([1, 2, 256]).success).toBe(false);
    expect(PalettePackSchema.safeParse(rgb([79, 82, 214])).success).toBe(true);
    expect(PalettePackSchema.safeParse(rgb([0, 0, 0])).success).toBe(true);
    expect(PalettePackSchema.safeParse(rgb([255, 255, 255])).success).toBe(true);
    for (const bad of [
      [256, 0, 0],
      [-1, 0, 0],
      [1.5, 0, 0],
      [1, 2],
      [1, 2, 3, 4],
      ['1', '2', '3'],
      '79 82 214',
      [Number.NaN, 0, 0],
    ])
      expect(PalettePackSchema.safeParse(rgb(bad)).success).toBe(false);
  });

  it('refuses a triplet on any other key, and a colour on accent-rgb', () => {
    expect(PalettePackSchema.safeParse(palette({ accent: [1, 2, 3] as unknown as string })).success).toBe(false);
    expect(PalettePackSchema.safeParse(rgb('#fff')).success).toBe(false);
    expect(PalettePackSchema.safeParse(rgb('rgb(1 2 3)')).success).toBe(false);
  });

  it('takes exactly rgb(var(--accent-rgb) / <alpha 0..1>) as a colour, on any palette token', () => {
    for (const ok of [
      'rgb(var(--accent-rgb) / 0.05)',
      'rgb(var(--accent-rgb) / 0)',
      'rgb(var(--accent-rgb) / 1)',
      'rgb(var(--accent-rgb) / .5)',
    ])
      expect(PalettePackSchema.safeParse(palette({ 'texture-ink': ok })).success).toBe(true);
    for (const bad of [
      'rgb(var(--accent-rgb) / 1.5)',
      'rgb(var(--accent-rgb) / 2)',
      'rgb(var(--accent-rgb))',
      'rgb(var(--accent-rgb) / var(--glow-alpha))',
      'rgb(var(--accent-rgb) / 0.5) url(x)',
      'rgb(var(--motion-slow) / 0.5)',
      'rgb(var(--fg) / 0.5)',
      'rgba(var(--accent-rgb) / 0.5)',
      'rgb(var(--accent-rgb) 0.5)',
    ])
      expect(PalettePackSchema.safeParse(palette({ 'texture-ink': bad })).success).toBe(false);
  });

  it("validates today's accent palette values", () => {
    const today = {
      'accent-rgb': [79, 82, 214],
      'texture-ink': 'rgb(var(--accent-rgb) / 0.05)',
      'grid-ink-major': 'rgb(var(--accent-rgb) / 0.1)',
      'grid-ink-minor': 'rgb(var(--accent-rgb) / 0.05)',
    };
    expect(PalettePackSchema.safeParse({ ...palette(), light: today, dark: today }).success).toBe(true);
  });
});
