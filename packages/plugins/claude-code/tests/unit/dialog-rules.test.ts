import { describe, it } from 'bun:test';
import should from 'should';
import { DialogRuleSchema, isGrantLabel } from '@ferretry/plugin-warden/contract';
import { CLAUDE_DIALOG_RULES, DIALOG_NUDGES } from '../../daemon/dialog-rules.ts';

describe('Claude Code’s dialog rules, which the Warden reads through its hook', () => {
  it('should be valid rules for the claude harness, with unique ids', () => {
    // Assert
    for (const rule of CLAUDE_DIALOG_RULES) {
      should(DialogRuleSchema.safeParse(rule).success).equal(true);
      should(rule.harness).equal('claude');
      should(rule.id).match(/^claude-/u);
    }
    should(new Set(CLAUDE_DIALOG_RULES.map(rule => rule.id)).size).equal(CLAUDE_DIALOG_RULES.length);
  });

  it('should never choose a row that grants', () => {
    // Assert
    for (const rule of CLAUDE_DIALOG_RULES)
      if ('choose' in rule.action) should(isGrantLabel(rule.action.choose)).equal(false);
  });

  it('should say its words only for a rule it has, and tell a ferret how to retry a dangerous rm', () => {
    // Assert
    const ids = new Set(CLAUDE_DIALOG_RULES.map(rule => rule.id));
    for (const id of Object.keys(DIALOG_NUDGES)) should(ids.has(id)).equal(true);
    should(DIALOG_NUDGES['claude-dangerous-rm']).match(/explicit absolute rm paths/u);
  });
});
