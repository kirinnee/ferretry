import { describe, expect, test } from 'bun:test';
import type { AskedQuestionFile } from '@ferretry/core-ferrets/contract';
import type { Question } from '../../../../contract/index.ts';
import { QuestionWatch, type QuestionWatchDeps } from '../../../../daemon/questions/lib/watch.ts';

/**
 * Finding 6 of the structured-questions review: the watch remembered a payload BEFORE its write landed, so one transient
 * state failure hid a still-open form (and its send guard) until a new hook payload or a restart.
 */

const payload = JSON.stringify({
  hook_event_name: 'PreToolUse',
  tool_name: 'AskUserQuestion',
  tool_use_id: 't1',
  transcript_path: '/t',
  tool_input: {
    questions: [
      {
        question: 'Q?',
        options: [
          { label: 'Yes', description: 'Proceed' },
          { label: 'No', description: 'Stop' },
        ],
        multiSelect: false,
      },
    ],
  },
});

const STORED = { toolUseId: 't1' } as Question;

function watchOf(overrides: Partial<QuestionWatchDeps>): QuestionWatch {
  return new QuestionWatch({
    roster: async () => [{ id: 'f1', harness: 'claude-code', state: 'working' }],
    harness: async () => ({
      askedQuestion: async () =>
        ({ payload, writtenAt: '2026-11-07T09:00:00.000Z', transcript: '/t' }) as AskedQuestionFile,
      transcript: { read: async () => [] },
    }),
    current: async () => undefined,
    lastAnswered: async () => undefined,
    write: async () => STORED,
    clear: async () => {},
    asked: async () => {},
    answered: async () => {},
    ...overrides,
  });
}

describe('a state write that fails does not hide the question', () => {
  test('a transient write failure is retried on the next tick', async () => {
    let writes = 0;
    const watch = watchOf({
      write: async () => {
        writes += 1;
        if (writes === 1) throw new Error('transient state IO');
        return STORED;
      },
    });
    await watch.sweep();
    await watch.sweep();
    expect(writes).toBe(2);
    await watch.sweep();
    expect(writes).toBe(2); // stored: no longer written
  });

  test('a store that keeps failing is retried a bounded number of looks, then left alone', async () => {
    let writes = 0;
    const watch = watchOf({
      write: async () => {
        writes += 1;
        throw new Error('the store is gone');
      },
    });
    for (let tick = 0; tick < 12; tick += 1) await watch.sweep();
    expect(writes).toBe(5);
  });

  test('a publish failure after the write never writes or announces the question a second time', async () => {
    let writes = 0;
    let announced = 0;
    const watch = watchOf({
      write: async () => {
        writes += 1;
        return STORED;
      },
      asked: async () => {
        announced += 1;
        throw new Error('the bus is down');
      },
    });
    await watch.sweep();
    await watch.sweep();
    expect(writes).toBe(1);
    expect(announced).toBe(1);
  });
});
