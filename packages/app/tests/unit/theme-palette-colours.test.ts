/**
 * THE SIX COLOUR-LED PALETTES (r10 T12: Vaporwave, Cyberpunk, Hacker, Vintage analog, Gradient mesh, Retro futurism).
 * Each is a complete, self-contained colour file in BOTH modes, so these checks read the CSS itself, with no browser:
 *   - every role a theme needs is declared, so nothing falls back to Studio LIGHT in a dark mode (the bug the compact
 *     palettes had before `tokens/derived.css`);
 *   - the readability pairs clear WCAG (text 4.5:1, control edge and focus ring 3:1), so a style that draws these
 *     colours inherits a readable page;
 *   - only Gradient mesh draws a `--surface-mesh`, and every palette names a suggested style that exists.
 * The cross-style matrix (T3) renders them; this is the part that needs no renderer.
 */
import { describe, expect, it } from 'bun:test';
import { PALETTES, STYLE_IDS } from '../../src/theme/catalog.ts';
import { readStyleFile } from '../../src/testing/theme-css.ts';

const NEW_PALETTES = ['vaporwave', 'cyberpunk', 'hacker', 'vintage', 'mesh', 'retrofuture', 'briefing'] as const;
const MODES = ['light', 'dark'] as const;

const withoutComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//gu, '');

/** The declarations of the one block `[data-palette='<id>'][data-mode='<mode>']`, by token name. */
function block(palette: string, mode: string): Record<string, string> {
  const css = withoutComments(readStyleFile(`palette/${palette}.css`));
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

describe('the six colour-led palettes are in the catalogue', () => {
  it('lists each once, with a suggested style that exists', () => {
    for (const id of NEW_PALETTES) {
      const entries = PALETTES.filter(palette => palette.id === id);
      expect(entries.length, id).toBe(1);
      expect(STYLE_IDS as readonly string[]).toContain(entries[0]?.suggestedStyle ?? '');
    }
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
          expect(ratio(hexOf('fg'), hexOf(surface)), `fg on ${surface}`).toBeGreaterThanOrEqual(7);
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

      it('sets the mesh only when it is Gradient mesh', () => {
        if (id === 'mesh') expect(tokens['--surface-mesh']).toContain('radial-gradient');
        else expect(tokens['--surface-mesh']).toBeUndefined();
      });
    });

describe('the mesh sits under the page wash and is `none` by default', () => {
  it('has a baseline of none, and the body paints the wash over the mesh', () => {
    expect(withoutComments(readStyleFile('tokens/base-palette.css'))).toContain('--surface-mesh: none;');
    expect(withoutComments(readStyleFile('index.css'))).toContain(
      'background-image: var(--body-wash), var(--surface-mesh);',
    );
  });
});
