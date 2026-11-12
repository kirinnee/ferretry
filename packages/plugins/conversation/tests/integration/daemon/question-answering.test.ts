import { describe, expect, it } from 'bun:test';
import type { FerretHarness, FerretsApi, FormKey, HarnessForm } from '@ferretry/core-ferrets/contract';
import { ApiError } from '@ferretry/kernel/contract';
import { err, ok } from '@ferretry/std';
import { harnessFormPane } from '../../../daemon/questions/adapters/harness-form-pane.ts';
import { buildQuestionAnswering } from '../../../daemon/questions/adapters/question-answering.ts';
import { KeyedSerialExecutor } from '../../../daemon/seams/keyed-serial-executor.ts';
import { memoryStatePort } from '../../support/state.ts';
import { RELOAD_THE_APP } from '../../../daemon/questions/lib/answer-wording.ts';
import { CONVERSATION_STATE, QUESTION_ANSWERED_STATE, QUESTION_STATE } from '../../../contract/index.ts';

/**
 * The answer path's adapters in the integration tier (they live under `adapters/`, which only integration runs judge): the
 * harness form pane, who may answer, and — over the real state port, ledger, coordinator and driver — what happens when
 * the pane, the state files or the neighbouring ports go wrong around a drive.
 */
const FRAME = { alive: true, dead: false, promptReady: false, activeWork: false, visible: 'v', history: 'h' } as const;

/** A Ferrets whose one ferret has the harness `make` builds; `calls` records who asked to reach it. */
function ferretsWith(harness: Partial<FerretHarness> | undefined, calls: unknown[][] = []) {
  return {
    get: async () => ({ id: 'f1', state: 'idle', harness: 'claude-code' }),
    harness: async (...args: unknown[]) => {
      calls.push(args);
      return harness as FerretHarness | undefined;
    },
  } as unknown as Pick<FerretsApi, 'get' | 'harness'>;
}

describe('the harness form pane', () => {
  it('captures the frame the runner masked, and refuses in words when it cannot', async () => {
    const live = harnessFormPane(
      ferretsWith({
        form: { capture: async () => ok(FRAME), key: async () => ok(undefined), paste: async () => ok(undefined) },
      }),
    );
    expect(await live.state('f1')).toEqual(FRAME);

    const gone = harnessFormPane(
      ferretsWith({
        form: {
          capture: async () => err({ refused: 'no_pane' }),
          key: async () => ok(undefined),
          paste: async () => ok(undefined),
        },
      }),
    );
    await expect(gone.state('f1')).rejects.toThrow(/no live agent/u);
  });

  it('hands on the runner’s reading of a permission prompt or dialog, as the capture gave it', async () => {
    const pane = harnessFormPane(
      ferretsWith({
        form: {
          capture: async () => ok({ ...FRAME, blocking: 'permission' as const }),
          key: async () => ok(undefined),
          paste: async () => ok(undefined),
        },
      }),
    );

    expect((await pane.state('f1')).blocking).toBe('permission');
  });

  it('says a question is over only when the transcript carries its result by id, and an unreadable one proves nothing', async () => {
    const reading = (read: () => Promise<unknown[]>) =>
      harnessFormPane(ferretsWith({ transcript: { read } } as unknown as Partial<FerretHarness>));

    const result = reading(async () => [{ tools: { results: ['t1'] } }]);
    const call = reading(async () => [{ tools: { calls: ['t1'] } }]);
    const broken = reading(async () => {
      throw new Error('transcript unreadable');
    });

    expect(await result.completed?.('f1', 't1')).toBe(true);
    expect(await result.completed?.('f1', 't2')).toBe(false);
    // A call without its result is a question still open.
    expect(await call.completed?.('f1', 't1')).toBe(false);
    expect(await broken.completed?.('f1', 't1')).toBe(false);
  });

  it('presses only the closed set of keys, and never asks the harness for any other', async () => {
    const pressed: FormKey[] = [];
    const pane = harnessFormPane(
      ferretsWith({
        form: {
          capture: async () => ok(FRAME),
          key: async key => {
            pressed.push(key);
            return ok(undefined);
          },
          paste: async () => ok(undefined),
        },
      }),
    );

    await pane.sendKey('f1', 'Down');
    await expect(pane.sendKey('f1', 'C-c')).rejects.toThrow(/not a key a question form is driven with/u);
    await expect(pane.sendKey('f1', 'y')).rejects.toThrow();

    expect(pressed).toEqual(['Down']);
  });

  it('turns a refused key or paste into an error, so the driver counts it as possibly landed', async () => {
    const pane = harnessFormPane(
      ferretsWith({
        form: {
          capture: async () => ok(FRAME),
          key: async () => err({ refused: 'not_ready', why: 'exited' }),
          paste: async () => err({ refused: 'plugin_unavailable' }),
        },
      }),
    );

    await expect(pane.sendKey('f1', 'Enter')).rejects.toThrow();
    await expect(pane.paste('f1', 'text')).rejects.toThrow(/off/u);
  });

  it('says so when Ferrets has no seam, no ferret, or the harness has no form acts', async () => {
    await expect(harnessFormPane({ get: async () => undefined } as never).state('f1')).rejects.toMatchObject({
      status: 503,
    });
    await expect(harnessFormPane(ferretsWith(undefined)).state('f1')).rejects.toMatchObject({ status: 404 });
    await expect(harnessFormPane(ferretsWith({})).state('f1')).rejects.toMatchObject({ status: 503 });
  });
});

