/**
 * THE CATALOGUE of the theme axes: which STYLES and PALETTES exist, what they are called, and which style a palette
 * suggests. The ids are `STYLE_IDS` / `PALETTE_IDS` in the Layouts contract (the one list, so a theme item and this app
 * cannot disagree); this file adds everything a picker needs and nothing a stylesheet decides.
 *
 *   style   HOW things are drawn   `styles/style/<id>.css`    type, radii, strokes, shadow geometry, spacing, motion
 *   palette WHICH colours          `styles/palette/<id>.css`  seed colours, status/syntax hues, shadow colours
 *   mode    light | dark                                      a third axis: any style takes any palette in either mode
 *
 * `styles/themes.css` says where every token lives; `tests/unit/theme-axes.test.ts` pins that the files, this list and
 * `public/pre-paint.js` agree.
 */
import {
  PALETTE_IDS,
  type PaletteId,
  STYLE_IDS,
  THEME_FAMILY_IDS,
  type StyleId,
} from '@ferretry/plugin-layouts/contract';

export { PALETTE_IDS, type PaletteId, STYLE_IDS, type StyleId };
/** The pre-split single "family" id (what a stored preference and a theme item's `base` used to name). */
export type ThemeFamilyId = (typeof THEME_FAMILY_IDS)[number];

export interface StyleEntry {
  readonly id: StyleId;
  /** Picker label. */
  readonly label: string;
  /** One line on how it draws, not what colour it is. */
  readonly blurb: string;
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
  /** The style this palette was drawn for, and the one the legacy single-pick "look" list pairs it with. */
  readonly suggestedStyle: StyleId;
}

/** Order is the order shown. A style EARNS a row by differing structurally, never by recolouring another. */
export const STYLES: readonly StyleEntry[] = Object.freeze([
  { id: 'studio', label: 'Studio', blurb: 'The house look: soft blurred shadows, calm rounded surfaces.' },
  { id: 'mission', label: 'Mission Control', blurb: 'A ruled instrument grid, square mono controls, hairlines.' },
  { id: 'neo', label: 'Neo-Brutalism', blurb: 'Hard rules, flat offset shadows, black display weights.' },
  { id: 'geist', label: 'Geist', blurb: 'Hairline rules, small precise type, airy engineered minimalism.' },
  { id: 'contrast', label: 'High Contrast', blurb: 'Maximum legibility, 2px edges, no effects.' },
  {
    id: 'glass',
    label: 'Glassmorphism',
    blurb: 'Frosted translucent panels over a soft colour field, big radii, light edges.',
  },
  {
    id: 'neumorphism',
    label: 'Neumorphism',
    blurb: 'Soft forms moulded from one ground: paired light and dark shadows, pressed in when chosen.',
  },
  {
    id: 'retro',
    label: 'Retro Desktop',
    blurb: 'An early-2000s desktop: bevelled buttons, sunken fields, gradient title strips, hard drop shadows.',
  },
  {
    id: 'lucid',
    label: 'Lucid',
    blurb: 'Glossy pill controls, soft deep shadows, a springy halo focus, system fonts.',
  },
  {
    id: 'hud',
    label: 'HUD',
    blurb: 'A sci-fi heads-up display: corner brackets, thin lit rules, a soft signal glow, scan-lines.',
  },
] as const);

