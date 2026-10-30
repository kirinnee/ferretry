import { z } from 'zod';

/**
 * A surface's human name: a lowercase letter, then up to 31 lowercase letters, digits or dashes.
 *
 * NEVER TWELVE HEX CHARACTERS, because that is what a terminal ID looks like, and `%terminal:<key>`
 * accepts either: a name that could also be an id would make one reference mean two shells.
 */
export const SURFACE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;
const TERMINAL_ID_SHAPE = /^[a-f0-9]{12}$/u;

export const SurfaceNameSchema = z
  .string()
  .regex(SURFACE_NAME_PATTERN, 'a name is a lowercase letter, then up to 31 lowercase letters, digits or dashes')
  .refine(value => !TERMINAL_ID_SHAPE.test(value), 'a name may not look like a terminal id (twelve hex characters)');
export type SurfaceName = z.infer<typeof SurfaceNameSchema>;

/**
 * How a call names an EXISTING surface: its name, or the id the daemon minted for it (`%terminal:`
 * references written before names existed still work). A `%terminal:` / `%browser:` prefix is
 * accepted and dropped, so an agent can pass a reference exactly as a person wrote it.
 */
export const SurfaceKeySchema = z
  .string()
  .trim()
  .transform(value => value.replace(/^%(?:terminal|browser):/u, ''))
  .pipe(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u, 'not a surface name or id'));

export const SurfaceKindSchema = z.enum(['terminal', 'browser']);
export type SurfaceKind = z.infer<typeof SurfaceKindSchema>;
