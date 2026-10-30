import { describe, expect, it } from 'bun:test';
import {
  boardBadgeCount,
  keyStep,
  phoneLanes,
  SWIPE_DISTANCE,
  shownLane,
  stepLane,
  swipeStep,
  UNPLACED_LANE,
} from '../../src/lib/board-phone.ts';
import { boardModelOf, card } from './board-support.ts';

describe('swipeStep', () => {
  it('goes to the next lane on a swipe left and the previous on a swipe right', () => {
    expect(swipeStep(-SWIPE_DISTANCE, 0)).toBe(1);
    expect(swipeStep(SWIPE_DISTANCE, 0)).toBe(-1);
    expect(swipeStep(-200, 30)).toBe(1);
  });

  it('ignores a drag shorter than the threshold', () => {
    expect(swipeStep(SWIPE_DISTANCE - 1, 0)).toBeNull();
    expect(swipeStep(0, 0)).toBeNull();
  });

  it('ignores a drag that is mostly up or down: the page is being scrolled', () => {
    expect(swipeStep(-60, 120)).toBeNull();
    expect(swipeStep(-90, 60)).toBe(1);
    expect(swipeStep(-90, 61)).toBeNull();
  });
});

describe('keyStep', () => {
  it('maps the strip keys and nothing else', () => {
    expect(keyStep('ArrowRight')).toBe(1);
    expect(keyStep('ArrowLeft')).toBe(-1);
    expect(keyStep('Home')).toBe('first');
    expect(keyStep('End')).toBe('last');
    expect(keyStep('Enter')).toBeNull();
    expect(keyStep('ArrowDown')).toBeNull();
  });
});

describe('stepLane', () => {
  const ids = ['a', 'b', 'c'];

  it('steps one lane and stops at either end', () => {
    expect(stepLane(ids, 'a', 1)).toBe('b');
    expect(stepLane(ids, 'c', -1)).toBe('b');
    expect(stepLane(ids, 'c', 1)).toBeNull();
    expect(stepLane(ids, 'a', -1)).toBeNull();
  });

  it('jumps to the first and last lane, and says nothing when already there', () => {
    expect(stepLane(ids, 'b', 'first')).toBe('a');
    expect(stepLane(ids, 'b', 'last')).toBe('c');
    expect(stepLane(ids, 'a', 'first')).toBeNull();
    expect(stepLane(ids, 'c', 'last')).toBeNull();
  });

  it('has nowhere to go on an empty strip, and starts from the front for an unknown lane', () => {
    expect(stepLane([], 'a', 1)).toBeNull();
    expect(stepLane(ids, 'gone', 1)).toBe('a');
  });
});

describe('phoneLanes and shownLane', () => {
  it('lists the lanes in order with their counts, and leaves the closed one out while it is hidden', async () => {
    const model = await boardModelOf([
      card('F1', { laneId: 'plan' }),
      card('F2', { laneId: 'plan' }),
      card('F3', { laneId: 'closed' }),
    ]);
    const group = model.groups[0];
    if (group === undefined) throw new Error('no group');
    const shown = phoneLanes(group, true);
    expect(shown.map(lane => lane.id)).not.toContain('closed');
    expect(shown.find(lane => lane.id === 'plan')?.count).toBe(2);
    expect(phoneLanes(group, false).find(lane => lane.id === 'closed')?.count).toBe(1);
  });

  it('adds an Unplaced chip for cards whose lane the board does not know', async () => {
    const model = await boardModelOf([card('F1', { laneId: 'no-such-lane' })]);
    const group = model.groups[0];
    if (group === undefined) throw new Error('no group');
    const lanes = phoneLanes(group, true);
    expect(lanes.at(-1)).toEqual({ id: UNPLACED_LANE, name: 'Unplaced', count: 1 });
  });

  it('shows the named lane, else the first lane with a card, else the first lane', () => {
    const lanes = [
      { id: 'a', name: 'A', count: 0 },
      { id: 'b', name: 'B', count: 2 },
      { id: 'c', name: 'C', count: 1 },
    ];
    expect(shownLane(lanes, 'c')?.id).toBe('c');
    expect(shownLane(lanes, 'gone')?.id).toBe('b');
    expect(shownLane(lanes, null)?.id).toBe('b');
    expect(
      shownLane(
        lanes.map(lane => ({ ...lane, count: 0 })),
        null,
      )?.id,
    ).toBe('a');
    expect(shownLane([], null)).toBeNull();
  });
});

describe('boardBadgeCount', () => {
  it('adds the cards to test and the cards waiting on the owner', () => {
    expect(boardBadgeCount({ toTest: 2, waitingOnYou: 3 })).toBe(5);
    expect(boardBadgeCount({ toTest: 0, waitingOnYou: 0 })).toBe(0);
  });
});
