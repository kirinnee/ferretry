import { describe, expect, it } from 'bun:test';
import { childLanes, embedCardOf, embedSpecOf, groupEmbedLanes } from '../../../app/lib/embed-lanes.ts';
import { NO_BOARD_FILTERS } from '../../../app/lib/board-model.ts';
import { boardModelOf, card, laneSetFor, OTHER_PROJECT } from './board-support.ts';

const lanes = laneSetFor();

describe('embedSpecOf: what a block named', () => {
  it('reads a card, a list and a parent', () => {
    expect(embedSpecOf({ kind: 'card', id: 'F1' })).toEqual({ kind: 'card', id: 'F1' });
    expect(embedSpecOf({ kind: 'cards', ids: ['F1', 'F2'] })).toEqual({ kind: 'cards', ids: ['F1', 'F2'] });
    expect(embedSpecOf({ kind: 'children', parent: 'F7' })).toEqual({ kind: 'children', parent: 'F7' });
  });

  it('draws nothing for a value it cannot name', () => {
    for (const value of [
      null,
      undefined,
      'F1',
      7,
      {},
      { kind: 'card' },
      { kind: 'cards', ids: [1] },
      { kind: 'children' },
    ])
      expect(embedSpecOf(value)).toBeNull();
  });
});

describe('groupEmbedLanes: the lanes of a mini board', () => {
  it("puts cards under their lane in the lane set's order, and a lane the board lost under Elsewhere, last", () => {
    const grouped = groupEmbedLanes([
      { task: card('F1', { laneId: 'review' }), laneSet: lanes },
      { task: card('F2', { laneId: 'todo' }), laneSet: lanes },
      { task: card('F3', { laneId: 'gone' }), laneSet: lanes },
      { task: card('F4', { laneId: 'review' }), laneSet: null },
      { task: card('F5', { laneId: 'review' }), laneSet: lanes },
    ]);
    expect(grouped.map(lane => [lane.name, lane.cards.map(entry => entry.task.id)])).toEqual([
      ['Todo', ['F2']],
      ['Review/CI', ['F1', 'F5']],
      ['Elsewhere', ['F3', 'F4']],
    ]);
    expect(grouped.map(lane => lane.category)).toEqual(['backlog', 'review', null]);
  });

  it('keeps each project together, in the order its first card was listed', () => {
    const other = laneSetFor(OTHER_PROJECT);
    const grouped = groupEmbedLanes([
      { task: card('F1', { laneId: 'review' }), laneSet: lanes },
      { task: card('F2', { laneId: 'todo', projectId: OTHER_PROJECT }), laneSet: other },
      { task: card('F3', { laneId: 'todo' }), laneSet: lanes },
    ]);
    expect(grouped.map(lane => lane.name)).toEqual(['Todo', 'Review/CI', 'Todo']);
  });

  it('names a card by this machine, never by what an author typed', () => {
    expect(embedCardOf(card('F1')).daemonId).toBe(embedCardOf(card('F2')).daemonId);
    expect(embedCardOf(card('F1')).task.id).toBe('F1');
  });
});

describe('childLanes: the children of one card by lane', () => {
  it('keeps only the lanes that hold a child, and the unplaced ones under Elsewhere', async () => {
    const model = await boardModelOf(
      [
        card('F10'),
        card('F11', { parent: { id: 'F10' } }),
        card('F12', { parent: { id: 'F10' }, laneId: 'review' }),
        card('F13', { parent: { id: 'F99' } }),
        card('F14', { parent: { id: 'F10' }, laneId: 'gone' }),
      ],
      { ...NO_BOARD_FILTERS, state: 'all', agents: true },
    );
    const grouped = childLanes(model, 'F10');
    expect(grouped.map(lane => [lane.name, lane.cards.map(entry => entry.task.id)])).toEqual([
      ['Implement', ['F11']],
      ['Review/CI', ['F12']],
      ['Elsewhere', ['F14']],
    ]);
  });
});
