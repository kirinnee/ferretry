import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = (path: string): string => readFileSync(join(import.meta.dir, '../../../src', path), 'utf8');
const css = src('ui/design-system.css');
const themes = src('styles/themes.css');
const rule = (selector: RegExp): string => css.match(selector)?.[0] ?? '';

describe('the shared menu row', () => {
  it('draws the keyboard focus ring from the theme tokens, inside the row so a menu’s clipping cannot hide it', () => {
    const ring = rule(/\n\.kt-menu-item:focus-visible \{[^}]*\}/u);
    expect(ring).toContain('outline: var(--focus-width) solid var(--focus-color);');
    expect(ring).toContain('outline-offset: calc(-1 * var(--focus-width));');
  });

  it('never switches its outline off, and marks the cursor and a checked row by more than a faint fill', () => {
    expect(rule(/\n\.kt-menu-item \{[^}]*\}/u)).not.toContain('outline');
    const cursor = rule(/\n\.kt-menu-item\[aria-selected='true'\],[^{]*\{[^}]*\}/u);
    expect(cursor).toContain('background: var(--menu-item-active);');
    expect(cursor).toContain('box-shadow: var(--rail-active);');
  });

  it('the popover wears the control edge, not the decorative hairline', () => {
    expect(rule(/\n\.kt-popover \{[^}]*\}/u)).toContain('solid var(--menu-edge)');
    expect(themes).toContain('--menu-edge: var(--border-strong);');
  });

  it('a dark theme raises its menu one step off the page', () => {
    expect(themes).toMatch(/\[data-theme\$='-dark'\][^{]*\{\s*--menu-bg: var\(--surface-2\);/u);
  });

  it('the shared menus use it: the context menu rows and the picker list', () => {
    const menu = src('ui/context-menu.tsx');
    expect(menu).toContain('kt-menu-item');
    expect(menu).not.toContain('focus:outline-none');
    expect(src('ui/picker-combobox.tsx')).toContain('kt-popover');
  });
});
