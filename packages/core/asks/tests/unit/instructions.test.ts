import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import manifest from '../../manifest.ts';

/** The Asks rule a lead ferret reads (`instructions/asks.md`), pinned exactly so a change shows in review. */
const ASKS_RULE = readFileSync(new URL('../../instructions/asks.md', import.meta.url), 'utf8');

describe('the Asks instruction', () => {
  test('says exactly this', () => {
    expect(ASKS_RULE).toBe(`## Asks: the agenda asks, the item shows

- Only an ask asks. When you need the owner to decide or do something, raise an ask (\`fy agenda add\`); a task
  (&F<n>) never asks, has no answer of its own, and is named on an ask at most once ("For &F<n> Badge colour").
- One ask, one answer row: say what you need once, in its "What I need from you", with its own answers or words.
- The owner's answer may move linked tasks (Done closes a tried task, Not good sends it back with their words). That
  is the daemon's bookkeeping: you are told the outcome; you never move a task to stand in for an answer.
- Ask only when there is something to ask, and on the topic's existing ask; never open a new ask per stage.
- Only the owner answers an ask. You never answer your own ask, and a value the owner types into an input form goes
  to its target, never to you.
`);
  });

  test('is for leads only: a helper has no agenda of its own', () => {
    expect(manifest.instructions?.find(entry => entry.id === 'asks')?.when).toEqual({ role: 'lead' });
  });
});
