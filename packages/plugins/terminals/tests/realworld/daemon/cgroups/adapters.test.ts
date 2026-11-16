// Realworld: asserts wall-clock speed; the outcome depends on the machine, not the code.
import { describe, it } from 'bun:test';
import should from 'should';
import { bunSpawn, systemClock } from '@ferretry/kernel/host';
import { milliseconds } from '@ferretry/std';
import { CGROUP_COMMAND_TIMEOUT_CODE, SpawnCgroupCommands } from '../../../../daemon/adapters/cgroups/index.ts';

describe('running one host-manager command', () => {
  it('should give up on a manager that never answers, and say so in the manager slot', async () => {
    // Arrange
    const subject = new SpawnCgroupCommands(
      bunSpawn({ PATH: '/usr/bin:/bin' }),
      (ms, fn) => systemClock().after(milliseconds(ms), fn),
      { timeoutMs: 50 },
    );

    // Act
    const started = Bun.nanoseconds();
    const result = await subject.execute(['/bin/sh', '-c', 'sleep 30']);
    const elapsedMs = (Bun.nanoseconds() - started) / 1_000_000;

    // Assert
    should(result.code).equal(CGROUP_COMMAND_TIMEOUT_CODE);
    should(elapsedMs).be.lessThan(10_000);
  });
});
