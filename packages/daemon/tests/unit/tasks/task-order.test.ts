import { describe, it } from 'bun:test';
import { TaskStatusSchema, type TaskId } from '@ferretry/protocol';
import should from 'should';
import { TASK_BOARD_ORDER, compareTasks, sortTasks } from '../../../src/lib/tasks/task-order.ts';
import { task } from './fixtures.ts';

const id = (value: string): TaskId => value as TaskId;

describe('TASK_BOARD_ORDER', () => {
  it('should rank every protocol status exactly once, so no two collapse into one group', () => {
    // Act
    const ranked = new Set(TASK_BOARD_ORDER);

    // Assert
    should(ranked.size).equal(TASK_BOARD_ORDER.length);
    should([...ranked].sort()).eql([...TaskStatusSchema.options].sort());
  });
});

describe('compareTasks', () => {
  it('should place shipped work ahead of work still waiting', () => {
    // Arrange
    const live = task({ id: id('F9'), phase: 'live', status: 'live' });
    const todo = task({ id: id('F1') });

    // Act
    const actual = compareTasks(live, todo);

    // Assert
    should(actual).be.below(0);
  });

  it('should rank an explicitly ordered task ahead of an unranked one in the same group', () => {
    // Arrange
    const ranked = task({ id: id('F9'), order: 5 });
    const unranked = task({ id: id('F1'), order: null });

    // Act
    const actual = compareTasks(ranked, unranked);

    // Assert
    should(actual).be.below(0);
  });

  it('should break an order tie by the identifier ordinal, not its text', () => {
    // Arrange — 'F10' sorts before 'F9' as text, but 9 precedes 10 as a rank
    const nine = task({ id: id('F9') });
    const ten = task({ id: id('F10') });

    // Act
    const actual = compareTasks(nine, ten);

    // Assert
    should(actual).be.below(0);
  });

  it('should break a same-ordinal tie deterministically by codepoint', () => {
    // Arrange
    const bug = task({ id: id('B1'), kind: 'bug' });
    const feature = task({ id: id('F1') });

    // Act & Assert
    should(compareTasks(bug, feature)).be.below(0);
    should(compareTasks(feature, bug)).be.above(0);
  });

  it('should be reflexive, so a record never displaces itself between two reads', () => {
    // Arrange
    const subject = task();

    // Act
    const actual = compareTasks(subject, subject);

    // Assert
    should(actual).equal(0);
  });
});

describe('sortTasks', () => {
  it('should produce the full board order from an arbitrary input order', () => {
    // Arrange
    const tasks = [
      task({ id: id('F3'), phase: 'todo', status: 'todo' }),
      task({ id: id('B1'), kind: 'bug', phase: 'done', status: 'done' }),
      task({ id: id('F2'), phase: 'build', status: 'in_progress', order: 1 }),
      task({ id: id('F10'), phase: 'build', status: 'in_progress' }),
      task({ id: id('C4'), kind: 'chore', phase: 'dropped', status: 'dropped', statusReason: 'obsolete' }),
    ];

    // Act
    const actual = sortTasks(tasks);

    // Assert
    should(actual.map(entry => entry.id)).eql(['B1', 'F2', 'F10', 'F3', 'C4']);
  });

  it('should be a total order — reversing the input yields the same result', () => {
    // Arrange
    const tasks = [
      task({ id: id('F1') }),
      task({ id: id('F2'), order: 0 }),
      task({ id: id('B2'), kind: 'bug' }),
      task({ id: id('F20') }),
    ];

    // Act
    const forward = sortTasks(tasks).map(entry => entry.id);
    const backward = sortTasks([...tasks].reverse()).map(entry => entry.id);

    // Assert
    should(backward).eql(forward);
  });

  it("should not reorder the caller's array in place", () => {
    // Arrange
    const tasks = [task({ id: id('F2'), phase: 'done', status: 'done' }), task({ id: id('F1') })];

    // Act
    sortTasks(tasks);

    // Assert
    should(tasks.map(entry => entry.id)).eql(['F2', 'F1']);
  });
});