describe('answering, who may', () => {
  const build = (ferrets: Pick<FerretsApi, 'get' | 'harness'>) => {
    const state = memoryStatePort(CONVERSATION_STATE);
    const lane = new KeyedSerialExecutor();
    const answering = buildQuestionAnswering({
      state,
      ferrets,
      questionLane: lane,
      serial: new KeyedSerialExecutor(),
      clock: { now: () => '2026-11-07T09:00:00.000Z' as never },
      status: async () => 'awaiting_user',
      publishAnswered: async () => undefined,
      log: { info: () => undefined, warn: () => undefined },
      sleep: async () => undefined,
    });
    return { answering, state };
  };
  const request = { toolUseId: 't1', labels: ['A'], requestId: 'r1' };

  it('asks Ferrets whether the calling ferret may touch this one, and stops at its refusal before anything is read or typed', async () => {
    const calls: unknown[][] = [];
    const typed: string[] = [];
    const ferrets = {
      get: async () => ({ id: 'f1' }),
      harness: async (...args: unknown[]) => {
        calls.push(args);
        throw new ApiError(403, 'a ferret touches only its own', 'forbidden');
      },
    } as unknown as Pick<FerretsApi, 'get' | 'harness'>;
    const { answering, state } = build(ferrets);
    await state.write(
      QUESTION_STATE,
      {
        format: 1,
        toolUseId: 't1',
        text: 'Q?',
        options: [{ label: 'A' }],
        multiple: false,
        askedAt: '2026-11-07T08:00:00.000Z',
        transcript: '/t',
      } as never,
      'f1',
    );

    await expect(answering.answer('f1', { ...request, caller: 'f2' })).rejects.toMatchObject({ status: 403 });

    expect(calls).toEqual([['f1', 'f2']]);
    expect(typed).toEqual([]);
    expect((await state.read(QUESTION_STATE, 'f1')).ok).toBe(true);
  });

  it('refuses a caller that is not a ferret id, and an id that is not usable', async () => {
    const { answering } = build(ferretsWith({ form: {} as never }));
    await expect(answering.answer('f1', { ...request, caller: '../x' })).rejects.toMatchObject({ status: 403 });
    await expect(answering.answer('', request)).rejects.toMatchObject({ failure: 'invalid' });
  });

  it('answers 503 when the seam is off and 404 for a ferret it does not know, before any receipt', async () => {
    const off = build(ferretsWith({}));
    await expect(off.answering.answer('f1', request)).rejects.toMatchObject({ status: 503 });
    const none = build(ferretsWith(undefined));
    await expect(none.answering.answer('f1', request)).rejects.toMatchObject({ failure: 'not_found' });
  });
});

/**
 * What goes wrong around a drive, through the real answer path (`buildQuestionAnswering`: service, coordinator, ledger,
 * bound pane, driver) over the real state port. The ONLY fake is the pane behind Ferrets' form seam: a scripted
 * `FormWorld` whose form redraws as keys land and which can be told to ignore Enter, to die, or to leave the form alone.
 */
const RULE = '─'.repeat(40);
const QUESTION = {
  format: 1,
  toolUseId: 't1',
  text: 'Deploy?',
  options: [{ label: 'Yes' }, { label: 'No' }, { label: 'Other' }],
  multiple: false,
  askedAt: '2026-11-07T08:59:00.000Z',
  transcript: '/transcripts/f1.jsonl',
} as const;

