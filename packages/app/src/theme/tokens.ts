import { ALL_TOKENS, ThemeSchema, type Theme, type ThemeToken } from '@ferretry/plugin-layouts/contract';
export { COLOUR_TOKENS, TYPE_TOKENS, SPACING_TOKENS, type ThemeToken } from '@ferretry/plugin-layouts/contract';

/** The app consumes exactly the theme accepted by the Layouts boundary. */
export const ThemeItemSchema = ThemeSchema;
export type ThemeItem = Theme;

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
