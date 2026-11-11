import { describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import type { FerretHarness, FerretId, FormKey, RunnerFormCapture } from '@ferretry/core-ferrets/contract';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import type { Instant } from '@ferretry/std';
import { ok } from '@ferretry/std';
import { fixedClock, owner, testHost } from '@ferretry/kernel/testing';
import {
  ANSWERS_STATE,
  CONVERSATION_STATE,
  type Question,
  QUESTION_ANSWERED_STATE,
  QUESTION_STATE,
} from '../../../contract/index.ts';
import daemon from '../../../daemon/index.ts';
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

  private frame(): RunnerFormCapture {
    const visible = this.answered ? '> ' : claude(this.asks, this.rows, this.cursor);
    return { alive: true, dead: false, promptReady: this.answered, activeWork: false, visible, history: visible };
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
          if (key === 'Enter' && !this.stuck) this.answered = true;
          return ok(undefined);
        },
        paste: async (text: string) => {
          this.pasted.push(text);
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
