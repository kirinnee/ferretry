import { z } from 'zod';
import { RENDER_OPTIONAL_STYLE_TOKENS, RENDER_PALETTE_TOKENS, RENDER_STYLE_TOKENS } from './render-contract.ts';

/**
 * WHAT A THEME PACK IS. A style, a palette and a font are each ONE folder under `theme/packs/{style,palette,font}/<id>/`,
 * and the registry generator (`scripts/gen/lib/theme-packs.ts`) discovers them, so adding one adds a folder and edits no
 * list. These schemas are the only thing the generator and the app share about a pack: a pack that does not parse never
 * reaches a build, so nothing at runtime has to cope with a broken one.
 *
 * A palette is DATA (colour only, light and dark, an optional gradient mesh). A style is a META file plus its own
 * `style.css` (rules and non-colour tokens). A font is one family and its files. Fonts are packs of their own because
 * several styles share a family.
 */

/** A pack id: also the folder name, which the generator checks. */
export const PackIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/);

/** A custom-property name without the leading `--`, so a pack can never write `color-scheme`, `}` or a second declaration. */
export const TokenNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,40}$/);

/**
 * THE TOKEN PARTITION: every custom property belongs to exactly one kind of pack. A palette owns colour roles; a style owns
 * everything else (type, radius, stroke, shadow geometry, spacing, motion, the `--hm-*` and `--md-*` slots).
 *
 * `render-contract.ts` owns the tokens a renderer reads, split by kind (`RENDER_PALETTE_TOKENS`, `RENDER_STYLE_TOKENS`),
 * and they are imported here, never copied. The app also owns tokens no renderer reads (the accent channels, the shadow
 * inks, the texture and grid inks, nav and step colours; the style's own geometry), and those are the two `*_ONLY` lists
 * below. `theme-pack-contract.test.ts` pins the union to `styles/tokens/base-palette.css` and `base-style.css`.
 * A palette that declares a style token (or reads one with `var()`), and a style that declares a palette token, never
 * reaches a build.
 */
const PALETTE_ONLY_TOKENS = [
  'accent-border',
  'accent-rgb',
  'bar-bg',
  'bubble-bg',
  'chrome-fg',
  'err-border',
  'field-ground-bottom',
  'field-ground-top',
  'focus-color',
  'fy-progress-now',
  'grid-ink-major',
  'grid-ink-minor',
  'ground',
  'nav-hover',
  'nav-sel-bg',
  'nav-sel-edge',
  'nav-sel-fg',
  'nav-sel-sub',
  'ok-border',
  'pend-border',
  'ring',
  'scrim',
  'selection-bg',
  'selection-fg',
  'shadow-ink',
  'shadow-lg-1',
  'shadow-lg-2',
  'shadow-lg-3',
  'shadow-md-1',
  'shadow-md-2',
  'shadow-md-3',
  'shadow-sm-1',
  'shadow-sm-2',
  'shadow-sm-3',
  'src-claude',
  'src-codex',
  'src-computer',
  'step-rail',
  'step-seg',
  'step-seg-now',
  'step-todo-edge',
  'surface-mesh',
  'texture-ink',
  'tool-bash',
  'tool-edit',
  'tool-generic',
  'tool-patch',
  'tool-plan',
  'tool-read',
  'tool-wait',
  'tool-write',
  'user-bg',
  'user-border',
  'user-rail',
  'warn-border',
] as const;

