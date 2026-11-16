import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE OWNER'S PHONE, 2026-10-30: "I can't even scroll, and 'needs you' doesn't open anywhere". An open agenda item
 * made the conversation inert, and the item's view — meant to cover it — was 0px tall: the conversation sat in a
 * `display: contents` wrapper, so it was auto-placed into a SECOND grid row that took the whole height, and the
 * row the view had named was left empty. Every touch landed on an inert list; ✕ was in a 0px box.
 *
 * The chat log is ONE cell with layers in it. Every layer must name that cell, or it falls into a row of its own. The
 * layers the Agenda draws over it (an open item, the drawer scrim) are checked in the Agenda's own tests.
 * `harness/phone-chat-screenshot.ts` measures the same thing in a browser.
 */

/** The packages directory: the cell is the shell's design system, and the layers in it come from the halves that draw them. */
const SRC = join(import.meta.dir, '../../../../../..');
const read = (path: string): string => readFileSync(join(SRC, path), 'utf8');
const rule = (css: string, selector: string): string =>
  css.match(new RegExp(`\\n${selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')} \\{[^}]*\\}`, 'u'))?.[0] ?? '';

describe('every layer of the chat log shares its one cell', () => {
  const log = rule(read('app/src/ui/design-system.css'), '.fy-chat-log');

  it('is one row and one column', () => {
    expect(log).toContain('display: grid;');
    expect(log).toContain('grid-template-rows: minmax(0, 1fr);');
    expect(log).toContain('grid-template-columns: minmax(0, 1fr);');
  });

  it('puts the message list in the cell', () => {
    expect(rule(read('app/src/ui/design-system.css'), '.fy-chat-log__messages')).toContain('grid-area: 1 / 1;');
  });

  it('lets the message list fill its cell, so the conversation keeps its own scroller', () => {
    const messages = rule(read('app/src/ui/design-system.css'), '.fy-chat-log__messages');
    expect(messages).toContain('display: flex;');
    expect(messages).toContain('min-height: 0;');
    expect(rule(read('app/src/ui/design-system.css'), '.fy-chat-log__messages > .fy-transcript-shell')).toContain(
      'flex: 1 1 0;',
    );
  });

  it('wraps the conversation in a real element, never a `contents` box that cannot hold a grid area', () => {
    const page = read('plugins/conversation/app/chat/session-chat-page.tsx');
    const log = page.slice(page.indexOf('<div className="fy-chat-log">'));
    expect(log.indexOf('className="fy-chat-log__messages"')).toBeGreaterThan(0);
    expect(log.slice(0, log.indexOf('<Transcript'))).not.toContain('className="contents"');
  });
});
