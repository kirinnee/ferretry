/**
 * A CONFIG OR STATE WRITE REFRESHES ONLY A SESSION'S METADATA (&F4319).
 *
 * Every `writeConfig`, `writeState` and `updateConfig`/`updateState` used to re-index its session from scratch: it
 * re-read the whole journal, planned every event and queued a `replace-session` carrying one pointer per event. The
 * owner's longest journal holds 236,562 events (50 MB); one `writeState` of a copy of it cost 1.5-2.0 s on 4.291.19 and
 * 13-54 ms once only the metadata moved. A spy index counts which kind of write each document write made.
 */
import { describe, it } from 'bun:test';
import type { StatePort } from '@ferretry/kernel/contract';
import should from 'should';
import { FerretHistoryFiles } from '../../../contract/index.ts';
import { ListedSessionIndex } from '../../../daemon/adapters/storage/listed-session-index.ts';
import { StateSqliteIndex } from '../../../daemon/adapters/storage/sqlite-index.ts';
import { FerretIndexFile } from '../../../contract/index.ts';
import type { SessionIndex } from '../../../daemon/lib/ports.ts';
import { parseSessionId } from '../../../daemon/lib/session-id.ts';
import { createSessionEvent, encodeSessionEvent } from '../../../daemon/lib/storage/journal.ts';
import type { MemoryStateFolder } from '@ferretry/kernel/testing';
import { memoryStorage, sessionConfig, sessionState, SESSION_STORE_FILES } from '../../support/daemon/storage.ts';

const ID = parseSessionId('docwrite-1');
const LATER = '2026-11-16T05:10:00.000Z';

/** The real index, with every whole-session write counted by kind. */
function spiedIndex(folder: MemoryStateFolder, calls: string[]): SessionIndex {
  const real = new ListedSessionIndex(new StateSqliteIndex(folder.port(SESSION_STORE_FILES).sqlite(FerretIndexFile)));
  return new Proxy(real, {
    get: (target, property) => {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (property === 'replaceSession' || property === 'refreshSession')
        return (...args: unknown[]) => {
          calls.push(property);
          return value.apply(target, args);
        };
      return value.bind(target);
    },
  });
}

/** A session with a journal of `events` events, indexed, with the calls of that set-up forgotten. */
async function indexed(events: number, wrapState?: (port: StatePort) => StatePort) {
  const calls: string[] = [];
  const world = await memoryStorage({ index: folder => spiedIndex(folder, calls), wrapState });
  await world.storage.writeConfig(ID, sessionConfig(ID));
  await world.storage.writeState(ID, sessionState(ID));
  for (let n = 0; n < events; n++) await world.storage.append(ID, 'note', { n });
  calls.length = 0;
  return { ...world, calls };
}

