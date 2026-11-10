import { describe, it } from 'bun:test';
import should from 'should';
import { boundedSpawn } from '../../../../daemon/adapters/tmux/bounded.ts';
import { hostSpawn } from '../support/host-spawn.ts';

describe('boundedSpawn', () => {
  it('should kill a command that outlives the bound instead of leaving it running', async () => {
    // Arrange
    const spawn = boundedSpawn(hostSpawn, 150);

    // Act
    const actual = await spawn.run('sh', ['-c', 'sleep 30']);

    // Assert — a `sleep 30` that ran its course would have exited 0; a killed one has a signal and no clean exit.
    should(actual.exitCode).not.equal(0);
  });

  it('should answer a command that finishes inside the bound untouched', async () => {
    // Arrange
    const spawn = boundedSpawn(hostSpawn, 5000);

    // Act
    const actual = await spawn.run('sh', ['-c', 'printf ok']);

    // Assert
    should(actual.exitCode).equal(0);
    should(actual.stdout).equal('ok');
  });

  it('should keep the raw bytes of a command that finishes inside the bound', async () => {
    // Arrange
    const spawn = boundedSpawn(hostSpawn, 5000);

    // Act
    const actual = await spawn.runBytes('sh', ['-c', 'printf abc']);

    // Assert
    should(actual.timedOut).equal(false);
    should(new TextDecoder().decode(actual.stdout)).equal('abc');
  });

  it('should mark a byte-reading command that outlives the bound as timed out', async () => {
    // Arrange
    const spawn = boundedSpawn(hostSpawn, 150);

    // Act
    const actual = await spawn.runBytes('sh', ['-c', 'sleep 30']);

    // Assert
    should(actual.timedOut).equal(true);
  });

  it('should kill a long-lived child started through it at the bound', async () => {
    // Arrange
    const spawn = boundedSpawn(hostSpawn, 150);
    const child = spawn.start('sh', ['-c', 'sleep 30']);

    // Act
    const exit = await child.exited;

    // Assert
    should(exit).not.equal(0);
  });
});
