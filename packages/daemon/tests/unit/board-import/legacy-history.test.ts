import { describe, it } from 'bun:test';
import type { BoardTaskEvent, TaskActivity } from '@ferretry/protocol';
import should from 'should';
import { mapHistory, type HistoryContext } from '../../../src/lib/board-import/index.ts';
import { lanes } from '../board/support.ts';
import { actorOf, createdAct, daemonActor, LATER, noteAct, oldTask, statusAct, taskAt, WHEN } from './support.ts';

const context = (overrides: Partial<HistoryContext> = {}): HistoryContext => ({
  task: oldTask(),
  laneSet: lanes(),
  cardOf: new Map([
    ['F1', 'F1'],
    ['F2', 'F20'],
  ]),
  actorOf,
  ...overrides,
});

const base = { v: 1 as const, time: LATER, actor: 'lead', actorName: null };
const typesOf = (events: readonly BoardTaskEvent[]): string[] => events.map(event => event.type);

describe('mapHistory', () => {
  it('should open with the created event in the lane the creating status means', () => {
    // Arrange
    const task = taskAt('in_progress');

    // Act
    const { events } = mapHistory(context({ task }), [createdAct(task)], 'implement');

    // Assert
    should(events).eql([
      { type: 'created', seq: 1, at: WHEN, actor: { kind: 'ferret', sessionId: 'lead' }, laneId: 'implement' },
    ]);
  });

  it('should fall back to a todo creation at the task time when the created activity was lost', () => {
    // Arrange
    const task = oldTask({ createdBy: null });

    // Act
    const { events } = mapHistory(context({ task }), [], 'todo');

    // Assert
    should(events).eql([{ type: 'created', seq: 1, at: WHEN, actor: daemonActor, laneId: 'todo' }]);
  });

  it('should turn a forward status change into a move and track the lane', () => {
    // Arrange
    const task = taskAt('built');
    const activity = [createdAct(oldTask()), statusAct(2, 'todo', 'in_progress', 'build')];

    // Act
    const { events } = mapHistory(context({ task }), activity, 'implement');

    // Assert
    should(events[1]).match({
      type: 'moved',
      seq: 2,
      from: 'todo',
      to: 'implement',
      backward: false,
      reason: 'because',
    });
    should(events).have.length(2);
  });

  it('should mark a move to an earlier lane as backward', () => {
    // Arrange
    const activity = [createdAct(taskAt('in_progress')), statusAct(2, 'in_progress', 'todo', 'todo')];

    // Act
    const { events } = mapHistory(context(), activity, 'todo');

    // Assert
    should(events[1]).match({ type: 'moved', from: 'implement', to: 'todo', backward: true });
  });

  it('should turn a reopening into a reopened event carrying the ask', () => {
    // Arrange
    const activity = [
      createdAct(taskAt('done')),
      statusAct(2, 'done', 'in_progress', 'build', { reopened: true, reason: 'broken again' }),
    ];

    // Act
    const { events } = mapHistory(context(), activity, 'implement');

    // Assert
    should(events[1]).match({
      type: 'reopened',
      from: 'closed',
      to: 'implement',
      reason: 'broken again',
      ask: { text: 'broken again', source: 'migrated from the old task store' },
    });
  });

  it('should turn a drop into a dropped event and no move', () => {
    // Arrange
    const activity = [
      createdAct(oldTask()),
      statusAct(2, 'todo', 'dropped', 'dropped', { reason: 'no longer needed' }),
    ];

    // Act
    const { events } = mapHistory(context(), activity, 'todo');

    // Assert
    should(typesOf(events)).eql(['created', 'dropped']);
    should(events[1]).match({ reason: 'no longer needed' });
  });

  it('should record a block without a move when the lane does not change', () => {
    // Arrange
    const activity = [createdAct(oldTask()), statusAct(2, 'todo', 'blocked', 'todo', { reason: 'CI down' })];

    // Act
    const { events } = mapHistory(context(), activity, 'todo');

    // Assert
    should(typesOf(events)).eql(['created', 'blocked']);
  });

  it('should record an unblock and the move it comes with', () => {
    // Arrange
    const activity = [
      createdAct(oldTask()),
      statusAct(2, 'todo', 'blocked', 'todo'),
      statusAct(3, 'blocked', 'in_progress', 'build', { reason: 'fixed' }),
    ];

    // Act
    const { events } = mapHistory(context(), activity, 'implement');

    // Assert
    should(typesOf(events)).eql(['created', 'blocked', 'unblocked', 'moved']);
  });

  it('should keep a status change that changes no lane as a note', () => {
    // Arrange
    const activity = [
      createdAct(taskAt('in_progress')),
      statusAct(2, 'in_progress', 'built', 'built', { reason: 'code done' }),
    ];

    // Act
    const { events } = mapHistory(context(), activity, 'implement');

    // Assert
    should(events[1]).match({ type: 'note', text: 'status in_progress → built: code done' });
  });

  it('should add one reconciling move when the final status disagrees with the history', () => {
    // Arrange
    const activity = [createdAct(oldTask())];

    // Act
    const forward = mapHistory(context(), activity, 'review').events;
    const backward = mapHistory(
      context({ task: taskAt('in_progress') }),
      [createdAct(taskAt('in_progress'))],
      'todo',
    ).events;

    // Assert
    should(forward[1]).match({
      type: 'moved',
      from: 'todo',
      to: 'review',
      backward: false,
      actor: daemonActor,
      at: LATER,
    });
    should(backward[1]).match({ type: 'moved', from: 'implement', to: 'todo', backward: true });
  });

  it('should not call a move to an unknown lane backward', () => {
    // Act
    const { events } = mapHistory(context(), [createdAct(oldTask())], 'nowhere');

    // Assert
    should(events[1]).match({ type: 'moved', to: 'nowhere', backward: false });
  });

  it('should map notes, feedback, links, assignments, orders and clarifications', () => {
    // Arrange
    const activity: TaskActivity[] = [
      createdAct(oldTask()),
      noteAct(2, 'a note'),
      { ...base, seq: 3, type: 'feedback', data: { text: 'too slow' } },
      { ...base, seq: 4, type: 'link', data: { field: 'pr', value: 'https://github.com/a/b/pull/1' } },
      { ...base, seq: 5, type: 'link', data: { field: 'branch', value: 'feat/x' } },
      { ...base, seq: 6, type: 'link', data: { field: 'commit', value: 'abc123' } },
      { ...base, seq: 7, type: 'link', data: { field: 'doc', value: 'docs/x.md' } },
      { ...base, seq: 8, type: 'assign', data: { from: null, to: 'child' } },
      { ...base, seq: 9, type: 'order', data: { from: null, to: 2 } },
      { ...base, seq: 10, type: 'clarification', data: { text: 'use bun', source: 'human' } },
    ];

    // Act
    const { events } = mapHistory(context(), activity, 'todo');

    // Assert
    should(typesOf(events)).eql([
      'created',
      'note',
      'note',
      'linked',
      'linked',
      'linked',
      'linked',
      'assigned',
      'ordered',
      'clarified',
    ]);
    should(events[2]).match({ text: 'feedback: too slow' });
    should(events.slice(3, 7).map(event => (event as { field: string }).field)).eql(['pr', 'branch', 'commit', 'doc']);
    should(events[9]).match({ text: 'use bun', source: 'human' });
  });

  it('should map dependencies through the new ids and note the ones that were not imported', () => {
    // Arrange
    const activity: TaskActivity[] = [
      createdAct(oldTask()),
      { ...base, seq: 2, type: 'dependency', data: { taskId: 'F2', operation: 'add' } },
      { ...base, seq: 3, type: 'dependency', data: { taskId: 'F2', operation: 'remove' } },
      { ...base, seq: 4, type: 'dependency', data: { taskId: 'F9', operation: 'add' } },
      { ...base, seq: 5, type: 'dependency', data: { taskId: 'F1', operation: 'add' } },
    ];

    // Act
    const { events } = mapHistory(context(), activity, 'todo');

    // Assert
    should(events[1]).match({ type: 'depended', task: { id: 'F20' }, until: 'shipped' });
    should(events[2]).match({ type: 'undepended', task: { id: 'F20' } });
    should(events[3]).match({ type: 'note', text: 'dependency add F9 (not imported)' });
    should(events[4]).match({ type: 'note', text: 'dependency add F1 (not imported)' });
  });

  it('should map file claims and releases, with or without a reason', () => {
    // Arrange
    const activity: TaskActivity[] = [
      createdAct(oldTask()),
      { ...base, seq: 2, type: 'file', data: { path: 'a.ts', operation: 'add' } },
      { ...base, seq: 3, type: 'file', data: { path: 'a.ts', operation: 'remove' } },
      { ...base, seq: 4, type: 'file', data: { path: 'b.ts', operation: 'remove', reason: 'moved' } },
    ];

    // Act
    const { events } = mapHistory(context(), activity, 'todo');

    // Assert
    should(events[1]).match({ type: 'file-claimed', path: 'a.ts' });
    should(events[2]).match({ type: 'file-released', reason: null });
    should(events[3]).match({ type: 'file-released', reason: 'moved' });
  });

  it('should note session events', () => {
    // Arrange
    const activity: TaskActivity[] = [
      createdAct(oldTask()),
      {
        ...base,
        seq: 2,
        type: 'session',
        data: { event: 'completion-claim', session: 'child', turn: 4, phase: 'build', claimedAt: LATER },
      },
      {
        ...base,
        seq: 3,
        type: 'session',
        data: { event: 'reopen-ack', reopenAck: 2, resolvedBy: 'human', resolvedByName: null },
      },
    ];

    // Act
    const { events } = mapHistory(context(), activity, 'todo');

    // Assert
    should(events[1]).match({ type: 'note', text: 'completion claimed by child at turn 4' });
    should(events[2]).match({ type: 'note', text: 'reopen acknowledged by human' });
  });

  it('should cut a note longer than the limit and number the events from one', () => {
    // Arrange
    const activity = [createdAct(oldTask()), noteAct(2, 'x'.repeat(5000))];

    // Act
    const { events } = mapHistory(context(), activity, 'todo');

    // Assert
    should((events[1] as { text: string }).text).have.length(2048);
    should(events.map(event => event.seq)).eql([1, 2]);
  });
});
