import { describe, it } from 'bun:test';
import should from 'should';
import { StorageHomeSessions } from '../../../src/adapters/agenda/storage-home-sessions.ts';
import type { DaemonStorage } from '../../../src/adapters/storage/session-storage.ts';

const ID = 'alpha-00001';

type IndexedStatus = 'running' | 'completed' | undefined;

/**
 * A frozen config document whose `mode` counts how often it is read: the schema reads every field it validates,
 * so the count is the number of times the document was parsed.
 */
const countedConfig = (overrides: Record<string, unknown> = {}) => {
  const reads = { mode: 0 };
  const config = Object.freeze(
    Object.defineProperties(
      { updatedAt: '2026-10-01T10:00:00.000Z', ...overrides },
      {
        mode: {
          enumerable: true,
          get: () => {
            reads.mode += 1;
            return 'auto';
          },
        },
      },
    ),
  );
  return { config, reads };
};

const build = (document: () => unknown, status: () => IndexedStatus) => {
  const storage = {
    findSession: () => ({ id: ID, status: status() }),
    readConfig: async () => document(),
    listSessions: () => [],
  } as unknown as Pick<DaemonStorage, 'findSession' | 'readConfig' | 'listSessions'>;
  return new StorageHomeSessions(storage);
};

describe('StorageHomeSessions.get', () => {
  it('should validate a config once while the storage hands back the same frozen document', async () => {
    // Arrange
    const { config, reads } = countedConfig({ parent: 'root-00001' });
    const sessions = build(
      () => config,
      () => 'running',
    );

    // Act
    const first = await sessions.get(ID);
    const second = await sessions.get(ID);

    // Assert
    should(reads.mode).equal(1);
    should(second).deepEqual(first);
    should(second).match({ id: ID, parent: 'root-00001', mode: 'auto', live: true });
  });

  it('should validate again once the document is a new one, and see what changed in it', async () => {
    // Arrange
    const before = countedConfig({ parent: 'root-00001' });
    const after = countedConfig({ parent: 'root-00002' });
    let current = before.config;
    const sessions = build(
      () => current,
      () => 'running',
    );

    // Act
    const first = await sessions.get(ID);
    current = after.config;
    const second = await sessions.get(ID);

    // Assert
    should(before.reads.mode).equal(1);
    should(after.reads.mode).equal(1);
    should(first?.parent).equal('root-00001');
    should(second?.parent).equal('root-00002');
  });

  it('should follow the index status on every call, even for a document it has already validated', async () => {
    // Arrange
    const { config } = countedConfig();
    let status: IndexedStatus = 'running';
    const sessions = build(
      () => config,
      () => status,
    );

    // Act
    const running = await sessions.get(ID);
    status = 'completed';
    const exited = await sessions.get(ID);
    status = undefined;
    const unknown = await sessions.get(ID);

    // Assert
    should(running?.live).equal(true);
    should(exited?.live).equal(false);
    should(unknown).not.have.property('live');
  });

  it('should remember a rejected document too, and still refuse it', async () => {
    // Arrange
    const rejected = Object.freeze({ mode: 7 });
    const sessions = build(
      () => rejected,
      () => 'running',
    );

    // Act / Assert
    should(await sessions.get(ID)).equal(undefined);
    should(await sessions.get(ID)).equal(undefined);
  });
});
