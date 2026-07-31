import { describe, it } from 'bun:test';
import should from 'should';
import {
  DaemonExitedError,
  DaemonNotReadyError,
  DaemonReadinessWaiter,
  type DaemonReadinessPorts,
} from '../../../src/adapters/runtime/daemon-wait.ts';

function portsFor(
  health: () => Promise<Record<string, unknown>>,
  liveness: () => Promise<'alive' | 'dead' | 'absent'>,
): { readonly ports: DaemonReadinessPorts; readonly progress: number[] } {
  let now = 0;
  const progress: number[] = [];
  return {
    ports: {
      health,
      pidLiveness: liveness,
      now: () => now,
      async sleep(milliseconds) {
        now += milliseconds;
      },
      progress: seconds => progress.push(seconds),
    },
    progress,
  };
}

describe('daemon readiness adapter', () => {
  it('should return health once the endpoint becomes ready and note slow boot once', async () => {
    // Arrange
    let probes = 0;
    const fixture = portsFor(
      async () => {
        probes += 1;
        if (probes < 3) throw new Error('not ready');
        return { status: 'ok' };
      },
      async () => 'alive',
    );

    // Act
    const result = await new DaemonReadinessWaiter(fixture.ports, '/tmp/fyd.log', {
      deadlineMs: 100,
      cadenceMs: 10,
      progressAfterMs: 10,
    }).wait();

    // Assert
    should(result).deepEqual({ status: 'ok' });
    should(fixture.progress).deepEqual([0]);
  });

  it('should fail early only after observing a live pid in this wait', async () => {
    // Arrange
    const liveness = ['dead', 'alive', 'dead'];
    const fixture = portsFor(
      async () => await Promise.reject(new Error('not ready')),
      async () => liveness.shift() as 'alive' | 'dead' | 'absent',
    );

    // Act + Assert
    await new DaemonReadinessWaiter(fixture.ports, '/tmp/fyd.log', {
      deadlineMs: 100,
      cadenceMs: 10,
      progressAfterMs: 90,
    })
      .wait()
      .then(
        () => {
          throw new Error('expected daemon exit');
        },
        error => {
          should(error instanceof DaemonExitedError).be.true();
          should(error.message).containEql('/tmp/fyd.log');
        },
      );
  });

  it('should treat liveness probe failures as absent and eventually time out', async () => {
    // Arrange
    const fixture = portsFor(
      async () => await Promise.reject(new Error('not ready')),
      async () => await Promise.reject(new Error('stale pid file')),
    );

    // Act + Assert
    await new DaemonReadinessWaiter(fixture.ports, '/tmp/fyd.log', {
      deadlineMs: 10,
      cadenceMs: 10,
      progressAfterMs: 1,
    })
      .wait()
      .then(
        () => {
          throw new Error('expected readiness timeout');
        },
        error => {
          should(error instanceof DaemonNotReadyError).be.true();
          should(error.message).containEql('within 0s');
        },
      );
  });
});