class FormWorld {
  readonly keys: FormKey[] = [];
  readonly results: string[] = [];
  /** `form`: the question is up; `ready`: back at a prompt; `elsewhere`: some other screen that is not a prompt. */
  mode: 'form' | 'ready' | 'elsewhere' = 'form';
  cursor = 0;
  captures = 0;
  /** Whether Enter on the form finishes it; `after` is the screen the finished form leaves. */
  enterTakes = true;
  after: 'ready' | 'elsewhere' = 'ready';
  escapeReleases = true;
  /** Runs inside each capture, with the 1-based number of the capture. */
  onCapture: (capture: number, world: FormWorld) => void | 'dead' = () => undefined;

  private frame() {
    const visible =
      this.mode === 'ready'
        ? '> '
        : this.mode === 'elsewhere'
          ? 'something else drew here'
          : [
              RULE,
              'Deploy?',
              '',
              ...['Yes', 'No', 'Other'].map(
                (row, index) => `${index === this.cursor ? '❯' : ' '} ${index + 1}. ${row}`,
              ),
              RULE,
              '  4. Chat about this',
            ].join('\n');
    return {
      alive: true,
      dead: false,
      promptReady: this.mode === 'ready',
      activeWork: false,
      visible,
      history: visible,
    };
  }

  ferrets(): Pick<FerretsApi, 'get' | 'harness'> {
    const form: HarnessForm = {
      capture: async () => {
        this.captures += 1;
        const verdict = this.onCapture(this.captures, this);
        return ok(verdict === 'dead' ? { ...this.frame(), alive: false, dead: true } : this.frame());
      },
      key: async key => {
        this.keys.push(key);
        if (key === 'Down') this.cursor += 1;
        if (key === 'Up') this.cursor -= 1;
        if (key === 'Enter' && this.enterTakes) this.mode = this.after;
        if (key === 'Escape' && this.escapeReleases) this.mode = 'ready';
        return ok(undefined);
      },
      paste: async () => ok(undefined),
    };
    return {
      get: async () => ({ id: 'f1', state: 'idle', harness: 'claude-code' }) as never,
      harness: async () =>
        ({
          form,
          transcript: { read: async () => [{ tools: { results: [...this.results] } }] },
        }) as unknown as FerretHarness,
    };
  }
}

function answerPath(
  world: FormWorld,
  over: Partial<Parameters<typeof buildQuestionAnswering>[0]> = {},
  ferrets: Pick<FerretsApi, 'get' | 'harness'> = world.ferrets(),
) {
  const state = memoryStatePort(CONVERSATION_STATE);
  const warnings: string[] = [];
  const info: string[] = [];
  const answering = buildQuestionAnswering({
    state,
    ferrets,
    questionLane: new KeyedSerialExecutor(),
    serial: new KeyedSerialExecutor(),
    clock: { now: () => '2026-11-07T09:00:00.000Z' as never },
    status: async () => 'awaiting_user',
    publishAnswered: async () => undefined,
    log: { info: event => void info.push(event), warn: message => void warnings.push(message) },
    sleep: async () => undefined,
    polls: 3,
    pollMs: 0,
    ...over,
  });
  return { answering, state, warnings, info };
}

const yes = { toolUseId: 't1', labels: ['Yes'], requestId: 'r1' };
const stored = async (state: ReturnType<typeof memoryStatePort>) => (await state.read(QUESTION_STATE, 'f1')).ok;
const questionOf = async (state: ReturnType<typeof memoryStatePort>) => {
  const read = await state.read(QUESTION_STATE, 'f1');
  return read.ok ? read.value?.toolUseId : 'unreadable';
};
const stampOf = async (state: ReturnType<typeof memoryStatePort>) => {
  const read = await state.read(QUESTION_ANSWERED_STATE, 'f1');
  return read.ok ? read.value?.toolUseId : 'unreadable';
};