describe('a config or state write to a session whose journal is indexed', () => {
  it('should refresh only its metadata: no replace, every pointer kept, the row what a full rescan gives', async () => {
    // Arrange
    const { storage, calls } = await indexed(40);
    const pointers = (await storage.replay(ID)).events.map(event => event.sequence);

    // Act
    await storage.writeState(ID, sessionState(ID, { status: 'waiting', lastActivityAt: LATER }));
    await storage.writeConfig(ID, sessionConfig(ID, { name: 'renamed', updatedAt: LATER }));
    await storage.updateConfig(ID, current => ({ ...(current as object), name: 'kept' }));
    await storage.updateState(ID, current => ({ ...(current as object), turn: 7 }));

    // Assert — four metadata refreshes and no whole-session write; the metadata is current, the replay intact.
    should(calls).eql(['refreshSession', 'refreshSession', 'refreshSession', 'refreshSession']);
    const refreshed = storage.findSession(ID);
    should(refreshed?.status).equal('waiting');
    should(refreshed?.updatedAt).equal(LATER);
    should(refreshed?.lastSequence).equal(40);
    should((await storage.replay(ID)).events.map(event => event.sequence)).eql(pointers);
    // The refreshed row is exactly what a full rescan of the same documents and journal produces.
    await storage.syncSession(ID);
    should(storage.findSession(ID)).eql(refreshed);
    should(calls.at(-1)).equal('replaceSession');
  });

  it('should keep refreshing across appends: an append leaves the journal the index describes', async () => {
    // Arrange
    const { storage, calls } = await indexed(3);
    await storage.append(ID, 'note', { n: 3 });
    calls.length = 0;

    // Act
    await storage.writeState(ID, sessionState(ID, { status: 'thinking' }));

    // Assert
    should(calls).eql(['refreshSession']);
    should(storage.findSession(ID)?.lastSequence).equal(4);
  });

  it('should re-index the session in full when its journal moved behind the index', async () => {
    // Arrange — a line the storage never saw: the index no longer describes the journal.
    const { storage, folder, calls } = await indexed(3);
    const behind = createSessionEvent(ID, 3, LATER, 'note', { n: 'behind' });
    await folder.port(SESSION_STORE_FILES).append(FerretHistoryFiles, encodeSessionEvent(behind), ID);

    // Act
    await storage.writeState(ID, sessionState(ID, { status: 'waiting' }));

    // Assert
    should(calls).eql(['replaceSession']);
    should(storage.findSession(ID)?.lastSequence).equal(4);
    should((await storage.replay(ID)).events).have.length(4);
  });

  it('should re-index the session in full when its indexed row was changed under the storage', async () => {
    // Arrange — the file is the one the storage recorded, but the row now carries another fingerprint.
    const { storage, calls } = await indexed(3);
    const row = storage.findSession(ID);
    if (row?.journal == null) throw new Error('the session should be indexed with a journal');
    const index = (storage as unknown as { index: SessionIndex }).index;
    index.refreshSession({ ...row, journal: { ...row.journal, size: row.journal.size + 5 } });
    calls.length = 0;

    // Act
    await storage.writeState(ID, sessionState(ID, { status: 'waiting' }));

    // Assert
    should(calls).eql(['replaceSession']);
    should(storage.findSession(ID)?.journal?.size).equal(row.journal.size);
  });

  it('should index a session that is not indexed yet in full', async () => {
    // Arrange — documents and a journal on disk that no storage has indexed.
    const calls: string[] = [];
    const first = await memoryStorage();
    await first.storage.writeConfig(ID, sessionConfig(ID));
    await first.storage.append(ID, 'note', { n: 0 });
    const second = await memoryStorage({ folder: first.folder, index: () => spiedIndex(first.folder, calls) });
    (second.storage as unknown as { index: SessionIndex }).index.removeSession(ID);
    calls.length = 0;

    // Act
    await second.storage.writeState(ID, sessionState(ID, { status: 'starting' }));

    // Assert
    should(calls).eql(['replaceSession']);
    should(second.storage.findSession(ID)?.status).equal('starting');
    should(second.storage.findSession(ID)?.lastSequence).equal(1);
  });

  it('should index in full, never refresh, a session whose journal has no lines', async () => {
    // Arrange
    const calls: string[] = [];
    const { storage } = await memoryStorage({ index: folder => spiedIndex(folder, calls) });

    // Act
    await storage.writeState(ID, sessionState(ID));
    await storage.writeState(ID, sessionState(ID, { status: 'waiting' }));

    // Assert
    should(calls).eql(['replaceSession', 'replaceSession']);
    should(storage.findSession(ID)?.journal).be.null();
  });

  it('should fall back to the full sync when the journal identity cannot be told', async () => {
    // Arrange — `version` fails: nothing can be proved unchanged, so nothing is skipped.
    const failure = { version: false };
    const { storage, calls } = await indexed(3, port => ({
      ...port,
      version: async (file, name) => {
        if (failure.version) throw new Error('lstat failed');
        return await port.version(file, name);
      },
    }));
    failure.version = true;

    // Act
    await storage.writeState(ID, sessionState(ID, { status: 'waiting' }));

    // Assert
    should(calls).eql(['replaceSession']);
    should(storage.findSession(ID)?.status).equal('waiting');
  });
});
