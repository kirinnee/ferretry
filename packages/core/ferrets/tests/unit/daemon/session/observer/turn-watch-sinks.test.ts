import { describe, it } from 'bun:test';
import should from 'should';
import { type PacedTurnPorts, PacedTurnWatcher } from '../../../../../daemon/lib/session/observer/turn-watch.ts';
import { parseSessionId } from '../../../../../daemon/lib/session-id.ts';

const ID = parseSessionId('sink-1');
const T0 = '2026-11-08T10:00:00.000Z';

/** Ports for one session whose pane cannot be read, so every tick meets a failure; the sinks are the test's. */
function ports(extra: Partial<PacedTurnPorts>): PacedTurnPorts {
  return {
    sessions: async () => [{ id: ID, state: { status: 'running', turn: 1, turnState: 'working' } }],
    transcript: async () => undefined,
    pane: async () => {
      throw new Error('the pane could not be read');
    },
    record: async () => true,
    clock: { now: () => T0 },
    yieldToLoop: async () => {},
    ...extra,
  };
}

describe('PacedTurnWatcher, the host sinks it tells a failure through', () => {
  it('run answers undefined, and the next run still works, when the session list itself cannot be read', async () => {
    // Arrange
    let broken = true;
    const watcher = new PacedTurnWatcher(
      ports({
        sessions: async () => {
          if (broken) throw new Error('the store is unreadable');
          return [];
        },
      }),
    );

    // Act
    const first = await watcher.run();
    broken = false;
    const second = await watcher.run();

    // Assert: a failed tick is not a stopped loop, and the guard against overlap was released.
    should(first).be.undefined();
    should(second?.failures.size).equal(0);
  });

  it('a failureKey that throws cannot stop the tick: the failure is still reported and told', async () => {
    // Arrange
    const told: string[] = [];
    const watcher = new PacedTurnWatcher(
      ports({
        failureKey: () => {
          throw new Error('the key could not be made');
        },
        failed: (_id, error) => void told.push((error as Error).message),
      }),
    );

    // Act
    const report = await watcher.tick();

    // Assert: with no key, the failure is told as an unkeyed one.
    should([...report.failures.keys()]).deepEqual([ID]);
    should(told).deepEqual(['the pane could not be read']);
  });

  it('a failed sink that throws cannot stop the tick: the failure stays in the report', async () => {
    // Arrange
    const watcher = new PacedTurnWatcher(
      ports({
        failed: () => {
          throw new Error('the host sink is gone');
        },
      }),
    );

    // Act
    const report = await watcher.tick();

    // Assert
    should([...report.failures.keys()]).deepEqual([ID]);
    should(report.failures.get(ID)).equal('the pane could not be read');
  });
});
