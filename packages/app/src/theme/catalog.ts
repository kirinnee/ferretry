/**
 * THE CATALOGUE of the theme axes: which STYLES and PALETTES exist, what they are called, and which palette a style
 * comes with. The ids are `STYLE_IDS` / `PALETTE_IDS` in the Layouts contract (the one list, so a theme item and this app
 * cannot disagree); this file adds everything a picker needs and nothing a stylesheet decides.
 *
 *   style   HOW things are drawn   `styles/style/<id>.css`    type, radii, strokes, shadow geometry, spacing, motion
 *   palette WHICH colours          `styles/palette/<id>.css`  seed colours, status/syntax hues, shadow colours
 *   mode    light | dark                                      a third axis: any style takes any palette in either mode
 *
 * `styles/themes.css` says where every token lives; `tests/unit/theme-axes.test.ts` pins that the files, this list and
 * `public/pre-paint.js` agree.
 */
import { PALETTE_IDS, type PaletteId, STYLE_IDS, type StyleId } from '@ferretry/plugin-layouts/contract';
import { PALETTE_NAMES } from './palette-names.ts';

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

/** Order is the order shown. A style EARNS a row by differing structurally, never by recolouring another. */
export const STYLES: readonly StyleEntry[] = Object.freeze([
  {
    id: 'studio',
    label: 'Studio',
    blurb: 'The house look: soft blurred shadows, calm rounded surfaces.',
    defaultPalette: 'studio',
  },
  {
    id: 'mission',
    label: 'Mission Control',
    blurb: 'A ruled instrument grid, square mono controls, hairlines.',
    defaultPalette: 'mission',
  },
  {
    id: 'neo',
    label: 'Neo-Brutalism',
    blurb: 'Hard rules, flat offset shadows, black display weights.',
    defaultPalette: 'neo',
  },
  {
    id: 'geist',
    label: 'Geist',
    blurb: 'Hairline rules, small precise type, airy engineered minimalism.',
    defaultPalette: 'geist',
  },
  {
    id: 'glass',
    label: 'Glassmorphism',
    blurb: 'Frosted translucent panels over a soft colour field, big radii, light edges.',
    defaultPalette: 'aurora',
  },
  {
    id: 'neumorphism',
    label: 'Neumorphism',
    blurb: 'Soft forms moulded from one ground: paired light and dark shadows, pressed in when chosen.',
    defaultPalette: 'afterglow',
  },
  {
    id: 'retro',
    label: 'Retro Desktop',
    blurb: 'An early-2000s desktop: bevelled buttons, sunken fields, gradient title strips, hard drop shadows.',
    defaultPalette: 'geist',
  },
  {
    id: 'lucid',
    label: 'Lucid',
    blurb: 'Glossy pill controls, soft deep shadows, a springy halo focus, system fonts.',
    defaultPalette: 'mesh',
  },
  {
    id: 'hud',
    label: 'HUD',
    blurb: 'A sci-fi heads-up display: corner brackets, thin lit rules, a soft signal glow, scan-lines.',
    defaultPalette: 'mission',
  },
  {
    id: 'raw',
    label: 'Raw Brutalism',
    blurb: 'The unstyled web on purpose: system serif and mono, square boxes, hard rules, no shadows.',
    defaultPalette: 'neo',
  },
  {
    id: 'swiss',
    label: 'Minimal Swiss',
    blurb: 'Ruled, flat and square: one tight grotesque, space instead of boxes.',
    defaultPalette: 'geist',
  },
  {
    id: 'pixel',
    label: 'Pixel art',
    blurb: 'Bitmap type, 2px blocks, flat offset shadows, stepped motion.',
    defaultPalette: 'hacker',
  },
  {
    id: 'antiposh',
    label: 'Anti-posh',
    blurb: 'Photocopied zine: typewriter type, dashed edges, off-register hard shadows. Rough on purpose.',
    defaultPalette: 'vintage',
    loud: true,
  },
  {
    id: 'briefing',
    label: 'Briefing',
    blurb:
      'A calm written report: Poppins, mono numbers, pill controls, 16px panels, soft shadows, an indigo focus ring.',
    defaultPalette: 'briefing',
  },
  {
    id: 'genz',
    label: 'Gen Z Maximalism',
    blurb: 'Loud on purpose: bubble type, sticker tags, stacked colour shadows, a spring on every pick.',
    defaultPalette: 'vaporwave',
    loud: true,
  },
  {
    id: 'exaggerated',
    label: 'Exaggerated Minimalism',
    blurb: 'Huge hair-thin titles, vast air, one hairline for everything, no shadows.',
    defaultPalette: 'hacker',
  },
] as const);

/**
 * Order is the order shown. A palette's display name lives in `palette-names.ts` (the one map; never a style's name); the
 * ids are the ones a device stores.
 * High contrast is a palette: it must pass on every style. Mesh, Aurora, Afterglow and Briefing paint a gradient mesh behind the page (`--surface-mesh`).
 */
export const PALETTES: readonly PaletteEntry[] = Object.freeze([
  { id: 'studio', label: PALETTE_NAMES.studio, blurb: 'Indigo on cool zinc.' },
  { id: 'geist', label: PALETTE_NAMES.geist, blurb: 'Near-absolute black and white, one blue accent.' },
  { id: 'mission', label: PALETTE_NAMES.mission, blurb: 'Cyan signal on near-black, deep teal on white.' },
  { id: 'neo', label: PALETTE_NAMES.neo, blurb: 'Cream paper, black ink, one electric blue.' },
  { id: 'hacker', label: PALETTE_NAMES.hacker, blurb: 'Matrix green on pure graphite.' },
  { id: 'vintage', label: PALETTE_NAMES.vintage, blurb: 'Sepia paper, rust and mustard.' },
  { id: 'vaporwave', label: PALETTE_NAMES.vaporwave, blurb: 'Lilac haze, magenta and teal neon, night purple.' },
  { id: 'mesh', label: PALETTE_NAMES.mesh, blurb: 'Violet, rose and sky glows blended behind the page.' },
  { id: 'aurora', label: PALETTE_NAMES.aurora, blurb: 'Teal, green and blue glows, like northern lights.' },
  { id: 'afterglow', label: PALETTE_NAMES.afterglow, blurb: 'Dusk orange, rose and gold glows behind the page.' },
  {
    id: 'briefing',
    label: PALETTE_NAMES.briefing,
    blurb: 'Navy and lavender-grey, a bright blue accent, hot pink glows.',
  },
  { id: 'contrast', label: PALETTE_NAMES.contrast, blurb: 'Pure black and white, AAA-targeted.' },
] as const);

export const DEFAULT_STYLE: StyleId = 'studio';
export const DEFAULT_PALETTE: PaletteId = 'studio';

export const isPaletteId = (value: unknown): value is PaletteId =>
  typeof value === 'string' && (PALETTE_IDS as readonly string[]).includes(value);
export const isStyleId = (value: unknown): value is StyleId =>
  typeof value === 'string' && (STYLE_IDS as readonly string[]).includes(value);

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
