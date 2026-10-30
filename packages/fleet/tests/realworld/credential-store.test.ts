// Realworld: asserts wall-clock speed; the outcome depends on the machine, not the code.
import { describe, it } from 'bun:test';
import should from 'should';
import { COMMAND_FAILED, SpawnCredentialCommand } from '../../src/adapters/credential-store.ts';

describe('SpawnCredentialCommand', () => {
  it('should return a failure when a command outlives its bound', async () => {
    // Arrange
    const shell = Bun.which('sh') ?? '/bin/sh';
    const started = Date.now();

    // Act
    const actual = await new SpawnCredentialCommand().run([shell, '-c', 'sleep 30'], 100);

    // Assert
    should(actual).deepEqual({ code: COMMAND_FAILED, stdout: '' });
    should(Date.now() - started).be.below(3_000);
  });
});
