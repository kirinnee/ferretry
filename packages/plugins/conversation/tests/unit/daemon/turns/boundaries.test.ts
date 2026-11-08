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
