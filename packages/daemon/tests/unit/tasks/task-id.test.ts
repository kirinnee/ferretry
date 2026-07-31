import { describe, it } from 'bun:test';
import type { TaskKind } from '@ferretry/protocol';
import should from 'should';
import {
  MAX_TASK_ID_NUMBER,
  TASK_ID_PREFIX,
  allocateTaskId,
  canonicalTaskId,
  splitTaskId,
} from '../../../src/lib/tasks/task-id.ts';
import { shouldRefuse } from './fixtures.ts';

describe('splitTaskId', () => {
  it.each([
    { id: 'B1', kind: 'bug', prefix: 'B', number: 1 },
    { id: 'F12', kind: 'feature', prefix: 'F', number: 12 },
    { id: 'I999999999', kind: 'infra', prefix: 'I', number: 999_999_999 },
    { id: '  C7  ', kind: 'chore', prefix: 'C', number: 7 },
  ])('should decompose $id into its kind and ordinal', ({ id, kind, prefix, number }) => {
    // Act
    const actual = splitTaskId(id);

    // Assert
    should(actual).eql({ kind: kind as TaskKind, prefix, number });
  });

  it.each(['', 'X1', 'F', 'F0', 'F01', 'f1', 'F1234567890', 'F1x', '#F1'])(
    'should reject %p as a task id rather than throwing',
    id => {
      // Act
      const actual = splitTaskId(id);

      // Assert
      should(actual).be.null();
    },
  );
});

describe('canonicalTaskId', () => {
  it.each([
    { input: 'f12', expected: 'F12' },
    { input: 'F12', expected: 'F12' },
    { input: ' b3 ', expected: 'B3' },
  ])('should canonicalise $input to $expected', ({ input, expected }) => {
    // Act
    const actual = canonicalTaskId(input);

    // Assert
    should(actual).equal(expected);
  });

  it('should return null for a reference that is not an id', () => {
    // Act
    const actual = canonicalTaskId('not-a-task');

    // Assert
    should(actual).be.null();
  });
});

describe('allocateTaskId', () => {
  it('should start each kind at one on an empty board', () => {
    // Act & Assert
    for (const [kind, prefix] of Object.entries(TASK_ID_PREFIX)) {
      should(allocateTaskId(kind as TaskKind, [])).equal(`${prefix}1`);
    }
  });

  it('should continue from the highest ordinal of its own kind only', () => {
    // Arrange
    const existing = ['B7', 'F3', 'F9', 'I2', 'C41'];

    // Act
    const actual = allocateTaskId('feature', existing);

    // Assert
    should(actual).equal('F10');
  });

  it('should ignore records whose ids the grammar does not admit', () => {
    // Arrange
    const existing = ['F2', 'nonsense', 'F0', 'f99'];

    // Act
    const actual = allocateTaskId('feature', existing);

    // Assert
    should(actual).equal('F3');
  });

  it('should never reissue an ordinal already present out of order', () => {
    // Arrange — a board whose highest id is not its last record
    const existing = ['F9', 'F2', 'F5'];

    // Act
    const actual = allocateTaskId('feature', existing);

    // Assert
    should(actual).equal('F10');
    should(existing).not.containEql(actual);
  });

  it('should refuse to allocate past the ids the protocol grammar admits', () => {
    // Act & Assert
    const error = shouldRefuse('too-long', () => allocateTaskId('feature', [`F${MAX_TASK_ID_NUMBER}`]));
    should(error.message).containEql('exhausted');
  });
});
