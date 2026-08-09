import { describe, it } from 'bun:test';
import type { PendingQuestion, StructuredQuestionAnswer } from '@ferretry/protocol';
import should from 'should';
import {
  StructuredQuestionDriveError,
  type StructuredQuestionPane,
  TmuxStructuredQuestionDriver,
} from '../../../../src/adapters/session/question/tmux-structured-question-driver.ts';
import { parseSessionId } from '../../../../src/lib/session-id.ts';
import type { PaneState } from '../../../../src/lib/tmux/contracts.ts';

const ID = parseSessionId('session-1');
const SESSION = 'fy-session-1';

function frame(visible: string, overrides: Partial<PaneState> = {}): PaneState {
  return { alive: true, dead: false, promptReady: false, history: visible, visible, ...overrides };
}

class ScriptedPane implements StructuredQuestionPane {
  readonly keys: string[] = [];
  readonly pasted: string[] = [];
  private index = 0;

  constructor(
    private readonly states: readonly PaneState[],
    private readonly sendFailureAt?: number,
  ) {}

  async state(): Promise<PaneState> {
    const state = this.states[Math.min(this.index, this.states.length - 1)];
    this.index += 1;
    if (state === undefined) throw new Error('test did not provide a pane state');
    return state;
  }

  async sendKey(_session: string, key: string): Promise<void> {
    this.keys.push(key);
    if (this.keys.length === this.sendFailureAt) throw new Error('tmux lost the key response');
  }

  async paste(_session: string, text: string): Promise<void> {
    this.pasted.push(text);
  }
}

function driver(pane: ScriptedPane) {
  return new TmuxStructuredQuestionDriver(
    pane,
    async () => SESSION,
    async () => {},
    1,
    0,
  );
}

const single: PendingQuestion = {
  toolUseId: 'question-1',
  questions: [{ question: 'Deploy?', options: [{ label: 'Yes' }, { label: 'No' }, { label: 'Other' }] }],
};

const yes: readonly StructuredQuestionAnswer[] = [{ kind: 'selection', labels: ['Yes'] }];

async function failureOf(operation: Promise<unknown>): Promise<StructuredQuestionDriveError> {
  const error = await operation.catch((failure: unknown) => failure);
  should(error).be.instanceOf(StructuredQuestionDriveError);
  return error as StructuredQuestionDriveError;
}

