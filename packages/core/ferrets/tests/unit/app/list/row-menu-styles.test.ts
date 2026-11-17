/**
 * The row menu must carry its own styles. Its rules (`fy-actions-menu`, `--at`, `--sheet`, the popover, the failure
 * line, the toast) live in `header/ferret-actions.css`, and the header view is the only other importer of that file.
 * The list screen is drawn before any ferret header (a phone's first bottom-nav item, or any route without a ferret
 * toolbar), so the list screen's own module graph has to reach the stylesheet: otherwise the menu draws unpositioned,
 * with no background and no z-index. Unit tests load no CSS, so this reads the import graph from source.
 */

import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('../../../../app', import.meta.url));
const MENU_STYLES = resolve(APP, 'features/header/ferret-actions.css');

const importsOf = (source: string): readonly string[] =>
  [...source.matchAll(/^import\s+(?!type\b)(?:[^'"]*?from\s+)?['"](\.[^'"]+)['"]/gm)].map(m => m[1] as string);

/** Every file the entry reaches through relative, value imports (`import type` is erased, so it does not count). */
const reachable = async (entry: string): Promise<ReadonlySet<string>> => {
  const seen = new Set<string>();
  const queue = [entry];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.tsx?$/.test(file)) continue;
    const source = await readFile(file, 'utf8');
    for (const spec of importsOf(source)) queue.push(resolve(dirname(file), spec));
  }
  return seen;
};

test('the list screen reaches the stylesheet that holds the row menu rules', async () => {
  const graph = await reachable(resolve(APP, 'views/list.tsx'));
  expect(graph.has(MENU_STYLES)).toBe(true);
});

test('the file that draws the row menu imports the stylesheet itself', async () => {
  for (const file of ['features/list/context-actions-menu.tsx', 'features/list/row-actions-host.tsx']) {
    const graph = await reachable(resolve(APP, file));
    expect(graph.has(MENU_STYLES)).toBe(true);
  }
});

test('the stylesheet really holds the rules the row menu draws', async () => {
  const css = await readFile(MENU_STYLES, 'utf8');
  for (const rule of [
    '.fy-actions-menu',
    '.fy-actions-menu--at',
    '.fy-actions-menu--sheet',
    '.fy-action-popover--at',
    '.fy-action-form__failure',
  ]) {
    expect(css).toContain(rule);
  }
});

test('a parent row reveals its own ⋯ and pin buttons on hover, never its sub-ferrets’, and the nesting keeps its indent', async () => {
  // A sub-ferret's row is INSIDE its parent's `li`, so a descendant selector would light up every child's buttons.
  // A real browser proved it (a shot of a hovered parent); unit tests load no CSS, so the rules are read from source.
  const css = await readFile(resolve(APP, 'features/list/ferret-list.css'), 'utf8');
  expect(css).toContain('.fy-sbar__row:hover > .fy-sbar__more');
  expect(css).toContain('.fy-sbar__row:hover > .fy-sbar__pin');
  expect(css).not.toMatch(/\.fy-sbar__row:hover \.fy-sbar__(?:more|pin)/u);
  // `.fy-sbar__list ul` strips every list's padding, so the nested list needs a rule at least as specific.
  expect(css).toMatch(/\.fy-sbar__list \.fy-sbar__children\s*\{[^}]*padding:\s*0 0 0 14px/u);
});
