import { describe, it } from 'bun:test';
import type { TaskId, TaskPhase } from '@ferretry/protocol';
import should from 'should';
import {
  assertTaskCanDrop,
  assertTaskDag,
  dependencySatisfied,
  replaceGraphTask,
  taskBlockedBy,
  taskDependents,
  taskGraphMap,
} from '../../../src/lib/tasks/task-graph.ts';
import { shouldRefuse, task } from './fixtures.ts';

const id = (value: string): TaskId => value as TaskId;

describe('dependencySatisfied', () => {
  it.each<{ phase: TaskPhase; expected: boolean }>([
    { phase: 'todo', expected: false },
    { phase: 'research', expected: false },
    { phase: 'design', expected: false },
    { phase: 'build', expected: false },
    { phase: 'built', expected: true },
    { phase: 'live', expected: true },
    { phase: 'done', expected: true },
    { phase: 'dropped', expected: false },
  ])('should treat $phase as satisfied=$expected', ({ phase, expected }) => {
    // Act
    const actual = dependencySatisfied(task({ phase, status: 'todo' }));

    // Assert
    should(actual).equal(expected);
  });

  it('should treat a missing task as unsatisfied rather than throwing', () => {
    // Act
    const actual = dependencySatisfied(undefined);

    // Assert
    should(actual).be.false();
  });
});

describe('taskGraphMap', () => {
  it('should index every task by id', () => {
    // Arrange
    const tasks = [task({ id: id('F1') }), task({ id: id('F2') })];

    // Act
    const actual = taskGraphMap(tasks);

    // Assert
    should(actual.size).equal(2);
    should(actual.get(id('F2'))).equal(tasks[1]);
  });

  it('should refuse a record set naming the same task twice', () => {
    // Act & Assert
    shouldRefuse('ambiguous', () => taskGraphMap([task({ id: id('F1') }), task({ id: id('F1') })]));
  });
});

describe('assertTaskDag', () => {
  it('should accept an acyclic set with resolvable edges', () => {
    // Arrange
    const tasks = [
      task({ id: id('F1'), dependsOn: [id('F2'), id('F3')] }),
      task({ id: id('F2'), dependsOn: [id('F3')] }),
      task({ id: id('F3') }),
    ];

    // Act & Assert
    should(() => assertTaskDag(tasks)).not.throw();
  });

  it('should refuse an edge pointing at a task that does not exist', () => {
    // Act & Assert
    const error = shouldRefuse('not-found', () => assertTaskDag([task({ id: id('F1'), dependsOn: [id('F9')] })]));
    should(error.message).containEql('F9');
  });

  it('should refuse a self-edge', () => {
    // Act & Assert
    shouldRefuse('cycle', () => assertTaskDag([task({ id: id('F1'), dependsOn: [id('F1')] })]));
  });

  it('should name the concrete cycle it refused', () => {
    // Arrange — a three-hop cycle no single-edge check could see
    const tasks = [
      task({ id: id('F1'), dependsOn: [id('F2')] }),
      task({ id: id('F2'), dependsOn: [id('F3')] }),
      task({ id: id('F3'), dependsOn: [id('F1')] }),
    ];

    // Act & Assert
    const error = shouldRefuse('cycle', () => assertTaskDag(tasks));
    should(error.message).containEql('F1 → F2 → F3 → F1');
  });

  it('should accept a diamond, which shares nodes without closing a cycle', () => {
    // Arrange
    const tasks = [
      task({ id: id('F1'), dependsOn: [id('F2'), id('F3')] }),
      task({ id: id('F2'), dependsOn: [id('F4')] }),
      task({ id: id('F3'), dependsOn: [id('F4')] }),
      task({ id: id('F4') }),
    ];

    // Act & Assert
    should(() => assertTaskDag(tasks)).not.throw();
  });
});

describe('taskDependents', () => {
  it('should list every task declaring an edge to the id', () => {
    // Arrange
    const tasks = [
      task({ id: id('F1'), dependsOn: [id('F3')] }),
      task({ id: id('F2'), dependsOn: [id('F3')] }),
      task({ id: id('F3') }),
    ];

    // Act
    const actual = taskDependents(tasks, id('F3'));

    // Assert
    should(actual.map(entry => entry.id)).eql(['F1', 'F2']);
  });
});

describe('assertTaskCanDrop', () => {
  it('should allow dropping work nothing waits on', () => {
    // Act & Assert
    should(() => assertTaskCanDrop([task({ id: id('F1') })], id('F1'))).not.throw();
  });

  it('should refuse dropping work a live task still depends on', () => {
    // Arrange
    const tasks = [task({ id: id('F1'), dependsOn: [id('F2')] }), task({ id: id('F2') })];

    // Act & Assert
    const error = shouldRefuse('dependency-conflict', () => assertTaskCanDrop(tasks, id('F2')));
    should(error.message).containEql('F1');
  });

  it('should ignore dependents that were themselves dropped', () => {
    // Arrange
    const tasks = [
      task({ id: id('F1'), dependsOn: [id('F2')], phase: 'dropped', status: 'dropped', statusReason: 'obsolete' }),
      task({ id: id('F2') }),
    ];

    // Act & Assert
    should(() => assertTaskCanDrop(tasks, id('F2'))).not.throw();
  });
});

describe('taskBlockedBy', () => {
  it('should report only the unsatisfied edges, in declaration order', () => {
    // Arrange
    const subject = task({ id: id('F1'), dependsOn: [id('F3'), id('F2')] });
    const tasks = [subject, task({ id: id('F2'), phase: 'done', status: 'done' }), task({ id: id('F3') })];

    // Act
    const actual = taskBlockedBy(tasks, subject);

    // Assert
    should(actual).eql(['F3']);
  });

  it('should report an edge to an absent task as blocking', () => {
    // Arrange
    const subject = task({ id: id('F1'), dependsOn: [id('F9')] });

    // Act
    const actual = taskBlockedBy([subject], subject);

    // Assert
    should(actual).eql(['F9']);
  });
});

describe('replaceGraphTask', () => {
  it('should substitute the record of the same id and leave the rest untouched', () => {
    // Arrange
    const tasks = [task({ id: id('F1') }), task({ id: id('F2') })];
    const replacement = task({ id: id('F2'), title: 'Renamed' });

    // Act
    const actual = replaceGraphTask(tasks, replacement);

    // Assert
    should(actual[0]).equal(tasks[0]);
    should(actual[1]).equal(replacement);
  });

  it('should leave a set that does not contain the replacement unchanged', () => {
    // Arrange
    const tasks = [task({ id: id('F1') })];

    // Act
    const actual = replaceGraphTask(tasks, task({ id: id('F9') }));

    // Assert
    should(actual.map(entry => entry.id)).eql(['F1']);
  });
});
