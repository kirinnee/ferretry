/**
 * THE ARCHIVE REGISTRY IS ONE SERIAL READ-MODIFY-WRITE.
 *
 * Writers on different session lanes (a revival of one session, an archive pass over others) all change the one
 * registry document. Each change must be computed from the registry as it is when ITS turn comes; one derived before
 * queueing is a lost update that archives a live session again (docs/session-archive.md).
 *
 * Over the kernel test host's state: the registry is the contract's `archive.json`, and each session is a state
 * document, so a revival re-indexes it for real.
 */
import { describe, it } from 'bun:test';
import type { StatePort } from '@ferretry/kernel/contract';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import should from 'should';
import { ArchiveFile, FerretStateFile } from '../../../contract/index.ts';
import { DaemonStorage } from '../../../daemon/adapters/storage/session-storage.ts';
import { parseSessionId, type SessionId } from '../../../daemon/lib/session-id.ts';
import { archiveRegistryValue } from '../../../daemon/lib/storage/archive-registry.ts';
import { RecordingLog, SESSION_STORE_FILES, sessionState } from '../../support/daemon/storage.ts';

const NOW = '2026-11-06T12:00:00.000Z';

const indexed = (id: SessionId) => ({
  id,
  status: 'completed',
  lastSequence: 0,
  journalLine: 1,
  journal: null,
});

/** A storage over a registry that already lists `archivedIds`, with `live` sessions indexed. */
async function archivedStorage(archivedIds: readonly string[], live: readonly string[] = [], port?: StatePort) {
  const folder = new MemoryStateFolder();
  const state = port ?? folder.port(SESSION_STORE_FILES);
  const ids = archivedIds.map(parseSessionId);
  await state.write(
    ArchiveFile,
    archiveRegistryValue(new Map(ids.map(id => [id, { archivedAt: NOW, indexed: indexed(id) }]))),
  );
  for (const name of [...archivedIds, ...live])
    await state.write(FerretStateFile, sessionState(name, { status: 'completed' }) as never, name);
  const storage = new DaemonStorage(state, { now: () => NOW }, new RecordingLog());
  for (const name of live) await storage.syncSession(parseSessionId(name));
  await storage.loadArchive();
  const registered = async (): Promise<string[]> => {
    const read = await state.read(ArchiveFile);
    return Object.keys((read.ok ? (read.value as { sessions: object }) : { sessions: {} }).sessions).sort();
  };
  const revive = async (id: string): Promise<void> =>
    await (storage as unknown as { reviveIfArchived(id: SessionId): Promise<void> }).reviveIfArchived(
      parseSessionId(id),
    );
  return { storage, registered, revive };
}

describe('the archive registry under concurrent writers', () => {
  it('should leave both sessions out of the archive when two archived sessions are revived at once', async () => {
    const { storage, registered, revive } = await archivedStorage(['a-1', 'b-1']);

    await Promise.all([revive('a-1'), revive('b-1')]);

    should(storage.listArchivedSessions().map(row => row.id)).deepEqual([]);
    should(await registered()).deepEqual([]);
  });

  it('should keep a session archived by a pass when an unrelated archived session is revived meanwhile', async () => {
    const { storage, registered, revive } = await archivedStorage(['a-1'], ['c-1']);

    const [, left] = await Promise.all([
      revive('a-1'),
      storage.archiveSessions([parseSessionId('c-1')], async () => ({})),
    ]);

    should(left).deepEqual(['c-1']);
    should(storage.listArchivedSessions().map(row => row.id)).deepEqual(['c-1']);
    should(await registered()).deepEqual(['c-1']);
  });

  it('should not bring a revived session back when an archive pass publishes after it', async () => {
    const { storage, registered, revive } = await archivedStorage(['a-1'], ['c-1', 'd-1']);

    await Promise.all([
      storage.archiveSessions([parseSessionId('c-1')], async () => ({})),
      revive('a-1'),
      storage.archiveSessions([parseSessionId('d-1')], async () => ({})),
    ]);

    should(storage.isArchived(parseSessionId('a-1'))).be.false();
    should(await registered()).deepEqual(['c-1', 'd-1']);
  });

  it('should publish nothing in memory when the registry write fails, and keep working after', async () => {
    let failing = false;
    const real = new MemoryStateFolder().port(SESSION_STORE_FILES);
    const port: StatePort = {
      ...real,
      write: async (file, value, name) => {
        if (failing && file === ArchiveFile) throw new Error('disk full');
        await real.write(file, value, name);
      },
    };
    const { storage } = await archivedStorage([], ['c-1'], port);
    const id = parseSessionId('c-1');
    failing = true;

    await should(storage.archiveSessions([id], async () => ({}))).be.rejectedWith('disk full');
    should(storage.isArchived(id)).be.false();
    should(storage.findSession(id)).not.be.undefined();
    should(storage.listSessions().map(row => row.id)).deepEqual([id]);

    failing = false;
    should(await storage.archiveSessions([id], async () => ({}))).deepEqual([id]);
    should(storage.isArchived(id)).be.true();
  });
});
