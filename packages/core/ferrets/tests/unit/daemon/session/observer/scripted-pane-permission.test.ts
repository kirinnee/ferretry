import { describe, it } from 'bun:test';
import should from 'should';
import { turnPaneEvidenceOf } from '../../../../../daemon/lib/session/observer/pane.ts';
import type { PaneState } from '../../../../../daemon/lib/session/peers/tmux.ts';
import { SCRIPTED_PANE_PARSERS } from '../../../../support/daemon/observer-stand-ins.ts';

const PERMISSION = ' Do you want to proceed?\n ❯ 1. Yes\n   2. No, and tell Claude what to do differently';
const paneShowing = (visible: string): PaneState => ({
  alive: true,
  dead: false,
  promptReady: false,
  history: '',
  visible,
});

// No guarantees row covers the permission phase (docs/rebuild/guarantees.tsv names none); the parity test pins it.
describe('the scripted pane parsers, read through the turn evidence (no guarantees row)', () => {
  it('should put a permission question with numbered choices into the turn evidence as permission', () => {
    should(turnPaneEvidenceOf(paneShowing(PERMISSION), SCRIPTED_PANE_PARSERS).permission).be.true();
  });

  it('should not read prose, a single choice, or a working screen as permission', () => {
    for (const visible of [
      'Do you want to proceed? maybe',
      ' Do you want to proceed?\n ❯ 1. Yes',
      '⏺ Reading.\n✽ Pontificating… (3s · esc to interrupt)',
    ])
      should(turnPaneEvidenceOf(paneShowing(visible), SCRIPTED_PANE_PARSERS).permission).be.false();
  });
});
