import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import type { Instant } from '@ferretry/std';
import { CONVERSATION_STATE, type Question } from '../../../../contract/index.ts';
import { panePending } from '../../../../daemon/questions/adapters/pane-question.ts';
import {
  writeAskedQuestion,
  writeProjectedQuestion,
} from '../../../../daemon/questions/adapters/state-asked-question.ts';
import {
  isPaneQuestionId,
  PANE_GONE_LOOKS,
  QuestionWatch,
  type QuestionWatchDeps,
  type WatchedFerret,
} from '../../../../daemon/questions/lib/watch.ts';
import { questionScreen, readOpenForm, type OpenForm } from '../../../../daemon/questions/lib/rendered-form.ts';
import type { TranscriptEvent } from '../../../../daemon/seams/transcript-types.ts';
import { KeyedSerialExecutor } from '../../../../daemon/seams/keyed-serial-executor.ts';
import { fixtureTexts } from '../../../support/fixtures.ts';
import { memoryStatePort } from '../../../support/state.ts';

/**
 * M7: Claude's PreToolUse question hook is gone. An open AskUserQuestion form is read off the PANE, a question call in the
 * TRANSCRIPT is read as it is, and either makes the same `question.json` the hook did (so the mailbox waits on it exactly
 * as before). Its answer or dismissal clears it; an ordinary numbered list never makes one.
 */
const forms = await fixtureTexts(join(import.meta.dir, '../../../fixtures/question-forms'));
const screen = (visible: string) => questionScreen(visible, visible);
const SINGLE = forms('claude-2.1.281-single-80x24.txt');
const FORM = readOpenForm(screen(SINGLE)) as OpenForm;
const ASKED = '2026-11-16T10:00:00.000Z';
const LATER = '2026-11-16T10:00:30.000Z';
const FERRET: WatchedFerret = { id: 'cla', harness: 'claude-code', state: 'working' };

/** Claude's question call as the transcript parser makes it (the call lands with its result, once the form is over). */
const call = (id: string, form: OpenForm = FORM, at = '2026-11-16T09:59:50.000Z'): TranscriptEvent =>
  ({
    kind: 'tool-call',
    timestamp: at,
    call: {
      id,
      name: 'AskUserQuestion',
      input: {},
      questions: [
        {
          ...(form.header === undefined ? {} : { header: form.header }),
          question: form.question,
          multiple: form.multiple,
          options: form.options,
        },
      ],
    },
  }) as unknown as TranscriptEvent;
const result = (id: string, at = LATER): TranscriptEvent =>
  ({ kind: 'tool-result', timestamp: at, result: { callId: id } }) as unknown as TranscriptEvent;
const chatter = (at: string): TranscriptEvent =>
  ({ kind: 'message', timestamp: at, role: 'assistant', text: 'working' }) as unknown as TranscriptEvent;

function world(ferrets: readonly WatchedFerret[] = [FERRET]) {
  const state = {
    events: [chatter('2026-11-16T09:59:00.000Z')] as readonly TranscriptEvent[],
    pane: { ownsPane: false } as Awaited<ReturnType<NonNullable<QuestionWatchDeps['paneForm']>>>,
    question: undefined as Question | undefined,
    stamp: undefined as string | undefined,
    panes: 0,
    now: ASKED,
  };
  const events: string[] = [];
  const deps: QuestionWatchDeps = {
    roster: async () => ferrets,
    // No `askedQuestion`: a launch without the hook has no file to read.
    harness: async () => ({ transcript: { read: async () => [] } }),
    current: async () => state.question,
    lastAnswered: async () => state.stamp,
    write: async () => undefined,
    clear: async (_ferret, toolUseId) => {
      if (state.question?.toolUseId === toolUseId) state.question = undefined;
    },
    asked: async (ferret, toolUseId) => void events.push(`asked ${ferret} ${toolUseId}`),
    answered: async (ferret, toolUseId) => void events.push(`answered ${ferret} ${toolUseId}`),
    transcriptEvents: async () => state.events,
    paneForm: async () => {
      state.panes += 1;
      return state.pane;
    },
    writeProjected: async (_ferret, pending, askedAt) => {
      const [first, ...more] = pending.questions;
      if (first === undefined) return undefined;
      state.question = {
        format: 1,
        toolUseId: pending.toolUseId,
        ...(first.header === undefined ? {} : { header: first.header }),
        text: first.question,
        options: (first.options ?? []).map(({ label, description }) => ({
          label,
          ...(description === undefined ? {} : { description }),
        })),
        multiple: first.multiSelect === true,
        ...(more.length === 0
          ? {}
          : {
              more: more.map(item => ({
                ...(item.header === undefined ? {} : { header: item.header }),
                text: item.question,
                options: (item.options ?? []).map(({ label }) => ({ label })),
                multiple: item.multiSelect === true,
              })),
            }),
        askedAt: (askedAt ?? state.now) as Instant,
      };
      return state.question;
    },
  };
  return { state, events, watch: new QuestionWatch(deps) };
}

