import { describe, it } from 'bun:test';
import should from 'should';
import { readBlockReason } from '../../../src/lib/board-import/index.ts';

const known = new Set(['F1', 'F2', 'B3']);

describe('readBlockReason', () => {
  it('should read a reason naming other tasks of the session as their dependencies', () => {
    // Act
    const reading = readBlockReason('waiting for &F2 and #B3, also F2 again', 'F1', known);

    // Assert
    should(reading).eql({ on: 'tasks', ids: ['F2', 'B3'] });
  });

  it('should ignore the task itself and ids the session does not hold', () => {
    // Act
    const reading = readBlockReason('after F1 and F99 land', 'F1', known);

    // Assert
    should(reading).eql({ on: 'external' });
  });

  it('should not read an id glued to other letters', () => {
    // Act
    const reading = readBlockReason('see xF2 and F2y', 'F1', known);

    // Assert
    should(reading).eql({ on: 'external' });
  });

  for (const reason of [
    'needs owner input',
    'waiting on a human',
    'asked the user',
    'waiting for your reply',
    'needs approval',
    'awaiting sign-off',
    'needs a go ahead',
    'a decision is pending',
    'waiting for an answer',
  ]) {
    it(`should read "${reason}" as waiting on the owner`, () => {
      // Act
      const reading = readBlockReason(reason, 'F1', known);

      // Assert
      should(reading).eql({ on: 'owner' });
    });
  }

  it('should prefer a named task over owner words', () => {
    // Act
    const reading = readBlockReason('F2 needs approval first', 'F1', known);

    // Assert
    should(reading).eql({ on: 'tasks', ids: ['F2'] });
  });

  it('should read anything else as external', () => {
    // Act
    const reading = readBlockReason('CI is down', 'F1', known);

    // Assert
    should(reading).eql({ on: 'external' });
  });
});
