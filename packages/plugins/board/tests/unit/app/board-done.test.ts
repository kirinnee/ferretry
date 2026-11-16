import { describe, expect, it } from 'bun:test';
import { ANSWER_AT_REST, boardDone, doneLaneOf, notGoodLaneOf } from '../../../app/lib/board-done.ts';
import { laneSetFor } from './board-support.ts';

const lanes = laneSetFor();

describe('boardDone', () => {
  it('closes an open card into the Closed lane', () => {
    expect(boardDone({ laneSet: lanes, category: 'verify', dropped: false })).toEqual({
      kind: 'done',
      laneId: 'closed',
    });
    expect(boardDone({ laneSet: lanes, category: 'backlog', dropped: false })).toEqual({
      kind: 'done',
      laneId: 'closed',
    });
  });

  it('reopens a closed card into the last active lane', () => {
    expect(boardDone({ laneSet: lanes, category: 'closed', dropped: false })).toEqual({
      kind: 'reopen',
      laneId: 'implement',
    });
  });

  it('reopens into the first open lane when the project has no active lane', () => {
    const noActive = { lanes: lanes.lanes.filter(lane => lane.category !== 'active') };
    expect(boardDone({ laneSet: noActive, category: 'closed', dropped: false })).toEqual({
      kind: 'reopen',
      laneId: 'todo',
    });
  });

  it('offers nothing for a dropped card, an unknown lane, no lanes, or nowhere to go', () => {
    expect(boardDone({ laneSet: lanes, category: 'active', dropped: true })).toBeNull();
    expect(boardDone({ laneSet: lanes, category: null, dropped: false })).toBeNull();
    expect(boardDone({ laneSet: null, category: 'active', dropped: false })).toBeNull();
    const noClosed = { lanes: lanes.lanes.filter(lane => lane.category !== 'closed') };
    expect(boardDone({ laneSet: noClosed, category: 'active', dropped: false })).toBeNull();
    const onlyClosed = { lanes: lanes.lanes.filter(lane => lane.category === 'closed') };
    expect(boardDone({ laneSet: onlyClosed, category: 'closed', dropped: false })).toBeNull();
  });
});

describe('the lanes Done and Not good go to', () => {
  it('follows the lanes a lane set declares', () => {
    const declared = { ...lanes, doneLane: 'closed', notGoodLane: 'plan' };
    expect(doneLaneOf(declared)).toBe('closed');
    expect(notGoodLaneOf(declared)).toBe('plan');
    expect(boardDone({ laneSet: declared, category: 'closed', dropped: false })).toEqual({
      kind: 'reopen',
      laneId: 'plan',
    });
  });

  it('falls back to the Closed lane and the last active lane when nothing is declared, or the declared lane is wrong', () => {
    expect(doneLaneOf(lanes)).toBe('closed');
    expect(notGoodLaneOf(lanes)).toBe('implement');
    // A declared lane that is missing, or not of the right kind, is not followed.
    const wrong = { ...lanes, doneLane: 'implement', notGoodLane: 'ghost' };
    expect(doneLaneOf(wrong)).toBe('closed');
    expect(notGoodLaneOf(wrong)).toBe('implement');
    expect(doneLaneOf({ ...lanes, doneLane: null, notGoodLane: null })).toBe('closed');
  });

  it('has nowhere to go with no lanes, or no lane of the kind', () => {
    expect(doneLaneOf(null)).toBeNull();
    expect(notGoodLaneOf(null)).toBeNull();
    expect(doneLaneOf({ lanes: lanes.lanes.filter(lane => lane.category !== 'closed') })).toBeNull();
    expect(notGoodLaneOf({ lanes: lanes.lanes.filter(lane => lane.category !== 'active') })).toBeNull();
  });

  it('starts every card at rest', () => {
    expect(ANSWER_AT_REST).toEqual({ pressed: null, error: null });
  });
});
