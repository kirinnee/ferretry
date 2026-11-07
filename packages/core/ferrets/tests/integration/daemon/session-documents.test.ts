/**
 * A SESSION'S DOCUMENTS THROUGH THE STATE PORT: what a reader is handed, what a writer sees, and what the config
 * count promises a reader that derives something from every config.
 *
 * The surviving assertions of today's `session-document-cache.test.ts` and `session-document-watch.test.ts`. The
 * identity cache and its watches are gone (the state port proves every read), so what is pinned is the contract the
 * cache had to keep: frozen documents, read-your-own-write, an outside edit seen at once, a damaged document refused
 * every time, and a config count that moves only after the write is published.
 */
import { describe, it } from 'bun:test';
import type { StatePort } from '@ferretry/kernel/contract';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import should from 'should';
import { DaemonStorage, InvalidStateDocumentError } from '../../../daemon/adapters/storage/session-storage.ts';
import { parseSessionId } from '../../../daemon/lib/session-id.ts';
import { SessionConfigFiles, SessionStateFiles } from '../../../daemon/lib/state.ts';
import { RecordingLog, SESSION_STORE_FILES, sessionConfig, sessionState } from '../../support/daemon/storage.ts';

const ID = parseSessionId('cached-1');

/** A storage whose writes can be made to land and then throw, as a write that renamed and then failed its sync. */
async function seeded() {
  const folder = new MemoryStateFolder();
  const real = folder.port(SESSION_STORE_FILES);
  const failure = { afterWrite: false };
  const state: StatePort = {
    ...real,
    write: async (file, value, name) => {
      await real.write(file, value, name);
      if (failure.afterWrite) throw new Error('fsync failed after the rename');
    },
  };
  const storage = new DaemonStorage(state, { now: () => '2026-07-31T09:00:00.000Z' }, new RecordingLog());
  await storage.loadArchive();
  await storage.writeConfig(ID, sessionConfig(ID));
  await storage.writeState(ID, sessionState(ID, { turn: 1, openTools: ['bash'] }));
  await storage.append(ID, 'session.created', {});
  return { storage, folder, raw: real, failure };
}

describe('session documents', () => {
  it('should hand out a frozen document, so no caller can change what the next one reads', async () => {
    // Arrange
    const { storage } = await seeded();
    const first = (await storage.readState(ID)) as Record<string, unknown>;

    // Act — this module is strict, so a write to a frozen object throws rather than failing silently.
    const tamper = () => {
      first.status = 'tampered';
    };
    const tamperNested = () => {
      (first.openTools as unknown[]).push('tampered');
    };
    const second = (await storage.readState(ID)) as Record<string, unknown>;

    // Assert — frozen all the way down.
    should(tamper).throw(TypeError);
    should(tamperNested).throw(TypeError);
    should(Object.isFrozen(first.openTools)).be.true();
    should(second.status).equal('running');
  });

  it('should hand out a new instance after a write, and leave the one already handed out as it was', async () => {
    // Arrange
    const { storage } = await seeded();
    const before = (await storage.readState(ID)) as Record<string, unknown>;

    // Act
    await storage.updateState(ID, raw => ({ ...(raw as Record<string, unknown>), status: 'stopped' }));
    const after = (await storage.readState(ID)) as Record<string, unknown>;

    // Assert
    should(after).not.equal(before);
    should(after.status).equal('stopped');
    should(before.status).equal('running');
    should(Object.isFrozen(after)).be.true();
  });

  it('should see its own writes at once', async () => {
    // Arrange
    const { storage } = await seeded();
    await storage.readState(ID);

    // Act
    await storage.updateState(ID, current => ({ ...(current as Record<string, unknown>), turn: 2 }));
    await storage.writeConfig(ID, sessionConfig(ID, { name: 'Written' }));

    // Assert
    should(((await storage.readState(ID)) as Record<string, unknown>).turn).equal(2);
    should(((await storage.readConfig(ID)) as Record<string, unknown>).name).equal('Written');
  });

  it('should hand each upsert what the last one wrote', async () => {
    // Arrange
    const { storage } = await seeded();
    await storage.upsertConfig(ID, () => sessionConfig(ID, { name: 'Created' }));
    await storage.readState(ID);
    const handed: unknown[] = [];

    // Act
    await storage.upsertState(ID, current => {
      handed.push(current);
      return { ...(current as Record<string, unknown>), turn: 2 };
    });
    await storage.upsertState(ID, current => {
      handed.push(current);
      return { ...(current as Record<string, unknown>), turnState: 'working' };
    });
    await storage.upsertConfig(ID, current => ({ ...(current as Record<string, unknown>), name: 'Renamed' }));

    // Assert
    should(handed).deepEqual([
      sessionState(ID, { turn: 1, openTools: ['bash'] }),
      sessionState(ID, { turn: 2, openTools: ['bash'] }),
    ]);
    should(await storage.readState(ID)).deepEqual(sessionState(ID, { turn: 2, openTools: ['bash'], turnState: 'working' }));
    should(await storage.readConfig(ID)).deepEqual(sessionConfig(ID, { name: 'Renamed' }));
  });

  it('should see another writer replace the document', async () => {
    // Arrange
    const { storage, raw } = await seeded();
    await storage.readState(ID);

    // Act
    await raw.write(SessionStateFiles, sessionState(ID, { status: 'stopped', turn: 1 }) as never, ID);
    const replaced = (await storage.readState(ID)) as Record<string, unknown>;

    // Assert
    should(replaced.status).equal('stopped');
  });

  it('should refuse a damaged document every time it is read', async () => {
    // Arrange
    const { storage, folder } = await seeded();
    folder.plant(SessionStateFiles, '{ not json', ID);

    // Act / Assert
    for (let attempt = 0; attempt < 2; attempt += 1)
      should(await storage.readState(ID).catch((error: unknown) => error)).be.instanceof(InvalidStateDocumentError);
  });

  it('should refuse to write a document its schema refuses, and leave the stored one as it was', async () => {
    // Arrange
    const { storage } = await seeded();

    // Act
    const refused = await storage.writeState(ID, { id: ID, status: 'not-a-status', turn: 1 }).catch(error => error);

    // Assert
    should(refused).be.instanceof(InvalidStateDocumentError);
    should(((await storage.readState(ID)) as Record<string, unknown>).status).equal('running');
  });

  it('should answer that a document that is gone is gone', async () => {
    // Arrange
    const { storage, raw } = await seeded();
    await storage.readConfig(ID);

    // Act
    await raw.remove(SessionConfigFiles, ID);

    // Assert
    should(await storage.readConfig(ID)).be.undefined();
  });
});

