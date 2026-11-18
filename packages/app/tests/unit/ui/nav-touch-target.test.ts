import { describe, expect, test } from 'bun:test';

/**
 * A TOP ROW OF TABS ON A PHONE IS A TOUCH TARGET: a finger needs 44px, and the row's items are 32px for a mouse. A layout
 * that puts the nav on top at phone width (an owner's choice) gets the same height as the bottom bar's entries.
 */
const css = await Bun.file(new URL('../../../src/styles/shell.css', import.meta.url)).text();

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

describe('the top nav at phone width', () => {
  test('its items are at least 44px tall, though a pointer row keeps its 32px', () => {
    const phone = phoneBlockWith('.fy-nav--top .fy-nav__item');
    expect(phone).toMatch(/\.fy-nav--top \.fy-nav__item \{[^}]*min-height: 44px;/u);
    expect(css).toMatch(/\.fy-nav--top \.fy-nav__item \{[^}]*min-height: 32px;/u);
  });
});
