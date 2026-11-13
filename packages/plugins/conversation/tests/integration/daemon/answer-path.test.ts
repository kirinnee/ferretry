import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import type { FerretHarness, FerretId, FormKey, RunnerFormCapture } from '@ferretry/core-ferrets/contract';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import type { Instant } from '@ferretry/std';
import { ok } from '@ferretry/std';
import { DaemonCallError } from '@ferretry/app';
import { render, run, runUntil } from '@ferretry/app/testing';
import { createElement } from 'react';
import { QuestionForm } from '../../../app/questions/question-form.tsx';
import { QuestionDraftStore } from '../../../app/questions/question-form-model.ts';
import { FORM_UNREADABLE } from '../../../daemon/questions/lib/answer-wording.ts';
import { fixedClock, owner, testHost } from '@ferretry/kernel/testing';
import {
  ANSWERS_STATE,
  CONVERSATION_STATE,
  type Question,
  QUESTION_ANSWERED_STATE,
  QUESTION_STATE,
} from '../../../contract/index.ts';
import daemon from '../../../daemon/index.ts';
import { writeAskedQuestion } from '../../../daemon/questions/adapters/index.ts';
import { KeyedSerialExecutor } from '../../../daemon/seams/keyed-serial-executor.ts';
import { memoryStatePort } from '../../support/state.ts';
import { wardenStandIn } from '../../support/warden-plugin.ts';

/**
 * Answering a question's form through the real daemon half: `POST /v1/ferrets/:id/answer` → the structured-answer
 * coordinator → the form driver → the ferret's `FerretHarness.form`. Ferrets is the fake whose form is a scripted pane
 * that redraws as keys land, so what is proved here is the ORDER of the keys, that the form is bound before one is
 * typed, and the state the answer leaves (`question.json` cleared, the answered stamp, the receipt).
 */

const F1 = ferretId('f1');
const START = '2026-11-07T09:00:00Z';
const ASKED_AT = '2026-11-07T08:59:00.000Z' as Instant;
const RULE = '─'.repeat(40);

/** A single-question form the way Claude Code 2.1.281 draws one: a border, the question, numbered rows. */
const claude = (question: string, rows: readonly string[], cursor: number): string =>
  [
    RULE,
    question,
    '',
    ...rows.map((row, index) => `${index === cursor ? '❯' : ' '} ${index + 1}. ${row}`),
    RULE,
    `  ${rows.length + 1}. Chat about this`,
  ].join('\n');

const question: Question = {
  format: 1,
  toolUseId: 'toolu_1',
  text: 'Deploy?',
  options: [{ label: 'Yes' }, { label: 'No' }, { label: 'Other' }],
  multiple: false,
  askedAt: ASKED_AT,
  transcript: '/transcripts/f1.jsonl',
};

/** A recorded page with its cursor marker moved to the `cursor`th row of the last numbered run (row 1 is what was recorded). */
function cursorAt(text: string, cursor: number): string {
  const lines = text.split('\n');
  const row = /^[❯ ] (\d+)\. /u;
  const first = lines.findLastIndex(line => /^[❯ ] 1\. /u.test(line));
  if (first < 0) return text;
  // The rows run to the rule under them; a row's description lines sit between them.
  let index = 0;
  for (let at = first; at < lines.length && !/^─{5,}/u.test(lines[at] ?? ''); at++) {
    if (!row.test(lines[at] ?? '')) continue;
    lines[at] = (lines[at] ?? '').replace(/^[❯ ]/u, index === cursor ? '❯' : ' ');
    index += 1;
  }
  return lines.join('\n');
}

