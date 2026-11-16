/**
 * THE BOOT RECONCILE DOES NOT READ A JOURNAL THE INDEX ALREADY DESCRIBES (c58-81b).
 *
 * `reconcile` used to read every session's journal whole on every deep pass, the first of them at boot: its proof that a
 * journal was unchanged lived in memory and was empty after a restart, so a 150 MB journal took the idle daemon to
 * 2.8 GB. The version etag of the journal file now lives in the session's index row, so a restart finds it. The state
 * port is wrapped to count every journal read per session.
 */
import { describe, it } from 'bun:test';
import type { StatePort } from '@ferretry/kernel/contract';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import should from 'should';
import { FerretHistoryFiles } from '../../../contract/index.ts';
import type { DaemonStorage } from '../../../daemon/adapters/storage/session-storage.ts';
import type { SessionIndex } from '../../../daemon/lib/ports.ts';
import { parseSessionId } from '../../../daemon/lib/session-id.ts';
import { createSessionEvent, encodeSessionEvent } from '../../../daemon/lib/storage/journal.ts';
import { memoryStorage, SESSION_STORE_FILES, sessionConfig, sessionState, T0 } from '../../support/daemon/storage.ts';

const A = parseSessionId('boot-a');
const B = parseSessionId('boot-b');
const C = parseSessionId('boot-c');
const EVENTS = 4;

/** Journal reads per session, through the state port every read of the storage goes by. */
function counting(reads: Map<string, number>) {
  return (port: StatePort): StatePort => ({
    ...port,
    lines: (file, name) => {
      if (file === FerretHistoryFiles && name !== undefined) reads.set(name, (reads.get(name) ?? 0) + 1);
      return port.lines(file, name);
    },
  });
}

/** Three sessions with journals, written by one storage; then a RESTART: a second storage on the same files. */
async function restarted() {
  const first = await memoryStorage();
  for (const id of [A, B, C]) {
    await first.storage.writeConfig(id, sessionConfig(id));
    await first.storage.writeState(id, sessionState(id));
    for (let n = 0; n < EVENTS; n++) await first.storage.append(id, 'note', { n });
  }
  // An append records no journal version (another writer may land a line in between); the next full read does.
  await first.storage.reconcile();
  const reads = new Map<string, number>();
  const second = await memoryStorage({ folder: first.folder, wrapState: counting(reads) });
  return { ...second, reads, rows: () => [A, B, C].map(id => second.storage.findSession(id)) };
}

/** A line the storage never saw, appended to a journal behind its back. */
async function appendBehind(folder: MemoryStateFolder, id: typeof A, sequence: number): Promise<void> {
  const event = createSessionEvent(id, sequence, T0, 'note', { behind: sequence });
  await folder.port(SESSION_STORE_FILES).append(FerretHistoryFiles, encodeSessionEvent(event), id);
}

function forgetVersion(storage: DaemonStorage, id: typeof A): void {
  const row = storage.findSession(id);
  if (row === undefined) throw new Error('indexed');
  (storage as unknown as { index: SessionIndex }).index.refreshSession({ ...row, journalVersion: undefined });
}

