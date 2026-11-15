import { describe, expect, test } from 'bun:test';
import { AskRefusedError, type AskDraft, type AskRef } from '@ferretry/core-asks/contract';
import type { Instant } from '@ferretry/std';
import type { Question } from '../../../contract/index.ts';
import { QuestionAsks, type QuestionAsksPort } from '../../../daemon/questions/adapters/question-asks.ts';

const question = (toolUseId: string): Question => ({
  format: 1,
  toolUseId,
  text: 'Which mode?',
  options: [{ label: 'Fast' }, { label: 'Slow' }],
  multiple: false,
  askedAt: '2026-11-14T01:00:00.000Z' as Instant,
});

/** The Asks port as far as a raise goes: what each raise was keyed by. */
function raised() {
  const entries: string[] = [];
  const port: QuestionAsksPort = {
    raise: async (draft: AskDraft) => {
      entries.push(draft.entry);
      return { ferret: draft.ferret ?? '', id: 'A1' } as AskRef;
    },
    open: async () => [],
    close: async () => {},
  };
  return { entries, asks: new QuestionAsks(port) };
}

describe('the entry a question is kept under on the Agenda', () => {
  test('is the ferret and the call id together when Asks takes them as written', async () => {
    const { asks, entries } = raised();

    await asks.raise('lead', question('call_1'));

    expect(entries).toEqual(['lead:call_1']);
  });

  test('is a digest of both when the call id is not a spelling Asks takes, the same one every time and another ferret’s own', async () => {
    const { asks, entries } = raised();

    await asks.raise('lead', question('call 1/with a space'));
    await asks.raise('lead', question('call 1/with a space'));
    await asks.raise('other', question('call 1/with a space'));

    expect(entries[0]).toMatch(/^q:[0-9a-f]{40}$/u);
    expect(entries[1]).toBe(entries[0]!);
    expect(entries[2]).not.toBe(entries[0]!);
  });
});

/** An Asks port whose raise is steered by the test: each call takes the next step, and can be held until released. */
function steered(steps: ((draft: AskDraft) => Promise<AskRef>)[]) {
  const attempts: string[] = [];
  const closed: string[] = [];
  const port: QuestionAsksPort = {
    raise: async (draft: AskDraft) => {
      attempts.push(draft.entry);
      const step = steps.shift();
      if (step === undefined) return { ferret: draft.ferret ?? '', id: 'A1' } as AskRef;
      return step(draft);
    },
    open: async () => [],
    close: async (_ref, _reason, entry) => {
      closed.push(String(entry));
    },
  };
  return { attempts, closed, port };
}

const refuseFull = async (): Promise<AskRef> => {
  throw new AskRefusedError('the board is full', 'full');
};

describe('a question the board refuses when nobody is listening', () => {
  test('is dropped quietly when the question is wrong in itself, and not asked again', async () => {
    const { port, attempts } = steered([
      async () => {
        throw new AskRefusedError('not a card', 'invalid');
      },
    ]);
    const asks = new QuestionAsks(port);

    await asks.raise('lead', question('call_1'));
    await asks.settle();
    await asks.retryWaiting();

    expect(attempts).toEqual(['lead:call_1']);
  });

  test('waits quietly when the board is full, and is asked again once the board changes', async () => {
    const { port, attempts } = steered([refuseFull]);
    const asks = new QuestionAsks(port);

    await asks.raise('lead', question('call_1'));
    await asks.settle();
    expect(attempts).toEqual(['lead:call_1']);

    await asks.retryWaiting();
    expect(attempts).toEqual(['lead:call_1', 'lead:call_1']);
  });
});

describe('asking again what the board refused for now', () => {
  test('does not ask again a question that was closed while the others were being asked', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const { port, attempts, closed } = steered([
      refuseFull,
      refuseFull,
      async draft => {
        await held;
        return { ferret: draft.ferret ?? '', id: 'A1' } as AskRef;
      },
    ]);
    const asks = new QuestionAsks(port);
    await asks.raise('lead', question('call_1'));
    await asks.raise('lead', question('call_2'));
    expect(attempts).toEqual(['lead:call_1', 'lead:call_2']);

    const retrying = asks.retryWaiting();
    await Promise.resolve();
    await asks.close('lead', 'call_2', 'answered');
    release();
    await retrying;

    expect(attempts).toEqual(['lead:call_1', 'lead:call_2', 'lead:call_1']);
    expect(closed).toEqual([]);
    await asks.retryWaiting();
    expect(attempts).toEqual(['lead:call_1', 'lead:call_2', 'lead:call_1']);
  });

  test('keeps a question owed when Asks cannot be reached on the retry, and asks again on the next look', async () => {
    const { port, attempts } = steered([
      refuseFull,
      async () => {
        throw new Error('asks is down');
      },
    ]);
    const asks = new QuestionAsks(port);
    await asks.raise('lead', question('call_1'));

    await asks.retryWaiting();
    expect(attempts).toEqual(['lead:call_1', 'lead:call_1']);

    await asks.settle();
    expect(attempts).toEqual(['lead:call_1', 'lead:call_1', 'lead:call_1']);
  });
});