const STYLE_ONLY_TOKENS = [
  'appnav-fg',
  'appnav-sel-fg',
  'appnav-underline',
  'bg-pattern',
  'bg-pattern-alpha',
  'bg-pattern-dots',
  'bg-pattern-grid',
  'bg-pattern-ink',
  'bg-pattern-lines',
  'bg-pattern-none',
  'bg-pattern-scan',
  'bg-pattern-size',
  'body-wash',
  'border-width-heavy',
  'bracket-size',
  'bubble-border',
  'bubble-fg',
  'bubble-radius',
  'bubble-shadow',
  'bubble-stroke',
  'card-bg',
  'card-border',
  'card-radius',
  'card-shadow',
  'card-stroke',
  'card-tail-radius',
  'chrome-font-size',
  'clip-control',
  'clip-panel',
  'code-font-size',
  'control-h',
  'control-h-desktop',
  'control-h-sm',
  'control-h-sm-desktop',
  'control-transform',
  'display-transform',
  'divider-color',
  'divider-width',
  'ease-emphasis',
  'ease-in',
  'ease-in-out',
  'ease-loading-ring',
  'ease-loading-run',
  'ease-out',
  'ease-spring',
  'ease-standard',
  'flow-1',
  'flow-2',
  'flow-3',
  'flow-4',
  'flow-5',
  'flow-chrome',
  'flow-chrome-after',
  'flow-live',
  'flow-message',
  'flow-turn',
  'focus-line',
  'focus-offset',
  'focus-shadow',
  'focus-width',
  'font-body',
  'font-size-base',
  'font-ui',
  'gap-md',
  'gap-sm',
  'gap-xs',
  'ghost-bg',
  'ghost-edge',
  'ghost-shadow',
  'glow-alpha',
  'grain-alpha',
  'grain-blend',
  'grain-image',
  'grain-noise',
  'grain-scale',
  'hm-edge',
  'hm-header',
  'hm-shape',
  'hover-fill',
  'input-font-floor',
  'label-size',
  'label-transform',
  'label-variant',
  'label-weight',
  'leading-base',
  'leading-tight',
  'md-cell-border-x',
  'md-code-bar',
  'md-code-border',
  'md-code-radius',
  'md-code-shadow',
  'md-stack-frame',
  'md-stack-label-weight',
  'md-stack-radius',
  'md-stack-row-fill',
  'md-stack-row-rule',
  'md-zebra',
  'menu-bg',
  'menu-edge',
  'menu-item-active',
  'menu-item-active-fg',
  'menu-item-h',
  'menu-item-hover',
  'menu-radius',
  'menu-sep',
  'menu-shadow',
  'motion-loading-ring',
  'motion-loading-run',
  'motion-loading-shimmer',
  'motion-pop',
  'nav-sel-shadow',
  'notch',
  'outline-always',
  'overlay',
  'overlay-blend',
  'overlay-opacity',
  'pad-badge-x',
  'pad-cell-x',
  'pad-control-x',
  'pad-control-x-want',
  'pad-panel',
  'pad-panel-want',
  'pad-row-y',
  'panel-bg',
  'panel-edge',
  'panel-edge-line',
  'panel-texture',
  'panel-texture-size',
  'press-translate',
  'prose-measure',
  'radius-badge',
  'radius-cap',
  'radius-control-max',
  'radius-dot',
  'radius-input',
  'radius-lg',
  'radius-md',
  'radius-panel',
  'radius-panel-max',
  'radius-pill',
  'radius-round',
  'radius-sm',
  'radius-tab',
  'rail-active',
  'row-min-h',
  'row-min-h-desktop',
  'rule-inset',
  'select-fill',
  'select-pop',
  'shadow-active',
  'shadow-control',
  'shadow-glow',
  'shadow-panel',
  'shadow-popover',
  'space-unit',
  'spinner-cap',
  'spinner-glow',
  'spinner-parts',
  'spinner-parts-speed',
  'spinner-parts-timing',
  'spinner-ring',
  'spinner-speed',
  'spinner-stroke',
  'spinner-sweep',
  'spinner-timing',
  'spinner-track-dash',
  'step-done-bg',
  'step-done-fg',
  'step-now-edge',
  'step-now-fg',
  'step-rail-done',
  'step-seg-done',
  'step-todo-fg',
  'stroke',
  'stroke-control',
  'stroke-heavy',
  'stroke-panel',
  'surface-field',
  'tab-fg',
  'tab-rule',
  'tab-sel-fg',
  'tab-underline',
  'tab-underline-width',
  'target-floor',
  'text-2xs',
  'text-base',
  'text-display',
  'text-input',
  'text-input-desktop',
  'text-lg',
  'text-md',
  'text-sm',
  'text-xs',
  'tracking-body',
  'tracking-label',
  'underline-links',
  'weight-display',
  'weight-heading',
] as const;

export const PALETTE_TOKENS: readonly string[] = [...RENDER_PALETTE_TOKENS, ...PALETTE_ONLY_TOKENS];
export const STYLE_TOKENS: readonly string[] = [
  ...RENDER_STYLE_TOKENS,
  ...RENDER_OPTIONAL_STYLE_TOKENS,
  ...STYLE_ONLY_TOKENS,
];

const paletteTokens: ReadonlySet<string> = new Set(PALETTE_TOKENS);
const styleTokens: ReadonlySet<string> = new Set(STYLE_TOKENS);

/** Whether a custom-property name (no leading `--`) is owned by palettes. */
export const isPaletteToken = (name: string): boolean => paletteTokens.has(name);
/** Whether a custom-property name (no leading `--`) is owned by styles. */
export const isStyleToken = (name: string): boolean => styleTokens.has(name);

/** A name a palette may declare: a palette-owned token, never a style-owned one. */
const PaletteTokenName = TokenNameSchema.refine(isPaletteToken, { message: 'not a palette-owned token' });

/** Anything that could fetch or run something: refused wherever a colour is expected. */
const FETCHES = /url\(|image|expression|@|\\|\/\*/iu;
const notFetching = (value: string): boolean => !FETCHES.test(value);
const balanced = (value: string): boolean => value.split('(').length === value.split(')').length;

/** A colour the product can paint and nothing else: no `url()`, no expression, no image. */
const Colour = z
  .string()
  .regex(/^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab)\([0-9.,%\s/a-z-]{1,60}\)|transparent)$/iu)
  .refine(notFetching);

