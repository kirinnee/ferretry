/**
 * Theme packs are discovered by the generator: a fixture pack tree under a temp root produces the two generated files, and
 * every way a pack can be wrong fails generation naming the pack path. Pack files here carry plain data (no imports), the
 * schema the generator checks them with is the app's own.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { staleFiles } from '../registries.ts';
import { THEME_PACKS_CSS, THEME_PACKS_TS, themePackFiles } from '../lib/theme-packs.ts';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const PACKS = 'packages/app/src/theme/packs';
const data = (value: unknown): string => `export default ${JSON.stringify(value, null, 2)};\n`;

const palette = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  label: `Palette ${id}`,
  blurb: 'A palette',
  order: 10,
  light: { bg: '#ffffff', fg: '#111111' },
  dark: { bg: '#000000', fg: '#eeeeee' },
  ...extra,
});
const style = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  label: `Style ${id}`,
  blurb: 'A style',
  order: 10,
  defaultPalette: 'ink',
  fonts: { text: ['inter'], code: [] },
  ...extra,
});
const font = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  family: 'Inter',
  licence: 'OFL-1.1',
  faces: [{ file: './inter.woff2', weight: '100 900', style: 'normal' }],
  range: 'latin',
  ...extra,
});

/** A valid tree: one default palette, one default style on it, one font. */
const GOOD: Record<string, string> = {
  'palette/ink/palette.ts': data(palette('ink', { default: true, order: 1 })),
  'palette/dawn/palette.ts': data(palette('dawn', { order: 5 })),
  'style/studio/style.ts': data(style('studio', { default: true, order: 1 })),
  'style/studio/style.css': "[data-style='studio'] { --radius-xs: 2px; }\n",
  'font/inter/font.ts': data(font('inter')),
  'font/inter/inter.woff2': 'wOF2',
};