describe('the config count', () => {
  it('should count every config it writes, and nothing else, for a reader that derives from every config', async () => {
    // Arrange
    const { storage } = await seeded();
    const seededWrites = storage.configWrites();

    // Act
    await storage.writeConfig(ID, sessionConfig(ID, { turn: 2 }));
    await storage.updateConfig(ID, current => ({ ...(current as Record<string, unknown>), turn: 3 }));
    await storage.writeState(ID, sessionState(ID, { turn: 3 }));
    await storage.updateState(ID, current => ({ ...(current as Record<string, unknown>), turn: 4 }));

    // Assert — the seed's one config write, then one per config write; a state write is not a config.
    should(seededWrites).equal(1);
    should(storage.configWrites()).equal(3);
  });

  it('should count a config write that landed and then threw', async () => {
    // Arrange
    const { storage, failure } = await seeded();
    const before = storage.configWrites();

    // Act
    failure.afterWrite = true;
    const written = await storage.writeConfig(ID, sessionConfig(ID, { turn: 7 })).then(
      () => undefined,
      (error: Error) => error,
    );
    const updated = await storage
      .updateConfig(ID, current => ({ ...(current as Record<string, unknown>), turn: 9 }))
      .then(
        () => undefined,
        (error: Error) => error,
      );
    failure.afterWrite = false;

    // Assert — the document changed under each failed call, and the stamp says so.
    should(written?.message).equal('fsync failed after the rename');
    should(updated?.message).equal('fsync failed after the rename');
    should(storage.configWrites()).equal(before + 2);
    should((await storage.readConfig(ID)) as Record<string, unknown>).have.property('turn', 9);
  });

  it('should move the config count only once a new session is listed, so a scan that raced the write is never trusted', async () => {
    // Arrange
    const { storage } = await seeded();
    const added = parseSessionId('watched-2');
    const before = storage.configWrites();
    const observed: Array<{ readonly moved: boolean; readonly listed: boolean }> = [];

    // Act — sample the count and the roster between every step of the write.
    let settled = false;
    const writing = storage.writeConfig(added, sessionConfig(added)).finally(() => {
      settled = true;
    });
    while (!settled) {
      observed.push({
        moved: storage.configWrites() > before,
        listed: storage.listSessions().some(session => session.id === added),
      });
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    await writing;

    // Assert — whenever the count had moved, the member was already published to the roster.
    should(observed.some(sample => !sample.moved && !sample.listed)).be.true();
    should(observed.filter(sample => sample.moved && !sample.listed)).deepEqual([]);
    should(storage.configWrites()).equal(before + 1);
    should(storage.listSessions().some(session => session.id === added)).be.true();
  });
});
