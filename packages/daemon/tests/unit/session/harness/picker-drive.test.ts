import { describe, it } from 'bun:test';
import should from 'should';
import {
  CodexModelPickerDriver,
  CodexPickerDriveError,
  codexEffortLabel,
  type CodexPickerDrivePort,
  type CodexPickerFrame,
  type CodexPickerKeyExpectation,
  quickPickerRefusal,
} from '../../../../src/lib/session/harness/picker-drive.ts';
import { parseCodexPickerScreen } from '../../../../src/lib/session/harness/picker-screen.ts';
import { planRuntimeSwitch } from '../../../../src/lib/session/harness/runtime-switch.ts';
import type { InjectionOutcome } from '../../../../src/lib/tmux/delivery.ts';

/**
 * Driving the picker, with the pane replaced by a script of screens.
 *
 * The transport is a fake, but every screen below is real captured-pane text run through the real
 * classifier — which is the point. The keys this driver sends are derived from that text, so a fake
 * that returned pre-parsed screens would prove nothing about the only input the driver ever has.
 */

const QUICK = ['Select Model', '  1. gpt-5.6-codex', '  2. gpt-5.6-terra', '  3. All models'].join('\n');
const QUICK_WITHOUT_TARGET = ['Select Model', '  1. gpt-5.6-terra', '  2. All models'].join('\n');
const ALL = ['Select Model and Effort', '  1. gpt-5.6-codex', '  2. gpt-5.6-terra'].join('\n');
const LEVELS = [
  'Select Reasoning Level for gpt-5.6-codex',
  '  1. Low',
  '  2. Medium',
  '  3. High',
  '  4. More reasoning…',
].join('\n');
const ADVANCED = ['Advanced Reasoning', '  1. Max', '  2. Ultra'].join('\n');
const PLAN_SCOPE = [
  'Apply reasoning change',
  '  1. Apply to global default only',
  '  2. Apply to global default and Plan mode override',
].join('\n');
const IDLE = ['› ', ''].join('\n');
const DEEP_ROW = [
  'Select Model and Effort',
  ...Array.from({ length: 10 }, (_, index) => `  ${index + 1}. m${index + 1}`),
]
  .join('\n')
  .replace('10. m10', '10. gpt-5.6-codex');

interface ScriptedFrame {
  readonly visible: string;
  readonly promptReady?: boolean;
  readonly alive?: boolean;
  readonly dead?: boolean;
}

/** A pane that shows each scripted screen in turn, then repeats the last one forever. */
class ScriptedPicker implements CodexPickerDrivePort {
  readonly keys: { key: string; expected: CodexPickerKeyExpectation }[] = [];
  opens = 0;
  #index = 0;

  constructor(
    private readonly frames: readonly ScriptedFrame[],
    private readonly opened: InjectionOutcome | Error = 'handled-local',
    /** Screens the transport refuses to key, by the row name it was aimed at. */
    private readonly rejectKeyFor: readonly string[] = [],
  ) {}

  async openPicker(): Promise<InjectionOutcome> {
    this.opens++;
    if (this.opened instanceof Error) throw this.opened;
    return this.opened;
  }

