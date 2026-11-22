import { describe, expect, test } from 'bun:test';
import type { BuzzableAsk, BuzzWords } from '@ferretry/core-asks/contract';
import type { StatePort } from '@ferretry/kernel/contract';
import { instantFromEpochMs } from '@ferretry/std';
import type { AskBuzzRecord } from '../../../../contract/index.ts';
import { StateAskBuzzLedger } from '../../../../daemon/adapters/push/state-ask-buzz-ledger.ts';
import { AskBuzzer, type AskBuzzLedger } from '../../../../daemon/lib/push/ask-buzz.ts';

const NOW = instantFromEpochMs(Date.parse('2026-11-22T09:00:00.000Z'));
const card = {
  id: 'A3',
  subject: 'Badge colour',
  ferret: 'f1',
  state: 'open',
  source: 'card',
  kind: 'task',
} as BuzzableAsk;

class MemoryLedger implements AskBuzzLedger {
  readonly records: AskBuzzRecord[] = [];
  async has(key: string) {
    return this.records.some(record => record.key === key);
  }
  async append(record: AskBuzzRecord) {
    this.records.push(record);
  }
}

function buzzer(options: { ledger?: AskBuzzLedger; buzz?: (words: BuzzWords) => Promise<number> } = {}) {
  const sent: BuzzWords[] = [];
  const warned: string[] = [];
  const ledger = options.ledger ?? new MemoryLedger();
  const made = new AskBuzzer({
    ledger,
    buzz:
      options.buzz ??
      (async words => {
        sent.push(words);
        return 1;
      }),
    now: () => NOW,
    warn: message => warned.push(message),
  });
  return { made, sent, warned, ledger };
}

describe('AskBuzzer', () => {
  test('buzzes a moment once and records it, and says whether a device was reached', async () => {
    const { made, sent, ledger } = buzzer();
    expect(await made.buzz(card)).toBe(true);
    expect(await made.buzz(card)).toBe(false);
    expect(sent).toEqual([
      { tag: 'agenda-f1:A3', title: 'Badge colour', body: 'Badge colour', url: '/ferrets/f1/chat?ask=A3' },
    ]);
    expect((ledger as MemoryLedger).records).toEqual([{ format: 1, key: 'ask:f1:A3', at: NOW, kind: 'card-ask' }]);
  });

  test('a push that reaches nobody is still recorded, and says false', async () => {
    const { made, ledger } = buzzer({ buzz: async () => 0 });
    expect(await made.buzz(card)).toBe(false);
    expect((ledger as MemoryLedger).records).toHaveLength(1);
  });

  test('two callers racing on one ask buzz once', async () => {
    const { made, sent } = buzzer();
    const results = await Promise.all([made.buzz(card), made.buzz(card)]);
    expect(results.sort()).toEqual([false, true]);
    expect(sent).toHaveLength(1);
  });

  test('an ask that is no buzzing moment, or has no ferret, sends nothing', async () => {
    const { made, sent } = buzzer();
    expect(await made.buzz({ ...card, source: 'ferret' } as BuzzableAsk)).toBe(false);
    expect(await made.buzz({ ...card, ferret: undefined } as BuzzableAsk)).toBe(false);
    expect(sent).toEqual([]);
  });

  test('a failing push or ledger is said and swallowed: buzzing is total, and the moment can buzz later', async () => {
    const failing = buzzer({
      buzz: async () => {
        throw new Error('push service down');
      },
    });
    expect(await failing.made.buzz(card)).toBe(false);
    expect(failing.warned).toEqual(["an ask's buzz could not be made: push service down"]);
    expect((failing.ledger as MemoryLedger).records).toEqual([]);
    const unreadable = buzzer({
      ledger: {
        has: async () => {
          throw 'the ledger is damaged';
        },
        append: async () => undefined,
      },
    });
    expect(await unreadable.made.buzz(card)).toBe(false);
    expect(unreadable.warned).toEqual(["an ask's buzz could not be made: the ledger is damaged"]);
  });
});

describe('StateAskBuzzLedger', () => {
  function state(lines: () => AsyncIterable<AskBuzzRecord>) {
    const appended: AskBuzzRecord[] = [];
    const port = {
      lines,
      append: async (_file: unknown, record: AskBuzzRecord) => void appended.push(record),
    } as unknown as StatePort;
    return { ledger: new StateAskBuzzLedger(port), appended };
  }

  test('reads the file once, then answers from memory, and remembers what it appends', async () => {
    let reads = 0;
    const { ledger, appended } = state(async function* () {
      reads += 1;
      yield { format: 1, key: 'ask:f1:A1', at: NOW, kind: 'notice' };
    });
    expect(await ledger.has('ask:f1:A1')).toBe(true);
    expect(await ledger.has('ask:f1:A2')).toBe(false);
    await ledger.append({ format: 1, key: 'ask:f1:A2', at: NOW, kind: 'card-ask' });
    expect(await ledger.has('ask:f1:A2')).toBe(true);
    expect(appended).toHaveLength(1);
    expect(reads).toBe(1);
  });

  test('a damaged file refuses the lookup rather than reading as empty, and is read again next time', async () => {
    let fail = true;
    const { ledger } = state(async function* () {
      if (fail) throw new Error('damaged');
      yield { format: 1, key: 'ask:f1:A1', at: NOW, kind: 'notice' };
    });
    await expect(ledger.has('ask:f1:A1')).rejects.toThrow('damaged');
    fail = false;
    expect(await ledger.has('ask:f1:A1')).toBe(true);
  });
});
