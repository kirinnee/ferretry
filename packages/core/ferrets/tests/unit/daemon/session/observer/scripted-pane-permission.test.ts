import { describe, it } from 'bun:test';
import should from 'should';
import { SCRIPTED_PANE_PARSERS } from '../../../../support/daemon/observer-stand-ins.ts';

const PERMISSION = ' Do you want to proceed?\n ❯ 1. Yes\n   2. No, and tell Claude what to do differently';

describe('the scripted pane parsers', () => {
  it('should read a permission question with numbered choices as a permission prompt', () => {
    should(SCRIPTED_PANE_PARSERS.paneShowsPermissionPrompt(PERMISSION)).be.true();
  });

  it('should not read prose, or one choice, or a working screen as a permission prompt', () => {
    should(SCRIPTED_PANE_PARSERS.paneShowsPermissionPrompt('Do you want to proceed? maybe')).be.false();
    should(SCRIPTED_PANE_PARSERS.paneShowsPermissionPrompt(' Do you want to proceed?\n ❯ 1. Yes')).be.false();
    should(
      SCRIPTED_PANE_PARSERS.paneShowsPermissionPrompt('⏺ Reading.\n✽ Pontificating… (3s · esc to interrupt)'),
    ).be.false();
  });
});
