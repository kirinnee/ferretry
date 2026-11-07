import { z } from 'zod';
import { THEME_FAMILIES, type ThemeFamilyId } from './preferences.ts';

/**
 * THEME TOKENS (§5.3): a theme is colour, type and spacing tokens, as data. A theme item names the built-in family it
 * starts from and overrides tokens on top; the shell writes them as CSS custom properties on the root, so every
 * stylesheet rule that reads `var(--accent)` follows the item. The built-in families stay in `styles/themes.css`
 * (copied from today), so a theme item needs no build.
 *
 * Only the tokens below may be set — a name outside the list is refused, so an item cannot reach a property the
 * stylesheet does not read through a token — and every value is checked against a narrow grammar, so a value cannot
 * close the declaration, load a resource (`url(`), or smuggle an expression.
 */

export const COLOUR_TOKENS = [
  'bg',
  'fg',
  'fg-soft',
  'faint',
  'accent',
  'accent-fg',
  'accent-soft',
  'accent-strong',
  'accent-border',
  'border',
  'border-soft',
  'border-strong',
  'card-bg',
  'card-border',
  'bar-bg',
  'chrome-fg',
  'bubble-bg',
  'bubble-fg',
  'bubble-border',
  'code-bg',
  'code-fg',
  'code-border',
  'err',
  'err-bg',
  'err-border',
  'focus-color',
  'divider-color',
] as const;

export const TYPE_TOKENS = [
  'font-body',
  'font-ui',
  'font-prose',
  'font-mono',
  'font-display',
  'text-2xs',
  'text-xs',
  'text-sm',
  'text-base',
  'text-md',
  'text-lg',
  'text-display',
] as const;

export const SPACING_TOKENS = [
  'card-radius',
  'bubble-radius',
  'border-width',
  'control-h',
  'control-h-sm',
  'flow-1',
  'flow-2',
  'flow-3',
  'flow-4',
  'flow-5',
] as const;

export type ThemeToken = (typeof COLOUR_TOKENS)[number] | (typeof TYPE_TOKENS)[number] | (typeof SPACING_TOKENS)[number];

const COLOUR_VALUE = /^(#[0-9a-fA-F]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab)\([0-9.,%\s/a-z-]{1,60}\)|transparent|currentColor)$/u;
const LENGTH_VALUE = /^-?\d{1,4}(\.\d{1,3})?(px|rem|em|%)?$/u;
/** Font stacks: quoted or bare family names separated by commas. No parentheses, no semicolons, no braces. */
const FONT_VALUE = /^[A-Za-z0-9 ,'"-]{1,160}$/u;

function valueSchema(token: ThemeToken): z.ZodType<string> {
  if ((COLOUR_TOKENS as readonly string[]).includes(token)) return z.string().regex(COLOUR_VALUE);
  if (token.startsWith('font-')) return z.string().regex(FONT_VALUE);
  return z.string().regex(LENGTH_VALUE);
}

const ALL_TOKENS: readonly ThemeToken[] = [...COLOUR_TOKENS, ...TYPE_TOKENS, ...SPACING_TOKENS];
const FAMILY_IDS = THEME_FAMILIES.map(family => family.id) as [ThemeFamilyId, ...ThemeFamilyId[]];

const TokensSchema = z.strictObject(
  Object.fromEntries(ALL_TOKENS.map(token => [token, valueSchema(token).optional()])) as Record<
    ThemeToken,
    z.ZodOptional<z.ZodType<string>>
  >,
);

/** A theme item (`themes/<id>.yaml`), as the Layouts plugin hands it over. Light and dark override separately. */
export const ThemeItemSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/u).max(40),
  label: z.string().min(1).max(60),
  base: z.enum(FAMILY_IDS),
  light: TokensSchema.default({}),
  dark: TokensSchema.default({}),
});

export type ThemeItem = z.infer<typeof ThemeItemSchema>;

/** The custom properties a theme item sets for one resolved mode: `{ '--accent': '#123456', … }`. */
export function themeProperties(item: ThemeItem, mode: 'light' | 'dark'): Readonly<Record<string, string>> {
  const tokens = item[mode] as Partial<Record<ThemeToken, string>>;
  const properties: Record<string, string> = {};
  for (const token of ALL_TOKENS) {
    const value = tokens[token];
    if (value !== undefined) properties[`--${token}`] = value;
  }
  return properties;
}

/** Writes a theme item's properties on the root, and removes every token property it does not set. */
export function applyThemeItem(
  root: { style: { setProperty(name: string, value: string): void; removeProperty(name: string): void } },
  item: ThemeItem | undefined,
  mode: 'light' | 'dark',
): void {
  const properties = item === undefined ? {} : themeProperties(item, mode);
  for (const token of ALL_TOKENS) {
    const name = `--${token}`;
    const value = properties[name];
    if (value === undefined) root.style.removeProperty(name);
    else root.style.setProperty(name, value);
  }
}
