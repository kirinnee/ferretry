/**
 * THE SELF-CONTAINED COLOUR PALETTES (ids vaporwave, hacker, vintage; C59 O6 brought back mesh and briefing and added aurora and
 * afterglow, so the gradient set is mesh, aurora, afterglow and the report set is briefing).
 * Each is a complete, self-contained colour file in BOTH modes, so these checks read the CSS itself, with no browser:
 *   - every role a theme needs is declared, so nothing falls back to Studio LIGHT in a dark mode (the bug the compact
 *     compact palettes had before they were removed);
 *   - the readability pairs clear WCAG (text 4.5:1, control edge and focus ring 3:1), so a style that draws these
 *     colours inherits a readable page;
 *   - a gradient palette (mesh, aurora, afterglow) draws a `--surface-mesh` of radial glows in BOTH modes, every other palette draws
 *     none, and the three original palettes are each the default of some style.
 * The cross-style matrix (T3) renders them; this is the part that needs no renderer.
 */
import { describe, expect, it } from 'bun:test';
import { PALETTE_PACKS } from '../../src/generated/theme-packs.ts';
import { DEFAULT_PALETTE, PALETTE_IDS, PALETTES, STYLES } from '../../src/theme/catalog.ts';
import { readPaletteCss, readStyleFile } from '../../src/testing/theme-css.ts';

const NEW_PALETTES = ['vaporwave', 'hacker', 'vintage', 'mesh', 'aurora', 'afterglow', 'briefing'] as const;
const STYLE_DEFAULTS = ['vaporwave', 'hacker', 'vintage'] as const;
const GRADIENT_PALETTES = ['mesh', 'aurora', 'afterglow', 'briefing'] as const;
const MODES = ['light', 'dark'] as const;

const withoutComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//gu, '');

