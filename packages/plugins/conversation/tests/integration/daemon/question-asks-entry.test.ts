import { describe, expect, test } from 'bun:test';
import type { AskDraft, AskRef } from '@ferretry/core-asks/contract';
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
