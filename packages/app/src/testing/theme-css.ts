/**
 * THE THEME STYLESHEET AS ONE TEXT. `src/styles/themes.css` is an index of `@import`s over `tokens/` and the generated
 * `theme-packs.css` (each style pack's `style.css` imported, each palette written from its data); a test that wants "the theme CSS" (to read a token's value, walk every block, or paint a page with it)
 * reads it through here, so it sees the files in the order the browser applies them.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const stylesRoot = join(import.meta.dir, '../styles');

/** The directory the theme CSS lives in. */
export const themeStylesDir = stylesRoot;

/** `file` with each `@import './x.css';` replaced by that file's own (recursively resolved) text. */
export function readCssWithImports(file: string): string {
  const text = readFileSync(file, 'utf8');
  return text.replace(/^@import\s+'([^']+)';\s*$/gmu, (_whole, target: string) =>
    readCssWithImports(join(dirname(file), target)),
  );
}

/**
 * Every theme token declaration, in the order the browser applies them: `themes.css` with all its imports inlined, i.e. the
 * bases, then the generated theme packs (every style's `style.css`, the fonts, the palettes as data), then the floors.
 */
export const readThemeCss = (): string => readCssWithImports(join(stylesRoot, 'themes.css'));

/** One file under `src/styles` (`tokens/base-palette.css`, `index.css`, …). */
export const readStyleFile = (relative: string): string => readFileSync(join(stylesRoot, relative), 'utf8');

/** One style pack's stylesheet (`theme/packs/style/<id>/style.css`): its tokens and its own rules. */
export const readStylePackCss = (id: string): string =>
  readFileSync(join(stylesRoot, '../theme/packs/style', id, 'style.css'), 'utf8');

/**
 * One palette's blocks of the generated stylesheet (`generated/theme-packs.css`, written from `theme/packs/palette/<id>/palette.ts`):
 * every top-level block whose selector names the palette. A palette is data now, so this is the CSS the browser gets for it.
 */
export function readPaletteCss(id: string): string {
  const generated = readFileSync(join(stylesRoot, '../generated/theme-packs.css'), 'utf8');
  return generated
    .split(/\n\n+/u)
    .filter(block => block.includes(`[data-palette='${id}']`))
    .join('\n\n');
}