/** A pane that shows the form, moves its cursor on Up/Down, and drops to a prompt on Enter (the answer took). */
class FormFerrets extends FakeFerrets {
  readonly keys: FormKey[] = [];
  readonly pasted: string[] = [];
  rows = ['Yes', 'No', 'Other'];
  cursor = 0;
  /** What the form asks on screen; differs from `question.text` when the form has drifted. */
  asks = 'Deploy?';
  answered = false;
  /** A pane that shows the form and ignores Enter, so the answer never visibly takes. */
  stuck = false;
  /**
   * Whole recorded panes, ONE PER PAGE (the last one stays): for a tabbed form, whose pages are a recording rather than
   * something this class can compute. Enter turns the page; Up and Down move the cursor within it (the recording shows it on
   * row 1, so the marker is redrawn where the keys have put it, as the real form does); reads change nothing. Left out, the
   * pane draws the single form above.
   */
  replay: readonly { readonly visible: string; readonly history: string }[] | undefined;
  private page = 0;
  /** A replayed pane that draws no selected-row marker at all, as a form whose selection cannot be read. */
  hideCursor = false;
  /** Text pasted on the current page: the inline row draws it where the recording shows its placeholder. */
  private typed: string | undefined;

  private frame(): RunnerFormCapture {
    if (this.replay !== undefined) {
      const shown = this.replay[Math.min(this.page, this.replay.length - 1)];
      if (shown === undefined) throw new Error('the replay holds no pane');
      const activeWork = /esc to interrupt|\(\d+s\s*[·•]/iu.test(shown.visible);
      return {
        alive: true,
        dead: false,
        promptReady: false,
        activeWork,
        visible: this.drawn(this.marked(shown.visible)),
        history: this.drawn(this.marked(shown.history)),
      };
    }
    const visible = this.answered ? '> ' : claude(this.asks, this.rows, this.cursor);
    return { alive: true, dead: false, promptReady: this.answered, activeWork: false, visible, history: visible };
  }

  private marked(text: string): string {
    return this.hideCursor ? text.replace(/^❯( +\d+\. )/gmu, ' $1') : cursorAt(text, this.cursor);
  }

  private drawn(text: string): string {
    const typed = this.typed;
    if (typed === undefined) return text;
    const at = text.lastIndexOf('Type something.');
    return at < 0 ? text : `${text.slice(0, at)}${typed}${text.slice(at + 'Type something.'.length)}`;
  }

  async harness(ferret: FerretId): Promise<FerretHarness | undefined> {
    if ((await this.get(ferret)) === undefined) return undefined;
    return {
      form: {
        capture: async () => ok(this.frame()),
        key: async (key: FormKey) => {
          this.keys.push(key);
          if (key === 'Down') this.cursor = Math.min(this.cursor + 1, this.rows.length - 1);
          if (key === 'Up') this.cursor = Math.max(this.cursor - 1, 0);
          if (key === 'Enter' && !this.stuck) {
            this.answered = true;
            this.page += 1;
            this.cursor = 0;
            this.typed = undefined;
          }
          return ok(undefined);
        },
        paste: async (text: string) => {
          this.pasted.push(text);
          // The inline free-form row is itself the text field: it draws what was pasted into it.
          if (this.replay === undefined) this.rows[this.cursor] = text;
          else this.typed = text;
          return ok(undefined);
        },
      },
    } as unknown as FerretHarness;
  }
}

async function world(setup: (ferrets: FormFerrets) => void = () => undefined) {
  const ferrets = new FormFerrets();
  ferrets.add({ id: F1, state: 'idle' });
  setup(ferrets);
  const state = memoryStatePort(CONVERSATION_STATE);
  const clock = fixedClock(START);
  const implementation = {
    ...daemon,
    build: (ctx: Parameters<NonNullable<typeof daemon.build>>[0]) => {
      const build = daemon.build;
      if (build === undefined) throw new Error('the conversation daemon half has no build');
      return build({ ...ctx, kernel: { ...ctx.kernel, state } });
    },
  } as typeof daemon;
  const host = await testHost({
    plugins: [implementation, wardenStandIn],
    fakes: { ferrets, asks: new FakeAsks() },
    clock,
  });
  await state.write(QUESTION_STATE, question, 'f1');
  /** POSTs an answer and moves the driven clock while the driver polls the pane for the form to move on. */
  const answer = async (body: unknown, requestId = 'req-1') => {
    let settled = false;
    const done = host
      .request('POST', '/v1/ferrets/f1/answer', { as: owner(), body, headers: { 'x-fy-request-id': requestId } })
      .finally(() => {
        settled = true;
      });
    for (let round = 0; round < 200 && !settled; round += 1) {
      await clock.advance(250);
      await Bun.sleep(0);
    }
    return await done;
  };
  return { host, ferrets, state, answer };
}

describe('answering a question’s form from the app', () => {
  test('the choice is typed in order into the bound form, then the question is cleared and stamped answered', async () => {
    const { host, ferrets, state, answer } = await world();

    const response = await answer({ toolUseId: 'toolu_1', labels: ['No'] });

    expect(response.status).toBe(200);
    expect(ferrets.keys).toEqual(['Down', 'Enter']);
    expect(ferrets.pasted).toEqual([]);
    expect(await state.read(QUESTION_STATE, 'f1')).toEqual({ ok: true, value: undefined });
    expect(await state.read(QUESTION_ANSWERED_STATE, 'f1')).toMatchObject({
      ok: true,
      value: { toolUseId: 'toolu_1' },
    });
    expect(host.published.map(event => event.event)).toContain('conversation.question-answered');
    await host.stop();
  });

  test('a free-form answer is pasted into the form’s own row and finished with Enter', async () => {
    const { host, ferrets, answer } = await world(f => {
      f.rows = ['Yes', 'No', 'Type something.'];
    });

    const response = await answer({ toolUseId: 'toolu_1', labels: [], answers: [{ kind: 'other', text: 'Tomorrow' }] });

    expect(response.status).toBe(200);
    expect(ferrets.pasted).toEqual(['Tomorrow']);
    expect(ferrets.keys).toEqual(['Down', 'Down', 'Enter']);
    await host.stop();
  });

  test('the same request again after it settled answers the same, and no key is typed twice', async () => {
    const { host, ferrets, answer } = await world();
    await answer({ toolUseId: 'toolu_1', labels: ['No'] });

    const again = await answer({ toolUseId: 'toolu_1', labels: ['No'] });

    expect(again.status).toBe(200);
    expect(ferrets.keys).toEqual(['Down', 'Enter']);
    await host.stop();
  });

  test('a form that is not the stored question is not typed into: refused, and nothing is cleared', async () => {
    const { host, ferrets, state, answer } = await world(f => {
      f.asks = 'A different prompt?';
    });

    const response = await answer({ toolUseId: 'toolu_1', labels: ['No'] });

    expect(response.status).toBe(409);
    expect(response.json()).toMatchObject({ code: 'answer_unconfirmed' });
    expect(ferrets.keys).toEqual([]);
    expect(await state.read(QUESTION_STATE, 'f1')).toMatchObject({ ok: true, value: { toolUseId: 'toolu_1' } });
    await host.stop();
  });

  test('an option the form did not offer is refused before any key', async () => {
    const { host, ferrets, answer } = await world();

    const response = await answer({ toolUseId: 'toolu_1', labels: ['Maybe'] });

    expect(response.status).toBe(409);
    expect(response.json()).toMatchObject({ code: 'answer_refused' });
    expect(ferrets.keys).toEqual([]);
    await host.stop();
  });

  test('an answer for another question than the one displayed is refused', async () => {
    const { host, ferrets, answer } = await world();

    const response = await answer({ toolUseId: 'toolu_OLD', labels: ['No'] });

    expect(response.status).toBe(409);
    expect(response.json()).toMatchObject({ code: 'answer_refused' });
    expect(ferrets.keys).toEqual([]);
    await host.stop();
  });

  test('a ferret with no question, and a ferret that is not there, are refused 409 and 404', async () => {
    const { host, state, answer } = await world();
    await state.remove(QUESTION_STATE, 'f1');

    expect((await answer({ toolUseId: 'toolu_1', labels: ['No'] })).status).toBe(409);
    const missing = await host.request('POST', '/v1/ferrets/f9/answer', {
      as: owner(),
      body: { toolUseId: 'toolu_1', labels: ['No'] },
      headers: { 'x-fy-request-id': 'req-9' },
    });
    expect(missing.status).toBe(404);
    await host.stop();
  });

  test('an answer without a request id is refused 400', async () => {
    const { host, ferrets } = await world();

    const response = await host.request('POST', '/v1/ferrets/f1/answer', {
      as: owner(),
      body: { toolUseId: 'toolu_1', labels: ['No'] },
    });

    expect(response.status).toBe(400);
    expect(ferrets.keys).toEqual([]);
    await host.stop();
  });

  test('a stopped ferret takes no answer', async () => {
    const { host, ferrets, answer } = await world(f => f.add({ id: F1, state: 'stopped' }));

    const response = await answer({ toolUseId: 'toolu_1', labels: ['No'] });

    expect(response.status).toBe(409);
    expect(response.json()).toMatchObject({ code: 'answer_refused' });
    expect(ferrets.keys).toEqual([]);
    await host.stop();
  });

  test('keys that never take leave the form pending, and the receipt is kept so the id is not driven again', async () => {
    const { host, ferrets, state, answer } = await world(f => {
      f.stuck = true;
    });

    const response = await answer({ toolUseId: 'toolu_1', labels: ['No'] });

    expect(response.status).toBe(409);
    // One Escape to release the form it could not answer, and no more.
    expect(ferrets.keys).toEqual(['Down', 'Enter', 'Escape']);
    expect(await state.read(QUESTION_STATE, 'f1')).toMatchObject({ ok: true, value: { toolUseId: 'toolu_1' } });
    const typedBefore = ferrets.keys.length;
    const again = await answer({ toolUseId: 'toolu_1', labels: ['No'] });
    expect(again.status).toBe(409);
    expect(ferrets.keys.length).toBe(typedBefore);
    const lines: unknown[] = [];
    for await (const line of state.lines(ANSWERS_STATE, 'f1')) lines.push(line);
    expect(lines.length).toBeGreaterThan(0);
    await host.stop();
  });
});

describe('the form seam refuses what it cannot do', () => {
  test('a Ferrets that offers no form acts says so, and types nothing', async () => {
    const ferrets = new FakeFerrets();
    ferrets.add({ id: F1, state: 'idle' });
    const state = memoryStatePort(CONVERSATION_STATE);
    const implementation = {
      ...daemon,
      build: (ctx: Parameters<NonNullable<typeof daemon.build>>[0]) => {
        const build = daemon.build;
        if (build === undefined) throw new Error('the conversation daemon half has no build');
        return build({ ...ctx, kernel: { ...ctx.kernel, state } });
      },
    } as typeof daemon;
    const host = await testHost({
      plugins: [implementation, wardenStandIn],
      fakes: { ferrets, asks: new FakeAsks() },
      clock: fixedClock(START),
    });
    await state.write(QUESTION_STATE, question, 'f1');

    const response = await host.request('POST', '/v1/ferrets/f1/answer', {
      as: owner(),
      body: { toolUseId: 'toolu_1', labels: ['No'] },
      headers: { 'x-fy-request-id': 'req-1' },
    });

    expect(response.status).toBe(503);
    expect(response.json()).toMatchObject({ code: 'plugin_unavailable' });
    await host.stop();
  });
});

/**
 * Findings 4 and 5 of the structured-questions review: the pane cannot tell two forms with the same text apart, and the
 * question lane (updates, the watch's retirement) is not the answer's. So an answer is bound to its question's tool id for
 * every key it types, and a question retired or replaced after the answer took does not turn a delivered answer into an
 * error. `onCapture` runs a step in the middle of the drive, in the frame the driver is reading.
 */
describe('a drive stays bound to its own question', () => {
  type World = Awaited<ReturnType<typeof world>>;
  const second: Question = { ...question, toolUseId: 'toolu_2' };

  /** Runs `step` when the driver captures a frame; `when` decides which capture (the 1st is the preflight read). */
  const onCapture = (w: World, when: (capture: number) => boolean, step: () => Promise<void>): void => {
    const original = w.ferrets.harness.bind(w.ferrets);
    let captures = 0;
    w.ferrets.harness = async id => {
      const harness = await original(id);
      if (harness?.form === undefined) return harness;
      const form = harness.form;
      return {
        ...harness,
        form: {
          ...form,
          capture: async () => {
            const captured = await form.capture();
            captures += 1;
            if (when(captures)) await step();
            return captured;
          },
        },
      };
    };
  };

  /** Runs `step` right after the form took the `nth` key (1-based). */
  const afterKey = (w: World, nth: number, step: () => Promise<void>): void => {
    const original = w.ferrets.harness.bind(w.ferrets);
    let typed = 0;
    w.ferrets.harness = async id => {
      const harness = await original(id);
      if (harness?.form === undefined) return harness;
      const form = harness.form;
      return {
        ...harness,
        form: {
          ...form,
          key: async (pressed: FormKey) => {
            const result = await form.key(pressed);
            typed += 1;
            if (typed === nth) await step();
            return result;
          },
        },
      };
    };
  };

  test('a question replaced during the first look types nothing, and the newer question is left whole', async () => {
    const w = await world();
    onCapture(
      w,
      n => n === 1,
      async () => await w.state.write(QUESTION_STATE, second, 'f1'),
    );

    const response = await w.answer({ toolUseId: 'toolu_1', labels: ['No'] });

    expect(w.ferrets.keys).toEqual([]);
    expect(response.status).toBe(409);
    expect(await w.state.read(QUESTION_STATE, 'f1')).toMatchObject({ ok: true, value: { toolUseId: 'toolu_2' } });
    expect(await w.state.read(QUESTION_ANSWERED_STATE, 'f1')).toMatchObject({ ok: true, value: undefined });
    await w.host.stop();
  });

  test('a question withdrawn during the first look types nothing', async () => {
    const w = await world();
    onCapture(
      w,
      n => n === 1,
      async () => await w.state.remove(QUESTION_STATE, 'f1'),
    );

    const response = await w.answer({ toolUseId: 'toolu_1', labels: ['No'] });

    expect(w.ferrets.keys).toEqual([]);
    expect(response.status).toBe(409);
    await w.host.stop();
  });

  test('a question replaced between two keys stops the drive: the second key is never typed', async () => {
    const w = await world();
    // The first key (Down) has landed; the replacement arrives before Enter.
    afterKey(w, 1, async () => await w.state.write(QUESTION_STATE, second, 'f1'));

    const response = await w.answer({ toolUseId: 'toolu_1', labels: ['No'] });

    expect(w.ferrets.keys).toEqual(['Down']);
    expect(w.ferrets.keys).not.toContain('Enter');
    expect(response.status).toBe(409);
    expect(await w.state.read(QUESTION_STATE, 'f1')).toMatchObject({ ok: true, value: { toolUseId: 'toolu_2' } });
    await w.host.stop();
  });

  test('the release Escape of a failed drive is not sent into a newer question’s form', async () => {
    const w = await world();
    w.ferrets.stuck = true; // Enter lands but the form never moves on: the drive fails and tries to cancel.
    onCapture(
      w,
      n => n === 3,
      async () => await w.state.write(QUESTION_STATE, second, 'f1'),
    );

    const response = await w.answer({ toolUseId: 'toolu_1', labels: ['No'] });

    expect(response.status).toBe(409);
    expect(w.ferrets.keys).not.toContain('Escape');
    expect(await w.state.read(QUESTION_STATE, 'f1')).toMatchObject({ ok: true, value: { toolUseId: 'toolu_2' } });
    await w.host.stop();
  });

  test('the watch retiring the question after the answer was typed does not turn the delivery into an error', async () => {
    const w = await world();
    // What the watch does once the transcript names the call: the exact-id clear, while the driver confirms.
    onCapture(
      w,
      () => w.ferrets.answered,
      async () => await w.state.remove(QUESTION_STATE, 'f1'),
    );

    const response = await w.answer({ toolUseId: 'toolu_1', labels: ['No'] });

    expect(response.status).toBe(200);
    expect(w.ferrets.keys).toEqual(['Down', 'Enter']);
    expect(await w.state.read(QUESTION_ANSWERED_STATE, 'f1')).toMatchObject({
      ok: true,
      value: { toolUseId: 'toolu_1' },
    });
    expect(await w.state.read(QUESTION_STATE, 'f1')).toMatchObject({ ok: true, value: undefined });
    expect(w.host.published.map(event => event.event)).toContain('conversation.question-answered');
    await w.host.stop();
  });

  test('a next question that replaced the answered one before the commit survives the commit', async () => {
    const w = await world();
    onCapture(
      w,
      () => w.ferrets.answered,
      async () => await w.state.write(QUESTION_STATE, second, 'f1'),
    );

    const response = await w.answer({ toolUseId: 'toolu_1', labels: ['No'] });

    expect(response.status).toBe(200);
    expect(await w.state.read(QUESTION_ANSWERED_STATE, 'f1')).toMatchObject({
      ok: true,
      value: { toolUseId: 'toolu_1' },
    });
    expect(await w.state.read(QUESTION_STATE, 'f1')).toMatchObject({ ok: true, value: { toolUseId: 'toolu_2' } });
    await w.host.stop();
  });
});

/**
 * A tabbed form: several questions in ONE tool call (finding 2 of the structured-questions review). The hook's payload is
 * stored whole, so the form is shown and guarded, and it is answered tab by tab through the recorded Claude Code 2.1.281
 * panes of a four-question form, then cleared.
 */
describe('a tabbed form of several questions', () => {
  const TABS = join(import.meta.dir, '../../fixtures/question-forms/claude-2.1.281-tabs4');
  // The recording is a series of reads; some are repeat reads of one page (2 and 3, 4 and 5, 6 and 7, 8 and 9 are the same page).
  const PAGE_STARTS = [0, 1, 3, 5, 7, 9];
  const recorded = (run: string) =>
    readdirSync(join(TABS, run))
      .filter(file => file.endsWith('.txt'))
      .sort()
      .filter((_, index) => PAGE_STARTS.includes(index))
      .map(file => {
        const history = readFileSync(join(TABS, run, file), 'utf8');
        return { visible: `${history.split('\n').slice(0, -1).slice(-24).join('\n')}\n`, history };
      });
  const pending = JSON.parse(readFileSync(join(TABS, 'pending.json'), 'utf8')) as {
    toolUseId: string;
    questions: unknown[];
  };
  const hookPayload = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_use_id: pending.toolUseId,
    transcript_path: question.transcript,
    tool_input: { questions: pending.questions },
  });

