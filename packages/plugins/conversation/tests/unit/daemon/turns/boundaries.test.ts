import { describe, expect, test } from 'bun:test';
import { type TurnBoundary, TurnBoundaries } from '../../../../daemon/turns/lib/boundaries.ts';

const run = () => {
  const ended: TurnBoundary[] = [];
  return { ended, bounds: new TurnBoundaries(boundary => ended.push(boundary)) };
};

describe('an interrupt marks only the round in progress', () => {
  test('a stop during a working round ends that round as interrupted', () => {
    const { ended, bounds } = run();
    bounds.look('f1', 'working', 't1');
    bounds.markInterrupted('f1');
    bounds.look('f1', 'idle', 't2');
    expect(ended).toEqual([{ ferret: 'f1', turn: 't1', outcome: 'interrupted', endedAt: 't2' }]);
  });

  test('a stop at an idle ferret leaves nothing behind: its NEXT round, nobody stopped, ends completed', () => {
    const { ended, bounds } = run();
    bounds.look('f1', 'idle', 't1');
    // No look follows the stop (an idle ferret's state does not change), so a mark would wait for the next round.
    bounds.markInterrupted('f1');
    bounds.look('f1', 'working', 't2');
    bounds.look('f1', 'idle', 't3');
    expect(ended).toEqual([{ ferret: 'f1', turn: 't2', outcome: 'completed', endedAt: 't3' }]);
  });

  test('a stop at a ferret never looked at marks nothing', () => {
    const { ended, bounds } = run();
    bounds.markInterrupted('f1');
    bounds.look('f1', 'working', 't1');
    bounds.look('f1', 'stopped', 't2');
    expect(ended).toEqual([{ ferret: 'f1', turn: 't1', outcome: 'failed', endedAt: 't2' }]);
  });
});
