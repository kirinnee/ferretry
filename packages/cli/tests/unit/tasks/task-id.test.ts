import { describe, it } from 'bun:test';
import should from 'should';
import { requireTaskId, taskReference } from '../../../src/lib/tasks/task-id';

describe('task ids', () => {
  it('should canonicalize the shapes a human actually types', () => {
    // Act + Assert
    for (const raw of ['F21', 'f21', '#F21', '&f21', '  #f21  ']) {
      should(requireTaskId(raw)).equal('F21');
    }
  });

  it('should accept every kind prefix', () => {
    // Act + Assert
    should(requireTaskId('b7')).equal('B7');
    should(requireTaskId('i7')).equal('I7');
    should(requireTaskId('c7')).equal('C7');
  });

  it('should refuse anything that is not a task id', () => {
    // Act + Assert — a zero-numbered id and an unknown prefix are both rejected by the wire schema.
    for (const raw of ['', 'F', '21', 'X21', 'F0', 'F 21', 'FF21']) {
      should(() => requireTaskId(raw)).throw(/expected a task id like F21/u);
    }
  });

  it('should name the field it was refusing so the message points at the right flag', () => {
    // Act + Assert
    should(() => requireTaskId('nope', 'dependency id')).throw(/expected a dependency id like F21, got "nope"/u);
  });

  it('should cite a task the way the product does everywhere else', () => {
    // Act
    const actual = taskReference('F21');

    // Assert
    should(actual).equal('#F21');
  });
});
