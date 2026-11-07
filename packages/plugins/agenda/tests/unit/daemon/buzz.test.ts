import { describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import type { AskSummary } from '@ferretry/core-asks/contract';
import { instantFromEpochMs } from '@ferretry/std';
import type { BuzzRecord } from '../../../contract/index.ts';
import type { AccessBuzzApi } from '../../../contract/others.ts';
import {
  askBuzzKey,
  askBuzzKind,
  askBuzzWords,
  type BuzzableAsk,
  stopBuzzKey,
  stopBuzzWords,
  waitingOnOwner,
} from '../../../daemon/lib/buzz-policy.ts';
import { type BuzzLedger, BuzzService } from '../../../daemon/lib/buzz-service.ts';
import { raiseAsk } from './support.ts';

class MemoryLedger implements BuzzLedger {
  readonly records: BuzzRecord[] = [];
  async has(key: string) {
    return this.records.some(record => record.key === key);
  }
  async append(record: BuzzRecord) {
    this.records.push(record);
  }
  async forFerret(ferret: string) {
    return this.records.filter(record => record.ferret === ferret);
  }
}

const WORDS = { tag: 'agenda-f1:A1', title: 'f1 is stopped · 1 needs you', body: 'Do it', url: '/agenda/f1/A1' };

function world(options: { reaches?: number; access?: boolean; ledger?: MemoryLedger } = {}) {
  const sent: Array<Parameters<AccessBuzzApi['buzz']>[0]> = [];
  const warned: string[] = [];
  const buzzed: string[] = [];
  const ledger = options.ledger ?? new MemoryLedger();
  const access: AccessBuzzApi = {
    buzz: async message => {
      sent.push(message);
      if (options.reaches === -1) throw new Error('push refused');
      return options.reaches ?? 2;
    },
  };
  const service = new BuzzService({
    ledger,
    access: () => (options.access === false ? undefined : access),
    now: () => instantFromEpochMs(1_794_052_800_000),
    buzzed: key => buzzed.push(key),
    warn: message => warned.push(message),
  });
  return { service, sent, warned, buzzed, ledger };
}

describe('BuzzService', () => {
  test('buzzes a moment once, and records who it reached', async () => {
    const { service, sent, ledger } = world({ reaches: 2 });
    expect(await service.buzz('stop:f1:t1', 'stopped', WORDS, { ferret: 'f1' })).toBe(true);
    expect(await service.buzz('stop:f1:t1', 'stopped', WORDS, { ferret: 'f1' })).toBe(false);
    expect(sent).toHaveLength(1);
    expect(ledger.records).toHaveLength(1);
    expect(ledger.records[0]).toMatchObject({
      format: 1,
      key: 'stop:f1:t1',
      kind: 'stopped',
      enrolled: 2,
      ferret: 'f1',
    });
  });

  test('never buzzes a moment twice after a restart: the ledger remembers', async () => {
    const first = world();
    await first.service.buzz('ask:f1:A1', 'notice', WORDS, { ferret: 'f1', ask: 'A1' });
    const second = world({ ledger: first.ledger });
    expect(await second.service.buzz('ask:f1:A1', 'notice', WORDS)).toBe(false);
    expect(second.sent).toHaveLength(0);
  });

  test('two callers racing on one key buzz once', async () => {
    const { service, sent } = world();
    const results = await Promise.all([service.buzz('k', 'notice', WORDS), service.buzz('k', 'notice', WORDS)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  test('with no Access nothing is sent and nothing is recorded, so the moment can still buzz later', async () => {
    const off = world({ access: false });
    expect(await off.service.buzz('k', 'notice', WORDS)).toBe(false);
    expect(off.ledger.records).toHaveLength(0);
  });

  test('a push that reaches nobody is recorded and says false', async () => {
    const { service, ledger } = world({ reaches: 0 });
    expect(await service.buzz('k', 'notice', WORDS)).toBe(false);
    expect(ledger.records[0]?.enrolled).toBe(0);
  });

  test('a failing push is said and swallowed: buzzing is total', async () => {
    const { service, warned, ledger } = world({ reaches: -1 });
    expect(await service.buzz('k', 'notice', WORDS)).toBe(false);
    expect(warned[0]).toMatch(/push refused/u);
    expect(ledger.records).toHaveLength(0);
  });

  test('says each buzz that went out, by key, with no words', async () => {
    const { service, buzzed } = world();
    await service.buzz('k1', 'deadline', WORDS);
    expect(buzzed).toEqual(['k1']);
  });
});

describe('buzz policy', () => {
  test('only a blocking notice or a card’s ask buzzes on its own; everything else waits for the stop', async () => {
    const asks = new FakeAsks();
    const plain = await raiseAsk(asks, 'f1', 'e1');
    const notice = await raiseAsk(asks, 'f1', 'e2', { kind: 'notice' });
    const card = await raiseAsk(asks, 'f1', 'e3', { source: 'card' });
    const get = async (ref: typeof plain) => (await asks.get(ref)) as AskSummary;
    expect(askBuzzKind(await get(plain))).toBeUndefined();
    expect(askBuzzKind(await get(notice))).toBeUndefined();
    expect(askBuzzKind({ ...(await get(notice)), blocking: true } as BuzzableAsk)).toBe('notice');
    expect(askBuzzKind(await get(card))).toBe('card-ask');
  });

  test('the stop waits on tasks, not notices or cards, blocking first, then oldest', async () => {
    const asks = new FakeAsks();
    await raiseAsk(asks, 'f1', 'e1', { subject: 'older' });
    await raiseAsk(asks, 'f1', 'e2', { kind: 'notice' });
    await raiseAsk(asks, 'f1', 'e3', { source: 'card' });
    const open = (await asks.open({ ferret: 'f1' as never })) as BuzzableAsk[];
    expect(waitingOnOwner(open).map(ask => ask.subject)).toEqual(['older']);
    const blocking = open.map(ask => (ask.subject === 'older' ? ask : { ...ask, blocking: true }));
    const two = [
      ...blocking.filter(ask => ask.kind === 'task'),
      { ...open[0], id: 'A9', blocking: true } as BuzzableAsk,
    ];
    expect(waitingOnOwner(two)[0]?.id).toBe('A9');
  });

  test('words an ask’s buzz by its subject and opens it', () => {
    const words = askBuzzWords({ id: 'A3', subject: 'Badge colour is at Released', ferret: 'f1' } as BuzzableAsk);
    expect(words).toEqual({
      tag: 'agenda-f1:A3',
      title: 'Badge colour is at Released',
      body: 'Badge colour is at Released',
      url: '/agenda/f1/A3',
    });
  });

  test('words a stop with the count in the title and opens the first ask', () => {
    const first = { id: 'A1', subject: 'Approve the plan' } as BuzzableAsk;
    const second = { id: 'A2', subject: 'Pick a colour' } as BuzzableAsk;
    expect(stopBuzzWords('f1', 'build-bot', [first, second])).toEqual({
      tag: 'agenda-f1',
      title: 'build-bot is stopped · 2 need you',
      body: 'Approve the plan',
      url: '/agenda/f1/A1',
    });
    expect(stopBuzzWords('f1', 'x'.repeat(60), [first]).title).toMatch(/is stopped · 1 needs you$/u);
  });

  test('keys an ask by ferret and id, and a stop by the instant it began', () => {
    expect(askBuzzKey('f1', 'A3')).toBe('ask:f1:A3');
    expect(stopBuzzKey('f1', '2026-11-07T10:00:00.000Z')).toBe('stop:f1:2026-11-07T10:00:00.000Z');
  });
});
