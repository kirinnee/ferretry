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

  constructor(private readonly states: readonly PaneState[]) {}

  async state(): Promise<PaneState> {
    const state = this.states[Math.min(this.index, this.states.length - 1)];
    this.index += 1;
    if (state === undefined) throw new Error('test did not provide a pane state');
    return state;
  }

  async sendKey(_session: string, key: string): Promise<void> {
    this.keys.push(key);
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

  it('refuses a missing question or a free-form page that never materializes', async () => {
    const missing = new ScriptedPane([frame('Deploy?\n> Yes\n  No\n  Other')]);
    await should(driver(missing).drive(ID, single, [])).be.rejectedWith(/vanished/u);

    const other = new ScriptedPane([frame('Deploy?\n> Yes\n  No\n  Other')]);
    await should(driver(other).drive(ID, single, [{ kind: 'other', text: 'explain' }])).be.rejectedWith(
      /free-form page/u,
    );
  });
});
