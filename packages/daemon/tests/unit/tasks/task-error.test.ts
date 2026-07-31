import { describe, it } from 'bun:test';
import should from 'should';
import { TaskError } from '../../../src/lib/tasks/task-error.ts';

describe('TaskError', () => {
  it('should carry a protocol error code and preserve its message', () => {
    // Arrange
    const expected = { code: 'cycle', message: 'dependency cycle refused' } as const;

    // Act
    const actual = new TaskError(expected.code, expected.message);

    // Assert
    should(actual).be.instanceOf(Error);
    should(actual.name).equal('TaskError');
    should(actual.code).equal(expected.code);
    should(actual.message).equal(expected.message);
  });
});