describe('a question form on the pane (M7)', () => {
  it('marks the ferret as asking, once, with the question the form shows', async () => {
    const w = world();
    w.state.pane = { form: FORM, ownsPane: true };
    await w.watch.sweep();
    const stored = w.state.question;
    expect(isPaneQuestionId(stored?.toolUseId ?? '')).toBe(true);
    expect(stored?.header).toBe('Pool check');
    expect(stored?.text).toStartWith('Test 4c collapsed');
    expect(stored?.options.map(option => option.label)).toEqual([
      'Read one prod pod (Recommended)',
      "I'll check Vault",
      'Skip; test with jitter',
    ]);
    expect(w.events).toEqual([`asked cla ${stored?.toolUseId}`]);
    await w.watch.sweep();
    await w.watch.sweep();
    expect(w.events).toHaveLength(1);
  });

  it('is the question.json the hook used to produce, field for field', async () => {
    const hooked = memoryStatePort(CONVERSATION_STATE);
    const paned = memoryStatePort(CONVERSATION_STATE);
    const lane = new KeyedSerialExecutor();
    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'toolu_hook',
      transcript_path: '/t.jsonl',
      tool_input: {
        questions: [{ header: FORM.header, question: FORM.question, multiSelect: false, options: FORM.options }],
      },
    });
    const fromHook = await writeAskedQuestion(hooked, lane, 'f', payload, ASKED as Instant, '/t.jsonl');
    const fromPane = await writeProjectedQuestion(
      paned,
      lane,
      'f',
      {
        toolUseId: 'pane:x',
        questions: [{ header: FORM.header, question: FORM.question, options: [...FORM.options] }],
      },
      undefined,
      () => ASKED as Instant,
    );
    const shape = ({ toolUseId: _id, transcript: _proof, ...rest }: Question) => rest;
    expect(shape(fromPane as Question)).toEqual(shape(fromHook as Question));
  });

  it('is retired by the transcript recording the answer (or the dismissal) for those words', async () => {
    const w = world();
    w.state.pane = { form: FORM, ownsPane: true };
    await w.watch.sweep();
    const id = w.state.question?.toolUseId as string;
    // Claude writes the call and its result together, once the form is answered or cancelled.
    w.state.events = [...w.state.events, call('toolu_real'), result('toolu_real')];
    w.state.pane = { ownsPane: false };
    await w.watch.sweep();
    expect(w.state.question).toBeUndefined();
    expect(w.events).toEqual([`asked cla ${id}`, `answered cla ${id}`]);
    // Nothing brings it back: the form is gone and the same words are in the transcript as answered.
    await w.watch.sweep();
    expect(w.events).toHaveLength(2);
  });

  it('is retired when the form has left a readable pane for two looks running, and not for one', async () => {
    const w = world();
    w.state.pane = { form: FORM, ownsPane: true };
    await w.watch.sweep();
    w.state.pane = { ownsPane: false };
    for (let look = 1; look < PANE_GONE_LOOKS; look++) {
      await w.watch.sweep();
      expect(w.state.question).toBeDefined();
    }
    await w.watch.sweep();
    expect(w.state.question).toBeUndefined();
    expect(w.events.at(-1)).toStartWith('answered cla pane:');
  });

  it('stays open across a redraw: a numbered surface that is not a readable form keeps it, and one form look resets the count', async () => {
    const w = world();
    w.state.pane = { form: FORM, ownsPane: true };
    await w.watch.sweep();
    w.state.pane = { ownsPane: true };
    for (let look = 0; look < 5; look++) await w.watch.sweep();
    expect(w.state.question).toBeDefined();
    w.state.pane = { ownsPane: false };
    await w.watch.sweep();
    w.state.pane = { form: FORM, ownsPane: true };
    await w.watch.sweep();
    w.state.pane = { ownsPane: false };
    await w.watch.sweep();
    expect(w.state.question).toBeDefined();
    w.state.pane = 'unreadable';
    for (let look = 0; look < 5; look++) await w.watch.sweep();
    expect(w.state.question).toBeDefined();
  });

  it('asks again for the same words later: the first answer’s stamp does not hide the second form', async () => {
    const w = world();
    w.state.pane = { form: FORM, ownsPane: true };
    await w.watch.sweep();
    const first = w.state.question?.toolUseId as string;
    w.state.events = [...w.state.events, call('toolu_real'), result('toolu_real')];
    w.state.pane = { ownsPane: false };
    await w.watch.sweep();
    w.state.stamp = first;
    w.state.events = [...w.state.events, chatter('2026-11-16T10:05:00.000Z')];
    w.state.now = '2026-11-16T10:05:10.000Z';
    w.state.pane = { form: FORM, ownsPane: true };
    await w.watch.sweep();
    expect(w.state.question?.toolUseId).not.toBe(first);
    expect(isPaneQuestionId(w.state.question?.toolUseId ?? '')).toBe(true);
  });

  it('is not made by a pane that shows no question form, so an ordinary numbered list asks nothing', async () => {
    const w = world();
    w.state.pane = { ownsPane: false };
    for (let look = 0; look < 3; look++) await w.watch.sweep();
    expect(w.state.question).toBeUndefined();
    expect(w.events).toEqual([]);
  });

  it('does not read the pane of an idle ferret with nothing stored', async () => {
    const w = world([{ ...FERRET, state: 'idle' }]);
    w.state.pane = { form: FORM, ownsPane: true };
    await w.watch.sweep();
    expect(w.state.panes).toBe(0);
    expect(w.state.question).toBeUndefined();
  });

  it('leaves a question the hook (an older launch) stored to its own retirement', async () => {
    const w = world();
    w.state.question = {
      format: 1,
      toolUseId: 'toolu_hook',
      text: FORM.question,
      options: [],
      multiple: false,
      askedAt: ASKED as Instant,
    };
    w.state.pane = { ownsPane: false };
    for (let look = 0; look < 4; look++) await w.watch.sweep();
    expect(w.state.question?.toolUseId).toBe('toolu_hook');
    expect(w.state.panes).toBe(0);
  });

  it('does not retire a stored question because a long transcript holds no call for it (Claude writes the call late)', async () => {
    const w = world();
    w.state.pane = { form: FORM, ownsPane: true };
    await w.watch.sweep();
    w.state.events = Array.from({ length: 250 }, (_, index) =>
      chatter(`2026-11-16T09:${String(index % 60).padStart(2, '0')}:00.000Z`),
    );
    await w.watch.sweep();
    expect(w.state.question).toBeDefined();
  });
});