  test('is stored whole by the writer, then answered tab by tab and cleared', async () => {
    const w = await world(f => {
      f.replay = recorded('fresh');
    });
    const stored = await writeAskedQuestion(
      w.state,
      new KeyedSerialExecutor(),
      'f1',
      hookPayload,
      ASKED_AT,
      question.transcript,
    );
    expect(stored?.more).toHaveLength(pending.questions.length - 1);

    const response = await w.answer({
      toolUseId: pending.toolUseId,
      labels: [],
      answers: [
        { kind: 'selection', labels: ['Lunch only'] },
        { kind: 'selection', labels: ['Decline'] },
        { kind: 'other', text: 'Only if it is on Zoom' },
        { kind: 'selection', labels: ['Maybe'] },
      ],
    });

    expect(response.status).toBe(200);
    const keys: FormKey[] = [
      ...(['Down', 'Down', 'Enter'] as const),
      ...(['Down', 'Enter'] as const),
      ...(['Down', 'Down', 'Enter'] as const),
      ...(['Down', 'Down', 'Enter'] as const),
      'Enter',
    ];
    expect(w.ferrets.keys).toEqual(keys);
    expect(w.ferrets.pasted).toEqual(['Only if it is on Zoom']);
    expect(await w.state.read(QUESTION_STATE, 'f1')).toMatchObject({ ok: true, value: undefined });
    expect(await w.state.read(QUESTION_ANSWERED_STATE, 'f1')).toMatchObject({
      ok: true,
      value: { toolUseId: pending.toolUseId },
    });
    await w.host.stop();
  });

