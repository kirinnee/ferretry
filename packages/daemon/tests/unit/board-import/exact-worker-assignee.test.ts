import { describe, it } from 'bun:test';
import should from 'should';
import {
  exactWorkerAssignee,
  type TaskAssigneeCandidate,
} from '../../../src/lib/board-import/exact-worker-assignee.ts';

function candidate(
  overrides: Partial<TaskAssigneeCandidate> & Pick<TaskAssigneeCandidate, 'id'>,
): TaskAssigneeCandidate {
  return { name: null, teammate: null, ...overrides };
}

describe('exactWorkerAssignee', () => {
  it('should resolve exact ids and unique names but refuse ambiguous names', () => {
    // Arrange
    const sessions = [
      candidate({ id: 'worker-1', teammate: 'sam' }),
      candidate({ id: 'worker-2', teammate: 'sam' }),
      candidate({ id: 'worker-3', name: 'unique' }),
    ];

    // Act
    const actual = {
      exact: exactWorkerAssignee({ assignee: 'worker-1' }, sessions),
      unique: exactWorkerAssignee({ assignee: 'unique' }, sessions),
      ambiguous: exactWorkerAssignee({ assignee: 'sam' }, sessions),
      blank: exactWorkerAssignee({ assignee: '  ' }, sessions),
      absent: exactWorkerAssignee({ assignee: null }, sessions),
    };

    // Assert
    should(actual).deepEqual({ exact: 'worker-1', unique: 'worker-3', ambiguous: null, blank: null, absent: null });
  });

  it('should not reach a session with a callsign through its display name', () => {
    // Arrange
    const sessions = [candidate({ id: 'a', name: 'ossy', teammate: 'loge' }), candidate({ id: 'b', teammate: '' })];

    // Act & Assert
    should(exactWorkerAssignee({ assignee: 'ossy' }, sessions)).be.null();
  });
});
