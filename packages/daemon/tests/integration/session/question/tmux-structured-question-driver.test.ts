import { describe, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PendingQuestion, StructuredQuestionAnswer } from '@ferretry/protocol';
import should from 'should';
import {
  StructuredQuestionDriveError,
  type StructuredQuestionPane,
  TmuxStructuredQuestionDriver,
} from '../../../../src/adapters/session/question/tmux-structured-question-driver.ts';
import {
  StructuredQuestionDrivePaused,
  type StructuredQuestionDriveStep,
} from '../../../../src/lib/session/question/service.ts';
import { parseSessionId } from '../../../../src/lib/session-id.ts';
import type { PaneState } from '../../../../src/lib/tmux/contracts.ts';

const ID = parseSessionId('session-1');
const SESSION = 'fy-session-1';

function frame(visible: string, overrides: Partial<PaneState> = {}): PaneState {
  return { alive: true, dead: false, promptReady: false, history: visible, visible, ...overrides };
}

const FIXTURES = join(import.meta.dir, '../../../fixtures/question-forms');
const fixture = (name: string): string => readFileSync(join(FIXTURES, `${name}.txt`), 'utf8');
const RULE = '─'.repeat(40);

/** A form drawn the way Claude Code 2.1.281 draws one: a border, the question, numbered rows. */
function claude(question: string, rows: readonly string[], cursor = 0): string {
  const drawn = rows.map((row, index) => `${index === cursor ? '❯' : ' '} ${index + 1}. ${row}`);
  return [RULE, question, '', ...drawn, RULE, `  ${rows.length + 1}. Chat about this`].join('\n');
}

