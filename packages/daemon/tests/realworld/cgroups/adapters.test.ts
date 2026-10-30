// Realworld: asserts wall-clock speed; the outcome depends on the machine, not the code.
import { describe, it } from 'bun:test';
import should from 'should';
import { CGROUP_COMMAND_TIMEOUT_CODE, SpawnCgroupCommands } from '../../../src/adapters/cgroups/index.ts';

describe('running one host-manager command', () => {
  it('should give up on a manager that never answers, and say so in the manager slot', async () => {
    // Arrange
    const subject = new SpawnCgroupCommands({ timeoutMs: 50 });

    // Act
    const started = Bun.nanoseconds();
    const result = await subject.execute(['/bin/sh', '-c', 'sleep 30']);
    const elapsedMs = (Bun.nanoseconds() - started) / 1_000_000;

    // Assert
    should(result.code).equal(CGROUP_COMMAND_TIMEOUT_CODE);
    should(elapsedMs).be.lessThan(10_000);
  });
});
