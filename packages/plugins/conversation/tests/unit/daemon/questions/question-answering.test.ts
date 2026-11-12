import { describe, expect, it } from 'bun:test';
import type { FerretHarness, FerretsApi, FormKey } from '@ferretry/core-ferrets/contract';
import { ApiError } from '@ferretry/kernel/contract';
import { err, ok } from '@ferretry/std';
import { harnessFormPane } from '../../../../daemon/questions/adapters/harness-form-pane.ts';
import { buildQuestionAnswering } from '../../../../daemon/questions/adapters/question-answering.ts';
import { KeyedSerialExecutor } from '../../../../daemon/seams/keyed-serial-executor.ts';
import { memoryStatePort } from '../../../support/state.ts';
import { CONVERSATION_STATE, QUESTION_STATE } from '../../../../contract/index.ts';

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
