import { describe, it } from 'bun:test';
import should from 'should';
import { CLAUDE_DIALOG_RULES, CODEX_DIALOG_RULES } from '../support/dialog-rules.ts';
import type { FormKey } from '@ferretry/core-ferrets/contract';
import {
  DialogLearnAnswerSchema,
  type DialogRule,
  DialogRulesFileSchema,
  dialogRulesLoosen,
  doesOf,
  WARDEN_DIALOG_RULES,
} from '../../contract/dialog-rules.ts';
import {
  type ClearFrame,
  DialogLearnRefused,
  maskShapes,
  proposeRule,
  WardenDialogClear,
  WardenDialogLearn,
  type ClearableDialogWords,
} from '../../daemon/lib/index.ts';
import { renderLearn } from '../../cli/index.ts';

/**
 * O14: an unknown screen is taught to Ferretry by its owner — the frame is masked and kept locally, a rule is proposed from
 * the screen's fixed lines and its decline row, the owner saves it, and the next appearance is cleared. Fake frames only.
 */

const SECRET = 'abc123def456ghi789jkl012';

const row = (number: number, label: string, grantsTrust = false) => ({ number, label, grantsTrust });
const unknown = (over: Partial<ClearableDialogWords> = {}): ClearableDialogWords => ({
  id: 'bbbbbbbbbbbbbbbb',
  harness: 'claude',
  kind: 'other',
  title: 'Try the new fullscreen renderer? (beta)',
  options: [row(1, 'Yes, try it', true), row(2, 'No, keep the current one'), row(3, 'Never ask again')],
  escape: 'cancel',
  ...over,
});

/** The frame the harness draws for that screen, with the cursor where the test puts it. */
const frameOf = (dialog: ClearableDialogWords, cursor: number, extra: readonly string[] = []): string =>
  [
    '',
    `  ${dialog.title}`,
    ...extra,
    '',
    ...dialog.options.map((option, index) => `  ${index + 1 === cursor ? '❯' : ' '} ${option.label}`),
    '',
    '  Enter to confirm · Esc to cancel',
  ].join('\n');

describe('proposing a rule', () => {
  it('should pick the row whose words decline, never one that grants, and say the keys', () => {
    // Act
    const proposal = proposeRule({ ferret: 'f1', dialog: unknown() });

    // Assert
    should(proposal.held).equal(false);
    should(proposal.rule?.action).eql({ choose: 'No, keep the current one' });
    should(proposal.rows.filter(each => each.pressed).map(each => each.number)).eql([2]);
    should(proposal.rule?.harness).equal('claude');
    should(proposal.rule?.kind).equal('other');
    should(new RegExp(proposal.rule?.title ?? '', 'iu').test('Try the new fullscreen renderer? (beta)')).equal(true);
    should(DialogLearnAnswerSchema.safeParse({ proposal, saved: false, heldFor: [] }).success).equal(true);
  });

  it('should press Esc when no row declines and the screen offers it, and propose nothing when it offers neither', () => {
    // Arrange
    const grantsOnly = unknown({ options: [row(1, 'Yes, try it', true), row(2, 'Always allow')] });

    // Assert
    should(proposeRule({ ferret: 'f1', dialog: grantsOnly }).rule?.action).eql({ press: 'escape' });
    const none = proposeRule({ ferret: 'f1', dialog: { ...grantsOnly, escape: undefined } });
    should(none.rule).equal(undefined);
    should(none.note).containEql('stays yours');
  });

  it('should HOLD a proposal whose chosen row grants, trusts or approves — shown, never saved', () => {
    const dialog = unknown({ options: [...unknown().options, row(4, 'Always allow')] });
    for (const choose of [1, 4]) {
      // Act
      const proposal = proposeRule({ ferret: 'f1', dialog, row: choose });

      // Assert
      should(proposal.held).equal(true);
      should(proposal.rule).equal(undefined);
      should(proposal.rows.find(each => each.pressed)?.number).equal(choose);
    }
  });

  it('should take the owner’s own row when it declines, and say so when the screen has no such row', () => {
    // Assert
    should(proposeRule({ ferret: 'f1', dialog: unknown(), row: 2 }).rule?.action).eql({
      choose: 'No, keep the current one',
    });
    should(proposeRule({ ferret: 'f1', dialog: unknown(), row: 7 }).note).containEql('no row 7');
  });

  it('should never teach a tool prompt, the usage-limit screen or a screen of a harness it does not know', () => {
    // Assert
    should(proposeRule({ ferret: 'f1', dialog: unknown({ kind: 'permission' }) }).note).containEql('never taught');
    should(proposeRule({ ferret: 'f1', dialog: unknown({ kind: 'usage-limit' }) }).note).containEql('auto-move');
    should(proposeRule({ ferret: 'f1', dialog: unknown({ harness: undefined }) }).note).containEql('not known');
  });

  it('should escape a title so a pattern never reads a title as a pattern, and keep a long title short', () => {
    // Act
    const title = `Is this (a) [test]? ${'x'.repeat(200)}`;
    const proposal = proposeRule({ ferret: 'f1', dialog: unknown({ title }) });

    // Assert
    should(proposal.rule?.title?.length).be.below(100);
    should(new RegExp(proposal.rule?.title ?? '', 'iu').test(title)).equal(true);
    should(new RegExp(proposal.rule?.title ?? '', 'iu').test('Is this a test? xxxx')).equal(false);
  });
});

