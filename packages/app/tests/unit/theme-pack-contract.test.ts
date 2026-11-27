/**
 * The pack schemas are the one thing the generator and the app share about a style, palette or font pack. They accept the
 * shapes the plan names, and refuse every colour that could fetch something, every token name that could escape its
 * declaration, and every unknown field.
 */
import { describe, expect, it } from 'bun:test';
import {
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
      a: '#abc',
      b: '#aabbccdd',
      c: 'rgba(167, 139, 250, 0.6)',
      d: 'hsl(210 40% 90%)',
      e: 'oklch(0.7 0.1 250 / 0.5)',
      f: 'transparent',
      g: 'var(--accent)',
      h: 'color-mix(in srgb, var(--tool-bash), var(--tool-edit))',
      i: 'color-mix(in oklch, var(--tool-bash) 40%, var(--tool-edit))',
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
});