  async readPane(): Promise<CodexPickerFrame> {
    const frame = this.frames[Math.min(this.#index, this.frames.length - 1)] ?? { visible: IDLE };
    this.#index++;
    return {
      alive: frame.alive ?? true,
      dead: frame.dead ?? false,
      promptReady: frame.promptReady ?? false,
      visible: frame.visible,
    };
  }

  async sendKey(key: string, expected: CodexPickerKeyExpectation): Promise<void> {
    if (this.rejectKeyFor.includes(expected.row.name))
      throw new Error(`the Codex picker changed before ${expected.row.name} could be selected`);
    this.keys.push({ key, expected });
  }
}

const noSleep = { sleep: async () => undefined };

const driver = (transport: CodexPickerDrivePort, maxObservations = 8) =>
  new CodexModelPickerDriver(transport, noSleep, { settleMs: 0, maxObservations });

describe('the Codex reasoning level label', () => {
  it('should name each level the way the picker renders it', async () => {
    // A capitalisation rule would get `xhigh` wrong, and a digit sent for a row that is not the one it
    // names selects a neighbour.
    // Arrange / Act / Assert
    should(codexEffortLabel('xhigh')).equal('Extra high');
    should(codexEffortLabel('medium')).equal('Medium');
    should(codexEffortLabel('ultra')).equal('Ultra');
  });

  it('should pass an unknown level through for an exact-match attempt', async () => {
    // Arrange / Act / Assert
    should(codexEffortLabel('glacial')).equal('glacial');
  });
});

describe('the quick-picker expressibility check', () => {
  it('should refuse a visible quick row whose preset level is not the one asked for', async () => {
    // Arrange / Act
    const refusal = quickPickerRefusal(parseCodexPickerScreen(QUICK), {
      model: 'gpt-5.6-codex',
      effort: 'high',
      quickPickerDefaultEffort: 'medium',
      quickPickerAppliesPreset: true,
    });

    // Assert
    should(refusal).match(/can only apply its default medium reasoning level for gpt-5\.6-codex, not high/u);
  });

  it('should refuse a visible quick row whose preset nobody can name', async () => {
    // THE DANGEROUS CASE. An account that advertises levels and no default gives a quick row whose
    // effect cannot be predicted — and judging by the preset's NAME read that as "no mismatch", so the
    // row was selected, Codex applied whatever it liked, the picker returned to a prompt, and the
    // daemon reported success for a session running a level nobody asked for.
    // Arrange / Act
    const refusal = quickPickerRefusal(parseCodexPickerScreen(QUICK), {
      model: 'gpt-5.6-codex',
      effort: 'high',
      quickPickerAppliesPreset: true,
    });

    // Assert
    should(refusal).match(/can only apply a reasoning level this account does not advertise/u);
  });

  it('should allow a model that is not on the quick list', async () => {
    // Reached through `All models`, whose flow shows the ordinary level screen.
    // Arrange / Act
    const refusal = quickPickerRefusal(parseCodexPickerScreen(QUICK_WITHOUT_TARGET), {
      model: 'gpt-5.6-codex',
      effort: 'high',
      quickPickerDefaultEffort: 'medium',
      quickPickerAppliesPreset: true,
    });

    // Assert
    should(refusal).equal(undefined);
  });

  it('should allow a quick row the planner did not flag', async () => {
    // The planner clears the flag exactly when the row provably applies the requested level, or when
    // the row opens the reasoning submenu instead of applying anything.
    // Arrange / Act, Assert
    should(quickPickerRefusal(parseCodexPickerScreen(QUICK), { model: 'gpt-5.6-codex', effort: 'medium' })).equal(
      undefined,
    );
  });

  it('should judge nothing on a screen that is not the quick picker', async () => {
    // Arrange / Act, Assert
    should(
      quickPickerRefusal(parseCodexPickerScreen(ALL), {
        model: 'gpt-5.6-codex',
        effort: 'high',
        quickPickerDefaultEffort: 'medium',
        quickPickerAppliesPreset: true,
      }),
    ).equal(undefined);
  });
});

describe('the Codex model picker preflight', () => {
  it('should open the picker and answer with the screen it found', async () => {
    // Arrange
    const transport = new ScriptedPicker([{ visible: IDLE, promptReady: true }, { visible: QUICK }]);
    const subject = driver(transport);

    // Act
    const screen = await subject.preflight({ model: 'gpt-5.6-codex', effort: 'medium' });

    // Assert
    should(transport.opens).equal(1);
    should(screen.kind).equal('quick-models');
    // Nothing was selected: preflight reads, it does not choose.
    should(transport.keys).have.length(0);
  });

  it('should refuse when the harness read the command as a turn', async () => {
    // A `/model` that started a paid turn is not an open picker, and driving on would send digits into
    // a conversation.
    // Arrange
    const transport = new ScriptedPicker([{ visible: QUICK }], 'turn-started');
    const subject = driver(transport);

    // Act
    const failure = await subject.preflight({ model: 'gpt-5.6-codex', effort: 'medium' }).catch(error => error);

    // Assert
    should(failure).be.instanceOf(CodexPickerDriveError);
    should(failure).match({ message: /consumed the picker command as a model turn/u });
  });

  it('should refuse before a single key when the quick row cannot express the target', async () => {
    // Arrange
    const transport = new ScriptedPicker([{ visible: QUICK }]);
    const subject = driver(transport);

    // Act
    const failure = await subject
      .preflight({
        model: 'gpt-5.6-codex',
        effort: 'high',
        quickPickerDefaultEffort: 'medium',
        quickPickerAppliesPreset: true,
      })
      .catch(error => error);

    // Assert
    should(failure).match({ message: /can only apply its default medium reasoning level/u });
    should(transport.keys).have.length(0);
  });

  it('should refuse a quick row with an unnameable preset before a single key', async () => {
    // The preflight ran and, before this fix, reached no verdict — so the drive went ahead.
    // Arrange
    const transport = new ScriptedPicker([{ visible: QUICK }]);
    const subject = driver(transport);

    // Act
    const failure = await subject
      .preflight({ model: 'gpt-5.6-codex', effort: 'high', quickPickerAppliesPreset: true })
      .catch(error => error);

    // Assert
    should(failure).match({ message: /a reasoning level this account does not advertise/u });
    should(transport.keys).have.length(0);
  });

  it('should give up on a pane that never shows a model list', async () => {
    // Arrange
    const transport = new ScriptedPicker([{ visible: IDLE, promptReady: true }]);
    const subject = driver(transport, 3);

    // Act
    const failure = await subject.preflight({ model: 'gpt-5.6-codex', effort: 'medium' }).catch(error => error);

    // Assert
    should(failure).match({ message: /did not reach a model list within 3 observations \(last: idle prompt\)/u });
  });
});

describe('the Codex model picker drive', () => {
  it('should reach a level through the quick picker without ever pressing Enter', async () => {
    // Arrange
    const transport = new ScriptedPicker([
      { visible: QUICK },
      { visible: LEVELS },
      { visible: IDLE, promptReady: true },
    ]);
    const subject = driver(transport);

    // Act
    await subject.drive({ model: 'gpt-5.6-codex', effort: 'high' });

    // Assert
    should(transport.keys.map(sent => sent.key)).deepEqual(['1', '3']);
    should(transport.keys.every(sent => /^[1-9]$/.test(sent.key))).equal(true);
  });

  it('should carry the exact row each key is aimed at, so the pane can be re-checked', async () => {
    // Arrange
    const transport = new ScriptedPicker([
      { visible: QUICK },
      { visible: LEVELS },
      { visible: IDLE, promptReady: true },
    ]);
    const subject = driver(transport);

    // Act
    await subject.drive({ model: 'gpt-5.6-codex', effort: 'high' });

    // Assert
    should(transport.keys[0]?.expected).deepEqual({
      kind: 'quick-models',
      title: 'Select Model',
      row: { number: 1, name: 'gpt-5.6-codex' },
    });
    should(transport.keys[1]?.expected).deepEqual({
      kind: 'reasoning',
      title: 'Select Reasoning Level for gpt-5.6-codex',
      row: { number: 3, name: 'High' },
    });
  });

  it('should go through All models when the quick list does not show the target', async () => {
    // Arrange
    const transport = new ScriptedPicker([
      { visible: QUICK_WITHOUT_TARGET },
      { visible: ALL },
      { visible: LEVELS },
      { visible: IDLE, promptReady: true },
    ]);
    const subject = driver(transport);

    // Act
    await subject.drive({ model: 'gpt-5.6-codex', effort: 'high' });

    // Assert
    should(transport.keys.map(sent => [sent.expected.row.name, sent.key])).deepEqual([
      ['All models', '2'],
      ['gpt-5.6-codex', '1'],
      ['High', '3'],
    ]);
  });

  it('should open the advanced submenu for a level that only lives there', async () => {
    // Arrange
    const transport = new ScriptedPicker([
      { visible: QUICK },
      { visible: LEVELS },
      { visible: ADVANCED },
      { visible: IDLE, promptReady: true },
    ]);
    const subject = driver(transport);

    // Act
    await subject.drive({ model: 'gpt-5.6-codex', effort: 'ultra' });

    // Assert
    should(transport.keys.map(sent => sent.expected.row.name)).deepEqual(['gpt-5.6-codex', 'More reasoning…', 'Ultra']);
  });

  it('should answer the Plan-mode scope prompt when Codex raises one', async () => {
    // Arrange
    const transport = new ScriptedPicker([
      { visible: QUICK },
      { visible: LEVELS },
      { visible: PLAN_SCOPE },
      { visible: IDLE, promptReady: true },
    ]);
    const subject = driver(transport);

    // Act
    await subject.drive({ model: 'gpt-5.6-codex', effort: 'high' });

    // Assert
    should(transport.keys.at(-1)?.expected.row.name).equal('Apply to global default and Plan mode override');
  });

  it('should answer a scope prompt raised in place of a level screen', async () => {
    // Codex skips straight to it when the model's level is already the one asked for.
    // Arrange
    const transport = new ScriptedPicker([
      { visible: QUICK },
      { visible: PLAN_SCOPE },
      { visible: IDLE, promptReady: true },
    ]);
    const subject = driver(transport);

    // Act
    await subject.drive({ model: 'gpt-5.6-codex', effort: 'high' });

    // Assert
    should(transport.keys.map(sent => sent.expected.row.name)).deepEqual([
      'gpt-5.6-codex',
      'Apply to global default and Plan mode override',
    ]);
  });

  it('should stop after the model when Codex returns straight to an idle prompt', async () => {
    // Arrange
    const transport = new ScriptedPicker([{ visible: QUICK }, { visible: IDLE, promptReady: true }]);
    const subject = driver(transport);

    // Act
    await subject.drive({ model: 'gpt-5.6-codex', effort: 'high' });

    // Assert
    should(transport.keys.map(sent => sent.expected.row.name)).deepEqual(['gpt-5.6-codex']);
  });

  it('should preflight itself when the caller supplies no screen', async () => {
    // Arrange
    const transport = new ScriptedPicker([
      { visible: QUICK },
      { visible: LEVELS },
      { visible: IDLE, promptReady: true },
    ]);
    const subject = driver(transport);

    // Act
    await subject.drive({ model: 'gpt-5.6-codex', effort: 'high' });

    // Assert
    should(transport.opens).equal(1);
  });

  it('should start from a preflighted screen without opening a second picker', async () => {
    // Arrange
    const transport = new ScriptedPicker([
      { visible: QUICK },
      { visible: LEVELS },
      { visible: IDLE, promptReady: true },
    ]);
    const subject = driver(transport);
    const preflighted = await subject.preflight({ model: 'gpt-5.6-codex', effort: 'high' });

    // Act
    await subject.drive({ model: 'gpt-5.6-codex', effort: 'high' }, preflighted);

    // Assert
    should(transport.opens).equal(1);
  });

  it('should re-assert expressibility even on a screen the caller handed in', async () => {
    // The invariant must not be bypassable by passing preflight in.
    // Arrange
    const transport = new ScriptedPicker([{ visible: QUICK }]);
    const subject = driver(transport);

    // Act
    const failure = await subject
      .drive(
        {
          model: 'gpt-5.6-codex',
          effort: 'high',
          quickPickerDefaultEffort: 'medium',
          quickPickerAppliesPreset: true,
        },
        parseCodexPickerScreen(QUICK),
      )
      .catch(error => error);

    // Assert
    should(failure).match({ message: /can only apply its default medium reasoning level/u });
    should(transport.keys).have.length(0);
  });

  it('should refuse a flagged quick row end to end, from the plan the planner actually makes', async () => {
    // The planner and the driver, wired as production wires them: the flag the planner sets on a model
    // with levels and no advertised default must stop the drive before any keystroke.
    // Arrange
    const plan = planRuntimeSwitch(
      { harness: 'codex', model: 'gpt-5.6-codex', effort: 'high' },
      {
        wrapper: 'codex-auto-test',
        catalog: {
          choices: [{ value: 'gpt-5.6-codex', reasoningEfforts: [{ value: 'medium' }, { value: 'high' }] }],
        },
      },
    );
    const transport = new ScriptedPicker([{ visible: QUICK }, { visible: LEVELS }]);
    const subject = driver(transport);

    // Act
    const failure = plan.kind === 'drive_picker' ? await subject.drive(plan.target).catch(error => error) : plan;

    // Assert
    should(plan).match({ kind: 'drive_picker', needsPreflight: true });
    should(failure).match({ message: /a reasoning level this account does not advertise/u });
    should(transport.keys).have.length(0);
  });

  it('should refuse a row past the ninth rather than counting arrows to it', async () => {
    // Arrange
    const transport = new ScriptedPicker([{ visible: DEEP_ROW }, { visible: LEVELS }]);
    const subject = driver(transport);

    // Act
    const failure = await subject.drive({ model: 'gpt-5.6-codex', effort: 'high' }).catch(error => error);

    // Assert
    should(failure).match({ message: /row 10 for gpt-5\.6-codex is not safely addressable/u });
    should(transport.keys).have.length(0);
  });

  it('should name the row the picker never offered', async () => {
    // Arrange
    const transport = new ScriptedPicker([{ visible: QUICK }, { visible: LEVELS }, { visible: LEVELS }]);
    const subject = driver(transport);

    // Act
    const failure = await subject.drive({ model: 'gpt-5.6-codex', effort: 'xhigh' }).catch(error => error);

    // Assert
    should(failure).match({ message: /did not offer Extra high on reasoning choices for gpt-5\.6-codex/u });
  });

  it('should fail when the full model list never appears after All models', async () => {
    // Arrange
    const transport = new ScriptedPicker([{ visible: QUICK_WITHOUT_TARGET }]);
    const subject = driver(transport, 3);

    // Act
    const failure = await subject.drive({ model: 'gpt-5.6-codex', effort: 'high' }).catch(error => error);

    // Assert
    should(failure).match({ message: /did not reach the full model list within 3 observations/u });
  });

  it('should fail when the applied setting never returns to a prompt', async () => {
    // Arrange
    const transport = new ScriptedPicker([{ visible: QUICK }, { visible: LEVELS }, { visible: ADVANCED }]);
    const subject = driver(transport, 3);

    // Act
    const failure = await subject.drive({ model: 'gpt-5.6-codex', effort: 'high' }).catch(error => error);

    // Assert
    should(failure).match({ message: /did not reach the applied setting within 3 observations/u });
  });

  it('should fail when a scope prompt never clears', async () => {
    // Arrange
    const transport = new ScriptedPicker([{ visible: QUICK }, { visible: PLAN_SCOPE }]);
    const subject = driver(transport, 3);

    // Act
    const failure = await subject.drive({ model: 'gpt-5.6-codex', effort: 'high' }).catch(error => error);

    // Assert
    should(failure).match({
      message: /did not reach the applied setting to return to an idle prompt within 3 observations/u,
    });
  });

  it('should fail when the advanced submenu never opens', async () => {
    // Arrange
    const transport = new ScriptedPicker([{ visible: QUICK }, { visible: LEVELS }]);
    const subject = driver(transport, 3);

    // Act
    const failure = await subject.drive({ model: 'gpt-5.6-codex', effort: 'max' }).catch(error => error);

    // Assert
    should(failure).match({ message: /did not reach advanced reasoning choices within 3 observations/u });
  });

  it('should stop the moment the pane dies rather than keep typing into it', async () => {
    // Arrange
    const transport = new ScriptedPicker([{ visible: QUICK }, { visible: '', alive: false, dead: true }]);
    const subject = driver(transport);

    // Act
    const failure = await subject.drive({ model: 'gpt-5.6-codex', effort: 'high' }).catch(error => error);

    // Assert
    should(failure).match({ message: /Codex exited while reaching reasoning choices for gpt-5\.6-codex/u });
  });

  it('should surface a transport that refused to send a verified key', async () => {
    // The transport re-checks the pane immediately before each key. A refusal there is the drive
    // failing, never a reason to send it anyway.
    // Arrange
    const transport = new ScriptedPicker(
      [{ visible: QUICK }, { visible: LEVELS }, { visible: IDLE, promptReady: true }],
      'handled-local',
      ['High'],
    );
    const subject = driver(transport);

    // Act
    const failure = await subject.drive({ model: 'gpt-5.6-codex', effort: 'high' }).catch(error => error);

    // Assert
    should(failure).match({ message: /changed before High could be selected/u });
  });

  it('should report the last screen it saw when it gives up', async () => {
    // Arrange
    const transport = new ScriptedPicker([{ visible: QUICK }, { visible: ALL }]);
    const subject = driver(transport, 3);

    // Act
    const failure = await subject.drive({ model: 'gpt-5.6-codex', effort: 'high' }).catch(error => error);

    // Assert
    should(failure).match({ message: /\(last: Select Model and Effort\)/u });
  });

  it('should say so when the pane it gave up on showed nothing recognisable', async () => {
    // Arrange
    const transport = new ScriptedPicker([{ visible: QUICK }, { visible: 'some half-drawn repaint' }]);
    const subject = driver(transport, 3);

    // Act
    const failure = await subject.drive({ model: 'gpt-5.6-codex', effort: 'high' }).catch(error => error);

    // Assert
    should(failure).match({ message: /\(last: unknown screen\)/u });
  });
});
