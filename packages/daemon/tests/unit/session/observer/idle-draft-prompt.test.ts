import { describe, it } from 'bun:test';
import should from 'should';
import { turnPaneEvidenceOf } from '../../../../src/lib/session/observer/pane.ts';
import { observeTurn } from '../../../../src/lib/session/turn/policy.ts';
import { paneStateFrom, parsePaneMetadata } from '../../../../src/lib/tmux/pane.ts';

const RULE = '─'.repeat(80);
const frame = (composer: string): string => ['⏺ Done reading the cache layer.', '', RULE, composer, RULE].join('\n');
const evidenceOf = (visible: string, cursorX: number) =>
  turnPaneEvidenceOf(paneStateFrom(parsePaneMetadata(`0||${cursorX}|3|24|80`), visible));

describe('B188 an idle composer holding a draft is an idle prompt for the turn look', () => {
  it('B188 reads atPrompt although the cursor sits at the end of the draft, where a send would not be accepted', () => {
    const draft = frame('❯ Read the file /x/turn-063.md now, then follow it');

    const look = evidenceOf(draft, 52);

    should(look.atPrompt).be.true();
    // The turn this gives with the transcript ended: the ferret's turn, confirmed on sight.
    should(observeTurn({ state: { status: 'running', turn: 2 }, transcript: 'ended', pane: look })).match({
      state: 'your-turn',
      confirmed: true,
    });
  });

  it('B188 still reads no prompt for a compaction, work or a dead pane', () => {
    should(evidenceOf(frame('❯ ').replace('⏺ Done reading the cache layer.', '· Compacting conversation…'), 2)).match({
      working: true,
      atPrompt: false,
    });
    should(
      evidenceOf(frame('❯ draft').replace('⏺ Done reading the cache layer.', '✻ Pondering… (3s · ↓ 1k tokens)'), 8),
    ).match({
      working: true,
      atPrompt: false,
    });
  });
});
