import { describe, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import should from 'should';

/**
 * B164: the swipe deck's top card is `will-change: transform`, which makes it the containing block of every
 * `position: fixed` descendant, so a hypermedia block's Fullscreen drew a card-sized box. The card must drop that
 * (and its stacking seal) while a block is fullscreen inside it. Geometry is proven by
 * `harness/fy-render-expand-screenshot.ts`; this pins the rule so it cannot be deleted quietly.
 */
const css = readFileSync(join(import.meta.dir, '../../../app/features/agenda/agenda-inbox.css'), 'utf8');

describe('agenda deck card with a fullscreen hypermedia block', () => {
  test('should drop the transform containing block and the stacking seal while a block is fullscreen', () => {
    should(css).match(/\.fy-attn-deck__top:has\(\.fy-render-fullscreen\)\s*\{[^}]*transform:\s*none\s*!important/u);
    should(css).match(/\.fy-attn-deck__top:has\(\.fy-render-fullscreen\)\s*\{[^}]*will-change:\s*auto/u);
    should(css).match(/\.fy-attn-deck:has\(\.fy-render-fullscreen\)\s*\{[^}]*isolation:\s*auto/u);
  });
});

/**
 * B152: the same card also holds a "Quote in composer" context menu. Left as the containing block it offset the menu and
 * the Inbox page's scroller clipped it at the page edge, so the card drops its transform while a `data-context-menu` is open.
 * Geometry is proven by the ContextMenu unit tests and the before/after captures; this pins the rule.
 */
describe('agenda deck card with an open context menu', () => {
  test('should drop the transform containing block while a context menu is open', () => {
    should(css).match(/\.fy-attn-deck__top:has\(\[data-context-menu\]\)\s*\{[^}]*transform:\s*none\s*!important/u);
    should(css).match(/\.fy-attn-deck__top:has\(\[data-context-menu\]\)\s*\{[^}]*will-change:\s*auto/u);
  });
});