describe('tmux structured-question driver', () => {
  it('drives only the bound visible choice and counts delivery only after the pane advances', async () => {
    const pane = new ScriptedPane([frame('Deploy?\n> Yes\n  No\n  Other'), frame('> ', { promptReady: true })]);

    const confirmation = await driver(pane).drive(ID, single, yes);

    should(pane.keys).deepEqual(['Enter']);
    should(confirmation).deepEqual({ confirmedBy: 'prompt-ready' });
  });

  it('fails closed when the answer keys do not visibly take', async () => {
    const pane = new ScriptedPane([frame('Deploy?\n> Yes\n  No\n  Other')]);

    await should(driver(pane).drive(ID, single, yes)).be.rejectedWith(
      /answer keys were sent, but the rendered form did not visibly advance/u,
    );
    should(pane.keys).deepEqual(['Enter']);
  });

  it('classifies pane death before input as proven non-acceptance and pane death after input as ambiguous', async () => {
    const before = new ScriptedPane([frame('Deploy?\n> Yes\n  No\n  Other', { alive: false, dead: true })]);
    const after = new ScriptedPane([frame('Deploy?\n> Yes\n  No\n  Other'), frame('', { alive: false, dead: true })]);

    const preflight = await failureOf(driver(before).drive(ID, single, yes));
    const postInput = await failureOf(driver(after).drive(ID, single, yes));

    should(preflight.acceptance).equal('none');
    should(before.keys).deepEqual([]);
    should(postInput.acceptance).equal('ambiguous');
    should(after.keys).deepEqual(['Enter']);
  });

  it('classifies a lost tmux response as ambiguous because the key may have landed', async () => {
    const pane = new ScriptedPane([frame('Deploy?\n> Yes\n  No\n  Other')], 1);

    const failure = await failureOf(driver(pane).drive(ID, single, yes));

    should(failure.acceptance).equal('ambiguous');
    should(pane.keys).deepEqual(['Enter']);
  });

  it('recognizes visible active work as stronger confirmation than a generic changed pane', async () => {
    const pane = new ScriptedPane([frame('Deploy?\n> Yes\n  No\n  Other'), frame('Working (2s • Esc to interrupt)')]);

    const confirmation = await driver(pane).drive(ID, single, yes);

    should(confirmation).deepEqual({ confirmedBy: 'turn-started' });
  });

  it('does not send keys unless the exact form, cursor, and requested choice are visible', async () => {
    const missing: readonly StructuredQuestionAnswer[] = [{ kind: 'selection', labels: ['Missing'] }];
    for (const [pane, answers] of [
      [new ScriptedPane([frame('A different prompt\n> Yes\n  No\n  Other')]), yes],
      [new ScriptedPane([frame('Deploy?\n  Yes\n  No\n  Other')]), yes],
      [new ScriptedPane([frame('Deploy?\n> Yes\n  No\n  Other')]), missing],
      [new ScriptedPane([frame('Deploy?\n> Yes\n  No\n  Other', { alive: false, dead: true })]), yes],
    ] satisfies ReadonlyArray<readonly [ScriptedPane, readonly StructuredQuestionAnswer[]]>) {
      await should(driver(pane).drive(ID, single, answers)).be.rejectedWith(StructuredQuestionDriveError);
      should(pane.keys).deepEqual([]);
    }
  });

  it('binds a question that tmux hard-wrapped across pane lines', async () => {
    const wrapped: PendingQuestion = {
      toolUseId: 'question-wrapped',
      questions: [
        {
          question: 'Should we deploy the carefully reviewed release now?',
          options: [{ label: 'Yes' }, { label: 'No' }],
        },
      ],
    };
    const pane = new ScriptedPane([
      frame('Should we deploy the carefully\nreviewed release now?\n> Yes\n  No'),
      frame('> ', { promptReady: true }),
    ]);

    const confirmation = await driver(pane).drive(ID, wrapped, yes);

    should(confirmation).deepEqual({ confirmedBy: 'prompt-ready' });
    should(pane.keys).deepEqual(['Enter']);
  });

  it('drives multi-select and free-form paths only through their visible pages', async () => {
    const multi: PendingQuestion = {
      toolUseId: 'question-2',
      questions: [
        { question: 'Targets?', options: [{ label: 'Web' }, { label: 'API' }], multiSelect: true },
        { question: 'Reason?', options: [{ label: 'Other' }] },
      ],
    };
    const pane = new ScriptedPane([
      frame('Targets?\n> Web\n  API'),
      frame('Reason?\n> Other'),
      frame('Reason?\n> Other'),
      frame('Reason?\nType your own answer'),
      frame('> ', { promptReady: true }),
    ]);

    const confirmation = await driver(pane).drive(ID, multi, [
      { kind: 'selection', labels: ['Web', 'API'] },
      { kind: 'other', text: 'Because the API changed' },
    ]);

    should(pane.keys).deepEqual(['Space', 'Down', 'Space', 'Enter', 'Enter', 'Enter']);
    should(pane.pasted).deepEqual(['Because the API changed']);
    should(confirmation).deepEqual({ confirmedBy: 'prompt-ready' });
  });

  it('drives the harness-native Other row even though it is implicit in transcript options', async () => {
    const implicit: PendingQuestion = {
      toolUseId: 'question-other',
      questions: [{ question: 'Deploy?', options: [{ label: 'Yes' }, { label: 'No' }] }],
    };
    const pane = new ScriptedPane([
      frame('Deploy?\n> Yes\n  No\n  Other…'),
      frame('Deploy?\nType your own answer'),
      frame('> ', { promptReady: true }),
    ]);

    const confirmation = await driver(pane).drive(ID, implicit, [{ kind: 'other', text: 'Not until review' }]);

    should(pane.keys).deepEqual(['Down', 'Down', 'Enter', 'Enter']);
    should(pane.pasted).deepEqual(['Not until review']);
    should(confirmation).deepEqual({ confirmedBy: 'prompt-ready' });
  });

  it('refuses a missing question or a free-form page that never materializes', async () => {
    const missing = new ScriptedPane([frame('Deploy?\n> Yes\n  No\n  Other')]);
    await should(driver(missing).drive(ID, single, [])).be.rejectedWith(/vanished/u);

    const other = new ScriptedPane([frame('Deploy?\n> Yes\n  No\n  Other')]);
    await should(driver(other).drive(ID, single, [{ kind: 'other', text: 'explain' }])).be.rejectedWith(
      /free-form page/u,
    );
  });

  it('does not send Escape when cancellation already has strong advance evidence', async () => {
    const pane = new ScriptedPane([frame('> ', { promptReady: true })]);

    const cancellation = await driver(pane).cancel(ID, single);

    should(cancellation.confirmedBy).equal('already-advanced');
    should(pane.keys).deepEqual([]);
  });

  it('does not mistake generic active-work text for pre-cancellation advance evidence', async () => {
    const pane = new ScriptedPane([frame('Working (2s • Esc to interrupt)')]);

    await should(driver(pane).cancel(ID, single)).be.rejectedWith(/positively bound/u);

    should(pane.keys).deepEqual([]);
  });

  it('sends Escape when the bound wrapped form also shows its active-work footer', async () => {
    const wrapped: PendingQuestion = {
      toolUseId: 'question-wrapped',
      questions: [
        {
          question: 'Should we deploy the carefully reviewed release now?',
          options: [{ label: 'Yes' }, { label: 'No' }],
        },
      ],
    };
    const pane = new ScriptedPane([
      frame('Should we deploy the carefully\nreviewed release now?\n> Yes\n  No\nWorking (2s • Esc to interrupt)'),
      frame('> ', { promptReady: true }),
    ]);

    const cancellation = await driver(pane).cancel(ID, wrapped);

    should(cancellation.confirmedBy).equal('prompt-ready');
    should(pane.keys).deepEqual(['Escape']);
  });

  it.each([
    ['prompt-ready', frame('> ', { promptReady: true })],
    ['turn-started', frame('Working (2s • Esc to interrupt)')],
    ['pane-advanced', frame('ordinary composer without a recognized prompt')],
  ] as const)('sends exactly one Escape and confirms cancellation by %s', async (confirmedBy, after) => {
    const pane = new ScriptedPane([frame('Deploy?\n> Yes\n  No\n  Other'), after]);

    const cancellation = await driver(pane).cancel(ID, single);

    should(cancellation.confirmedBy).equal(confirmedBy);
    should(pane.keys).deepEqual(['Escape']);
  });

  it('refuses automatic Escape unless the failed form is still positively bound', async () => {
    const pane = new ScriptedPane([frame('A newer question\n> Yes\n  No')]);

    const failure = await failureOf(driver(pane).cancel(ID, single));

    should(failure.diagnostics).match({ phase: 'cancel-preflight', reason: 'question-unbound' });
    should(pane.keys).deepEqual([]);
  });

  it('sends at most one Escape when cancellation cannot be confirmed or the pane then dies', async () => {
    for (const after of [frame('Deploy?\n> Yes\n  No\n  Other'), frame('', { alive: false, dead: true })]) {
      const pane = new ScriptedPane([frame('Deploy?\n> Yes\n  No\n  Other'), after]);

      await should(driver(pane).cancel(ID, single)).be.rejectedWith(StructuredQuestionDriveError);

      should(pane.keys).deepEqual(['Escape']);
    }
  });

  it('does not send Escape into a pane that was already dead', async () => {
    const pane = new ScriptedPane([frame('', { alive: false, dead: true })]);

    await should(driver(pane).cancel(ID, single)).be.rejectedWith(/dead/u);

    should(pane.keys).deepEqual([]);
  });
});