/** The declarations of the one block `[data-palette='<id>'][data-mode='<mode>']`, by token name. */
function block(palette: string, mode: string): Record<string, string> {
  const css = withoutComments(readPaletteCss(palette));
  const rule = new RegExp(
    `:root\\[data-palette='${palette}'\\]\\[data-mode='${mode}'\\]\\s*,[^{]*\\{([^}]*)\\}`,
    'u',
  ).exec(css);
  expect(rule, `${palette} ${mode} block`).not.toBeNull();
  const out: Record<string, string> = {};
  for (const match of (rule?.[1] ?? '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/gu))
    out[match[1] as string] = (match[2] as string).trim();
  return out;
}

const channel = (value: number): number => {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string): number => {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};
const ratio = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/** Every role a palette must say for itself (the rest are shared by design: `--src-*`, the unused shadow slots, the inks derived from `--accent-rgb`). */
const ROLES = [
  'bg',
  'surface',
  'surface-2',
  'surface-3',
  'fg',
  'fg-soft',
  'muted',
  'faint',
  'chrome-fg',
  'border',
  'border-soft',
  'border-strong',
  'accent',
  'accent-rgb',
  'accent-fg',
  'accent-soft',
  'accent-border',
  'accent-strong',
  'user-bg',
  'user-border',
  'user-rail',
  'code-bg',
  'code-border',
  'code-fg',
  'ok',
  'ok-bg',
  'ok-border',
  'warn',
  'warn-bg',
  'warn-border',
  'err',
  'err-bg',
  'err-border',
  'pend',
  'pend-bg',
  'pend-border',
  'tool-bash',
  'tool-read',
  'tool-edit',
  'tool-write',
  'tool-patch',
  'tool-search',
  'tool-plan',
  'tool-wait',
  'tool-generic',
  'syn-comment',
  'syn-keyword',
  'syn-string',
  'syn-type',
  'syn-number',
  'syn-meta',
  'syn-addition',
  'syn-deletion',
  'bar-bg',
  'shadow-sm-1',
  'shadow-md-1',
  'shadow-md-2',
  'shadow-lg-1',
  'shadow-lg-2',
  'shadow-ink',
  'scrim',
  'ring',
  'focus-color',
  'selection-bg',
  'selection-fg',
  'nav-hover',
  'nav-sel-bg',
  'nav-sel-fg',
  'nav-sel-sub',
  'nav-sel-edge',
  'ground',
  'step-todo-edge',
  'step-rail',
  'step-seg',
  'step-seg-now',
] as const;

describe('the self-contained palettes are in the catalogue', () => {
  it('lists each once, as the default palette of a style', () => {
    for (const id of NEW_PALETTES) expect(PALETTES.filter(palette => palette.id === id).length, id).toBe(1);
    for (const id of STYLE_DEFAULTS)
      expect(
        STYLES.some(style => style.defaultPalette === id),
        id,
      ).toBe(true);
  });
});

for (const id of NEW_PALETTES)
  for (const mode of MODES)
    describe(`${id} ${mode}`, () => {
      const tokens = block(id, mode);
      const hexOf = (name: string): string => {
        const value = tokens[`--${name}`] ?? '';
        expect(value, `--${name} is a literal colour`).toMatch(/^#[0-9a-f]{6}$/u);
        return value;
      };

      it('declares every role itself (nothing falls back to Studio LIGHT)', () => {
        const missing = ROLES.filter(role => tokens[`--${role}`] === undefined);
        expect(missing).toEqual([]);
      });

      it('reads: body ink 7:1, muted ink and the accent as text 4.5:1 on every surface', () => {
        for (const surface of ['bg', 'surface', 'surface-2', 'surface-3', 'code-bg', 'user-bg']) {
          // Code is read in its own ink (a palette may draw code on a navy block in both modes: Briefing, as its reference does).
          const ink = surface === 'code-bg' ? 'code-fg' : 'fg';
          expect(ratio(hexOf(ink), hexOf(surface)), `${ink} on ${surface}`).toBeGreaterThanOrEqual(7);
          if (surface !== 'code-bg')
            expect(ratio(hexOf('muted'), hexOf(surface)), `muted on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
        for (const surface of ['bg', 'surface', 'surface-2'])
          expect(ratio(hexOf('accent'), hexOf(surface)), `accent on ${surface}`).toBeGreaterThanOrEqual(4.5);
        expect(ratio(hexOf('accent-fg'), hexOf('accent')), 'ink on an accent fill').toBeGreaterThanOrEqual(4.5);
        expect(ratio(hexOf('nav-sel-fg'), hexOf('nav-sel-bg')), 'selected nav row').toBeGreaterThanOrEqual(4.5);
        expect(ratio(hexOf('nav-sel-sub'), hexOf('nav-sel-bg')), 'selected nav row, sub line').toBeGreaterThanOrEqual(
          4.5,
        );
      });

      it('keeps the control edge and the focus ring at 3:1 on the page, a surface and a checked row', () => {
        for (const surface of ['bg', 'surface']) {
          expect(ratio(hexOf('border-strong'), hexOf(surface)), `edge on ${surface}`).toBeGreaterThanOrEqual(3);
          expect(ratio(hexOf('focus-color'), hexOf(surface)), `ring on ${surface}`).toBeGreaterThanOrEqual(3);
        }
        expect(ratio(hexOf('focus-color'), hexOf('nav-sel-bg')), 'ring on a checked row').toBeGreaterThanOrEqual(3);
      });

      it('keeps status ink readable on its own tint and on the surface, and syntax on the code ground', () => {
        for (const status of ['ok', 'warn', 'err']) {
          expect(ratio(hexOf(status), hexOf(`${status}-bg`)), `${status} on its tint`).toBeGreaterThanOrEqual(4.5);
          expect(ratio(hexOf(status), hexOf('surface')), `${status} on surface`).toBeGreaterThanOrEqual(4.5);
        }
        for (const syntax of ['comment', 'keyword', 'string', 'type', 'number', 'meta', 'addition', 'deletion'])
          expect(ratio(hexOf(`syn-${syntax}`), hexOf('code-bg')), `syntax ${syntax}`).toBeGreaterThanOrEqual(4.5);
        for (const tool of ['bash', 'read', 'edit', 'write', 'patch', 'search', 'plan', 'wait', 'generic'])
          expect(ratio(hexOf(`tool-${tool}`), hexOf('surface')), `tool ${tool}`).toBeGreaterThanOrEqual(3);
      });

      it('draws a gradient mesh only when it is a gradient palette', () => {
        const mesh = tokens['--surface-mesh'];
        if ((GRADIENT_PALETTES as readonly string[]).includes(id)) {
          expect(mesh, 'a gradient palette says its mesh').toBeDefined();
          expect(mesh?.match(/radial-gradient\(/gu)?.length, 'four glows').toBe(4);
        } else expect(mesh).toBeUndefined();
      });
    });

describe('the mesh token is `none` unless a gradient palette sets it (index.css paints it under the page wash, on the app background only)', () => {
  it('has a baseline of none, and the body paints the wash over the mesh', () => {
    expect(withoutComments(readStyleFile('tokens/base-palette.css'))).toContain('--surface-mesh: none;');
    expect(withoutComments(readStyleFile('index.css'))).toContain(
      'background-image: var(--bg-pattern), var(--body-wash), var(--surface-mesh);',
    );
  });
});

describe('palettes are packs: one folder each, discovered, nothing listed by hand (G2 U3)', () => {
  /** The `--surface-mesh` strings the four gradient palettes drew BEFORE they became data, copied from the base stylesheet. */
  const TODAYS_MESH: Readonly<Record<string, Readonly<Record<'light' | 'dark', string>>>> = {
    mesh: {
      light:
        'radial-gradient(70% 60% at 8% 6%, rgba(167, 139, 250, 0.6), transparent 72%), radial-gradient(65% 55% at 92% 14%, rgba(251, 146, 190, 0.5), transparent 72%), radial-gradient(70% 60% at 80% 94%, rgba(125, 211, 252, 0.55), transparent 72%), radial-gradient(55% 50% at 14% 88%, rgba(253, 224, 140, 0.4), transparent 72%)',
      dark: 'radial-gradient(70% 60% at 8% 6%, rgba(124, 58, 237, 0.62), transparent 72%), radial-gradient(65% 55% at 92% 14%, rgba(236, 72, 153, 0.46), transparent 72%), radial-gradient(70% 60% at 80% 94%, rgba(14, 165, 233, 0.5), transparent 72%), radial-gradient(55% 50% at 14% 88%, rgba(99, 102, 241, 0.42), transparent 72%)',
    },
    aurora: {
      light:
        'radial-gradient(70% 60% at 8% 6%, rgba(45, 212, 191, 0.5), transparent 72%), radial-gradient(65% 55% at 92% 14%, rgba(74, 222, 128, 0.4), transparent 72%), radial-gradient(70% 60% at 80% 94%, rgba(96, 165, 250, 0.5), transparent 72%), radial-gradient(55% 50% at 14% 88%, rgba(167, 243, 208, 0.45), transparent 72%)',
      dark: 'radial-gradient(70% 60% at 8% 6%, rgba(13, 148, 136, 0.55), transparent 72%), radial-gradient(65% 55% at 92% 14%, rgba(22, 163, 74, 0.38), transparent 72%), radial-gradient(70% 60% at 80% 94%, rgba(37, 99, 235, 0.5), transparent 72%), radial-gradient(55% 50% at 14% 88%, rgba(6, 182, 212, 0.38), transparent 72%)',
    },
    afterglow: {
      light:
        'radial-gradient(70% 60% at 8% 6%, rgba(253, 186, 116, 0.6), transparent 72%), radial-gradient(65% 55% at 92% 14%, rgba(251, 146, 160, 0.5), transparent 72%), radial-gradient(70% 60% at 80% 94%, rgba(244, 114, 182, 0.4), transparent 72%), radial-gradient(55% 50% at 14% 88%, rgba(253, 224, 140, 0.5), transparent 72%)',
      dark: 'radial-gradient(70% 60% at 8% 6%, rgba(234, 88, 12, 0.5), transparent 72%), radial-gradient(65% 55% at 92% 14%, rgba(225, 29, 72, 0.42), transparent 72%), radial-gradient(70% 60% at 80% 94%, rgba(219, 39, 119, 0.4), transparent 72%), radial-gradient(55% 50% at 14% 88%, rgba(217, 119, 6, 0.42), transparent 72%)',
    },
    briefing: {
      light:
        'radial-gradient(60% 50% at 94% 4%, rgba(85, 95, 255, 0.11), transparent 70%), radial-gradient(50% 42% at 4% 98%, rgba(249, 25, 116, 0.09), transparent 70%), radial-gradient(45% 40% at 6% 6%, rgba(85, 95, 255, 0.05), transparent 70%), radial-gradient(45% 40% at 96% 96%, rgba(249, 25, 116, 0.06), transparent 70%)',
      dark: 'radial-gradient(60% 50% at 94% 4%, rgba(85, 95, 255, 0.26), transparent 70%), radial-gradient(55% 46% at 4% 98%, rgba(249, 25, 116, 0.2), transparent 70%), radial-gradient(45% 40% at 6% 6%, rgba(85, 95, 255, 0.1), transparent 70%), radial-gradient(50% 42% at 96% 96%, rgba(249, 25, 116, 0.12), transparent 70%)',
    },
  };

  it('discovers every palette from its folder, in picker order, with exactly one default', () => {
    expect(PALETTE_PACKS.map(pack => pack.id)).toEqual([...PALETTE_IDS]);
    const orders = PALETTE_PACKS.map(pack => pack.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(new Set(orders).size).toBe(orders.length);
    expect(PALETTE_PACKS.filter(pack => 'default' in pack).map(pack => pack.id)).toEqual(['studio']);
    expect(DEFAULT_PALETTE).toBe('studio');
    expect(PALETTES.map(entry => entry.label)).toEqual(PALETTE_PACKS.map(pack => pack.label));
  });

  it('emits today’s gradient mesh strings exactly, for every gradient palette in both modes', () => {
    for (const id of GRADIENT_PALETTES)
      for (const mode of MODES) {
        const mesh = block(id, mode)['--surface-mesh'];
        expect(mesh?.replace(/\s+/gu, ' '), `${id} ${mode}`).toBe(TODAYS_MESH[id]?.[mode]);
      }
  });

  it('states in each dark block every token the default palette’s dark block sets, so the unqualified dark baseline changes none', () => {
    const baseline = Object.keys(PALETTE_PACKS.find(pack => 'default' in pack)?.dark ?? {});
    expect(baseline.length).toBeGreaterThan(50);
    for (const pack of PALETTE_PACKS)
      expect(
        baseline.filter(name => !(name in pack.dark)),
        `${pack.id} dark`,
      ).toEqual([]);
  });
});