describe('a question call in the transcript (M7)', () => {
  it('marks the ferret as asking from an AskUserQuestion tool_use with no result, under its own id', async () => {
    const w = world();
    w.state.events = [call('toolu_open')];
    await w.watch.sweep();
    expect(w.state.question?.toolUseId).toBe('toolu_open');
    expect(w.events).toEqual(['asked cla toolu_open']);
    // The same form on the pane is not a second question.
    w.state.pane = { form: FORM, ownsPane: true };
    await w.watch.sweep();
    expect(w.events).toEqual(['asked cla toolu_open']);
  });

  it('is cleared by the call’s result, and never stored again once answered', async () => {
    const w = world();
    w.state.events = [call('toolu_open')];
    await w.watch.sweep();
    w.state.events = [call('toolu_open'), result('toolu_open')];
    await w.watch.sweep();
    expect(w.state.question).toBeUndefined();
    expect(w.events).toEqual(['asked cla toolu_open', 'answered cla toolu_open']);
    await w.watch.sweep();
    expect(w.events).toHaveLength(2);
  });
});

describe('a form of several questions the pane showed one tab of (M7)', () => {
  /** The transcript's call for the form on the pane: its first question is the pane's, and it carries two more. */
  const tabbed = (id: string, at = '2026-11-16T09:59:55.000Z'): TranscriptEvent => {
    const [first] = (call(id) as unknown as { call: { questions: object[] } }).call.questions;
    return {
      kind: 'tool-call',
      timestamp: at,
      call: {
        id,
        name: 'AskUserQuestion',
        input: {},
        questions: [
          first,
          { question: 'Where to?', options: [{ label: 'Prod' }, { label: 'Stage' }], multiple: false },
          { header: 'Checks', question: 'Which checks?', options: [{ label: 'Unit' }], multiple: true },
        ],
      },
    } as unknown as TranscriptEvent;
  };

  it('stores every tab when the call lands, under the pane question’s own id, without retiring or asking anew', async () => {
    const w = world();
    w.state.pane = { form: FORM, ownsPane: true };
    await w.watch.sweep();
    const pane = w.state.question;
    expect(pane?.more).toBeUndefined();

    w.state.events = [chatter('2026-11-16T09:59:00.000Z'), tabbed('toolu_tabs')];
    await w.watch.sweep();

    expect(w.state.question?.toolUseId).toBe(pane?.toolUseId ?? '');
    expect(w.state.question?.askedAt).toBe(pane?.askedAt as Instant);
    expect(w.state.question?.text).toBe(pane?.text ?? '');
    expect(w.state.question?.more?.map(item => item.text)).toEqual(['Where to?', 'Which checks?']);
    expect(w.state.question?.more?.[1]?.multiple).toBe(true);
    // Not retired (no 'answered'), and the form is announced again so a screen shows its tabs.
    expect(w.events).toEqual([`asked cla ${pane?.toolUseId}`, `asked cla ${pane?.toolUseId}`]);

    // Nothing more is written while the call stays open and the form stays on the pane.
    w.state.pane = { form: FORM, ownsPane: true };
    await w.watch.sweep();
    await w.watch.sweep();
    expect(w.events).toHaveLength(2);
  });

  it('is retired as the pane question is once the call’s result lands', async () => {
    const w = world();
    w.state.pane = { form: FORM, ownsPane: true };
    await w.watch.sweep();
    const id = w.state.question?.toolUseId ?? '';
    w.state.events = [tabbed('toolu_tabs')];
    await w.watch.sweep();
    // The form is answered: the call has its result and the pane draws no form.
    w.state.pane = { ownsPane: false };
    w.state.events = [tabbed('toolu_tabs'), result('toolu_tabs')];
    await w.watch.sweep();
    expect(w.state.question).toBeUndefined();
    expect(w.events.at(-1)).toBe(`answered cla ${id}`);
  });

  it('is another question, as before, when the call is for a different form', async () => {
    const w = world();
    w.state.pane = { form: FORM, ownsPane: true };
    await w.watch.sweep();
    const id = w.state.question?.toolUseId ?? '';
    w.state.events = [call('toolu_other', { ...FORM, question: 'A different question entirely?' })];
    await w.watch.sweep();
    expect(w.state.question?.toolUseId).toBe('toolu_other');
    expect(w.events).toContain(`answered cla ${id}`);
  });
});

