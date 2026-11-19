import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readThemeCss } from '../../../src/testing/theme-css.ts';

const src = (path: string): string => readFileSync(join(import.meta.dir, '../../../src', path), 'utf8');
const css = src('ui/design-system.css');
const themes = readThemeCss();
const rule = (selector: RegExp): string => css.match(selector)?.[0] ?? '';

describe('the shared menu row', () => {
  it('draws the keyboard focus ring from the theme tokens, inside the row so a menu’s clipping cannot hide it', () => {
    const ring = rule(/\n\.kt-menu-item:focus-visible \{[^}]*\}/u);
    expect(ring).toContain('outline: var(--focus-width) solid var(--focus-color);');
    expect(ring).toContain('outline-offset: calc(-1 * var(--focus-width));');
  });

  it('never switches its outline off, and marks the cursor and a checked row by ONE cue: the neutral fill', () => {
    expect(rule(/\n\.kt-menu-item \{[^}]*\}/u)).not.toContain('outline');
    const cursor = rule(/\n\.kt-menu-item\[aria-selected='true'\],[^{]*\{[^}]*\}/u);
    expect(cursor).toContain('background: var(--menu-item-active);');
    expect(cursor).not.toMatch(/box-shadow|border|font-weight|color:/u);
    expect(themes).toContain('--menu-item-active: var(--select-fill);');
  });

  it('the popover wears the control edge, not the decorative hairline', () => {
    expect(rule(/\n\.kt-popover \{[^}]*\}/u)).toContain('solid var(--menu-edge)');
    expect(themes).toContain('--menu-edge: var(--border-strong);');
  });

  it('a dark theme raises its menu one step off the page', () => {
    expect(themes).toMatch(/\[data-mode='dark'\][^{]*\{\s*--menu-bg: var\(--surface-2\);/u);
  });

  it('the shared menus use it: the context menu rows and the picker list', () => {
    const menu = src('ui/context-menu.tsx');
    expect(menu).toContain('kt-menu-item');
    expect(menu).not.toContain('focus:outline-none');
    expect(src('ui/picker-combobox.tsx')).toContain('kt-popover');
  });

  it('the danger ink rides the row-ink vars, so no state rule (hover, the one-highlight reset) can out-rank it', () => {
    const danger = rule(/\n\.kt-menu-item\[data-danger\] \{[^}]*\}/u);
    expect(danger).toContain('--menu-item-fg: var(--err);');
    expect(danger).toContain('--menu-item-hover-fg: var(--err);');
    // The hover rule (0,3,0) and the reset rule beat `[data-danger]` (0,2,0) on specificity, so neither may hard-code an ink.
    const hover = rule(/\n\.kt-menu-item:hover:not\([^{]*\{[^}]*\}/u);
    expect(hover).toContain('color: var(--menu-item-hover-fg, var(--fg));');
    const reset = rule(/\n\.kt-menu-item:hover:not\(:focus-visible[^{]*\{[^}]*\}/u);
    expect(reset).toContain('color: var(--menu-item-fg, var(--fg-soft));');
    expect(css).not.toMatch(/\.kt-menu-item[^{]*:hover[^{]*\{[^}]*color: var\(--fg(-soft)?\);/u);
  });

  it('a row is sized by row vars: this file loads after Tailwind, so a utility on a row is dead', () => {
    const row = rule(/\n\.kt-menu-item \{[^}]*\}/u);
    for (const variable of ['--menu-item-align', '--menu-item-py', '--menu-item-fg', '--menu-item-h'])
      expect(row).toContain(variable);
    const dead = /\b(?:min-h-\[|items-start|text-fg\b|text-muted\b|py-1(?:\.5)?\b)/u;
    for (const path of ['ui/context-menu.tsx', 'ui/picker-combobox.tsx']) {
      const classes = src(path)
        .split('\n')
        .filter(line => line.includes('kt-menu-item'));
      for (const line of classes) expect(line, `${path}: ${line.trim()}`).not.toMatch(dead);
    }
    const picker = src('ui/picker-combobox.tsx');
    expect(picker).toContain('[--menu-item-h:44px]');
    expect(picker).toContain('[--menu-item-align:flex-start]');
  });

  it('every compact palette names its own focus ring and a >=3:1 control edge (the baseline is Studio LIGHT)', () => {
    const block = themes.match(/\n:root\[data-palette='phosphor'\],[^{]*\{[^}]*--border-strong:[^}]*\}/u)?.[0] ?? '';
    expect(block).toContain('--focus-color: var(--accent);');
    expect(block).toContain('--border-strong: color-mix(in srgb, var(--fg) 58%, var(--surface));');
  });
});
