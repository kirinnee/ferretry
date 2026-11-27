/**
 * THE RENDERER CONTRACT — the one list a theme and a renderer both know, and nothing else.
 *
 * A theme (a style and a palette) paints the app; a renderer (Durian hypermedia, a Chart.js chart, a Mermaid
 * diagram) draws inside it. Neither may know the other. They meet here: a theme MUST resolve every token below
 * to a value, and a renderer MAY read no app token that is not below. `tests/unit/theme-render-contract.test.ts`
 * holds every style × palette × mode to the first half (resolution and contrast); the conversation plugin's
 * `dh-theme.test.ts` holds the hypermedia stylesheets to the second.
 *
 * PURE DATA. The sandbox shells import `fy-render/palette.ts`, which imports this file, so it carries no
 * schema or YAML library and touches no DOM.
 */

/** The colour tokens every palette must resolve, without their leading `--`. */
export const RENDER_PALETTE_TOKENS = [
  // Grounds and ink.
  'bg',
  'surface',
  'surface-2',
  'surface-3',
  'fg',
  'fg-soft',
  'muted',
  'faint',
  // Accent.
  'accent',
  'accent-fg',
  'accent-soft',
  'accent-strong',
  // Lines (`border-soft` is read by the illustration palette only).
  'border',
  'border-strong',
  'border-soft',
  // Code.
  'code-bg',
  'code-fg',
  'code-border',
  // Status: an ink and its tint.
  'ok',
  'ok-bg',
  'warn',
  'warn-bg',
  'err',
  'err-bg',
  'pend',
  'pend-bg',
  // Syntax.
  'syn-addition',
  'syn-comment',
  'syn-deletion',
  'syn-keyword',
  'syn-meta',
  'syn-number',
  'syn-string',
  'syn-type',
  // Tools.
  'tool-search',
  // Chart series.
  'viz-1',
  'viz-2',
  'viz-3',
  'viz-4',
  'viz-5',
  'viz-6',
  'viz-7',
  'viz-8',
] as const;
export type RenderPaletteToken = (typeof RENDER_PALETTE_TOKENS)[number];

/** The non-colour tokens every style must resolve, without their leading `--`. */
export const RENDER_STYLE_TOKENS = [
  // Fonts.
  'font-prose',
  'font-display',
  'font-mono',
  // Weights and tracking.
  'weight-normal',
  'weight-medium',
  'weight-strong',
  'tracking-display',
  // Corners and strokes.
  'radius-xs',
  'radius-control',
  'border-width',
  // Shadows and blur.
  'shadow-sm',
  'shadow-md',
  'shadow-lg',
  'surface-blur',
  // The motion scale.
  'motion-fast',
  'motion-base',
  'motion-slow',
  // Spacing.
  'flow-paragraph',
  'flow-list',
  // Hypermedia slots.
  'hm-font',
  'hm-radius',
  'hm-stroke',
  'hm-node-fill-alpha',
  // Prose slots.
  'md-font-size',
  'md-leading',
  'md-h1-size',
  'md-h1-weight',
  'md-h1-case',
  'md-h1-rule',
  'md-h1-rule-pad',
  'md-h2-size',
  'md-h2-weight',
  'md-h2-case',
  'md-h2-rule',
  'md-h2-rule-pad',
  'md-link-bg',
  'md-link-decoration',
  'md-link-pad',
  'md-link-radius',
  'md-list-marker-color',
  'md-ul-marker',
  'md-ol-marker',
  'md-quote-bar',
  'md-quote-bg',
  'md-quote-font-style',
  'md-quote-pad',
  'md-quote-radius',
  'md-th-bg',
  'md-th-case',
  'md-th-weight',
  'md-cell-border-y',
] as const;
export type RenderStyleToken = (typeof RENDER_STYLE_TOKENS)[number];

/**
 * Style tokens a renderer reads that a style MAY leave unset, without their leading `--`. `--md-link-weight` is the base's `inherit`:
 * a CSS-wide keyword, so it resolves to nothing and a link takes the weight of the text around it (a link in a heading or in bold
 * stays that weight). A style that wants a fixed link weight names a number; one that does not, says nothing. The resolver therefore
 * does not require it, and a renderer may read it.
 */
export const RENDER_OPTIONAL_STYLE_TOKENS = ['md-link-weight'] as const;

/**
 * The values a stylesheet cannot branch on, which `look.ts` reads once per theme change. A style must set each to
 * one of its allowed words. (`--hm-edge` is declared by styles but read by no renderer, so it is not here yet.)
 */
export const RENDER_KEYWORD_SLOTS = {
  'hm-shape': ['shaped', 'flat', 'ink', 'block'],
  'hm-header': ['band', 'label', 'none'],
} as const satisfies Readonly<Record<string, readonly string[]>>;
export type RenderKeywordSlot = keyof typeof RENDER_KEYWORD_SLOTS;

/** One promised contrast: `ink` painted on `ground`, at least `floor`:1, in every palette and both modes. */
export interface RenderContrastPair {
  readonly ink: RenderPaletteToken;
  readonly ground: RenderPaletteToken;
  readonly floor: number;
  readonly kind: 'text' | 'mark';
}

const TEXT = 4.5;
const MARK = 3;
/** The High contrast palette asks 7:1 of body text and keeps 4.5:1 for muted text. */
const HIGH_CONTRAST_BODY = 7;

const SURFACES = ['surface', 'surface-2', 'surface-3'] as const;
const GROUNDS = ['bg', ...SURFACES] as const;
const STATUS = ['ok', 'warn', 'err', 'pend'] as const;
const SYNTAX = RENDER_PALETTE_TOKENS.filter(token => token.startsWith('syn-'));
const SERIES = RENDER_PALETTE_TOKENS.filter(token => token.startsWith('viz-'));

/**
 * THE MEASURABLE PROMISE, as data: text 4.5:1, chart marks 3:1, and on the High contrast palette body text 7:1
 * with muted text still 4.5:1. A style never changes a colour, so these depend on the palette and the mode only,
 * and a `loud` style (which may fight readability on purpose) has nothing to be waived from here.
 */
export function renderContrastPairs(highContrast: boolean): readonly RenderContrastPair[] {
  const body = highContrast ? HIGH_CONTRAST_BODY : TEXT;
  const text = (ink: RenderPaletteToken, ground: RenderPaletteToken, floor = TEXT): RenderContrastPair => ({
    floor,
    ground,
    ink,
    kind: 'text',
  });
  return [
    ...GROUNDS.flatMap(ground => [text('fg', ground, body), text('fg-soft', ground, body)]),
    ...SURFACES.map(ground => text('muted', ground)),
    text('accent', 'surface'),
    text('accent-fg', 'accent'),
    text('code-fg', 'code-bg', body),
    ...SYNTAX.map(ink => text(ink, 'code-bg')),
    ...STATUS.flatMap(ink => [text(ink, `${ink}-bg` as RenderPaletteToken), text(ink, 'surface')]),
    ...SERIES.flatMap(ink =>
      (['surface', 'bg'] as const).map(ground => ({ floor: MARK, ground, ink, kind: 'mark' as const })),
    ),
  ];
}
