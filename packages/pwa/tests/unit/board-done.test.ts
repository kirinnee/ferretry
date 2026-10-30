import { describe, expect, it } from 'bun:test';
import { boardDone, doneLabel, doneTitle, isReleaseLane } from '../../src/lib/board-done.ts';
import { laneSetFor } from './board-support.ts';
import { must } from '../support/dom.ts';

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
});
