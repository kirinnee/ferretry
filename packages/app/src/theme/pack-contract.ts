import { z } from 'zod';

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

/** Anything that could fetch or run something: refused wherever a colour is expected. */
const FETCHES = /url\(|image|expression|@|\\|\/\*/iu;
const notFetching = (value: string): boolean => !FETCHES.test(value);
const balanced = (value: string): boolean => value.split('(').length === value.split(')').length;

/** A colour the product can paint and nothing else: no `url()`, no expression, no image. */
const Colour = z
  .string()
  .regex(/^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab)\([0-9.,%\s/a-z-]{1,60}\)|transparent)$/iu)
  .refine(notFetching);

/** A colour, another palette token, or a `color-mix` of two. */
const ColourRef = z
  .union([
    Colour,
    z.string().regex(/^var\(--[a-z0-9-]{1,40}\)$/u),
    z
      .string()
      .regex(/^color-mix\(in (srgb|oklch), [^;{}]{1,120}\)$/u)
      .refine(value => notFetching(value) && balanced(value)),
  ])
  .refine(notFetching);

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
  light: z.record(TokenNameSchema, ColourRef),
  dark: z.record(TokenNameSchema, ColourRef),
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

export const FontPackSchema = z.strictObject({
  id: PackIdSchema,
  family: z.string().regex(/^[A-Za-z0-9 -]{1,40}$/u),
  licence: z.string().min(1).max(40),
  faces: z
    .array(
      z.strictObject({
        /** Beside the pack file: `./inter-latin-wght-normal.woff2`. */
        file: z.string().regex(/^\.\/[a-z0-9-]+\.woff2$/u),
        weight: z.string().regex(/^\d{3}( \d{3})?$/u),
        style: z.enum(['normal', 'italic']),
      }),
    )
    .min(1)
    .max(6),
  /** The subset every bundled file is cut to. */
  range: z.enum(['latin']),
});
