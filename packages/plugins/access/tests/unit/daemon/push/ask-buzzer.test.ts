import { describe, expect, test } from 'bun:test';
import type { BuzzableAsk, BuzzWords } from '@ferretry/core-asks/contract';
import type { StatePort } from '@ferretry/kernel/contract';
import { instantFromEpochMs } from '@ferretry/std';
import type { AskBuzzRecord } from '../../../../contract/index.ts';
import { ASK_BUZZ_LEDGER_CAP, StateAskBuzzLedger } from '../../../../daemon/adapters/push/state-ask-buzz-ledger.ts';
import { AskBuzzer, type AskBuzzLedger } from '../../../../daemon/lib/push/ask-buzz.ts';
import { PushService, type PushDelivery, type PushSubscriptionStore } from '../../../../daemon/lib/push/index.ts';
import { AT, deviceId, record } from './support.ts';

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
  async forget(key: string) {
    const at = this.records.findIndex(record => record.key === key);
    if (at >= 0) this.records.splice(at, 1);
  }
}

/** A promise opened from outside, so a test says exactly which await it holds and when it lets go. */
function latch() {
  let open!: () => void;
  const opened = new Promise<void>(resolve => (open = resolve));
  return { opened, open };
}

function buzzer(
  options: { ledger?: AskBuzzLedger; buzz?: (words: BuzzWords, cancelled: () => boolean) => Promise<number> } = {},
) {
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

  test('the moment is recorded BEFORE the push goes out: a crash in between loses the buzz, never doubles it', async () => {
    const ledger = new MemoryLedger();
    let recordedWhenSent = -1;
    const { made } = buzzer({
      ledger,
      buzz: async () => {
        recordedWhenSent = ledger.records.length;
        return 1;
      },
    });
    await made.buzz(card);
    expect(recordedWhenSent).toBe(1);
  });

  test('a closed ask drops its key, and an unknown one is nothing', async () => {
    const { made, ledger } = buzzer();
    await made.buzz(card);
    await made.settle('f1', 'A9');
    expect((ledger as MemoryLedger).records).toHaveLength(1);
    await made.settle('f1', 'A3');
    expect((ledger as MemoryLedger).records).toEqual([]);
  });

  test('an ask that settles while its lookup is in flight sends no push and keeps no key (E-242)', async () => {
    const records = new MemoryLedger();
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const slow: AskBuzzLedger = {
      has: async key => {
        await gate;
        return records.has(key);
      },
      append: record => records.append(record),
      forget: key => records.forget(key),
    };
    const { made, sent } = buzzer({ ledger: slow });
    const buzzing = made.buzz(card);
    const settling = made.settle('f1', 'A3');
    release();
    expect(await buzzing).toBe(false);
    await settling;
    expect(sent).toEqual([]);
    expect(records.records).toEqual([]);
  });

  test('an ask that settles while its push is going out keeps no key (E-242)', async () => {
    const ledger = new MemoryLedger();
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const entered = latch();
    const { made } = buzzer({
      ledger,
      buzz: async () => {
        entered.open();
        await gate;
        return 1;
      },
    });
    const buzzing = made.buzz(card);
    await entered.opened;
    const settling = made.settle('f1', 'A3');
    release();
    await Promise.all([buzzing, settling]);
    expect(ledger.records).toEqual([]);
  });

  describe('over the real PushService (E-242)', () => {
    /** The real service over one enrolled device; `granted` and `deliver` are the two awaits a test can hold. */
    function pushing(
      hold: { granted?: Promise<void>; deliver?: Promise<void> },
      signal: { granted: () => void; deliver: () => void },
    ) {
      const sends: PushDelivery[] = [];
      const store: PushSubscriptionStore = {
        list: async () => [record()],
        save: async () => undefined,
        forget: async () => 0,
      };
      const service = new PushService({
        store,
        transport: {
          deliver: async delivery => {
            signal.deliver();
            await hold.deliver;
            sends.push(delivery);
            return 'delivered';
          },
        },
        keys: { publicKey: async () => 'the-public-point' },
        devices: {
          granted: async () => {
            signal.granted();
            await hold.granted;
            return new Set([deviceId('a')]);
          },
        },
        clock: { now: () => AT },
        ids: { next: () => '22222222-2222-4222-8222-222222222222' },
      });
      const buzz = async (words: BuzzWords, cancelled: () => boolean) =>
        (
          await service.notify(
            {
              payload: {
                version: 1,
                eventKey: 'e1',
                title: words.title,
                body: words.body,
                tag: words.tag,
                url: words.url,
                count: 1,
                sessionId: 's1',
                kind: 'agenda',
              },
            },
            undefined,
            cancelled,
          )
        ).delivered;
      return { sends, buzz };
    }

    test("an ask that settles during the sender's enrolment lookup sends nothing and keeps no key", async () => {
      const lookup = latch();
      const entered = latch();
      const ledger = new MemoryLedger();
      const { sends, buzz } = pushing({ granted: lookup.opened }, { granted: entered.open, deliver: () => undefined });
      const { made } = buzzer({ ledger, buzz });
      const buzzing = made.buzz(card);
      await entered.opened; // the sender is inside its enrolment lookup: the ask is already recorded, nothing is sent
      const settling = made.settle('f1', 'A3');
      lookup.open();
      expect(await buzzing).toBe(false);
      await settling;
      expect(sends).toEqual([]);
      expect(ledger.records).toEqual([]);
    });

    test('an ask that settles right after dispatch still gets exactly one send, and its key goes', async () => {
      const dispatch = latch();
      const entered = latch();
      const ledger = new MemoryLedger();
      const { sends, buzz } = pushing(
        { deliver: dispatch.opened },
        { granted: () => undefined, deliver: entered.open },
      );
      const { made } = buzzer({ ledger, buzz });
      const buzzing = made.buzz(card);
      await entered.opened; // the transport has been called: the push is already on its way
      const settling = made.settle('f1', 'A3');
      dispatch.open();
      expect(await buzzing).toBe(true);
      await settling;
      expect(sends).toHaveLength(1);
      expect(ledger.records).toEqual([]);
    });
  });

  test('a settle that arrives before any buzz does not block a later ask of the same key', async () => {
    const { made, sent } = buzzer();
    await made.settle('f1', 'A3');
    expect(await made.buzz(card)).toBe(true);
    expect(sent).toHaveLength(1);
  });

  test('a ledger that cannot drop a key says so and does not throw', async () => {
    const { made, warned } = buzzer({
      ledger: {
        has: async () => false,
        append: async () => undefined,
        forget: async () => {
          throw new Error('disk full');
        },
      },
    });
    await made.settle('f1', 'A3');
    expect(warned).toEqual(["an ask's buzz record could not be dropped: disk full"]);
    const odd = buzzer({
      ledger: {
        has: async () => false,
        append: async () => undefined,
        forget: async () => {
          throw 'odd';
        },
      },
    });
    await odd.made.settle('f1', 'A3');
    expect(odd.warned).toEqual(["an ask's buzz record could not be dropped: odd"]);
  });

  test('a failing push or ledger is said and swallowed: buzzing is total, and a failed push is not retried (at most once)', async () => {
    const failing = buzzer({
      buzz: async () => {
        throw new Error('push service down');
      },
    });
    expect(await failing.made.buzz(card)).toBe(false);
    expect(failing.warned).toEqual(["an ask's buzz could not be made: push service down"]);
    expect((failing.ledger as MemoryLedger).records).toHaveLength(1);
    const unreadable = buzzer({
      ledger: {
        has: async () => {
          throw 'the ledger is damaged';
        },
        append: async () => undefined,
        forget: async () => undefined,
      },
    });
    expect(await unreadable.made.buzz(card)).toBe(false);
    expect(unreadable.warned).toEqual(["an ask's buzz could not be made: the ledger is damaged"]);
  });
});