const tree = (files: Readonly<Record<string, string>>): string => {
  const root = mkdtempSync(join(tmpdir(), 'theme-packs-'));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const file = join(root, PACKS, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return root;
};
const fail = (files: Readonly<Record<string, string>>): string => {
  try {
    themePackFiles(tree(files));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('generation succeeded');
};

describe('theme pack generation', () => {
  test('no packs is valid: empty lists and an empty stylesheet', () => {
    const files = themePackFiles(tree({}));
    expect([...files.keys()]).toEqual([THEME_PACKS_TS, THEME_PACKS_CSS]);
    expect(files.get(THEME_PACKS_TS)).toContain('export const PALETTE_PACKS = [\n] as const;');
    expect(files.get(THEME_PACKS_TS)).toContain('export const STYLE_IDS = [\n] as const;');
    expect(files.get(THEME_PACKS_CSS)).not.toContain('{');
  });

  test('a fixture pack tree produces the expected lists and stylesheet', () => {
    const files = themePackFiles(tree(GOOD));
    const ts = files.get(THEME_PACKS_TS) ?? '';
    expect(ts).toContain("import palette_ink from '../theme/packs/palette/ink/palette.ts';");
    expect(ts).toContain("import style_studio from '../theme/packs/style/studio/style.ts';");
    expect(ts).toContain("import font_inter from '../theme/packs/font/inter/font.ts';");
    expect(ts).toContain('export const PALETTE_PACKS = [\n  palette_ink,\n  palette_dawn,\n] as const;');
    expect(ts).toContain('export const PALETTE_IDS = [\n  "ink",\n  "dawn",\n] as const;');
    expect(ts).toContain('export const STYLE_IDS = [\n  "studio",\n] as const;');
    expect(ts).toContain('export const FONT_IDS = [\n  "inter",\n] as const;');
    const css = files.get(THEME_PACKS_CSS) ?? '';
    // @import first, then fonts, the default palette's dark baseline, then every palette in order.
    expect(css.indexOf("@import '../theme/packs/style/studio/style.css';")).toBeLessThan(css.indexOf('@font-face'));
    expect(css).toContain("font-family: 'Inter';");
    expect(css).toContain("src: url('../theme/packs/font/inter/inter.woff2') format('woff2');");
    expect(css).toContain(
      ":root[data-mode='dark'],\n[data-swatch][data-mode='dark'] {\n  --bg: #000000;\n  --fg: #eeeeee;\n}",
    );
    expect(css).toContain(
      ":root[data-palette='dawn'][data-mode='light'],\n[data-swatch][data-palette='dawn'][data-mode='light'] {\n  --bg: #ffffff;\n  --fg: #111111;\n}",
    );
    expect(css.indexOf("[data-palette='ink'][data-mode='light']")).toBeLessThan(css.indexOf("[data-palette='dawn']"));
  });

  test('order is the `order` field, then the id', () => {
    const files = themePackFiles(
      tree({
        ...GOOD,
        'palette/zed/palette.ts': data(palette('zed', { order: 5 })),
        'palette/amber/palette.ts': data(palette('amber', { order: 5 })),
        'palette/first/palette.ts': data(palette('first', { order: -3 })),
      }),
    );
    expect(files.get(THEME_PACKS_TS)).toContain(
      'export const PALETTE_IDS = [\n  "first",\n  "ink",\n  "amber",\n  "dawn",\n  "zed",\n] as const;',
    );
  });

  test('a mesh becomes one `--surface-mesh` of radial gradients in its mode', () => {
    const glow = { w: 70, h: 60, x: 8, y: 6, colour: 'rgba(167, 139, 250, 0.6)', fade: 72 };
    const css =
      themePackFiles(
        tree({
          ...GOOD,
          'palette/dawn/palette.ts': data(palette('dawn', { mesh: { light: [glow, glow], dark: [] } })),
        }),
      ).get(THEME_PACKS_CSS) ?? '';
    const light = css.slice(css.indexOf("[data-palette='dawn'][data-mode='light']"));
    expect(light).toContain(
      '  --surface-mesh:\n    radial-gradient(70% 60% at 8% 6%, rgba(167, 139, 250, 0.6), transparent 72%),\n    radial-gradient(70% 60% at 8% 6%, rgba(167, 139, 250, 0.6), transparent 72%);',
    );
    expect(css.slice(css.indexOf("[data-palette='dawn'][data-mode='dark']"))).not.toContain('--surface-mesh');
  });
});

describe('a broken pack fails generation and names the pack path', () => {
  test('a folder that is not the pack id', () => {
    const message = fail({ ...GOOD, 'palette/dusk/palette.ts': data(palette('dawn', { order: 6 })) });
    expect(message).toContain(`${PACKS}/palette/dusk/palette.ts: id "dawn" must equal its folder name "dusk"`);
  });

  test('a duplicate id', () => {
    const message = fail({ ...GOOD, 'palette/dusk/palette.ts': data(palette('dawn', { order: 6 })) });
    expect(message).toContain('duplicate palette id "dawn"');
  });

  test('two defaults, or none', () => {
    expect(fail({ ...GOOD, 'palette/dawn/palette.ts': data(palette('dawn', { default: true })) })).toContain(
      `${PACKS}/palette: exactly one palette pack must be \`default: true\`, found 2`,
    );
    const noDefault = { ...GOOD, 'palette/ink/palette.ts': data(palette('ink')) };
    expect(fail(noDefault)).toContain('exactly one palette pack must be `default: true`, found 0');
  });

  test('a font a style names that is not a pack', () => {
    const message = fail({
      ...GOOD,
      'style/studio/style.ts': data(style('studio', { default: true, fonts: { text: ['nope'], code: [] } })),
    });
    expect(message).toContain(`${PACKS}/style/studio/style.ts: fonts: "nope" is not a font pack`);
  });

  test('a font file that is not there, a style.css that is not there', () => {
    expect(
      fail({
        ...GOOD,
        'font/inter/font.ts': data(
          font('inter', { faces: [{ file: './gone.woff2', weight: '400', style: 'normal' }] }),
        ),
      }),
    ).toContain(`${PACKS}/font/inter/font.ts: faces: ./gone.woff2 does not exist`);
    const { 'style/studio/style.css': _css, ...withoutCss } = GOOD;
    expect(fail(withoutCss)).toContain(`${PACKS}/style/studio/style.ts: style.css does not exist beside it`);
  });

  test('a default palette that is not a palette pack', () => {
    const message = fail({
      ...GOOD,
      'style/studio/style.ts': data(style('studio', { default: true, defaultPalette: 'ghost' })),
    });
    expect(message).toContain('defaultPalette "ghost" is not a palette pack');
  });

  test('a `url()` or an image in a colour, in a plain value or inside color-mix', () => {
    for (const bad of [
      'url(https://x.test/a.png)',
      'url(data:image/png;base64,AA)',
      'color-mix(in srgb, url(x) 50%, red)',
      'red; } body { x: y',
    ]) {
      const message = fail({ ...GOOD, 'palette/dawn/palette.ts': data(palette('dawn', { light: { bg: bad } })) });
      expect(message).toContain(`${PACKS}/palette/dawn/palette.ts: light.bg`);
    }
  });

  test('a token name that is not a custom-property name, and an unknown field', () => {
    expect(
      fail({
        ...GOOD,
        'palette/dawn/palette.ts': data(palette('dawn', { light: { 'color-scheme: dark; --x': '#fff' } })),
      }),
    ).toContain(`${PACKS}/palette/dawn/palette.ts: light`);
    expect(fail({ ...GOOD, 'palette/dawn/palette.ts': data(palette('dawn', { extra: 1 })) })).toContain(
      `${PACKS}/palette/dawn/palette.ts`,
    );
  });

  test('a folder with no pack file, and a pack file that does not load', () => {
    expect(fail({ ...GOOD, 'palette/lonely/notes.txt': 'x' })).toContain(`${PACKS}/palette/lonely/palette.ts: missing`);
    expect(fail({ ...GOOD, 'palette/dawn/palette.ts': 'export default {;\n' })).toContain(
      `${PACKS}/palette/dawn/palette.ts: does not load`,
    );
  });

  test('a mesh and a `surface-mesh` token on the same palette', () => {
    const glow = { w: 1, h: 1, x: 1, y: 1, colour: '#fff', fade: 1 };
    const message = fail({
      ...GOOD,
      'palette/dawn/palette.ts': data(
        palette('dawn', { light: { 'surface-mesh': '#fff' }, mesh: { light: [glow], dark: [] } }),
      ),
    });
    expect(message).toContain('light.surface-mesh: set by `mesh` already');
  });
});

describe('--check', () => {
  test('reports a stale generated file, and a new pack folder changes the output with no list edited', () => {
    const root = tree(GOOD);
    const before = themePackFiles(root);
    expect(staleFiles(root, before, true).sort()).toEqual([
      `${THEME_PACKS_CSS} (missing)`,
      `${THEME_PACKS_TS} (missing)`,
    ]);
    for (const [rel, text] of before) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    expect(staleFiles(root, before, true)).toEqual([]);
    writeFileSync(
      join(root, PACKS, 'palette/ink/palette.ts'),
      data(palette('ink', { default: true, order: 1, light: { bg: '#fafafa' } })),
    );
    mkdirSync(join(root, PACKS, 'palette/new'), { recursive: true });
    writeFileSync(join(root, PACKS, 'palette/new/palette.ts'), data(palette('new', { order: 20 })));
    const after = themePackFiles(root);
    expect(staleFiles(root, after, true).sort()).toEqual([THEME_PACKS_CSS, THEME_PACKS_TS]);
    expect(after.get(THEME_PACKS_TS)).toContain('palette_new');
    expect(after.get(THEME_PACKS_CSS)).toContain('#fafafa');
  });
});
