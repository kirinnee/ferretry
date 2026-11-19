import { describe, expect, test } from 'bun:test';

/**
 * THE DRAWER'S ROWS ON A PHONE ARE TOUCH TARGETS: a finger needs 44px, and the rows are 36px for a mouse. The overlay drawer
 * at phone width gets the same height as the bottom bar's entries.
 */
const css = await Bun.file(new URL('../../../src/styles/drawer.css', import.meta.url)).text();

/** The body of the first `@media (max-width: 767.98px)` block that contains `selector`. */
const phoneBlockWith = (selector: string): string | undefined => {
  for (const match of css.matchAll(/@media \(max-width: 767\.98px\) \{/gu)) {
    let depth = 1;
    let i = (match.index ?? 0) + match[0].length;
    const from = i;
    while (depth > 0 && i < css.length) {
      depth += css[i] === '{' ? 1 : css[i] === '}' ? -1 : 0;
      i += 1;
    }
    const body = css.slice(from, i - 1);
    if (body.includes(selector)) return body;
  }
  return undefined;
};

describe('the drawer at phone width', () => {
  test('its rows are at least 44px tall, though a pointer row keeps its 36px', () => {
    const phone = phoneBlockWith('.fy-nav--drawer .fy-nav__item');
    expect(phone).toMatch(/\.fy-nav--drawer \.fy-nav__item \{[^}]*min-height: 44px;/u);
    expect(css).toMatch(/\.fy-nav--drawer \.fy-nav__item \{[^}]*min-height: 36px;/u);
  });
});
