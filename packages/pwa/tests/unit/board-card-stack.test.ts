import { describe, expect, test } from 'bun:test';
import { cardStack } from '../../src/lib/board-card-stack.ts';
import { chatCards } from '../../src/lib/board-chat.ts';
import { boardModelOf, card, laptop } from './board-support.ts';

const SELF = 's1';
const ASK = { sessionId: 's1', id: 'A1' };

const NOW = Date.parse('2026-08-02T12:00:00.000Z');

const stackOf = async (extra: readonly ReturnType<typeof card>[], now = NOW) => {
  const model = await boardModelOf(extra);
  return cardStack(
    chatCards(model, {
      daemonId: laptop.daemonId,
      sessionId: SELF,
      focus: null,
      relatives: new Set(),
      agents: false,
    }),
    now,
  );
};

describe('cardStack', () => {
  test('puts the cards to test first, then the ones waiting on the owner, then the rest', async () => {
    const stack = await stackOf([
      card('F1', { owner: SELF, laneId: 'implement' }),
      card('F2', { owner: SELF, laneId: 'implement', activity: 'waiting', waitingOnOwner: [ASK], openAsks: [ASK] }),
      card('F3', { owner: SELF, laneId: 'tested' }),
      card('F4', { owner: SELF, laneId: 'review' }),
      card('F5', { owner: SELF, laneId: 'tested' }),
    ]);
    expect(stack.map(entry => [entry.card.task.id, entry.rank])).toEqual([
      ['F3', 'to-test'],
      ['F5', 'to-test'],
      ['F2', 'waiting'],
      ['F1', 'rest'],
      ['F4', 'rest'],
    ]);
  });

  test('a card to test carries what the shared answer row needs', async () => {
    const [first] = await stackOf([card('F3', { owner: SELF, laneId: 'tested', howToTest: '1. Open it' })]);
    expect(first?.toTest?.doneLaneId).toBe('closed');
    expect(first?.toTest?.notGoodLaneId).toBe('implement');
    expect(first?.toTest?.howToTest).toBe('1. Open it');
  });

  test('a card waiting on a non-blocking ask is not "waiting on you"', async () => {
    const stack = await stackOf([card('F1', { owner: SELF, laneId: 'implement', activity: 'waiting' })]);
    expect(stack.map(entry => entry.rank)).toEqual(['rest']);
  });

  test('a dropped card in a verify lane is not offered for a verdict', async () => {
    const stack = await stackOf([
      card('F1', { owner: SELF, laneId: 'tested', dropped: { at: '2026-08-01T10:00:00.000Z', reason: 'no' } }),
    ]);
    expect(stack.map(entry => entry.rank)).toEqual(['rest']);
    expect(stack[0]?.toTest).toBeNull();
  });

  test('a card an agent made is not offered for a verdict: it stays in the rest', async () => {
    const stack = await stackOf([card('F1', { owner: SELF, laneId: 'tested', askedBy: 'agent' })]);
    expect(stack.map(entry => [entry.rank, entry.toTest])).toEqual([['rest', null]]);
  });

  test('a snoozed card to test drops to the rest until its time is up', async () => {
    const snoozed = card('F1', {
      owner: SELF,
      laneId: 'tested',
      snoozed: { until: '2026-08-02T15:00:00.000Z', laneId: 'tested' },
    });
    const asleep = await stackOf([snoozed]);
    expect(asleep.map(entry => [entry.rank, entry.toTest])).toEqual([['rest', null]]);
    const awake = await stackOf([snoozed], Date.parse('2026-08-02T15:00:00.000Z'));
    expect(awake.map(entry => entry.rank)).toEqual(['to-test']);
  });

  test('is empty when the ferret has no cards', async () => {
    expect(await stackOf([])).toEqual([]);
  });
});
