import { describe, expect, test } from 'bun:test';
import { releaseWords, toTestCards, toTestKey } from '../../src/lib/to-test-inbox.ts';
import { boardModelOf, card } from './board-support.ts';

const shipped = (version: string, at: string) => ({ version, tag: `v${version}`, at });

describe('toTestCards', () => {
  test('takes the cards waiting in a verify lane, with the lanes Done and Not good go to', async () => {
    const model = await boardModelOf([
      card('F1', {
        laneId: 'tested',
        shippedIn: shipped('1.2.0', '2026-08-01T09:00:00.000Z'),
        howToTest: '1. Open it',
      }),
      card('F2', { laneId: 'implement' }),
      card('F3', { laneId: 'closed' }),
    ]);
    const rows = toTestCards(model);
    expect(rows.map(row => row.card.task.id)).toEqual(['F1']);
    expect(rows[0]?.doneLaneId).toBe('closed');
    expect(rows[0]?.notGoodLaneId).toBe('implement');
    expect(rows[0]?.howToTest).toBe('1. Open it');
    expect(rows[0]?.key).toBe(rows[0] === undefined ? undefined : toTestKey(rows[0].card));
  });

  test('puts the most recently released first, and a card with no release after those that have one', async () => {
    const model = await boardModelOf([
      card('F1', { laneId: 'tested', shippedIn: shipped('1.0.0', '2026-08-01T09:00:00.000Z') }),
      card('F2', { laneId: 'tested', shippedIn: shipped('1.1.0', '2026-08-02T09:00:00.000Z') }),
      card('F3', { laneId: 'tested' }),
    ]);
    expect(toTestCards(model).map(row => row.card.task.id)).toEqual(['F2', 'F1', 'F3']);
  });

  test('leaves out a dropped card: there is nothing to decide on it', async () => {
    const model = await boardModelOf([
      card('F1', {
        laneId: 'tested',
        dropped: { at: '2026-08-01T10:00:00.000Z', reason: 'not needed' },
      }),
    ]);
    expect(toTestCards(model)).toEqual([]);
  });

  test('is empty for a board with nothing to test', async () => {
    expect(toTestCards(await boardModelOf([card('F1')]))).toEqual([]);
  });
});

describe('releaseWords', () => {
  test('names the release a card shipped in', () => {
    expect(releaseWords(shipped('1.2.0', '2026-08-01T09:00:00.000Z'))).toBe('Shipped in v1.2.0');
  });

  test('says nothing for a card that has not shipped', () => {
    expect(releaseWords(null)).toBeNull();
  });
});
