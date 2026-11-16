import { describe, it } from 'bun:test';
import should from 'should';
import { turnPaneEvidenceOf } from '../../../../../daemon/lib/session/observer/pane.ts';
import type { PaneParsers, PaneState } from '../../../../../daemon/lib/session/peers/tmux.ts';
import { observeTurn } from '../../../../../daemon/lib/session/peers/turn.ts';

/**
 * &B188: an idle composer holding a draft is an idle prompt for the turn look, although a send would not be accepted
 * there (`promptReady` is false with the cursor on the draft). The pane parsers are the terminals plugin's, and how they
 * read a real frame is tested there; these read the frames below as those parsers do.
 */
const RULE = '─'.repeat(80);
const DRAFT = [
  '⏺ Done reading the cache layer.',
  '',
  RULE,
  '❯ Read the file /x/turn-063.md now, then follow it',
  RULE,
].join('\n');
const COMPACTING = DRAFT.replace('⏺ Done reading the cache layer.', '· Compacting conversation…');

const parsers: PaneParsers = {
  parsePermissionPrompt: () => undefined,
  paneActiveWork: visible => (visible === COMPACTING ? 'status' : undefined),
  paneShowsPermissionPrompt: () => false,
  paneBlockingPrompt: () => undefined,
  parseHarnessDialog: () => undefined,
  // An idle composer with no work on screen, whatever the box holds.
  idlePromptShown: visible => visible === DRAFT,
};

const pane = (visible: string, over: Partial<PaneState> = {}): PaneState => ({
  alive: true,
  dead: false,
  promptReady: false,
  history: '',
  visible,
  ...over,
});

describe('B188 an idle composer holding a draft is an idle prompt for the turn look', () => {
  it('B188 reads atPrompt although a send would not be accepted, and settles your-turn on sight with the transcript ended', () => {
    const look = turnPaneEvidenceOf(pane(DRAFT), parsers);

    should(look.atPrompt).be.true();
    should(observeTurn({ state: { status: 'running', turn: 2 }, transcript: 'ended', pane: look })).match({
      state: 'your-turn',
      confirmed: true,
    });
  });

  it('B188 still reads no prompt for a compaction, and none for a dead pane', () => {
    should(turnPaneEvidenceOf(pane(COMPACTING), parsers)).match({ working: true, atPrompt: false });
    should(turnPaneEvidenceOf(pane(DRAFT, { dead: true }), parsers)).match({ atPrompt: false });
  });

  it('B188 a pane whose composer accepts a send reads atPrompt without asking the parser', () => {
    should(turnPaneEvidenceOf(pane('anything', { promptReady: true }), parsers).atPrompt).be.true();
  });
});
