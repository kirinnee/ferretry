import { describe, it } from 'bun:test';
import should from 'should';
import { LaunchEnvironmentStore } from '../../../../src/lib/session/lifecycle/launch-environment.ts';
import type { SessionEnvironmentStore } from '../../../../src/lib/session/lifecycle/types.ts';
import { parseSessionId, type SessionId } from '../../../../src/lib/session-id.ts';

/** An in-memory environment store, as the session's own file would answer. */
class MemoryStore implements SessionEnvironmentStore {
  readonly documents = new Map<SessionId, Readonly<Record<string, string>>>();

  async write(id: SessionId, environment: Readonly<Record<string, string>>): Promise<void> {
    this.documents.set(id, environment);
  }

  async read(id: SessionId): Promise<Readonly<Record<string, string>>> {
    return this.documents.get(id) ?? {};
  }
}

const ID = parseSessionId('session-1');

describe('LaunchEnvironmentStore', () => {
  it("should fill in a switch the store never recorded from the session's record", async () => {
    // Arrange — a ferret started before Pack mode: its store holds only its credential.
    const stored = new MemoryStore();
    await stored.write(ID, { FY_SESSION_BOARD_CAPABILITY: 'capability' });
    const subject = new LaunchEnvironmentStore(stored, async () => ({ FY_PACK: '1' }));

    // Act
    const actual = await subject.read(ID);

    // Assert
    should(actual).deepEqual({ FY_PACK: '1', FY_SESSION_BOARD_CAPABILITY: 'capability' });
  });

  it('should let a stored switch win, in either direction', async () => {
    // Arrange
    const stored = new MemoryStore();
    await stored.write(ID, { FY_PACK: '0' });
    const subject = new LaunchEnvironmentStore(stored, async () => ({ FY_PACK: '1' }));

    // Act
    const actual = await subject.read(ID);

    // Assert
    should(actual).deepEqual({ FY_PACK: '0' });
  });

  it('should launch with the stored environment alone when the defaults cannot be resolved', async () => {
    // Arrange
    const stored = new MemoryStore();
    await stored.write(ID, { FY_HYPERMEDIA: '1' });
    const subject = new LaunchEnvironmentStore(stored, async () => {
      throw new Error('the session documents are unreadable');
    });

    // Act
    const actual = await subject.read(ID);

    // Assert
    should(actual).deepEqual({ FY_HYPERMEDIA: '1' });
  });

  it('should write straight through, never storing a derived switch', async () => {
    // Arrange
    const stored = new MemoryStore();
    const subject = new LaunchEnvironmentStore(stored, async () => ({ FY_PACK: '1' }));

    // Act
    await subject.write(ID, { TASK_BOARD: 'board-7' });

    // Assert
    should(await stored.read(ID)).deepEqual({ TASK_BOARD: 'board-7' });
  });
});
