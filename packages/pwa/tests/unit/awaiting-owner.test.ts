import { describe, expect, test } from 'bun:test';
import { awaitingOwner, isGateLane } from '../../src/lib/awaiting-owner.ts';
import { NO_BOARD_FILTERS } from '../../src/lib/board-model.ts';
import { boardModelOf, card } from './board-support.ts';

const placed = async (extra: Record<string, unknown>) => {
  const model = await boardModelOf([card('F1', extra)], { ...NO_BOARD_FILTERS, agents: true });
  const group = model.groups[0];
  const found = group?.lanes.flatMap(lane => lane.cards).find(candidate => candidate.task.id === 'F1');
  if (group === undefined || found === undefined) throw new Error('fixture card missing');
  return { found, laneSet: group.laneSet };
};

const stageIn = async (extra: Record<string, unknown>) => {
  const { found, laneSet } = await placed(extra);
  return awaitingOwner(found, laneSet);
};

describe('isGateLane', () => {
  test('a verify lane and an owner-gated active lane are gates', () => {
    expect(isGateLane({ category: 'verify' })).toBe(true);
    expect(isGateLane({ category: 'active', ownerGate: true })).toBe(true);
  });
  test('the closing lane, even gated, and ordinary lanes are not', () => {
    expect(isGateLane({ category: 'closed', ownerGate: true })).toBe(false);
    expect(isGateLane({ category: 'active' })).toBe(false);
    expect(isGateLane({ category: 'backlog' })).toBe(false);
    expect(isGateLane({ category: 'review' })).toBe(false);
    expect(isGateLane({ category: 'shipped' })).toBe(false);
  });
});

describe('awaitingOwner', () => {
  test('a person-asked card in the verify lane waits for a try; in the plan gate, for an approval', async () => {
    expect(await stageIn({ laneId: 'tested' })).toBe('try');
    expect(await stageIn({ laneId: 'plan' })).toBe('approve');
  });

  test.each(['todo', 'implement', 'review', 'merged', 'released', 'closed'])('never in %s', async laneId => {
    expect(await stageIn({ laneId })).toBeNull();
  });

  test('an internal card in a gate lane never waits on the owner', async () => {
    expect(await stageIn({ laneId: 'tested', askedBy: 'agent' })).toBeNull();
    expect(await stageIn({ laneId: 'plan', askedBy: 'agent' })).toBeNull();
  });

  test('a dropped card never waits on the owner', async () => {
    expect(await stageIn({ laneId: 'tested', dropped: { at: '2026-08-01T10:00:00.000Z', reason: 'no' } })).toBeNull();
  });

  test('a card whose project lanes are unknown never waits on the owner', async () => {
    const { found } = await placed({ laneId: 'tested' });
    expect(awaitingOwner(found, null)).toBeNull();
  });
});
