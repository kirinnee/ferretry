import { describe, expect, test } from 'bun:test';
import { cardStack } from '../../src/lib/board-card-stack.ts';
import { chatCards } from '../../src/lib/board-chat.ts';
import { boardModelOf, card, laptop } from './board-support.ts';

const SELF = 's1';

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
  test('puts the cards to test first, then the plans to approve', async () => {
    const stack = await stackOf([
      card('F1', { owner: SELF, laneId: 'plan' }),
      card('F3', { owner: SELF, laneId: 'tested' }),
      card('F5', { owner: SELF, laneId: 'tested' }),
    ]);
    expect(stack.map(entry => [entry.card.task.id, entry.rank])).toEqual([
      ['F3', 'to-test'],
      ['F5', 'to-test'],
      ['F1', 'approve'],
    ]);
  });

  test('a card to test carries what the shared answer row needs', async () => {
    const [first] = await stackOf([card('F3', { owner: SELF, laneId: 'tested', howToTest: '1. Open it' })]);
    expect(first?.toTest?.doneLaneId).toBe('closed');
    expect(first?.toTest?.notGoodLaneId).toBe('implement');
    expect(first?.toTest?.howToTest).toBe('1. Open it');
  });

  test('a plan to approve is a row too: Approve moves it on, Send back to the lane before, the brief is the plan', async () => {
    const [first] = await stackOf([card('F1', { owner: SELF, laneId: 'plan', brief: 'Build it in two steps.' })]);
    expect(first?.toTest?.stage).toBe('approve');
    expect(first?.toTest?.howToTest).toBe('Build it in two steps.');
    expect(first?.toTest?.doneLaneId).toBe('implement');
    expect(first?.toTest?.notGoodLaneId).toBe('todo');
  });

  test('a snoozed plan leaves the stack until its time is up', async () => {
    const snoozed = card('F1', {
      owner: SELF,
      laneId: 'plan',
      snoozed: { until: '2026-08-02T15:00:00.000Z', laneId: 'plan' },
    });
    expect(await stackOf([snoozed])).toEqual([]);
    expect((await stackOf([snoozed], Date.parse('2026-08-02T15:00:00.000Z'))).map(entry => entry.rank)).toEqual([
      'approve',
    ]);
  });

  test('a card that is not in a gate lane is never in the stack', async () => {
    const stack = await stackOf([
      card('F1', { owner: SELF, laneId: 'todo' }),
      card('F2', { owner: SELF, laneId: 'implement' }),
      card('F3', { owner: SELF, laneId: 'implement', activity: 'waiting' }),
      card('F4', { owner: SELF, laneId: 'review' }),
      card('F5', { owner: SELF, laneId: 'merged' }),
      card('F6', { owner: SELF, laneId: 'released' }),
      card('F7', { owner: SELF, laneId: 'closed' }),
    ]);
    expect(stack).toEqual([]);
  });

  test('a dropped card in a gate lane is not offered', async () => {
    const dropped = { at: '2026-08-01T10:00:00.000Z', reason: 'no' };
    const stack = await stackOf([
      card('F1', { owner: SELF, laneId: 'tested', dropped }),
      card('F2', { owner: SELF, laneId: 'plan', dropped }),
    ]);
    expect(stack).toEqual([]);
  });

  test('a card an agent made is never offered, in a verify lane or a plan gate', async () => {
    const stack = await stackOf([
      card('F1', { owner: SELF, laneId: 'tested', askedBy: 'agent' }),
      card('F2', { owner: SELF, laneId: 'plan', askedBy: 'agent' }),
    ]);
    expect(stack).toEqual([]);
  });

  test('a snoozed card to test leaves the stack until its time is up', async () => {
    const snoozed = card('F1', {
      owner: SELF,
      laneId: 'tested',
      snoozed: { until: '2026-08-02T15:00:00.000Z', laneId: 'tested' },
    });
    expect(await stackOf([snoozed])).toEqual([]);
    const awake = await stackOf([snoozed], Date.parse('2026-08-02T15:00:00.000Z'));
    expect(awake.map(entry => entry.rank)).toEqual(['to-test']);
  });

  test('is empty when the ferret has no cards', async () => {
    expect(await stackOf([])).toEqual([]);
  });
});
