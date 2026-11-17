import { describe, it } from 'bun:test';
import should from 'should';
import type { DialogRule } from '../../contract/dialog-rules.ts';
import { builtInDialogRules, type DialogRuleProvision } from '../../daemon/dialog-rules-source.ts';
import { CLAUDE_DIALOG_RULES, CODEX_DIALOG_RULES, DIALOG_NUDGES } from '../support/dialog-rules.ts';

const decline: DialogRule = {
  id: 'claude-x',
  harness: 'claude',
  kind: 'other',
  title: '^x$',
  action: { choose: 'No, not now' },
};

function stand(provisions: readonly DialogRuleProvision[]) {
  const journal: { type: string; data: Readonly<Record<string, string>> }[] = [];
  const source = builtInDialogRules(
    () => provisions,
    (type, data) => void journal.push({ type, data }),
  );
  return { source, journal };
}

describe('the built-in dialog rules the harness plugins provide', () => {
  it('should give the rules each harness provides, claude then codex, and the words it says after a declined prompt', () => {
    // Arrange
    const { source, journal } = stand([
      { harness: 'claude', provided: { rules: CLAUDE_DIALOG_RULES, nudges: DIALOG_NUDGES } },
      { harness: 'codex', provided: { rules: CODEX_DIALOG_RULES } },
    ]);

    // Act
    const rules = source.rules();

    // Assert
    should(rules).eql([...CLAUDE_DIALOG_RULES, ...CODEX_DIALOG_RULES]);
    should(source.nudgeOf('claude-dangerous-rm')).match(/explicit absolute rm paths/u);
    should(source.nudgeOf('codex-update')).equal(undefined);
    should(journal).eql([]);
  });

  it('should give no rule for a harness with no provider, or whose plugin is off', () => {
    // Arrange
    const { source } = stand([
      { harness: 'claude', provided: undefined },
      { harness: 'codex', provided: 'unavailable' },
    ]);

    // Assert
    should(source.rules()).eql([]);
    should(source.nudgeOf('claude-dangerous-rm')).equal(undefined);
  });

  it('should refuse a provided rule that picks a granting row, journal it once, and keep the rest', () => {
    // Arrange
    const grants = { ...decline, id: 'claude-grants', action: { choose: 'Yes, and don’t ask again' } };
    const { source, journal } = stand([
      { harness: 'claude', provided: { rules: [grants, decline], nudges: { 'claude-grants': 'never said' } } },
    ]);

    // Act
    const first = source.rules();
    const second = source.rules();

    // Assert
    should(first).eql([decline]);
    should(second).eql([decline]);
    should(journal).have.length(1);
    should(journal[0]?.type).equal('fleet.warden_dialog_rule_refused');
    should(journal[0]?.data).containEql({ harness: 'claude', rule: 'claude-grants' });
    should(source.nudgeOf('claude-grants')).equal(undefined);
  });

  it('should refuse a rule for another harness than its hook, a duplicate id, and a rule that is not a rule', () => {
    // Arrange
    const { source, journal } = stand([
      { harness: 'claude', provided: { rules: [decline, { ...decline, harness: 'codex', id: 'codex-lies' }] } },
      {
        harness: 'codex',
        provided: {
          rules: [
            { ...decline, harness: 'codex' },
            { id: 'bad', harness: 'codex', kind: 'other', action: { press: 'escape' } } as unknown as DialogRule,
          ],
        },
      },
    ]);

    // Act
    const rules = source.rules();

    // Assert
    should(rules.map(rule => rule.id)).eql(['claude-x']);
    should(journal.map(entry => entry.data.rule).sort()).eql(['bad', 'claude-x', 'codex-lies']);
  });
});
