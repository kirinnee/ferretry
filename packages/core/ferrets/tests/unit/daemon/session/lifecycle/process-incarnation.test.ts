import { describe, it } from 'bun:test';
import should from 'should';
import {
  type IncarnationSpawn,
  processIncarnationFor,
} from '../../../../../daemon/adapters/session/lifecycle/process-incarnation.ts';

const STAT = `4242 (a b) S ${Array.from({ length: 18 }, () => '0').join(' ')} 987654 0 0`;
const never: IncarnationSpawn = {
  run: async () => {
    throw new Error('ps must not run here');
  },
};

describe('processIncarnationFor', () => {
  it('should read a Linux process start from the kernel host facts, never from a path of its own', async () => {
    // Arrange
    const asked: [number | 'self', string][] = [];
    const host = {
      platform: 'linux',
      procFile: async (pid: number | 'self', file: string) => {
        asked.push([pid, file]);
        return STAT;
      },
    };

    // Act
    const ticks = await processIncarnationFor(host, never).startOf(4242);

    // Assert
    should(ticks).equal(987654);
    should(asked).deepEqual([[4242, 'stat']]);
  });

  it('should answer nothing for a Linux process that has gone', async () => {
    // Arrange
    const host = {
      platform: 'linux',
      procFile: async () => {
        throw new Error('ENOENT');
      },
    };

    // Act / Assert
    should(await processIncarnationFor(host, never).startOf(1)).be.undefined();
  });

  it('should read a macOS start from ps run through the kernel spawn with a fixed locale and zone', async () => {
    // Arrange
    const calls: { program: string; args: readonly string[]; env: unknown }[] = [];
    const spawn: IncarnationSpawn = {
      run: async (program, args, options) => {
        calls.push({ program, args, env: options?.env });
        return { exitCode: 0, signal: null, stdout: 'Mon Aug  3 10:11:12 2026\n', stderr: '' };
      },
    };

    // Act
    const seconds = await processIncarnationFor({ platform: 'darwin', procFile: never.run as never }, spawn).startOf(
      77,
    );

    // Assert
    should(seconds).equal(Date.UTC(2026, 7, 3, 10, 11, 12) / 1000);
    should(calls).deepEqual([{ program: 'ps', args: ['-o', 'lstart=', '-p', '77'], env: { LC_ALL: 'C', TZ: 'UTC0' } }]);
  });

  it('should answer nothing when ps fails or the pid is not a positive integer, without running ps for the latter', async () => {
    // Arrange
    const failing: IncarnationSpawn = { run: async () => ({ exitCode: 1, signal: null, stdout: '', stderr: '' }) };
    const host = { platform: 'darwin', procFile: never.run as never };

    // Act / Assert
    should(await processIncarnationFor(host, failing).startOf(77)).be.undefined();
    should(await processIncarnationFor(host, never).startOf(0)).be.undefined();
  });

  it('should refuse to start sessions on a platform it cannot prove processes on, saying which', async () => {
    // Arrange
    const subject = processIncarnationFor({ platform: 'freebsd', procFile: never.run as never }, never);

    // Act / Assert
    await should(subject.startOf(1)).rejectedWith(/sessions cannot start on freebsd/u);
  });
});
