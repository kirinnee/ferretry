import { describe, expect, it } from 'bun:test';
import {
  groupUnderHuman,
  type HumanTask,
  humanTaskKey,
  humanParentKey,
  humanScope,
  isAgentTask,
  isPrivateTask,
  splitAvailable,
  taskAsker,
} from '../../../app/lib/board-human.ts';
import { boardTask, originTask, unasked } from './board-support.ts';

const entry = (daemonId: string, task: ReturnType<typeof boardTask>): HumanTask & { readonly task: typeof task } => ({
  daemonId,
  task,
});

describe('who asked for a card', () => {
  it('reads only what the daemon declared', () => {
    expect(taskAsker(originTask('F1', 'human'))).toBe('person');
    expect(taskAsker(originTask('F2', 'agent'))).toBe('agent');
    expect(taskAsker(unasked([boardTask('F3')])[0] ?? {})).toBeNull();
    expect(taskAsker({ origin: 'robot' })).toBeNull();
    expect(taskAsker({ askedBy: 'robot' })).toBeNull();
    expect(isAgentTask(originTask('F2', 'agent'))).toBe(true);
    expect(isAgentTask(boardTask('F3'))).toBe(false);
  });

  it('reads askedBy first and falls back to origin for a daemon that sends only that', () => {
    expect(taskAsker({ askedBy: 'agent' })).toBe('agent');
    expect(taskAsker({ askedBy: 'person', origin: 'agent' })).toBe('person');
    expect(taskAsker({ origin: 'agent' })).toBe('agent');
    expect(taskAsker({ origin: 'human' })).toBe('person');
    expect(isAgentTask({ askedBy: 'agent' })).toBe(true);
    expect(isAgentTask({ origin: 'agent' })).toBe(true);
  });

  it('keeps a card the daemon says is for the owner, though no owner message proved its ask', () => {
    // `askedBy: agent` is the stricter "no owner message matches the ask", which only the cards to test wait on.
    expect(taskAsker({ askedBy: 'agent', origin: 'human' })).toBe('person');
    expect(isAgentTask({ askedBy: 'agent', origin: 'human' })).toBe(false);
    expect(isAgentTask({ askedBy: 'agent', origin: 'agent' })).toBe(true);
  });

  it('offers the split only when some card says who asked', () => {
    expect(splitAvailable(unasked([boardTask('F1'), boardTask('F2')]))).toBe(false);
    expect(splitAvailable([boardTask('F1'), originTask('F2', 'agent')])).toBe(true);
    expect(splitAvailable([{ origin: 'agent' }])).toBe(true);
    expect(splitAvailable([])).toBe(false);
  });
});

describe('private cards', () => {
  const sub = { parent: { id: 'F1' } };

  it('believes the daemon’s visibility over who asked', () => {
    expect(isPrivateTask(boardTask('F2', { askedBy: 'person', visibility: 'private' }))).toBe(true);
    expect(isPrivateTask(boardTask('F3', { askedBy: 'agent', visibility: 'public' }))).toBe(false);
    expect(isPrivateTask(boardTask('F4', { ...sub, askedBy: 'person', visibility: 'public' }))).toBe(false);
  });

  it('falls back to the older rule for a card whose daemon sends no visibility', () => {
    expect(isPrivateTask(boardTask('F2', { askedBy: 'agent' }))).toBe(true);
    expect(isPrivateTask(boardTask('F3', { ...sub, askedBy: 'agent' }))).toBe(true);
    expect(isPrivateTask(boardTask('F4', { ...sub, askedBy: 'person' }))).toBe(false);
    expect(isPrivateTask(boardTask('F5', { askedBy: 'person' }))).toBe(false);
  });

  it('offers the split when a card says its visibility, even if nothing says who asked', () => {
    expect(splitAvailable([{ visibility: 'private' }])).toBe(true);
    expect(splitAvailable([{ visibility: 'sideways' }])).toBe(false);
  });
});

describe('the human card an agent card serves', () => {
  const human = entry('d', originTask('F1', 'human'));
  const sub = entry('d', originTask('F2', 'agent', undefined, { parent: { id: 'F1' } }));
  const deep = entry('d', originTask('F3', 'agent', undefined, { parent: { id: 'F2' } }));
  const told = entry('d', originTask('F4', 'agent', { id: 'F1' }, { parent: null }));
  const untold = entry('d', originTask('F5', 'agent', undefined, { parent: null }));
  const scope = humanScope([human, sub, deep, told, untold]);

  it('believes the declared human parent, and has none for a human card', () => {
    expect(humanParentKey(told, scope)).toBe(humanTaskKey(human));
    expect(humanParentKey(human, scope)).toBeNull();
    expect(humanParentKey(untold, scope)).toBeNull();
    expect(humanParentKey(entry('d', originTask('F6', 'agent', null, { parent: { id: 'F1' } })), scope)).toBeNull();
  });

  it('walks the parent chain to the nearest human when nothing was declared', () => {
    expect(humanParentKey(sub, scope)).toBe(humanTaskKey(human));
    expect(humanParentKey(deep, scope)).toBe(humanTaskKey(human));
  });

  it('has nothing to group under when the human is not on the board, or the chain loops', () => {
    expect(humanParentKey(sub, humanScope([sub]))).toBeNull();
    expect(humanParentKey(told, humanScope([told]))).toBeNull();
    const a = entry('d', originTask('F11', 'agent', undefined, { parent: { id: 'F12' } }));
    const b = entry('d', originTask('F12', 'agent', undefined, { parent: { id: 'F11' } }));
    expect(humanParentKey(a, humanScope([a, b]))).toBeNull();
  });

  it('never mixes up two machines that use the same task id', () => {
    const other = entry('e', originTask('F1', 'human'));
    const child = entry('e', originTask('F9', 'agent', { id: 'F1' }));
    expect(humanParentKey(child, humanScope([human, other, child]))).toBe(humanTaskKey(other));
  });
});

describe('grouping agent cards under their human card', () => {
  const a = entry('d', originTask('F1', 'human'));
  const b = entry('d', originTask('F2', 'human'));
  const x = entry('d', originTask('F3', 'agent', { id: 'F1' }));
  const y = entry('d', originTask('F4', 'agent', { id: 'F1' }));
  const lost = entry('d', originTask('F5', 'agent', { id: 'F8' }));

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