describe('StateAskBuzzLedger', () => {
  /** A state port over an in-memory jsonl: `write` replaces the lines, `append` adds one; `log` says which was used. */
  function state(initial: readonly AskBuzzRecord[], onRead?: () => void) {
    let lines = [...initial];
    const log: string[] = [];
    const port = {
      lines: async function* () {
        onRead?.();
        for (const line of lines) yield line;
      },
      append: async (_file: unknown, record: AskBuzzRecord) => {
        log.push('append');
        lines.push(record);
      },
      write: async (_file: unknown, next: readonly AskBuzzRecord[]) => {
        log.push('write');
        lines = [...next];
      },
    } as unknown as StatePort;
    return { ledger: new StateAskBuzzLedger(port), log, file: () => lines.map(line => line.key) };
  }
  const line = (n: number): AskBuzzRecord => ({ format: 1, key: `ask:f1:A${n}`, at: NOW, kind: 'notice' });

  test('reads the file once, then answers from memory, and remembers what it appends', async () => {
    let reads = 0;
    const { ledger, log } = state([line(1)], () => (reads += 1));
    expect(await ledger.has('ask:f1:A1')).toBe(true);
    expect(await ledger.has('ask:f1:A2')).toBe(false);
    await ledger.append(line(2));
    expect(await ledger.has('ask:f1:A2')).toBe(true);
    expect(log).toEqual(['append']);
    expect(reads).toBe(1);
  });

  test('a damaged file refuses the lookup rather than reading as empty, and is read again next time', async () => {
    let fail = true;
    const ledger = new StateAskBuzzLedger({
      lines: async function* () {
        if (fail) throw new Error('damaged');
        yield line(1);
      },
    } as unknown as StatePort);
    await expect(ledger.has('ask:f1:A1')).rejects.toThrow('damaged');
    fail = false;
    expect(await ledger.has('ask:f1:A1')).toBe(true);
  });

  test('forgetting a key rewrites the file without it; a key it never had writes nothing', async () => {
    const { ledger, log, file } = state([line(1), line(2)]);
    await ledger.forget('ask:f1:A9');
    expect(log).toEqual([]);
    await ledger.forget('ask:f1:A1');
    expect(log).toEqual(['write']);
    expect(file()).toEqual(['ask:f1:A2']);
    expect(await ledger.has('ask:f1:A1')).toBe(false);
  });

  test('the file is capped: past the cap the OLDEST keys go and the newest stay, however the writes race', async () => {
    const full = Array.from({ length: ASK_BUZZ_LEDGER_CAP }, (_, n) => line(n));
    const { ledger, file } = state(full);
    await Promise.all([ledger.append(line(ASK_BUZZ_LEDGER_CAP)), ledger.append(line(ASK_BUZZ_LEDGER_CAP + 1))]);
    expect(file()).toHaveLength(ASK_BUZZ_LEDGER_CAP);
    expect(file()[0]).toBe('ask:f1:A2');
    expect(file().at(-1)).toBe(`ask:f1:A${ASK_BUZZ_LEDGER_CAP + 1}`);
    expect(await ledger.has('ask:f1:A0')).toBe(false);
    expect(await ledger.has('ask:f1:A2')).toBe(true);
  });

  test('a failed write is said to its caller and does not block the next one', async () => {
    let fail = true;
    const ledger = new StateAskBuzzLedger({
      lines: async function* () {},
      append: async () => {
        if (fail) throw new Error('disk full');
      },
    } as unknown as StatePort);
    await expect(ledger.append(line(1))).rejects.toThrow('disk full');
    fail = false;
    await ledger.append(line(2));
    expect(await ledger.has('ask:f1:A2')).toBe(true);
    expect(await ledger.has('ask:f1:A1')).toBe(false);
  });
});