describe('masking a frame', () => {
  it('should hide an authorization value and a provider key by their shape', () => {
    // Assert
    should(maskShapes(`Authorization: Bearer ${SECRET}`)).equal('Authorization: Bearer ***');
    should(maskShapes('key sk-ant-api03-abcdefghijklmnopqrstuvwx')).equal('key ***');
    should(maskShapes('Bearer short')).equal('Bearer short');
  });
});

/** The learn flow over fakes: the ferret's dialog and frame, the masker, the kept frame, the proposals, the saved rules. */
function stand(
  options: {
    dialog?: ClearableDialogWords | undefined;
    frame?: ClearFrame | undefined;
    saved?: readonly string[];
  } = {},
) {
  const log = {
    frames: [] as string[],
    saved: [] as DialogRule[],
    events: [] as { type: string; data: Readonly<Record<string, string>> }[],
  };
  let proposals: Record<string, readonly string[]> = {};
  const dialog =
    'dialog' in options ? options.dialog : unknown({ options: unknown().options.map(each => ({ ...each })) });
  const learn = new WardenDialogLearn({
    dialogOf: async () => dialog,
    frame: async () =>
      'frame' in options
        ? options.frame
        : { visible: frameOf(unknown(), 1, [`  Authorization: Bearer ${SECRET}`]), blocking: 'dialog' },
    // The Vault-value masker, as the kernel's stand-in does it: a known value becomes `*`s of the same width.
    mask: async text => text.replaceAll(SECRET, '*'.repeat(SECRET.length)),
    saveFrame: async (_ferret, masked) => {
      log.frames.push(masked);
    },
    proposals: {
      read: async () => proposals,
      write: async next => {
        proposals = next;
      },
    },
    saveRule: async rule => {
      log.saved.push(rule);
      return options.saved ?? [];
    },
    record: (type, data) => {
      log.events.push({ type, data });
    },
  });
  return { learn, log, proposals: () => proposals };
}

