/**
 * THE CATALOGUE of the theme axes: which STYLES and PALETTES exist, what they are called, and which palette a style
 * comes with. The ids are `STYLE_IDS` / `PALETTE_IDS` in the Layouts contract (the one list, so a theme item and this app
 * cannot disagree); this file adds everything a picker needs and nothing a stylesheet decides.
 *
 *   style   HOW things are drawn   `theme/packs/style/<id>/`  type, radii, strokes, shadow geometry, spacing, motion
 *   palette WHICH colours          `theme/packs/palette/<id>/` seed colours, status/syntax hues, shadow colours
 *   mode    light | dark                                      a third axis: any style takes any palette in either mode
 *
 * `styles/themes.css` says where every token lives; `tests/unit/theme-axes.test.ts` pins that the files, this list and
 * `public/pre-paint.js` agree.
 */
import {
  currentPaletteId,
  currentStyleId,
  PALETTE_IDS,
  type PaletteId,
  STYLE_IDS,
  THEME_FAMILY_IDS,
  type StyleId,
} from '@ferretry/plugin-layouts/contract';
import { PALETTE_PACKS, STYLE_PACKS } from '../generated/theme-packs.ts';

export { PALETTE_IDS, type PaletteId, STYLE_IDS, type StyleId };
/** A single-pick look is a palette (with the style that comes with it): the family ids ARE the palette ids now. */
export type ThemeFamilyId = PaletteId;

export interface StyleEntry {
  readonly id: StyleId;
  /** Picker label. */
  readonly label: string;
  /** One line on how it draws, not what colour it is. */
  readonly blurb: string;
  /** The palette picking this style brings (unless the device keeps its colours). A style is how things are drawn, not a colour. */
  readonly defaultPalette: PaletteId;
  /**
   * A style that DELIBERATELY fights the readability rules (owner, 2026-11-19: "its ok some style fights readability
   * rules"). The contrast matrix reports a contrast miss for it as a warning row, not a failure; the focus ring and the
   * no-overflow checks stay hard for every style. Absent means false.
   */
  readonly loud?: boolean;
}

export interface PaletteEntry {
  readonly id: PaletteId;
  readonly label: string;
  /** One line on the colours. */
  readonly blurb: string;
}

/**
 * Order is the order shown: each style pack's own `order` (a style EARNS a row by differing structurally, never by
 * recolouring another). A style's label, blurb, default palette and `loud` flag live on its pack
 * (`theme/packs/style/<id>/style.ts`), so there is no second list of them.
 */
export const STYLES: readonly StyleEntry[] = Object.freeze(
  STYLE_PACKS.map(
    (pack): StyleEntry => ({
      id: pack.id,
      label: pack.label,
      blurb: pack.blurb,
      defaultPalette: pack.defaultPalette,
      ...('loud' in pack ? { loud: true } : {}),
    }),
  ),
);

/**
 * Order is the order shown: each palette pack's own `order`. A palette's name and blurb live on its pack
 * (`theme/packs/palette/<id>/palette.ts`), so there is no second map of names. High contrast is a palette: it must pass on
 * every style. Mesh, Aurora, Afterglow and Briefing paint a gradient mesh behind the page (`--surface-mesh`).
 */
export const PALETTES: readonly PaletteEntry[] = Object.freeze(
  PALETTE_PACKS.map(({ id, label, blurb }): PaletteEntry => ({ id, label, blurb })),
);

/** The style pack flagged `default: true` (the generator pins that there is exactly one). */
export const DEFAULT_STYLE: StyleId = STYLE_PACKS.find(pack => 'default' in pack)?.id ?? STYLE_PACKS[0].id;
/** The palette pack flagged `default: true` (the generator pins that there is exactly one). */
export const DEFAULT_PALETTE: PaletteId = PALETTE_PACKS.find(pack => 'default' in pack)?.id ?? PALETTE_PACKS[0].id;

export const isPaletteId = (value: unknown): value is PaletteId =>
  typeof value === 'string' && (PALETTE_IDS as readonly string[]).includes(value);
export const isFamilyId = (value: unknown): value is ThemeFamilyId =>
  typeof value === 'string' && (THEME_FAMILY_IDS as readonly string[]).includes(value);

/** A stored `family` (pre-split), read on the new axes: the kept palette it names. `undefined` when it names none. */
export const paletteOfFamily = (family: unknown): PaletteId | undefined =>
  isFamilyId(family) ? currentPaletteId(family) : undefined;

/** The stored style id, read on the current axes (the removed `contrast` style is Studio, in the High contrast palette). */
export { currentPaletteId, currentStyleId };

/** What picking a style brings: its default palette. */
export const defaultPaletteOf = (style: StyleId): PaletteId =>
  STYLES.find(entry => entry.id === style)?.defaultPalette ?? DEFAULT_PALETTE;

/**
 * The single-pick LOOK of a PALETTE: the palette and the first style that comes with it, or Studio when none does (High
 * contrast is a colour, so it is on Studio). An id no palette answers to is the default look.
 */
export function lookOfPalette(palette: PaletteId): { readonly style: StyleId; readonly palette: PaletteId } {
  if (!isPaletteId(palette)) return { style: DEFAULT_STYLE, palette: DEFAULT_PALETTE };
  return { style: STYLES.find(entry => entry.defaultPalette === palette)?.id ?? DEFAULT_STYLE, palette };
}

/** What a single-pick family is on the three axes. A family id is a palette id. */
export function lookOfFamily(family: ThemeFamilyId): { readonly style: StyleId; readonly palette: PaletteId } {
  return lookOfPalette(family);
}

/**
 * The attributes a preview element wears to render in a look of its own, whatever the page around it is
 * (`[data-swatch]` re-declares every token locally, `styles/themes.css`). `theme` is a single-pick look plus a mode,
 * `"<palette>-<light|dark>"` (the picker's own vocabulary: a palette with the style it was drawn for).
 */
export function swatchAttributes(
  theme: string,
): Readonly<Record<'data-swatch' | 'data-style' | 'data-palette' | 'data-mode', string>> {
  const cut = theme.lastIndexOf('-');
  const palette = theme.slice(0, cut);
  const mode = theme.slice(cut + 1) === 'dark' ? 'dark' : 'light';
  const look = lookOfPalette(isPaletteId(palette) ? palette : DEFAULT_PALETTE);
  return { 'data-swatch': theme, 'data-style': look.style, 'data-palette': look.palette, 'data-mode': mode };
}
