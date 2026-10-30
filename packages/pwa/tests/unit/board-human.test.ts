import { describe, expect, it } from 'bun:test';
import {
  groupUnderHuman,
  type HumanCard,
  humanCardKey,
  humanParentKey,
  humanScope,
  isAgentTask,
  splitAvailable,
  taskOrigin,
} from '../../src/lib/board-human.ts';
import { card, originCard } from './board-support.ts';

const entry = (daemonId: string, task: ReturnType<typeof card>): HumanCard & { readonly task: typeof task } => ({
  daemonId,
  task,
});

describe('who asked for a card', () => {
  it('reads only what the daemon declared', () => {
    expect(taskOrigin(originCard('F1', 'human'))).toBe('human');
    expect(taskOrigin(originCard('F2', 'agent'))).toBe('agent');
    expect(taskOrigin(card('F3'))).toBeNull();
    expect(taskOrigin({ origin: 'robot' })).toBeNull();
    expect(isAgentTask(originCard('F2', 'agent'))).toBe(true);
    expect(isAgentTask(card('F3'))).toBe(false);
  });

  it('offers the split only when some card says who asked', () => {
    expect(splitAvailable([card('F1'), card('F2')])).toBe(false);
    expect(splitAvailable([card('F1'), originCard('F2', 'agent')])).toBe(true);
    expect(splitAvailable([])).toBe(false);
  });
});

describe('the human card an agent card serves', () => {
  const human = entry('d', originCard('F1', 'human'));
  const sub = entry('d', originCard('F2', 'agent', undefined, { parent: { id: 'F1' } }));
  const deep = entry('d', originCard('F3', 'agent', undefined, { parent: { id: 'F2' } }));
  const told = entry('d', originCard('F4', 'agent', { id: 'F1' }, { parent: null }));
  const untold = entry('d', originCard('F5', 'agent', undefined, { parent: null }));
  const scope = humanScope([human, sub, deep, told, untold]);

  it('believes the declared human parent, and has none for a human card', () => {
    expect(humanParentKey(told, scope)).toBe(humanCardKey(human));
    expect(humanParentKey(human, scope)).toBeNull();
    expect(humanParentKey(untold, scope)).toBeNull();
    expect(humanParentKey(entry('d', originCard('F6', 'agent', null, { parent: { id: 'F1' } })), scope)).toBeNull();
  });

  it('walks the parent chain to the nearest human when nothing was declared', () => {
    expect(humanParentKey(sub, scope)).toBe(humanCardKey(human));
    expect(humanParentKey(deep, scope)).toBe(humanCardKey(human));
  });

  it('has nothing to group under when the human is not on the board, or the chain loops', () => {
    expect(humanParentKey(sub, humanScope([sub]))).toBeNull();
    expect(humanParentKey(told, humanScope([told]))).toBeNull();
    const a = entry('d', originCard('F11', 'agent', undefined, { parent: { id: 'F12' } }));
    const b = entry('d', originCard('F12', 'agent', undefined, { parent: { id: 'F11' } }));
    expect(humanParentKey(a, humanScope([a, b]))).toBeNull();
  });

  it('never mixes up two machines that use the same task id', () => {
    const other = entry('e', originCard('F1', 'human'));
    const child = entry('e', originCard('F9', 'agent', { id: 'F1' }));
    expect(humanParentKey(child, humanScope([human, other, child]))).toBe(humanCardKey(other));
  });
});

describe('grouping agent cards under their human card', () => {
  const a = entry('d', originCard('F1', 'human'));
  const b = entry('d', originCard('F2', 'human'));
  const x = entry('d', originCard('F3', 'agent', { id: 'F1' }));
  const y = entry('d', originCard('F4', 'agent', { id: 'F1' }));
  const lost = entry('d', originCard('F5', 'agent', { id: 'F8' }));

  it('moves an agent card to sit after its human, keeping the order of the rest', () => {
    const scope = humanScope([a, b, x, y, lost]);
    const placed = groupUnderHuman([a, b, x, lost, y], scope).map(({ item, under }) => [item.task.id, under === null]);
    expect(placed).toEqual([
      ['F1', true],
      ['F3', false],
      ['F4', false],
      ['F2', true],
      ['F5', true],
    ]);
  });

  it('keeps an agent card in place when its human is not in this list', () => {
    const scope = humanScope([a, x]);
    expect(groupUnderHuman([x], scope).map(({ item, under }) => [item.task.id, under])).toEqual([['F3', null]]);
  });
});
