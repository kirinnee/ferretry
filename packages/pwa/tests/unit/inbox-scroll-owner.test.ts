import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '../../src');
const css = readFileSync(join(SRC, 'features/agenda/agenda-inbox.css'), 'utf8');
const rule = (selector: RegExp): string => css.match(selector)?.[0] ?? '';

describe('the Inbox is its own scroller, so the phone tab bar under it covers nothing', () => {
  const page = rule(/\n\.fy-attn-inbox \{[^}]*\}/u);

  it('scrolls inside the page area, which ends where the tab bar begins', () => {
    expect(page).toContain('height: 100%;');
    expect(page).toContain('min-height: 0;');
    expect(page).toContain('overflow-y: auto;');
    expect(page).toContain('overscroll-behavior: contain;');
    expect(page).toContain('box-sizing: border-box;');
  });

  it('keeps its children their natural height instead of squeezing them to fit', () => {
    expect(rule(/\n\.fy-attn-inbox > \* \{[^}]*\}/u)).toContain('flex-shrink: 0;');
  });

  it('centres its column with padding, so the scrollbar stays at the window edge', () => {
    expect(page).toContain('padding: var(--gap-md) max(16px, calc((100% - 56rem) / 2)) 96px;');
    expect(page).not.toContain('max-width');
  });

  it('leaves the bottom inset to the tab bar that owns it, in the list and in the card view', () => {
    expect(page).not.toContain('safe-bottom');
    expect(rule(/\.fy-attn-inbox\[data-agenda-inbox='card'\] \{\s*min-height: 100%;[^}]*\}/u)).not.toContain(
      'safe-bottom',
    );
    expect(rule(/\.fy-attn-inbox\[data-agenda-inbox='card'\] \{\s*min-height: 100%;[^}]*\}/u)).toContain(
      'padding-bottom: 12px;',
    );
  });

  it('clears the undo toast, which floats one tab bar and 12px above the screen edge', () => {
    // The toast is ~46px tall and rides 12px above the bar, so the last card needs under 96px to clear it.
    expect(rule(/@media \(max-width: 767\.98px\) \{\s*\.fy-attn-undo \{[^}]*\}/u)).toContain(
      'bottom: calc(52px + 12px + var(--safe-bottom, 0px));',
    );
  });
});