describe('a reconcile after a restart', () => {
  it('should read no journal when none changed, and leave every row as it was', async () => {
    // Arrange
    const { storage, reads, rows } = await restarted();
    const before = rows();
    should(before.map(row => row?.journalVersion)).not.containEql(undefined);

    // Act
    const result = await storage.reconcile();

    // Assert — three sessions, four events each, and not one journal read.
    should(reads.size).equal(0);
    should([result.sessionCount, result.eventCount, result.problems]).eql([3, 3 * EVENTS, []]);
    should(rows()).eql(before);
    should((await storage.replay(A)).events).have.length(EVENTS);
  });

  it('should read only the journal that changed, then record its version so the next pass reads none', async () => {
    // Arrange
    const { storage, folder, reads, rows } = await restarted();
    const [a, , c] = rows();
    await appendBehind(folder, B, EVENTS);

    // Act
    const first = await storage.reconcile();
    const readsAfterFirst = new Map(reads);
    await storage.reconcile();

    // Assert
    should([...readsAfterFirst]).eql([[B, 1]]);
    should(reads).eql(readsAfterFirst);
    should([first.sessionCount, first.eventCount]).eql([3, 3 * EVENTS + 1]);
    should(storage.findSession(B)?.lastSequence).equal(EVENTS + 1);
    should(storage.findSession(A)).eql(a);
    should(storage.findSession(C)).eql(c);
    should((await storage.replay(B)).events).have.length(EVENTS + 1);
  });

  it('should read a row that records no version once and record it', async () => {
    // Arrange — a row from before the version was kept, or one a writer that did not know it left.
    const { storage, reads, rows } = await restarted();
    const before = rows();
    forgetVersion(storage, A);
    should(storage.findSession(A)?.journalVersion).be.undefined();

    // Act
    await storage.reconcile();
    await storage.reconcile();

    // Assert
    should([...reads]).eql([[A, 1]]);
    should(rows()).eql(before);
  });

  it('should read a journal another writer appended to in the middle of an append through the storage', async () => {
    // Arrange — a second writer (another queue) lands a line right after the storage's append, before anything else
    // reads the journal's version.
    const reads = new Map<string, number>();
    const folder = new MemoryStateFolder();
    const behind = folder.port(SESSION_STORE_FILES);
    let armed = false;
    const { storage } = await memoryStorage({
      folder,
      wrapState: port => ({
        ...counting(reads)(port),
        append: async (file, line, name) => {
          await port.append(file, line, name);
          if (armed && file === FerretHistoryFiles && name === A) {
            armed = false;
            const event = createSessionEvent(A, EVENTS + 1, T0, 'note', { behind: EVENTS + 2 });
            await behind.append(FerretHistoryFiles, encodeSessionEvent(event), A);
          }
        },
      }),
    });
    await storage.writeConfig(A, sessionConfig(A));
    await storage.writeState(A, sessionState(A));
    for (let n = 0; n < EVENTS; n++) await storage.append(A, 'note', { n });
    armed = true;
    await storage.append(A, 'note', { n: EVENTS });
    reads.clear();

    // Act
    const result = await storage.reconcile();

    // Assert — the row records no version, so the journal is read, and the line behind is counted.
    should(reads.get(A)).equal(1);
    should(result.eventCount).equal(EVENTS + 2);
    should(storage.findSession(A)?.lastSequence).equal(EVENTS + 2);
    should(storage.findSession(A)?.journalVersion).not.be.undefined();
  });

  it('should still report a journal that vanished, as a read of it did before', async () => {
    // Arrange
    const { storage, folder } = await restarted();
    await folder.port(SESSION_STORE_FILES).remove(FerretHistoryFiles, C);

    // Act
    const result = await storage.reconcile();

    // Assert
    should(result.lostJournalSessionIds).eql([C]);
    should(result.failedSessionIds).eql([C]);
    should(storage.findSession(A)?.lastSequence).equal(EVENTS);
  });

  it('should report a damaged line when it reads the journal that holds it', async () => {
    // Arrange — a line whose sequence goes backwards, appended behind the storage.
    const { storage, folder, reads } = await restarted();
    await appendBehind(folder, B, 1);

    // Act
    const result = await storage.reconcile();

    // Assert — read, so reported, exactly as a read of every journal reported it before.
    should(result.problems.map(problem => problem.message)).eql(['event sequence 2 is not greater than 4']);
    should([...reads]).eql([[B, 1]]);
  });
});

describe('a journal asked about, not read', () => {
  it('should answer that a journal is present, and that one is lost, without reading it', async () => {
    // Arrange
    const { storage, folder, reads } = await restarted();

    // Act
    await storage.assertJournalReadable(A);
    await folder.port(SESSION_STORE_FILES).remove(FerretHistoryFiles, C);
    const lost = await storage.assertJournalReadable(C).then(
      () => undefined,
      (error: unknown) => (error as Error).name,
    );

    // Assert
    should(lost).equal('MissingSessionJournalError');
    should(reads.size).equal(0);
  });
});