export const PALETTES: readonly PaletteEntry[] = Object.freeze([
  { id: 'studio', label: 'Studio', blurb: 'Indigo on cool zinc.', suggestedStyle: 'studio' },
  {
    id: 'mission',
    label: 'Mission Control',
    blurb: 'Cyan signal on near-black, deep teal on white.',
    suggestedStyle: 'mission',
  },
  { id: 'neo', label: 'Neo-Brutalism', blurb: 'Cream paper, black ink, one electric blue.', suggestedStyle: 'neo' },
  { id: 'geist', label: 'Geist', blurb: 'Near-absolute black and white, one blue accent.', suggestedStyle: 'geist' },
  { id: 'contrast', label: 'High Contrast', blurb: 'Pure black and white, AAA-targeted.', suggestedStyle: 'contrast' },
  { id: 'phosphor', label: 'Phosphor', blurb: 'A green CRT terminal.', suggestedStyle: 'mission' },
  {
    id: 'blueprint',
    label: 'Blueprint',
    blurb: 'Technical drawing: cyan lines on drafting blue.',
    suggestedStyle: 'mission',
  },
  { id: 'broadsheet', label: 'Broadsheet', blurb: 'Newsprint ink on warm paper.', suggestedStyle: 'geist' },
  { id: 'wayfinding', label: 'Wayfinding', blurb: 'Transit-signage blue and white.', suggestedStyle: 'neo' },
  { id: 'ledger', label: 'Ledger', blurb: 'Green-bar accounting paper, restrained ink.', suggestedStyle: 'geist' },
  { id: 'ma', label: 'Ma', blurb: 'Quiet paper, one rose accent.', suggestedStyle: 'geist' },
  {
    id: 'vaporwave',
    label: 'Vaporwave',
    blurb: 'Lilac haze, magenta and teal neon, night purple.',
    suggestedStyle: 'studio',
  },
  {
    id: 'cyberpunk',
    label: 'Cyberpunk',
    blurb: 'Neon yellow and hot pink on blue-black asphalt.',
    suggestedStyle: 'mission',
  },
  { id: 'hacker', label: 'Hacker', blurb: 'Matrix green on pure graphite.', suggestedStyle: 'mission' },
  { id: 'vintage', label: 'Vintage analog', blurb: 'Sepia paper, rust and mustard.', suggestedStyle: 'geist' },
  {
    id: 'mesh',
    label: 'Gradient mesh',
    blurb: 'Violet, rose and sky glows behind calm panels.',
    suggestedStyle: 'studio',
  },
  {
    id: 'retrofuture',
    label: 'Retro futurism',
    blurb: 'Space-age navy, sunset orange and teal.',
    suggestedStyle: 'neo',
  },
] as const);

export const DEFAULT_STYLE: StyleId = 'studio';
export const DEFAULT_PALETTE: PaletteId = 'studio';
const DEFAULT_FAMILY: ThemeFamilyId = 'studio';

export const isStyleId = (value: unknown): value is StyleId =>
  typeof value === 'string' && (STYLE_IDS as readonly string[]).includes(value);
export const isPaletteId = (value: unknown): value is PaletteId =>
  typeof value === 'string' && (PALETTE_IDS as readonly string[]).includes(value);
export const isFamilyId = (value: unknown): value is ThemeFamilyId =>
  typeof value === 'string' && (THEME_FAMILY_IDS as readonly string[]).includes(value);

/**
 * The single-pick LOOK the picker shows as selected for a palette. A family id is a palette id only for the eleven
 * ORIGINAL palettes (`THEME_FAMILY_IDS` is frozen at the pre-split list); a palette added later is not a family, so the
 * picker falls back to the default look rather than the type system demanding a new frozen entry. Read-side only.
 */
export const familyOfPalette = (palette: PaletteId): ThemeFamilyId => (isFamilyId(palette) ? palette : DEFAULT_FAMILY);

/**
 * What a single-pick look of a PALETTE is on the three axes: the palette itself and the style it was drawn for. Takes
 * any palette, so a palette added later needs no family entry to be previewed; an id no palette answers to is the
 * default look.
 */
export function lookOfPalette(palette: PaletteId): { readonly style: StyleId; readonly palette: PaletteId } {
  const entry = PALETTES.find(candidate => candidate.id === palette);
  return { style: entry?.suggestedStyle ?? DEFAULT_STYLE, palette: isPaletteId(palette) ? palette : DEFAULT_PALETTE };
}

/** What a pre-split family (a stored `family`, a theme item's `base`) is on the three axes. A family id is a palette id. */
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
