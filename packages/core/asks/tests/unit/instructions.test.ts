import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import manifest from '../../manifest.ts';

/** The Asks rule a lead ferret reads (`instructions/asks.md`), pinned exactly so a change shows in review. */
const ASKS_RULE = readFileSync(new URL('../../instructions/asks.md', import.meta.url), 'utf8');

describe('the Asks instruction', () => {
  test('says exactly this', () => {
    expect(ASKS_RULE).toBe(`## Asks: the agenda asks, the item shows

- Only an ask asks. When you need the owner to decide or do something, raise an ask (\`fy agenda add\`).
- One ask, one answer row: say what you need once, in its "What I need from you", with its own answers or words.
- Ask only when there is something to ask, and on the topic's existing ask; never open a new ask per stage.
- Only the owner answers an ask. You never answer your own ask, and a value the owner types into an input form goes
  to its target, never to you.
`);
  });

  test('names no verb or word the work switch (Board, Agenda, Loops) can turn off, and still teaches the core Asks verb', () => {
    // Core Asks is always on, so its words are what a ferret reads with the work switch off: a task is Board's word.
    expect(ASKS_RULE).not.toMatch(/\bfy (?:task|board)\b|&F<n>|\btasks?\b/u);
    expect(ASKS_RULE).toContain('`fy agenda add`');
  });

  test('is for leads only: a helper has no agenda of its own', () => {
    expect(manifest.instructions?.find(entry => entry.id === 'asks')?.when).toEqual({ role: 'lead' });
  });
});
