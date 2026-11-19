/**
 * THE THEME STYLESHEET AS ONE TEXT. `src/styles/themes.css` is an index of `@import`s over `tokens/`, `style/` and
 * `palette/`; a test that wants "the theme CSS" (to read a token's value, walk every block, or paint a page with it)
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

/** Every theme token declaration, in cascade order: `themes.css` with all its imports inlined. */
export const readThemeCss = (): string => readCssWithImports(join(stylesRoot, 'themes.css'));

/** One file under `src/styles` (`style/neo.css`, `tokens/base-palette.css`, …). */
export const readStyleFile = (relative: string): string => readFileSync(join(stylesRoot, relative), 'utf8');
