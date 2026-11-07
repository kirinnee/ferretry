import { describe, it } from 'bun:test';
import should from 'should';
import { countWorkerChildren } from '../../../../src/adapters/index.ts';

/**
 * The worker's own child counter, for a child whose exit cannot be reported.
 *
 * The counted start is what `fy daemon profile` sees of a worker, so a child that never reports an
 * exit must neither be counted as a finished one nor take the worker down with an unhandled rejection.
 */
describe('countWorkerChildren — a child that fails to report its exit', () => {
  it('should leave it out of the report, and still count the children that did exit', async () => {
    // Arrange
    let now = 0;
    const host = {
      spawn: ((first: unknown) =>
        Array.isArray(first) && first[0] === 'doomed'
          ? { exited: Promise.reject(new Error('the exit report failed')) }
          : { exited: Promise.resolve(0) }) as unknown as typeof Bun.spawn,
      spawnSync: ((..._args: unknown[]) => ({ exitCode: 0 })) as unknown as typeof Bun.spawnSync,
    };
    const drain = countWorkerChildren(host, () => now);

    // Act
    const doomed = host.spawn(['doomed', 'run']);
    now = 7;
    const fine = host.spawn(['tmux', 'list-panes']);
    await doomed.exited.catch(() => undefined);
    await fine.exited;
    const drained = drain();

    // Assert: the spawn itself is returned untouched, and only the child that exited is reported.
    should(drained.map(child => child.argv)).deepEqual([['tmux', 'list-panes']]);
    should(drained[0]?.wallMs).equal(0);
  });
});
