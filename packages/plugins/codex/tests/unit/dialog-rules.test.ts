import { describe, it } from 'bun:test';
import should from 'should';
import { DialogRuleSchema, isGrantLabel } from '@ferretry/plugin-warden/contract';
import { CODEX_DIALOG_RULES } from '../../daemon/dialog-rules.ts';

describe('Codex’s dialog rules, which the Warden reads through its hook', () => {
  it('should be valid rules for the codex harness, with unique ids', () => {
    // Assert
    for (const rule of CODEX_DIALOG_RULES) {
      should(DialogRuleSchema.safeParse(rule).success).equal(true);
      should(rule.harness).equal('codex');
      should(rule.id).match(/^codex-/u);
    }
    should(new Set(CODEX_DIALOG_RULES.map(rule => rule.id)).size).equal(CODEX_DIALOG_RULES.length);
  });

  it('should never choose a row that grants', () => {
    // Assert
    for (const rule of CODEX_DIALOG_RULES)
      if ('choose' in rule.action) should(isGrantLabel(rule.action.choose)).equal(false);
  });
});
