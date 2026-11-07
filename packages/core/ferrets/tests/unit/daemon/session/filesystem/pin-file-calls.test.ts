import { describe, it } from 'bun:test';
import { constants } from 'node:fs';
import should from 'should';
import { NODE_PIN_FILE_CALLS } from '../../../../src/adapters/session/filesystem/posix-session-root-pinner.ts';

/**
 * The runtime's own pin calls must describe one object the same way whichever call asked.
 *
 * The working-directory proof compares what `lstat('.')` says with what `fstat` of the installed descriptor says,
 * by device and inode. A `number` stat never equals a `bigint` one, so a mix proved NOTHING the same and closed file
 * browsing on every macOS host. Read-only, of the process's own working directory.
 */
describe('NODE_PIN_FILE_CALLS', () => {
  it('should give lstat and fstat of one folder the same exact device and inode', () => {
    // Arrange
    const fd = NODE_PIN_FILE_CALLS.open('.', constants.O_RDONLY | constants.O_DIRECTORY);

    try {
      // Act
      const named = NODE_PIN_FILE_CALLS.lstat('.');
      const held = NODE_PIN_FILE_CALLS.fstat(fd);

      // Assert: the same kind of number, so the proof's comparison can ever succeed.
      should(typeof named.dev).equal('bigint');
      should(typeof held.dev).equal('bigint');
      should([named.dev, named.ino]).deepEqual([held.dev, held.ino]);
    } finally {
      NODE_PIN_FILE_CALLS.close(fd);
    }
  });
});
