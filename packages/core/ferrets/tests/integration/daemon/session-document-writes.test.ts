/**
 * A CONFIG OR STATE WRITE REFRESHES ONLY A SESSION'S METADATA (&F4319).
 *
 * Every `writeConfig`, `writeState` and `updateConfig`/`updateState` used to re-index its session from scratch: it
 * re-read the whole journal, planned every event and queued a `replace-session` carrying one pointer per event. The
 * owner's longest journal holds 236,562 events (50 MB); one `writeState` of a copy of it cost 1.5-2.0 s on 4.291.19 and
 * 13-54 ms once only the metadata moved. A spy index counts which kind of write each document write made.
 */
import { afterEach, describe, it } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StatePort } from '@ferretry/kernel/contract';
import { state as hostState } from '@ferretry/kernel/host';
import should from 'should';
import { DaemonStorage } from '../../../daemon/adapters/storage/session-storage.ts';
import { FerretHistoryFiles } from '../../../contract/index.ts';
import { ListedSessionIndex } from '../../../daemon/adapters/storage/listed-session-index.ts';
import { StateSqliteIndex } from '../../../daemon/adapters/storage/sqlite-index.ts';
import { FerretIndexFile } from '../../../contract/index.ts';
import type { SessionIndex } from '../../../daemon/lib/ports.ts';
import { parseSessionId } from '../../../daemon/lib/session-id.ts';
import { createSessionEvent, encodeSessionEvent } from '../../../daemon/lib/storage/journal.ts';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import {
  memoryStorage,
  RecordingLog,
  sessionConfig,
  sessionState,
  SESSION_STORE_FILES,
} from '../../support/daemon/storage.ts';

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

describe('a journal that cannot be taken as the one the index describes', () => {
  it('should index in full, and remember nothing, when the journal could not be read to its end', async () => {
    // Arrange — an io fault cuts the read of a 3-event journal short: the sync indexes what it got.
    const fault = { lines: false };
    const { storage, calls } = await indexed(3, port => ({
      ...port,
      lines: (file, name) => {
        if (fault.lines) throw new Error('EIO');
        return port.lines(file, name);
      },
    }));
    fault.lines = true;
    await storage.syncSession(ID);
    fault.lines = false;
    calls.length = 0;

    // Act — the fault is gone; the next document write must not trust the half-read row.
    await storage.writeState(ID, sessionState(ID, { status: 'waiting' }));

    // Assert — a full sync, and the row is what a healthy one gives.
    should(calls).eql(['replaceSession']);
    const row = storage.findSession(ID);
    should([row?.lastSequence, row?.journalLine, row?.journal?.size]).eql([3, 4, 3]);
  });

  it('should index in full when the journal identity is not settled (a coarse or too recent stamp)', async () => {
    // Arrange
    const unsettled = { on: false };
    const { storage, calls } = await indexed(3, port => ({
      ...port,
      version: async (file, name) => {
        const version = await port.version(file, name);
        return version === undefined || !unsettled.on ? version : { ...version, settled: false };
      },
    }));
    unsettled.on = true;

    // Act
    await storage.writeState(ID, sessionState(ID, { status: 'waiting' }));

    // Assert
    should(calls).eql(['replaceSession']);
  });
});

describe('on a real filesystem', () => {
  const homes: string[] = [];
  afterEach(async () => {
    for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
  });

  /** A storage on the kernel's real state port over the real disk, its index counted. */
  async function onDisk() {
    const home = await mkdtemp(join(tmpdir(), 'fy-docwrite-'));
    homes.push(home);
    const calls: string[] = [];
    const folder = new MemoryStateFolder();
    const state = hostState.createStatePort({
      home,
      pluginId: 'ferrets',
      files: SESSION_STORE_FILES,
      fs: hostState.createNodeHostFs(),
    });
    const storage = new DaemonStorage(state, { now: () => LATER }, new RecordingLog(), spiedIndex(folder, calls));
    await storage.loadArchive();
    const journal = join(hostState.pluginStateRoot(home, 'ferrets'), ID, 'history.jsonl');
    return { storage, calls, journal };
  }
  /** Long enough that the journal's ctime is out of the racy window. */
  const settle = async (): Promise<void> => await new Promise(resolve => setTimeout(resolve, 60));

  it('should refresh only the metadata of a journal that has been quiet', async () => {
    // Arrange
    const { storage, calls } = await onDisk();
    await storage.writeConfig(ID, sessionConfig(ID));
    await storage.append(ID, 'note', { n: 1 });
    await settle();
    await storage.syncSession(ID);
    calls.length = 0;

    // Act
    await storage.writeState(ID, sessionState(ID, { status: 'waiting' }));

    // Assert
    should(calls).eql(['refreshSession']);
    should(storage.findSession(ID)?.status).equal('waiting');
  });

  it('should index in full a journal rewritten in place at the same length with its mtime put back', async () => {
    // Arrange — sequence 1 indexed; the journal then becomes sequence 9 byte for byte the same length, and `utimes`
    // restores the mtime. The inode, size and mtime are all as they were; the ctime cannot be.
    const { storage, calls, journal } = await onDisk();
    await storage.writeConfig(ID, sessionConfig(ID));
    await storage.append(ID, 'note', { n: 1 });
    await settle();
    await storage.syncSession(ID);
    should(storage.findSession(ID)?.lastSequence).equal(1);
    const before = await stat(journal, { bigint: true });
    // `touch -r` puts the exact nanosecond timestamps of the original back, as an attacker's `futimens` would.
    const original = `${journal}.original`;
    await writeFile(original, '');
    await new Promise<void>((resolve, reject) =>
      execFile('touch', ['-r', journal, original], error => (error ? reject(error) : resolve())),
    );
    const text = await readFile(journal, 'utf8');
    await writeFile(journal, text.replace('"sequence":1', '"sequence":9'));
    await new Promise<void>((resolve, reject) =>
      execFile('touch', ['-r', original, journal], error => (error ? reject(error) : resolve())),
    );
    const after = await stat(journal, { bigint: true });
    should([after.ino, after.size, after.mtimeNs]).eql([before.ino, before.size, before.mtimeNs]);
    should(after.ctimeNs).not.equal(before.ctimeNs);
    await settle();
    calls.length = 0;

    // Act
    await storage.writeState(ID, sessionState(ID, { status: 'waiting' }));

    // Assert — the full sync saw sequence 9.
    should(calls).eql(['replaceSession']);
    should(storage.findSession(ID)?.lastSequence).equal(9);
  });
});