const DEPLOY = claude('Deploy?', ['Yes', 'No', 'Other']);

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
    const pane = new ScriptedPane([frame(DEPLOY), frame('> ', { promptReady: true })]);

    const confirmation = await driver(pane).drive(ID, single, yes);

    should(pane.keys).deepEqual(['Enter']);
    should(confirmation).deepEqual({ confirmedBy: 'prompt-ready' });
  });

  it('fails closed when the answer keys do not visibly take', async () => {
    const pane = new ScriptedPane([frame(DEPLOY)]);

    await should(driver(pane).drive(ID, single, yes)).be.rejectedWith(
      /answer keys were sent, but the rendered form did not visibly advance/u,
    );
    should(pane.keys).deepEqual(['Enter']);
  });

  it('classifies pane death before input as proven non-acceptance and pane death after input as ambiguous', async () => {
    const before = new ScriptedPane([frame(DEPLOY, { alive: false, dead: true })]);
    const after = new ScriptedPane([frame(DEPLOY), frame('', { alive: false, dead: true })]);

    const preflight = await failureOf(driver(before).drive(ID, single, yes));
    const postInput = await failureOf(driver(after).drive(ID, single, yes));

    should(preflight.acceptance).equal('none');
    should(before.keys).deepEqual([]);
    should(postInput.acceptance).equal('ambiguous');
    should(after.keys).deepEqual(['Enter']);
  });

  it('classifies a lost tmux response as ambiguous because the key may have landed', async () => {
    const pane = new ScriptedPane([frame(DEPLOY)], 1);

    const failure = await failureOf(driver(pane).drive(ID, single, yes));

    should(failure.acceptance).equal('ambiguous');
    should(pane.keys).deepEqual(['Enter']);
  });

  it('recognizes visible active work as stronger confirmation than a generic changed pane', async () => {
    const pane = new ScriptedPane([frame(DEPLOY), frame('Working (2s • Esc to interrupt)')]);

    const confirmation = await driver(pane).drive(ID, single, yes);

    should(confirmation).deepEqual({ confirmedBy: 'turn-started' });
  });

  it('does not send keys unless the exact form, cursor, and requested choice are visible', async () => {
    const missing: readonly StructuredQuestionAnswer[] = [{ kind: 'selection', labels: ['Missing'] }];
    for (const [pane, answers] of [
      [new ScriptedPane([frame(claude('A different prompt', ['Yes', 'No', 'Other']))]), yes],
      [new ScriptedPane([frame(DEPLOY.replace('❯', ' '))]), yes],
      [new ScriptedPane([frame(DEPLOY)]), missing],
      [new ScriptedPane([frame(DEPLOY, { alive: false, dead: true })]), yes],
    ] satisfies ReadonlyArray<readonly [ScriptedPane, readonly StructuredQuestionAnswer[]]>) {
      await should(driver(pane).drive(ID, single, answers)).be.rejectedWith(StructuredQuestionDriveError);
      should(pane.keys).deepEqual([]);
    }
  });

  it('binds a question that the harness wrapped behind a │ gutter', async () => {
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
      frame(claude('│ Should we deploy the carefully\n│ reviewed release now?', ['Yes', 'No'])),
      frame('> ', { promptReady: true }),
    ]);

    const confirmation = await driver(pane).drive(ID, wrapped, yes);

    should(confirmation).deepEqual({ confirmedBy: 'prompt-ready' });
    should(pane.keys).deepEqual(['Enter']);
  });

  describe('against panes recorded from Claude Code 2.1.281', () => {
    const poolCheck: PendingQuestion = {
      toolUseId: 'question-pool',
      questions: [
        {
          header: 'Pool check',
          question:
            "Test 4c collapsed, and the next test depends on which pool settings prod's Valkey client really uses. How should we find out?",
          options: [
            { label: 'Read one prod pod (Recommended)' },
            { label: "I'll check Vault" },
            { label: 'Skip; test with jitter' },
          ],
        },
      ],
    };
    const done = frame('❯ ', { promptReady: true });

    it('answers the reported question in an 80×24 pane', async () => {
      const pane = new ScriptedPane([frame(fixture('claude-2.1.281-single-80x24')), done]);

      const confirmation = await driver(pane).drive(ID, poolCheck, [
        { kind: 'selection', labels: ["I'll check Vault"] },
      ]);

      should(pane.keys).deepEqual(['Down', 'Enter']);
      should(confirmation).deepEqual({ confirmedBy: 'prompt-ready' });
    });

    it('answers a form taller than the pane, whose question has scrolled into the scrollback', async () => {
      const tall = {
        ...frame(fixture('claude-2.1.281-tall-80x16.visible')),
        history: fixture('claude-2.1.281-tall-80x16.history'),
      };
      const pane = new ScriptedPane([tall, done]);

      await driver(pane).drive(ID, poolCheck, [{ kind: 'selection', labels: ['Skip; test with jitter'] }]);

      should(pane.keys).deepEqual(['Down', 'Down', 'Enter']);
    });

    it('types a free-form answer straight into the Type something row', async () => {
      const pane = new ScriptedPane([frame(fixture('claude-2.1.281-single-80x24')), done]);

      await driver(pane).drive(ID, poolCheck, [{ kind: 'other', text: 'Ask the on-call first' }]);

      should(pane.keys).deepEqual(['Down', 'Down', 'Down', 'Enter']);
      should(pane.pasted).deepEqual(['Ask the on-call first']);
    });

    it('toggles multi-select rows with Space, finishes from the Submit row, then submits the review page', async () => {
      const banner: PendingQuestion = {
        toolUseId: 'question-banner',
        questions: [
          { question: 'Which colour should the banner use?', options: [{ label: 'Red' }, { label: 'Blue' }] },
          {
            question: 'Which extras should ship with the banner?',
            multiSelect: true,
            options: [{ label: 'Shadow' }, { label: 'Border' }, { label: 'Icon' }],
          },
        ],
      };
      const pane = new ScriptedPane([
        frame(fixture('claude-2.1.281-multi-q1')),
        frame(fixture('claude-2.1.281-multi-q2-multiselect')),
        frame(fixture('claude-2.1.281-multi-q2-multiselect')),
        frame(fixture('claude-2.1.281-review')),
        frame(fixture('claude-2.1.281-review')),
        done,
      ]);

      const confirmation = await driver(pane).drive(ID, banner, [
        { kind: 'selection', labels: ['Blue'] },
        { kind: 'selection', labels: ['Shadow', 'Icon'] },
      ]);

      // Blue; then Shadow and Icon ticked, the Submit row chosen; then "Submit answers" on the review.
      should(pane.keys).deepEqual([
        'Down',
        'Enter',
        'Space',
        'Down',
        'Down',
        'Space',
        'Down',
        'Down',
        'Enter',
        'Enter',
      ]);
      should(confirmation).deepEqual({ confirmedBy: 'prompt-ready' });
    });

    it('fails ambiguously when the review page will not close', async () => {
      const extras: PendingQuestion = {
        toolUseId: 'question-extras',
        questions: [
          {
            question: 'Which extras should ship?',
            multiSelect: true,
            options: [{ label: 'Shadow' }, { label: 'Border' }],
          },
        ],
      };
      const review = [
        RULE,
        '←  ☒ Extras  ✔ Submit  →',
        '',
        'Review your answers',
        '',
        ' ● Which extras should ship?',
        '   → Border',
        '',
        'Ready to submit your answers?',
        '',
        '❯ 1. Submit answers',
        '  2. Cancel',
      ].join('\n');
      const pane = new ScriptedPane([frame(fixture('claude-2.1.281-single-multiselect')), frame(review)]);

      const failure = await failureOf(driver(pane).drive(ID, extras, [{ kind: 'selection', labels: ['Border'] }]));

      should(failure.message).match(/review page did not close/u);
      should(failure.acceptance).equal('ambiguous');
      should(pane.keys).deepEqual(['Down', 'Space', 'Down', 'Down', 'Enter', 'Enter']);
    });

    it('unticks a box the answer does not want and leaves a wanted one alone', async () => {
      const extras: PendingQuestion = {
        toolUseId: 'question-extras',
        questions: [{ question: 'Extras?', multiSelect: true, options: [{ label: 'Shadow' }, { label: 'Border' }] }],
      };
      const ticked = claude('Extras?', ['[✔] Shadow', '[✔] Border', '[ ] Type something']).replace(
        `${RULE}\n  4.`,
        `     Submit\n${RULE}\n  4.`,
      );
      const pane = new ScriptedPane([frame(ticked), done]);

      await driver(pane).drive(ID, extras, [{ kind: 'selection', labels: ['Border'] }]);

      should(pane.keys).deepEqual(['Space', 'Down', 'Down', 'Down', 'Enter']);
    });
  });

  describe('against panes recorded from Codex 0.156.1', () => {
    const codexPool: PendingQuestion = {
      toolUseId: 'question-codex',
      questions: [
        {
          question:
            'Test 4c collapsed, and the next test depends on which pool settings prod Valkey client really uses. How should we find out?',
          options: [
            { label: 'Read one prod pod (Recommended)' },
            { label: 'I will check Vault' },
            { label: 'Skip; test with jitter' },
          ],
        },
      ],
    };

    it('opens a note with Tab for a free-form answer and pastes only once it is open', async () => {
      const form = fixture('codex-0.156.1-single-80x24');
      const pane = new ScriptedPane([
        frame(form),
        frame(`${form}\n  › Add notes\n\n  tab or esc to clear notes | enter to submit answer`),
        frame('› Ask Codex to do anything', { promptReady: true }),
      ]);

      await driver(pane).drive(ID, codexPool, [{ kind: 'other', text: 'Ask the on-call first' }]);

      should(pane.keys).deepEqual(['Down', 'Down', 'Down', 'Tab', 'Enter']);
      should(pane.pasted).deepEqual(['Ask the on-call first']);
    });

    it('pastes nothing when Tab does not open a note', async () => {
      const form = fixture('codex-0.156.1-single-80x24');
      const pane = new ScriptedPane([frame(form), frame(form)]);

      const failure = await failureOf(driver(pane).drive(ID, codexPool, [{ kind: 'other', text: 'x' }]));

      should(failure.message).match(/did not open a note/u);
      should(pane.pasted).deepEqual([]);
    });
  });

  it('opens a plain Other row as its own page and pastes only once that page shows the question', async () => {
    const implicit: PendingQuestion = {
      toolUseId: 'question-other',
      questions: [{ question: 'Deploy?', options: [{ label: 'Yes' }, { label: 'No' }] }],
    };
    const form = claude('Deploy?', ['Yes', 'No', 'Other…']);
    const pane = new ScriptedPane([
      frame(form),
      frame(form),
      frame('Deploy?\nType your own answer'),
      frame('> ', { promptReady: true }),
    ]);

    const confirmation = await driver(pane).drive(ID, implicit, [{ kind: 'other', text: 'Not until review' }]);

    should(pane.keys).deepEqual(['Down', 'Down', 'Enter', 'Enter']);
    should(pane.pasted).deepEqual(['Not until review']);
    should(confirmation).deepEqual({ confirmedBy: 'prompt-ready' });
  });

  it('refuses a missing question, a form without a free-form row, or a free-form page that never materializes', async () => {
    const missing = new ScriptedPane([frame(DEPLOY)]);
    await should(driver(missing).drive(ID, single, [])).be.rejectedWith(/vanished/u);

    const closed = new ScriptedPane([frame(claude('Deploy?', ['Yes', 'No']))]);
    const noRow = await failureOf(
      driver(closed).drive(
        ID,
        { toolUseId: 'q', questions: [{ question: 'Deploy?', options: [{ label: 'Yes' }, { label: 'No' }] }] },
        [{ kind: 'other', text: 'explain' }],
      ),
    );
    should(noRow.diagnostics).match({ reason: 'choice-missing' });
    should(closed.keys).deepEqual([]);

    const other = new ScriptedPane([frame(DEPLOY)]);
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
      frame(
        `${claude('│ Should we deploy the carefully\n│ reviewed release now?', ['Yes', 'No'])}\nWorking (2s • Esc to interrupt)`,
      ),
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
    const pane = new ScriptedPane([frame(DEPLOY), after]);

    const cancellation = await driver(pane).cancel(ID, single);

    should(cancellation.confirmedBy).equal(confirmedBy);
    should(pane.keys).deepEqual(['Escape']);
  });

  it('refuses automatic Escape unless the failed form is still positively bound', async () => {
    const pane = new ScriptedPane([frame(claude('A newer question', ['Yes', 'No']))]);

    const failure = await failureOf(driver(pane).cancel(ID, single));

    should(failure.diagnostics).match({ phase: 'cancel-preflight', reason: 'question-unbound' });
    should(pane.keys).deepEqual([]);
  });

  it('sends at most one Escape when cancellation cannot be confirmed or the pane then dies', async () => {
    for (const after of [frame(DEPLOY), frame('', { alive: false, dead: true })]) {
      const pane = new ScriptedPane([frame(DEPLOY), after]);

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

/**
 * A four-question form driven on a REAL Claude Code 2.1.281 pane at 80×24, every frame the driver read
 * recorded in order (`claude-2.1.281-tabs4/<run>/NNN.txt`, each the whole pane with its scrollback, so its
 * last 24 lines are the screen). Replaying them proves the key sequence that really submitted the form.
 */
describe('a tabbed four-question form (Claude Code 2.1.281)', () => {
  const TABS = join(FIXTURES, 'claude-2.1.281-tabs4');
  const recorded = (name: string): PaneState => {
    const history = readFileSync(join(TABS, `${name}.txt`), 'utf8');
    return frame(`${history.split('\n').slice(0, -1).slice(-24).join('\n')}\n`, { history });
  };
  const run = (name: string): PaneState[] =>
    readdirSync(join(TABS, name))
      .filter(file => file.endsWith('.txt'))
      .sort()
      .map(file => recorded(`${name}/${file.slice(0, -'.txt'.length)}`));
  const pending: PendingQuestion = JSON.parse(readFileSync(join(TABS, 'pending.json'), 'utf8'));
  const pick = (...labels: string[]): StructuredQuestionAnswer[] =>
    labels.map(label => ({ kind: 'selection', labels: [label] }));

  function journalled(pane: ScriptedPane, polls = 1) {
    const steps: StructuredQuestionDriveStep[] = [];
    const drive = new TmuxStructuredQuestionDriver(
      pane,
      async () => SESSION,
      async () => {},
      polls,
      0,
      async (_id, step) => {
        steps.push(step);
      },
    );
    return { drive, steps };
  }

  async function pausedBy(operation: Promise<unknown>): Promise<StructuredQuestionDrivePaused> {
    const error = await operation.catch((failure: unknown) => failure);
    should(error).be.instanceOf(StructuredQuestionDrivePaused);
    return error as StructuredQuestionDrivePaused;
  }

  it('finishes a form whose first two questions were answered in the Console, as the reported pane was', async () => {
    const pane = new ScriptedPane(run('partial'));
    const { drive, steps } = journalled(pane);

    const confirmation = await drive.drive(ID, pending, pick('Decline all 3', 'Accept', 'Accept', 'Maybe'));

    // Meet&Greet: Accept is under the cursor; Sprint plan: Maybe; then Submit answers.
    should(pane.keys).deepEqual(['Enter', 'Down', 'Down', 'Enter', 'Enter']);
    should(confirmation).deepEqual({ confirmedBy: 'turn-started' });
    should(steps).deepEqual([
      { step: 'started', mode: 'tabs', answered: [true, true, false, false] },
      { step: 'answered', questionIndex: 2 },
      { step: 'answered', questionIndex: 3 },
      { step: 'review-verified' },
      { step: 'submitted' },
    ]);
  });

  it('goes back and changes a tab the Console answered differently, then passes over the tabs that agree', async () => {
    const pane = new ScriptedPane(run('mismatch'));
    const { drive, steps } = journalled(pane);

    const confirmation = await drive.drive(ID, pending, pick('Decline all 3', 'Maybe', 'Decline', 'Accept'));

    should(pane.keys).deepEqual([
      ...['Down', 'Enter'], // Meet&Greet: Decline
      'Enter', // Sprint plan: Accept
      ...['Left', 'Left', 'Left'], // the review lists Weekly: Accept — back to Weekly
      ...['Down', 'Down', 'Enter'], // Weekly: Maybe
      'Right', // Meet&Greet already says Decline
      'Right', // Sprint plan already says Accept
      'Enter', // Submit answers
    ]);
    should(confirmation).deepEqual({ confirmedBy: 'turn-started' });
    should(steps).containDeep([
      { step: 'revisited', questionIndex: 1, shown: 'Accept' },
      { step: 'answered', questionIndex: 1 },
      { step: 'kept', questionIndex: 2 },
      { step: 'kept', questionIndex: 3 },
      { step: 'review-verified' },
    ]);
  });

  it('answers a fresh form tab by tab, typing a free-form answer into its row', async () => {
    const pane = new ScriptedPane(run('fresh'));
    const { drive } = journalled(pane);

    await drive.drive(ID, pending, [
      ...pick('Lunch only', 'Decline'),
      { kind: 'other', text: 'Only if it is on Zoom' },
      ...pick('Maybe'),
    ]);

    should(pane.keys).deepEqual([
      ...['Down', 'Down', 'Enter'],
      ...['Down', 'Enter'],
      ...['Down', 'Down', 'Enter'],
      ...['Down', 'Down', 'Enter'],
      'Enter',
    ]);
    should(pane.pasted).deepEqual(['Only if it is on Zoom']);
  });

  it('pauses, sending nothing, when a tab already holds different typed text', async () => {
    const pane = new ScriptedPane([recorded('typed-revisited')]);
    const { drive } = journalled(pane);

    const paused = await pausedBy(
      drive.drive(ID, pending, [{ kind: 'other', text: 'Going in for lunch' }, ...pick('Accept', 'Accept', 'Maybe')]),
    );

    should(pane.keys).deepEqual([]);
    should(paused.message).match(
      /^stopped at question 1 of 4 \(Socials\): it already holds the typed answer «WFH, decide later»/u,
    );
    should(paused.progress).deepEqual({ stoppedAt: 0, answered: [true, false, false, false] });
    should(paused.acceptance).equal('none');
    should(paused.diagnostics).match({ formOpen: true, reason: 'typed-answer-held' });
  });

  it('passes over a tab already holding the same typed text', async () => {
    const typed = recorded('typed-revisited');
    const pane = new ScriptedPane([typed, recorded('partial/001')]);
    const { drive, steps } = journalled(pane);

    await pausedBy(
      drive.drive(ID, pending, [{ kind: 'other', text: 'WFH, decide later' }, ...pick('Accept', 'Accept', 'Maybe')]),
    );

    should(pane.keys[0]).equal('Right');
    should(steps).containDeep([{ step: 'kept', questionIndex: 0 }]);
  });

  it('pauses with the questions answered so far when a tab does not take its answer', async () => {
    const meet = recorded('partial/001');
    const pane = new ScriptedPane([meet, meet, meet]);
    const { drive } = journalled(pane);

    const paused = await pausedBy(drive.drive(ID, pending, pick('Decline all 3', 'Accept', 'Decline', 'Maybe')));

    should(pane.keys).deepEqual(['Down', 'Enter']);
    should(paused.message).match(/^stopped at question 3 of 4 \(Meet&Greet\): the answer keys were sent/u);
    should(paused.progress).deepEqual({ stoppedAt: 2, answered: [true, true, false, false] });
    should(paused.acceptance).equal('ambiguous');
  });

  it('stops choosing a tab whose answer does not hold', async () => {
    // Meet&Greet ticks and moves on, then comes back unticked — twice.
    const meet = recorded('partial/001');
    const sprint = recorded('partial/003');
    const pane = new ScriptedPane([meet, sprint, meet, sprint, meet, sprint]);
    const { drive } = journalled(pane);

    const paused = await pausedBy(drive.drive(ID, pending, pick('Decline all 3', 'Accept', 'Accept', 'Maybe')));

    should(pane.keys).deepEqual(['Enter', 'Enter']);
    should(paused.diagnostics).match({ reason: 'answer-not-held', questionIndex: 2 });
  });

  it('goes back from a review page to the question still unanswered', async () => {
    const review = recorded('review-missing');
    const pane = new ScriptedPane([review, review, review]);
    const { drive, steps } = journalled(pane);

    const paused = await pausedBy(drive.drive(ID, pending, pick('Decline all 3', 'Accept', 'Accept', 'Accept')));

    should(pane.keys).deepEqual(['Left', 'Left', 'Left', 'Left']);
    should(steps).containDeep([{ step: 'revisited', questionIndex: 0 }]);
    should(paused.message).match(/← did not bring its tab back/u);
    should(paused.progress).deepEqual({ stoppedAt: 0, answered: [false, true, true, true] });
  });

  it('pauses when → does not move past a tab that already agrees', async () => {
    const weekly = recorded('revisited');
    const pane = new ScriptedPane([weekly, weekly]);
    const { drive } = journalled(pane);

    const paused = await pausedBy(drive.drive(ID, pending, pick('Decline all 3', 'Accept', 'Accept', 'Maybe')));

    should(pane.keys).deepEqual(['Right']);
    should(paused.message).match(/→ did not move past its tab/u);
  });

  it('refuses, sending nothing, a strip whose question on screen is not pending', async () => {
    const strange = frame(recorded('fresh/001').visible.replace('Pastry Cart', 'Coffee Cart'));
    const pane = new ScriptedPane([strange]);
    const { drive } = journalled(pane);

    const paused = await pausedBy(drive.drive(ID, pending, pick('Decline all 3', 'Accept', 'Accept', 'Maybe')));

    should(pane.keys).deepEqual([]);
    should(paused.diagnostics).match({ reason: 'question-unbound', questionIndex: 0 });
  });

  it('fails without pausing once the form is gone from the pane', async () => {
    const meet = recorded('partial/001');
    for (const [after, pattern] of [
      [frame('❯ '), /question tabs are no longer on screen/u],
      [frame('', { alive: false, dead: true }), /pane died/u],
    ] as const) {
      const pane = new ScriptedPane([meet, recorded('partial/003'), after]);
      const { drive } = journalled(pane);

      const failure = await failureOf(drive.drive(ID, pending, pick('Decline all 3', 'Accept', 'Accept', 'Maybe')));

      should(failure).not.be.instanceOf(StructuredQuestionDrivePaused);
      should(failure.message).match(pattern);
      should(failure.acceptance).equal('ambiguous');
    }
  });

  it('gives up, paused, when the review keeps listing an answer that its tab says it holds', async () => {
    const strip = '←  ☒ Deploy  ✔ Submit  →';
    const tab = [RULE, strip, '', 'Deploy?', '', '❯ 1. Yes ✔', '  2. No', RULE, '  3. Chat about this'].join('\n');
    const review = [
      RULE,
      strip,
      '',
      'Review your answers',
      '',
      ' ● Deploy?',
      '   → No',
      '',
      '❯ 1. Submit answers',
      '  2. Cancel',
    ].join('\n');
    const deploy: PendingQuestion = {
      toolUseId: 'deploy',
      questions: [{ header: 'Deploy', question: 'Deploy?', options: [{ label: 'Yes' }, { label: 'No' }] }],
    };
    const pane = new ScriptedPane(
      Array.from({ length: 40 }, (_, index) => frame(index % 4 === 1 || index % 4 === 2 ? tab : review)),
    );
    const { drive } = journalled(pane);

    const paused = await pausedBy(drive.drive(ID, deploy, [{ kind: 'selection', labels: ['Yes'] }]));

    // A single question names no question in its message.
    should(paused.message).equal('the form did not reach a review page listing the requested answers');
    should(paused.diagnostics).match({ reason: 'steps-exhausted' });
    should(pane.keys.filter(key => key === 'Enter')).deepEqual([]);
  });

  it('never stops a drive because a step could not be journalled', async () => {
    const pane = new ScriptedPane(run('partial'));
    const drive = new TmuxStructuredQuestionDriver(
      pane,
      async () => SESSION,
      async () => {},
      1,
      0,
      async () => {
        throw new Error('journal is full');
      },
    );

    should(await drive.drive(ID, pending, pick('Decline all 3', 'Accept', 'Accept', 'Maybe'))).deepEqual({
      confirmedBy: 'turn-started',
    });
  });
  describe('a single multi-select tab', () => {
    const extras: PendingQuestion = {
      toolUseId: 'question-extras',
      questions: [
        {
          header: 'Extras',
          question: 'Which extras should ship?',
          multiSelect: true,
          options: [{ label: 'Shadow' }, { label: 'Border' }],
        },
      ],
    };
    const ticked = [
      RULE,
      '←  ☒ Extras  ✔ Submit  →',
      '',
      'Which extras should ship?',
      '',
      '❯ 1. [✔] Shadow',
      '  2. [ ] Border',
      '  3. [ ] Type something',
      '     Submit',
      RULE,
      '  4. Chat about this',
    ].join('\n');
    const review = (strip: boolean) =>
      [
        RULE,
        ...(strip ? ['←  ☒ Extras  ✔ Submit  →', ''] : []),
        'Review your answers',
        '',
        ' ● Which extras should ship?',
        '   → Shadow',
        '',
        '❯ 1. Submit answers',
        '  2. Cancel',
      ].join('\n');
    const done = frame('❯ ', { promptReady: true });

    it('passes over a ticked tab whose boxes already agree', async () => {
      const pane = new ScriptedPane([frame(ticked), frame(review(true)), frame(review(true)), done]);

      await driver(pane).drive(ID, extras, [{ kind: 'selection', labels: ['Shadow'] }]);

      should(pane.keys).deepEqual(['Right', 'Enter']);
    });

    it('reads which questions are answered off a review page drawn without its strip', async () => {
      const pane = new ScriptedPane([
        frame(fixture('claude-2.1.281-single-multiselect')),
        frame(review(false)),
        frame(review(false)),
        done,
      ]);

      await driver(pane).drive(ID, extras, [{ kind: 'selection', labels: ['Shadow'] }]);

      should(pane.keys).deepEqual(['Space', 'Down', 'Down', 'Down', 'Enter', 'Enter']);
    });

    it('keeps the original failure when the pane cannot be read to decide whether to pause', async () => {
      class FailingPane extends ScriptedPane {
        reads = 0;
        override async state(): Promise<PaneState> {
          this.reads += 1;
          if (this.reads > 2) throw new Error('tmux is gone');
          return await super.state();
        }
      }
      const pane = new FailingPane([frame(ticked), frame(ticked)]);

      const failure = await failureOf(driver(pane).drive(ID, extras, [{ kind: 'selection', labels: ['Shadow'] }]));

      should(failure).not.be.instanceOf(StructuredQuestionDrivePaused);
      should(failure.message).match(/→ did not move past its tab/u);
    });
  });
});