describe('learning a screen', () => {
  it('should keep a MASKED frame and let no secret reach the frame, the proposal, the journal or the pending store', async () => {
    // Arrange
    const { learn, log, proposals } = stand();

    // Act
    const answer = await learn.learn('f1');

    // Assert
    should(log.frames).have.length(1);
    should(log.frames[0]).not.containEql(SECRET).and.containEql('Bearer ***');
    for (const surface of [JSON.stringify(answer), JSON.stringify(log.events), JSON.stringify(proposals())])
      should(surface).not.containEql(SECRET);
    should(answer.saved).equal(false);
    should(log.saved).eql([]);
    should(log.events.map(event => event.type)).eql(['fleet.warden_dialog_learned']);
  });

  it('should propose nothing — and say why — when the screen’s own words carry a secret', async () => {
    // Arrange
    const { learn, proposals } = stand({ dialog: unknown({ title: `Token ${SECRET} was found` }) });

    // Act
    const answer = await learn.learn('f1');

    // Assert
    should(answer.proposal.rule).equal(undefined);
    should(answer.proposal.note).containEql('secret-shaped');
    should(JSON.stringify(answer)).not.containEql(SECRET);
    should(proposals()).eql({});
  });

  it('should refuse a ferret that is not parked on a dialog, and a screen it cannot read as one', async () => {
    // Assert
    await stand({ dialog: undefined })
      .learn.learn('f1')
      .then(
        () => should.fail(undefined, undefined, 'learned'),
        (error: unknown) => should(error).be.instanceOf(DialogLearnRefused),
      );
    await stand({ frame: undefined })
      .learn.learn('f1')
      .then(
        () => should.fail(undefined, undefined, 'learned'),
        (error: unknown) => should((error as Error).message).containEql('could not be read'),
      );
    await stand({ frame: { visible: 'x', blocking: false } })
      .learn.learn('f1')
      .then(
        () => should.fail(undefined, undefined, 'learned'),
        (error: unknown) => should(error).be.instanceOf(DialogLearnRefused),
      );
  });

  it('should keep no pending proposal for a held one', async () => {
    // Arrange
    const { learn, proposals } = stand();

    // Act
    const answer = await learn.learn('f1', 1);

    // Assert
    should(answer.proposal.held).equal(true);
    should(proposals()).eql({});
    await learn.confirm('f1').then(
      () => should.fail(undefined, undefined, 'confirmed'),
      (error: unknown) => should(error).be.instanceOf(DialogLearnRefused),
    );
  });
});

describe('the owner’s yes', () => {
  it('should save the proposed rule once, and clear that screen the next time it shows', async () => {
    // Arrange
    const { learn, log, proposals } = stand();
    await learn.learn('f1');
    should(Object.keys(proposals())).eql(['f1']);

    // Act
    const answer = await learn.confirm('f1');

    // Assert
    should(answer.saved).equal(true);
    should(answer.heldFor).eql([]);
    should(log.saved).have.length(1);
    should(proposals()).eql({});
    should(log.events.map(event => event.type)).eql(['fleet.warden_dialog_learned', 'fleet.warden_dialog_rule_saved']);

    // The next appearance: a fake pane that obeys keys, the taught rule beside the built-in tables.
    const screen = unknown();
    const state = { cursor: 1, gone: false, pressed: [] as FormKey[] };
    const clear = new WardenDialogClear({
      rules: async () => [...CLAUDE_DIALOG_RULES, ...CODEX_DIALOG_RULES, ...log.saved],
      words: async () => screen,
      frame: async () =>
        state.gone
          ? { visible: '\n  ❯ \n', blocking: false }
          : { visible: frameOf(screen, state.cursor), blocking: 'dialog' },
      key: async (_session, key) => {
        state.pressed.push(key);
        if (key === 'Down') state.cursor += 1;
        if (key === 'Enter' || key === 'Escape') state.gone = true;
        return true;
      },
      nudge: () => undefined,
      sleep: async () => undefined,
      memory: { read: async () => ({}), write: async () => undefined },
      record: () => undefined,
    });
    const next = await clear.clear([{ sessionId: 'f1', name: 'ada', dialog: screen }]);
    should(state.pressed).eql(['Down', 'Enter']);
    should(next.toTell).eql([]);
  });

  it('should refuse to confirm what was never proposed', async () => {
    // Assert
    await stand()
      .learn.confirm('f1')
      .then(
        () => should.fail(undefined, undefined, 'confirmed'),
        (error: unknown) => should((error as Error).message).containEql('run learn first'),
      );
  });

  it('should say what is held for the owner when the kernel holds the write, and keep nothing in effect', async () => {
    // Arrange
    const { learn } = stand({ saved: ['the Warden may press keys to clear the claude-code other screen (x)'] });
    await learn.learn('f1');

    // Act
    const answer = await learn.confirm('f1');

    // Assert
    should(answer.saved).equal(false);
    should(answer.heldFor).have.length(1);
  });
});