/** `var(--name)` references inside a value. */
const references = (value: string): string[] =>
  [...value.matchAll(/var\(--([a-z0-9-]+)/gu)].map(match => match[1] as string);
/** A palette may read only palette-owned tokens: a style token it named would let it steer a style. */
const readsOnlyPalette = (value: string): boolean => references(value).every(isPaletteToken);

/** The accent as a tint: exactly `rgb(var(--accent-rgb) / <alpha 0..1>)`, the one shape that reads the channel triplet. */
const AccentTint = z.string().regex(/^rgb\(var\(--accent-rgb\) \/ (?:0(?:\.\d{1,4})?|1(?:\.0{1,4})?|\.\d{1,4})\)$/u);

/**
 * `--accent-rgb`: the accent as three channels, so a tint can take an alpha. Three integers 0-255, written with spaces
 * (`79 82 214`). It is the only key that holds a bare triplet, and the only value allowed there.
 */
const Channel = z.number().int().min(0).max(255);
export const AccentRgbSchema = z.tuple([Channel, Channel, Channel]);
const ACCENT_RGB = 'accent-rgb';

/** A colour, another palette token, the accent tint, or a `color-mix` of two. */
const ColourRef = z
  .union([
    Colour,
    AccentTint,
    z.string().regex(/^var\(--[a-z0-9-]{1,40}\)$/u),
    z
      .string()
      .regex(/^color-mix\(in (srgb|oklch), [^;{}]{1,120}\)$/u)
      .refine(value => notFetching(value) && balanced(value)),
  ])
  .refine(notFetching)
  .refine(readsOnlyPalette, { message: 'reads a token a palette does not own' });

/** One palette mode: palette-owned tokens only; a colour everywhere except `accent-rgb`, which is a channel triplet. */
const PaletteTokens = z
  .record(PaletteTokenName, z.union([ColourRef, AccentRgbSchema]))
  .superRefine((tokens, context) => {
    for (const [name, value] of Object.entries(tokens)) {
      const triplet = Array.isArray(value);
      if (triplet && name !== ACCENT_RGB)
        context.addIssue({ code: 'custom', path: [name], message: 'a channel triplet belongs only to accent-rgb' });
      if (!triplet && name === ACCENT_RGB)
        context.addIssue({ code: 'custom', path: [name], message: 'accent-rgb is three integers 0-255' });
    }
  });

/** One radial glow: `radial-gradient(<w>% <h>% at <x>% <y>%, <colour>, transparent <fade>%)`. */
const Glow = z.strictObject({
  w: z.number().finite(),
  h: z.number().finite(),
  x: z.number().finite(),
  y: z.number().finite(),
  colour: Colour,
  fade: z.number().finite(),
});

export const PalettePackSchema = z.strictObject({
  id: PackIdSchema,
  /** A proper name, never a plain colour word. */
  label: z.string().min(1).max(40),
  blurb: z.string().min(1).max(120),
  /** Picker order: a field on the pack, not a central list. */
  order: z.number().int(),
  /** Exactly one palette pack carries it once there is any palette pack. */
  default: z.literal(true).optional(),
  light: PaletteTokens,
  dark: PaletteTokens,
  /** Gradient-mesh glows, drawn into `--surface-mesh`. */
  mesh: z.strictObject({ light: z.array(Glow).max(6), dark: z.array(Glow).max(6) }).optional(),
});

export const StylePackSchema = z.strictObject({
  id: PackIdSchema,
  label: z.string().min(1).max(40),
  blurb: z.string().min(1).max(160),
  order: z.number().int(),
  /** Exactly one style pack carries it once there is any style pack. */
  default: z.literal(true).optional(),
  /** The palette a pick brings; it must name a palette pack. */
  defaultPalette: PackIdSchema,
  /** A style that fights readability on purpose. */
  loud: z.literal(true).optional(),
  /** Font pack ids. */
  fonts: z.strictObject({ text: z.array(PackIdSchema).max(4), code: z.array(PackIdSchema).max(2) }),
});

const isFontWeight = (value: string): boolean =>
  /^[1-9]\d{0,3}( [1-9]\d{0,3})?$/u.test(value) && value.split(' ').every(part => Number(part) <= 1000);

export const FontPackSchema = z.strictObject({
  id: PackIdSchema,
  family: z.string().regex(/^[A-Za-z0-9 -]{1,40}$/u),
  licence: z.string().min(1).max(40),
  faces: z
    .array(
      z.strictObject({
        /** Beside the pack file: `./inter-latin-wght-normal.woff2`. */
        file: z.string().regex(/^\.\/[a-z0-9-]+\.woff2$/u),
        /** One CSS font weight or a range of two, each 1 to 1000 (`400`, `200 1000`). */
        weight: z.string().refine(isFontWeight, 'a font weight is 1 to 1000, or two of them as a range'),
        style: z.enum(['normal', 'italic']),
      }),
    )
    .min(1)
    .max(6),
  /** The subset every bundled file is cut to. */
  range: z.enum(['latin']),
});
