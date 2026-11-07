import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE OWNER'S PHONE, 2026-10-30: "I can't even scroll, and 'needs you' doesn't open anywhere". An open agenda item
 * made the conversation inert, and the item's view — meant to cover it — was 0px tall: the chat log is ONE grid cell
 * with layers in it, and every layer must name that cell or it falls into a row of its own. The cell and the message
 * list are Conversation's (its `chat-log-cell` test); the two layers the Agenda draws over them are checked here.
 */

const AGENDA = join(import.meta.dir, '../../../app/features/agenda');
const rule = (css: string, selector: string): string =>
  css.match(new RegExp(`\\n${selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')} \\{[^}]*\\}`, 'u'))?.[0] ?? '';

describe('the Agenda layers over the chat log share its one cell', () => {
  it.each([
    ['an open item', 'agenda-item-card.css', '.fy-item-view'],
    ['the drawer scrim', 'agenda-chat.css', '.fy-chat-log > .fy-agenda-scrim'],
  ])('%s names the cell', (_name, file, selector) => {
    expect(rule(readFileSync(join(AGENDA, file), 'utf8'), selector)).toContain('grid-area: 1 / 1;');
  });
});