describe('the rules file', () => {
  const rule: DialogRule = {
    id: 'learned-x',
    harness: 'codex',
    kind: 'other',
    title: '^x',
    action: { press: 'escape' },
  };

  it('should count every rule added as a loosening, so an edit by anyone but the owner is held', () => {
    // Assert
    should(dialogRulesLoosen(undefined, { rules: [rule] })).have.length(1);
    should(dialogRulesLoosen({ rules: [rule] }, { rules: [rule] })).eql([]);
    should(dialogRulesLoosen({ rules: [rule] }, { rules: [] })).eql([]);
    should(dialogRulesLoosen(undefined, {})).eql([]);
  });

  it('should be a file no agent edits, owner-only and under the configure axis', () => {
    // Assert
    should(WARDEN_DIALOG_RULES.personOnly).equal(true);
    should(WARDEN_DIALOG_RULES.axis).equal('configure');
    should(WARDEN_DIALOG_RULES.file).equal('warden-dialogs.yaml');
  });

  it('should refuse a file with a rule it does not understand', () => {
    // Assert
    should(DialogRulesFileSchema.safeParse({ rules: [rule] }).success).equal(true);
    should(DialogRulesFileSchema.safeParse({ rules: [{ ...rule, extra: 1 }] }).success).equal(false);
    should(DialogRulesFileSchema.safeParse({ unknown: [] }).success).equal(false);
  });

  it('should say a rule in a sentence', () => {
    // Assert
    should(doesOf(rule)).equal('presses Esc');
    should(doesOf({ ...rule, action: { choose: 'No, not now' } })).equal('chooses “No, not now”');
  });
});

describe('what `fy warden dialog learn` prints', () => {
  it('should show the screen, mark the row pressed, and say how to save', async () => {
    // Arrange
    const answer = await stand().learn.learn('f1');

    // Act
    const text = renderLearn(answer, 'ada');

    // Assert
    should(text).containEql('ada is parked on: Try the new fullscreen renderer? (beta)');
    should(text).containEql('→ 2. No, keep the current one');
    should(text).containEql('fy warden dialog learn ada --confirm');
    should(text).not.containEql(SECRET);
  });

  it('should say a saved rule, a held one, a held proposal and a refusal to propose', async () => {
    // Arrange
    const proposal = proposeRule({ ferret: 'f1', dialog: unknown() });
    const held = proposeRule({ ferret: 'f1', dialog: unknown(), row: 1 });
    const nothing = proposeRule({ ferret: 'f1', dialog: unknown({ kind: 'permission' }) });

    // Assert
    should(renderLearn({ proposal, saved: true, heldFor: [] }, 'ada')).containEql('Saved.');
    should(renderLearn({ proposal, saved: false, heldFor: ['waits'] }, 'ada')).containEql('Held for you');
    should(renderLearn({ proposal: held, saved: false, heldFor: [] }, 'ada')).containEql('held');
    should(renderLearn({ proposal: nothing, saved: false, heldFor: [] }, 'ada')).containEql('never taught');
    should(
      renderLearn(
        {
          proposal: { ...proposal, rule: { ...(proposal.rule as DialogRule), action: { press: 'escape' } } },
          saved: false,
          heldFor: [],
        },
        'ada',
      ),
    ).containEql('press Esc');
  });
});
