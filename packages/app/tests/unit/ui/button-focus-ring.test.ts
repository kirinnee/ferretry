import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(import.meta.dir, '../../../src/ui/design-system.css'), 'utf8');
const rule = (selector: RegExp): string => css.match(selector)?.[0] ?? '';

describe('the shared Button', () => {
  it('takes its height from the app control-height token, in both sizes', () => {
    expect(rule(/\n\.kt-btn \{[^}]*\}/u)).toContain('height: var(--control-h);');
    expect(rule(/\n\.kt-btn--sm \{[^}]*\}/u)).toContain('height: var(--control-h-sm);');
  });

  it('draws the keyboard focus ring from the theme tokens, so every theme and its dark twin keep their own ring', () => {
    const ring = rule(/\n\.kt-btn:focus-visible \{[^}]*\}/u);
    expect(ring).toContain('outline: var(--focus-width) solid var(--focus-color);');
    expect(ring).toContain('outline-offset: calc(-1 * var(--focus-width));');
  });

  it('declares the ring after the base rule that resets outline, so the reset cannot hide it', () => {
    expect(css.indexOf('\n.kt-btn:focus-visible {')).toBeGreaterThan(css.indexOf('\n.kt-btn {'));
    expect(rule(/\n\.kt-btn \{[^}]*\}/u)).toContain('outline: var(--outline-always);');
  });
});