describe('panePending: the pane as the watch reads it', () => {
  const ferrets = (capture: Record<string, unknown> | 'refused') =>
    ({
      harness: async () => ({
        transcript: { read: async () => [] },
        form: {
          capture: async () =>
            capture === 'refused'
              ? { ok: false, error: 'no_pane' }
              : { ok: true, value: { alive: true, dead: false, promptReady: true, activeWork: false, ...capture } },
        },
      }),
    }) as never;
  const read = (capture: Record<string, unknown> | 'refused') =>
    panePending(ferrets(capture))('00000000-0000-4000-8000-000000000001');

  it('reads the form of a recorded Claude pane', async () => {
    const seen = await read({ visible: SINGLE, history: SINGLE });
    expect(seen).not.toBe('unreadable');
    expect((seen as { form?: OpenForm }).form?.question).toStartWith('Test 4c collapsed');
  });

  it('reads no form from a pane the runner calls a permission prompt or dialog, though it shares the rows', async () => {
    for (const blocking of ['permission', 'dialog'] as const)
      expect(await read({ visible: SINGLE, history: SINGLE, blocking })).toEqual({ ownsPane: true });
  });

  it('says a pane it cannot read is unreadable, never an empty one', async () => {
    expect(await read('refused')).toBe('unreadable');
    expect(await read({ visible: SINGLE, history: SINGLE, dead: true })).toBe('unreadable');
  });

  it('reads an ordinary numbered list as no form and no numbered surface', async () => {
    const plan = '⏺ Plan:\n\n  1. Read\n  2. Change\n  3. Test\n\n❯ \n';
    expect(await read({ visible: plan, history: plan })).toEqual({ ownsPane: false });
  });
});
