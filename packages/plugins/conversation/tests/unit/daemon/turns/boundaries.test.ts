import { describe, expect, it } from 'bun:test';
import { type TurnBoundary, TurnBoundaries } from '../../../../daemon/turns/lib/boundaries.ts';

const build = () => {
  const ended: TurnBoundary[] = [];
  return { boundaries: new TurnBoundaries(boundary => void ended.push(boundary)), ended };
};

describe('TurnBoundaries', () => {
  it('names the round a ferret is in the middle of, and none once it stops working', () => {
    const { boundaries } = build();
    expect(boundaries.current('f1')).toBeUndefined();
    boundaries.look('f1', 'working', 't1');
    boundaries.look('f1', 'working', 't2');
    expect(boundaries.current('f1')).toBe('t1');
    boundaries.look('f1', 'idle', 't3');
    expect(boundaries.current('f1')).toBeUndefined();
  });

  it('ends a round as completed when the ferret goes idle, and as failed when it stops', () => {
    const { boundaries, ended } = build();
    boundaries.look('f1', 'working', 't1');
    boundaries.look('f1', 'idle', 't2');
    boundaries.look('f2', 'working', 't3');
    boundaries.look('f2', 'stopped', 't4');
    expect(ended).toEqual([
      { ferret: 'f1', turn: 't1', outcome: 'completed', endedAt: 't2' },
      { ferret: 'f2', turn: 't3', outcome: 'failed', endedAt: 't4' },
    ]);
  });

  it('ends an interrupted round as interrupted however the ferret then settles, for that round only', () => {
    const { boundaries, ended } = build();
    boundaries.look('f1', 'working', 't1');
    boundaries.markInterrupted('f1');
    boundaries.look('f1', 'stopped', 't2');
    boundaries.look('f1', 'working', 't3');
    boundaries.look('f1', 'idle', 't4');
    expect(ended.map(each => each.outcome)).toEqual(['interrupted', 'completed']);
  });

  it('ends nothing for a look at a ferret that was not working, or that is only starting', () => {
    const { boundaries, ended } = build();
    boundaries.look('f1', 'idle', 't1');
    boundaries.look('f1', 'stopped', 't2');
    boundaries.look('f1', 'working', 't3');
    boundaries.look('f1', 'starting', 't4');
    expect(ended).toEqual([]);
  });
});

describe('TurnBoundaries.forget', () => {
  it('forgets a ferret that is gone, with the round it was in and an interrupt owed to it', () => {
    const { boundaries, ended } = build();
    boundaries.look('f1', 'working', 't1');
    boundaries.markInterrupted('f1');
    boundaries.forget('f1');
    expect(boundaries.current('f1')).toBeUndefined();
    boundaries.look('f1', 'idle', 't2');
    boundaries.look('f1', 'working', 't3');
    boundaries.look('f1', 'idle', 't4');
    expect(ended).toEqual([{ ferret: 'f1', turn: 't3', outcome: 'completed', endedAt: 't4' }]);
  });
});

const run = () => {
  const ended: TurnBoundary[] = [];
  return { ended, bounds: new TurnBoundaries(boundary => ended.push(boundary)) };
};

describe('an interrupt marks only the round in progress', () => {
  it('a stop during a working round ends that round as interrupted', () => {
    const { ended, bounds } = run();
    bounds.look('f1', 'working', 't1');
    bounds.markInterrupted('f1');
    bounds.look('f1', 'idle', 't2');
    expect(ended).toEqual([{ ferret: 'f1', turn: 't1', outcome: 'interrupted', endedAt: 't2' }]);
  });

  it('a stop at an idle ferret leaves nothing behind: its NEXT round, nobody stopped, ends completed', () => {
    const { ended, bounds } = run();
    bounds.look('f1', 'idle', 't1');
    // No look follows the stop (an idle ferret's state does not change), so a mark would wait for the next round.
    bounds.markInterrupted('f1');
    bounds.look('f1', 'working', 't2');
    bounds.look('f1', 'idle', 't3');
    expect(ended).toEqual([{ ferret: 'f1', turn: 't2', outcome: 'completed', endedAt: 't3' }]);
  });

  it('a stop at a ferret never looked at marks nothing', () => {
    const { ended, bounds } = run();
    bounds.markInterrupted('f1');
    bounds.look('f1', 'working', 't1');
    bounds.look('f1', 'stopped', 't2');
    expect(ended).toEqual([{ ferret: 'f1', turn: 't1', outcome: 'failed', endedAt: 't2' }]);
  });
});