  test('an unreadable tabbed form is refused as unreadable, not paused, and the app tells the person to answer at the terminal', async () => {
    // The recording with its native selected-row marker removed: the cursor cannot be read, so nothing may be typed.
    const w = await world(f => {
      f.replay = recorded('fresh');
      f.hideCursor = true;
    });
    await writeAskedQuestion(w.state, new KeyedSerialExecutor(), 'f1', hookPayload, ASKED_AT, question.transcript);
    const body = {
      toolUseId: pending.toolUseId,
      labels: [],
      answers: [
        { kind: 'selection', labels: ['Lunch only'] },
        { kind: 'selection', labels: ['Decline'] },
        { kind: 'other', text: 'Only if it is on Zoom' },
        { kind: 'selection', labels: ['Maybe'] },
      ],
    };

    // The daemon's own refusal, as the shell's client turns it into the error the form receives.
    const daemonCall = async (): Promise<never> => {
      const response = await w.answer(body, 'req-tabbed');
      const reply = response.json<Record<string, unknown>>();
      throw new DaemonCallError(response.status, String(reply.code), String(reply.error), reply);
    };
    const response = await w.answer(body, 'req-tabbed-direct');
    expect(response.status).toBe(409);
    const reply = response.json<{
      code: string;
      error: string;
      detail: string;
      stoppedAt: number;
      answered: boolean[];
    }>();
    expect(reply.code).toBe('answer_form_unreadable');
    expect(reply.error).toBe(FORM_UNREADABLE);
    expect(reply.detail).toMatch(/cursor is not visible/u);
    // The partial progress rides along; the question stays pending and nothing was typed, not even an Escape.
    expect(reply.stoppedAt).toBe(0);
    expect(reply.answered).toEqual([false, false, false, false]);
    expect(w.ferrets.keys).toEqual([]);
    expect(w.ferrets.pasted).toEqual([]);
    expect(await w.state.read(QUESTION_STATE, 'f1')).toMatchObject({
      ok: true,
      value: { toolUseId: pending.toolUseId },
    });

    // And the app, given that very refusal, says so in words and offers the Console, not Resume.
    const opened: string[] = [];
    const form = render(
      createElement(QuestionForm, {
        api: { answer: daemonCall },
        daemon: 'daemon-a',
        drafts: new QuestionDraftStore(),
        ferretId: 'f1',
        onOpenConsole: () => opened.push('console'),
        question: { toolUseId: 'stuck', questions: [{ question: 'Proceed?', options: [{ label: 'Yes' }] }] },
      }),
    );
    run(() => form.root.findAllByType('input')[0]?.props.onChange());
    await runUntil(
      () => form.root.findByProps({ className: 'fy-question-submit' }).props.onClick(),
      () => form.root.findAllByProps({ role: 'alert' }).length > 0,
      'the refusal to be shown',
    );
    expect(form.root.findByProps({ role: 'alert' }).children.join('')).toBe(FORM_UNREADABLE);
    expect(form.root.findAllByProps({ className: 'fy-question-console' })).toHaveLength(1);
    expect(form.root.findAllByProps({ className: 'fy-question-resume' })).toHaveLength(0);
    run(() => form.root.findByProps({ className: 'fy-question-console' }).props.onClick());
    expect(opened).toEqual(['console']);
    expect(w.ferrets.keys).toEqual([]);
    await w.host.stop();
  });

  test('a request that answers fewer questions than the form holds is refused before any key', async () => {
    const w = await world(f => {
      f.replay = recorded('fresh');
    });
    await writeAskedQuestion(w.state, new KeyedSerialExecutor(), 'f1', hookPayload, ASKED_AT, question.transcript);

    const response = await w.answer({
      toolUseId: pending.toolUseId,
      labels: [],
      answers: [{ kind: 'selection', labels: ['Lunch only'] }],
    });

    expect(response.status).toBe(409);
    expect(w.ferrets.keys).toEqual([]);
    await w.host.stop();
  });
});