describe('answering when something around the drive goes wrong', () => {
  it('answers, stamps and clears when the form takes the answer, and a failing event never undoes it', async () => {
    const world = new FormWorld();
    const { answering, state, warnings } = answerPath(world, {
      publishAnswered: async () => {
        throw new Error('event bus down');
      },
    });
    await state.write(QUESTION_STATE, QUESTION as never, 'f1');

    await answering.answer('f1', yes);

    expect(world.keys).toEqual(['Enter']);
    expect(await stampOf(state)).toBe('t1');
    expect(await questionOf(state)).toBeUndefined();
    expect(warnings).toEqual([
      expect.stringContaining('could not publish question-answered for f1: Error: event bus down'),
    ]);
  });

  it('takes a pane that moved on as answered once the transcript carries the result, and not before', async () => {
    const world = new FormWorld();
    world.after = 'elsewhere';
    world.results.push('t1');
    const { answering, state } = answerPath(world);
    await state.write(QUESTION_STATE, QUESTION as never, 'f1');

    await answering.answer('f1', yes);

    expect(await stampOf(state)).toBe('t1');
    expect(await questionOf(state)).toBeUndefined();

    const silent = new FormWorld();
    silent.after = 'elsewhere';
    const other = answerPath(silent);
    await other.state.write(QUESTION_STATE, QUESTION as never, 'f1');
    // Nothing proves the question over, and the pane is no longer a form to cancel: the answer stays unconfirmed.
    await expect(other.answering.answer('f1', yes)).rejects.toMatchObject({ failure: 'unconfirmed' });
    expect(await stampOf(other.state)).toBeUndefined();
    expect(await questionOf(other.state)).toBe('t1');
  });

  it('takes the watch’s own stamp for the question as proof that a pane which moved on has answered', async () => {
    const world = new FormWorld();
    world.after = 'elsewhere';
    const { answering, state } = answerPath(world);
    await state.write(QUESTION_STATE, QUESTION as never, 'f1');
    world.onCapture = (capture, w) => {
      // The watch stamps the question once the transcript names the call, while the driver is still confirming.
      if (w.mode === 'elsewhere' && capture > 2)
        void state.write(
          QUESTION_ANSWERED_STATE,
          { format: 1, toolUseId: 't1', answeredAt: '2026-11-07T09:00:00.000Z' } as never,
          'f1',
        );
    };

    await answering.answer('f1', yes);

    expect(world.keys).toEqual(['Enter']);
    expect(await stampOf(state)).toBe('t1');
  });

  it('releases a form whose Enter never took with one Escape, clears the question, and keeps refusing the same request', async () => {
    const world = new FormWorld();
    world.enterTakes = false;
    const { answering, state, info } = answerPath(world);
    await state.write(QUESTION_STATE, QUESTION as never, 'f1');

    await expect(answering.answer('f1', yes)).rejects.toMatchObject({ failure: 'released' });

    expect(world.keys).toEqual(['Enter', 'Escape']);
    expect(await questionOf(state)).toBeUndefined();
    expect(await stampOf(state)).toBeUndefined();
    expect(info).toContain('question.answer_failed');
    expect(info).toContain('question.answer_unconfirmed');

    // The receipt is the durable warning: the same request is not driven again.
    await expect(answering.answer('f1', yes)).rejects.toMatchObject({ failure: 'released' });
    expect(world.keys).toEqual(['Enter', 'Escape']);
  });

  it('types nothing into a pane that died after the first look, then releases the form', async () => {
    const world = new FormWorld();
    // Capture 1 is the driver's first look, 2 is the read that binds the first key.
    world.onCapture = capture => (capture === 2 ? 'dead' : undefined);
    const { answering, state } = answerPath(world);
    await state.write(QUESTION_STATE, QUESTION as never, 'f1');

    await expect(answering.answer('f1', yes)).rejects.toMatchObject({ failure: 'released' });

    expect(world.keys).toEqual(['Escape']);
    expect(await questionOf(state)).toBeUndefined();
  });

  it('types nothing when the question file stops being readable mid-drive, and keeps the question', async () => {
    const world = new FormWorld();
    const { answering, state } = answerPath(world);
    await state.write(QUESTION_STATE, QUESTION as never, 'f1');
    world.onCapture = capture => {
      if (capture === 1) state.folder.plant(QUESTION_STATE, '{ not json', 'f1');
    };

    await expect(answering.answer('f1', yes)).rejects.toMatchObject({ failure: 'unconfirmed' });

    expect(world.keys).toEqual([]);
    expect(await stored(state)).toBe(false);
  });

  it('refuses to answer when the question file is unreadable to begin with, before anything is typed', async () => {
    const world = new FormWorld();
    const { answering, state } = answerPath(world);
    state.folder.plant(QUESTION_STATE, '{ not json', 'f1');

    await expect(answering.answer('f1', yes)).rejects.toMatchObject({ failure: 'failed' });

    expect(world.keys).toEqual([]);
    expect(world.captures).toBe(0);
  });

  it('does not clear, and says so, when the question file turns unreadable after the form took the answer', async () => {
    const world = new FormWorld();
    const { answering, state } = answerPath(world);
    await state.write(QUESTION_STATE, QUESTION as never, 'f1');
    world.onCapture = (_capture, w) => {
      if (w.mode === 'ready') state.folder.plant(QUESTION_STATE, '{ not json', 'f1');
    };

    await expect(answering.answer('f1', yes)).rejects.toBeDefined();

    expect(world.keys).toEqual(['Enter']);
    expect(await stampOf(state)).toBeUndefined();
  });

  it('refuses a ferret whose terminal shutdown was not confirmed, and any finished one, naming why', async () => {
    const world = new FormWorld();
    for (const [status, words] of [
      ['kill_failed', /shutdown .* was not confirmed/u],
      ['completed', /is completed; a terminal session cannot accept/u],
    ] as const) {
      const { answering, state } = answerPath(world, { status: async () => status });
      await state.write(QUESTION_STATE, QUESTION as never, 'f1');

      await expect(answering.answer('f1', yes)).rejects.toMatchObject({
        failure: 'refused',
        message: expect.stringMatching(words),
      });
    }
    expect(world.keys).toEqual([]);
  });

  it('says the answer was confirmed but the ferret’s record is unreadable, once the answer is committed', async () => {
    const world = new FormWorld();
    const unknown = { ...world.ferrets(), get: async () => undefined };
    const { answering, state } = answerPath(world, {}, unknown);
    await state.write(QUESTION_STATE, QUESTION as never, 'f1');

    await expect(answering.answer('f1', yes)).rejects.toMatchObject({
      failure: 'failed',
      message: expect.stringContaining('answer was confirmed but its record is unreadable'),
    });

    expect(await stampOf(state)).toBe('t1');
  });

  it('turns an unexpected failure of the status port into a failed answer carrying its words', async () => {
    const world = new FormWorld();
    let reads = 0;
    const { answering, state } = answerPath(world, {
      status: async () => {
        reads += 1;
        // The first read is the service's own; the document the coordinator reads next is the one that blows up.
        if (reads > 1) throw new Error('status port down');
        return 'awaiting_user';
      },
    });
    await state.write(QUESTION_STATE, QUESTION as never, 'f1');

    await expect(answering.answer('f1', yes)).rejects.toMatchObject({ failure: 'failed', message: 'status port down' });
  });

  it('refuses a request id reused for a different answer, with the reload words only for a question-scoped id', async () => {
    const world = new FormWorld();
    const { answering, state } = answerPath(world);
    await state.write(QUESTION_STATE, QUESTION as never, 'f1');
    await answering.answer('f1', yes);

    await expect(answering.answer('f1', { ...yes, labels: ['No'] })).rejects.toMatchObject({
      failure: 'conflict',
      message: expect.stringContaining('A different answer was already sent for this question'),
    });

    // A question-scoped id is one the app minted for exactly this form: its conflict is a stale screen, so the remedy is a reload.
    const scopedWorld = new FormWorld();
    const scoped = answerPath(scopedWorld);
    await scoped.state.write(QUESTION_STATE, QUESTION as never, 'f1');
    const requestId = 'question:f1:t1:1';
    await scoped.answering.answer('f1', { toolUseId: 't1', labels: ['Yes'], requestId });
    await expect(scoped.answering.answer('f1', { toolUseId: 't1', labels: ['No'], requestId })).rejects.toMatchObject({
      failure: 'conflict',
      message: RELOAD_THE_APP,
    });
  });

  it('says a question is already answered when another request id asks for it again, and types nothing more', async () => {
    const world = new FormWorld();
    const { answering, state } = answerPath(world);
    await state.write(QUESTION_STATE, QUESTION as never, 'f1');
    await answering.answer('f1', yes);

    await expect(answering.answer('f1', { ...yes, requestId: 'r2' })).rejects.toMatchObject({
      failure: 'already_answered',
      answeredWith: expect.stringContaining('Yes'),
    });

    expect(world.keys).toEqual(['Enter']);
  });
});
