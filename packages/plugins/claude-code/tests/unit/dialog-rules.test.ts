import { describe, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import should from 'should';
import { DialogRuleSchema, isGrantLabel } from '@ferretry/plugin-warden/contract';
import { CLAUDE_DIALOG_RULES, DIALOG_NUDGES } from '../../daemon/dialog-rules.ts';
import { parseHarnessDialog } from '../../daemon/lib/pane/harness-dialog.ts';

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

/**
 * The table against REAL frames. Every Claude fixture is read the way the runner reads it and put to the table: a rule
 * must name a screen that is on screen today and pick a row the screen really has, and a screen the table leaves alone
 * is listed here, so an unlisted one fails the test instead of sitting on a launch with nobody told.
 */
describe('the Claude rules over every real Claude fixture', () => {
  const DIALOGS = join(import.meta.dir, '../fixtures/harness-dialogs');
  const matches = (source: string | undefined, text: string): boolean =>
    source === undefined || new RegExp(source, 'iu').test(text);
  const ruleOf = (dialog: NonNullable<ReturnType<typeof parseHarnessDialog>>) =>
    CLAUDE_DIALOG_RULES.find(
      rule =>
        rule.kind === dialog.kind &&
        matches(rule.title, dialog.title) &&
        matches(rule.body, (dialog.body ?? '').split('\n')[0] ?? ''),
    );

  /** What the table does with each real screen: the rule that clears it, or `null` for a screen that stays a notice. */
  const EXPECTED: Readonly<Record<string, string | null>> = {
    'claude-2.1.220-mcp-servers': 'claude-mcp-servers',
    'claude-2.1.281-mcp-servers': 'claude-mcp-servers',
    'claude-2.1.220-settings-error': 'claude-settings-error',
    'claude-2.1.281-settings-error': 'claude-settings-error',
    'claude-2.1.281-spend-limit': null, // the auto-move's
    'claude-2.1.327-chrome-notice': 'claude-chrome-notice',
    'claude-2.1.327-directory-trust': null, // its only ways out trust the folder or exit the ferret
    'claude-2.1.327-api-key': null, // "Yes" uses a key, "No" leaves the ferret unsigned: a person decides
    'claude-2.1.327-bypass-warning': null, // pre-answered by a home key; "Yes, I accept" is never pressed
  };

  it('has a disposition for every fixture, and none is left out', () => {
    should(Object.keys(EXPECTED).sort()).eql(
      readdirSync(DIALOGS)
        .map(file => file.replace(/\.txt$/u, ''))
        .sort(),
    );
  });

  for (const [name, expected] of Object.entries(EXPECTED))
    it(`${name}: ${expected === null ? 'stays a notice' : `cleared by ${expected}`}, never by a granting row`, () => {
      const dialog = parseHarnessDialog(readFileSync(join(DIALOGS, `${name}.txt`), 'utf8'));
      if (dialog === undefined) throw new Error(`${name} read as no dialog`);
      const rule = ruleOf(dialog);

      should(rule?.id ?? null).equal(expected);
      if (rule === undefined) return;
      if ('choose' in rule.action) {
        const rows = dialog.options.filter(
          option => option.label.toLowerCase() === (rule.action as { choose: string }).choose.toLowerCase(),
        );
        should(rows).have.length(1);
        should(rows[0]?.grantsTrust).equal(false);
      } else should(dialog.escape).not.be.undefined();
    });
});
