import { describe, expect, it } from 'bun:test';
import { LANE_TEMPLATES } from '@ferretry/protocol';
import {
  ANSWER_AT_REST,
  answerRowOf,
  boardDone,
  doneLabel,
  doneLaneOf,
  doneTitle,
  isReleaseLane,
  notGoodLaneOf,
} from '../../src/lib/board-done.ts';
import { must } from '../support/dom.ts';
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

describe('the words', () => {
  it('is short on a row and spelled out where it is the main action', () => {
    const done = { kind: 'done', laneId: 'closed' } as const;
    expect(doneLabel(done)).toBe('Done');
    expect(doneLabel(done, true)).toBe('Mark done');
    expect(doneLabel({ kind: 'reopen', laneId: 'implement' })).toBe('Reopen');
    expect(doneTitle(done, 'Fix it')).toBe('Mark Fix it done and close it');
    expect(doneTitle({ kind: 'reopen', laneId: 'implement' }, 'Fix it')).toBe(
      'Reopen Fix it: send it back, with a reason',
    );
  });
});

describe('isReleaseLane', () => {
  it('is the last shipped lane of the set, not an earlier one', () => {
    const shipped = lanes.lanes.filter(lane => lane.category === 'shipped');
    expect(shipped.length).toBeGreaterThan(1);
    expect(isReleaseLane(lanes, must(shipped.at(-1), 'the release lane').id)).toBe(true);
    expect(isReleaseLane(lanes, must(shipped[0], 'the merged lane').id)).toBe(false);
    expect(isReleaseLane(lanes, 'todo')).toBe(false);
    expect(isReleaseLane(null, 'released')).toBe(false);
  });

  it('is the lane a release enters when that is the owner’s test lane, so Merged never reads as released', () => {
    const merged = { ...lanes, ...LANE_TEMPLATES['pr-release-verify'] };
    expect(isReleaseLane(merged, 'released')).toBe(true);
    expect(isReleaseLane(merged, 'merged')).toBe(false);
    expect(isReleaseLane({ lanes: [{ id: 'todo', name: 'Todo', category: 'backlog' }] }, 'todo')).toBe(false);
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

describe('answerRowOf', () => {
  const done = { kind: 'done', laneId: 'closed' } as const;
  const reopen = { kind: 'reopen', laneId: 'implement' } as const;

  it('gives a movable card in a verify lane the verdict row, even where a Done-only row is on offer', () => {
    expect(answerRowOf({ category: 'verify', movable: true, done })).toBe('verdict');
    expect(answerRowOf({ category: 'verify', movable: true, done: null })).toBe('verdict');
  });

  it('gives any other card with a Done the Done-only row', () => {
    expect(answerRowOf({ category: 'shipped', movable: true, done })).toBe('done');
    expect(answerRowOf({ category: 'verify', movable: false, done })).toBe('done');
  });

  it('draws nothing without a Done, and never a Reopen as a row', () => {
    expect(answerRowOf({ category: 'shipped', movable: true, done: null })).toBeNull();
    expect(answerRowOf({ category: 'closed', movable: true, done: reopen })).toBeNull();
    expect(answerRowOf({ category: null, movable: false, done: null })).toBeNull();
  });
});
