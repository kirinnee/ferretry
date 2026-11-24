import { describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { CreateConfigSchema } from '../../contract/index.ts';
import { approvalFor, dayOf, judgeSpend, requestDigest } from '../../daemon/lib/spend.ts';

const config = { ...CreateConfigSchema.parse({}), timeZone: 'UTC' };
const facts = (spentToday: number) => ({ spentToday, earlierSpends: 0 });

describe('judgeSpend: the day’s cap is a wall, the one-call limit is a question', () => {
  test('a call under the limit goes', () => {
    expect(judgeSpend(30_000, facts(0), config)).toEqual({ kind: 'go' });
  });
  test('exactly $1 goes; a cent over asks', () => {
    expect(judgeSpend(1_000_000, facts(0), config)).toEqual({ kind: 'go' });
    expect(judgeSpend(1_010_000, facts(0), config)).toEqual({ kind: 'ask', threshold: 1_000_000 });
  });
  test('a call that would pass $5 for the day is refused, and it is refused before it is asked', () => {
    const verdict = judgeSpend(1_200_000, facts(4_000_000), config);
    expect(verdict.kind).toBe('refuse');
    expect(verdict.kind === 'refuse' && verdict.sentence).toContain('$5.00');
  });
  test('exactly reaching $5 is allowed', () => {
    expect(judgeSpend(1_000_000, facts(4_000_000), config).kind).toBe('go');
  });
});

describe('dayOf is the owner’s day', () => {
  test('the same instant is two days in two zones', () => {
    const at = new Date('2026-11-24T03:00:00Z');
    expect(dayOf(at, 'UTC')).toBe('2026-11-24');
    expect(dayOf(at, 'America/Los_Angeles')).toBe('2026-11-23');
  });
});

describe('requestDigest', () => {
  test('is the same for the same words, and differs by model, size and words', () => {
    const base = { prompt: 'a fox', model: 'flux-dev', size: 'square' } as const;
    expect(requestDigest(base)).toBe(requestDigest({ ...base }));
    expect(requestDigest(base)).toMatch(/^[0-9a-f]{16}$/u);
    expect(requestDigest({ ...base, model: 'flux-pro' })).not.toBe(requestDigest(base));
    expect(requestDigest({ ...base, size: 'square_hd' })).not.toBe(requestDigest(base));
    expect(requestDigest({ ...base, prompt: 'a cat' })).not.toBe(requestDigest(base));
  });
});

describe('approvalFor goes through Asks, and only the owner’s answer approves', () => {
  const details = {
    ferret: 'f1',
    request: 'abcdef0123456789',
    earlierSpends: 0,
    cost: 1_200_000,
    model: 'flux-pro',
    threshold: 1_000_000,
    prompt: 'a fox',
  };
  test('the first ask waits; asking again finds the same ask; approve approves; the next time asks again', async () => {
    const asks = new FakeAsks();
    const first = await approvalFor(asks, details);
    expect(first.kind).toBe('waiting');
    expect(await approvalFor(asks, details)).toEqual(first);
    const [open] = await asks.open({});
    expect(open).toMatchObject({ source: 'create-spend', kind: 'permission', ferret: 'f1', blocking: true });
    expect(open?.subject).toContain('$1.20');
    asks.answerAs({ ferret: 'f1', id: open!.id }, 'approve');
    expect(await approvalFor(asks, details)).toEqual({ kind: 'approved' });
    // a paid-for request is a NEW question the next time: the entry carries how many times it was spent
    expect((await approvalFor(asks, { ...details, earlierSpends: 1 })).kind).toBe('waiting');
  });
  test('an approval holds up to the price it was asked at: a higher price asks again, an equal or lower one does not', async () => {
    const asks = new FakeAsks();
    await approvalFor(asks, details);
    const [open] = await asks.open({});
    // the price is part of the entry the ask is keyed by
    expect(String(open?.entry)).toBe('abcdef0123456789-0-1200000');
    asks.answerAs({ ferret: 'f1', id: open!.id }, 'approve');
    expect(await approvalFor(asks, { ...details, cost: 1_100_000 })).toEqual({ kind: 'approved' });
    const dearer = await approvalFor(asks, { ...details, cost: 1_300_000 });
    expect(dearer.kind).toBe('waiting');
    expect(await asks.open({})).toHaveLength(1);
    expect(String((await asks.open({}))[0]?.entry)).toBe('abcdef0123456789-0-1300000');
  });
  test('reject declines, and so does a dismissal', async () => {
    const asks = new FakeAsks();
    await approvalFor(asks, details);
    const [open] = await asks.open({});
    asks.answerAs({ ferret: 'f1', id: open!.id }, 'reject');
    expect(await approvalFor(asks, details)).toEqual({ kind: 'declined' });
  });
  test('an agenda that cannot take the ask means nothing is sent', async () => {
    const broken = {
      raise: async () => {
        throw new Error('the board is full');
      },
      answers: async () => [],
    };
    const result = await approvalFor(broken, details);
    expect(result.kind).toBe('unavailable');
  });
});
