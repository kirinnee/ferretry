/**
 * THE ARCHIVE REGISTRY IS ONE SERIAL READ-MODIFY-WRITE, AND ARCHIVING LETS GO OF WHAT WATCHED THE SESSION.
 *
 * Writers on different session lanes (a revival of one session, an archive pass over others) all change the one
 * registry document. Each change must be computed from the registry as it is when ITS turn comes; one derived before
 * queueing is a lost update that archives a live session again (docs/session-archive.md).
 *
 * In-memory collaborators only: the registry document, the index and the watch hub are doubles, so what is pinned is
 * the storage's own ordering and bookkeeping.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { DaemonStorage } from '../../../daemon/adapters/storage/session-storage.ts';
import { createFoundationPaths, createSessionPaths } from '../../src/lib/paths.ts';
import { parseSessionId, type SessionId } from '../../../daemon/lib/session-id.ts';
import { serializeArchiveRegistry } from '../../../daemon/lib/session/archive/registry.ts';

const NOW = '2026-11-06T12:00:00.000Z';
const paths = createFoundationPaths('/state-home-that-is-never-touched' as never);
/** The name of a session's version marker, whatever session directory holds it. */
const MARKER_FILE = `/${createSessionPaths(paths, parseSessionId('x')).marker.split('/').at(-1) ?? ''}`;

const indexed = (id: SessionId) => ({
  id,
  status: 'completed',
  lastSequence: 0,
  journalLine: 1,
  journal: null,
});

/** A storage over an in-memory registry that already lists `archivedIds`. */
async function archivedStorage(archivedIds: readonly string[], live: readonly string[] = []) {
  const ids = archivedIds.map(parseSessionId);
  let document = serializeArchiveRegistry(new Map(ids.map(id => [id, { archivedAt: NOW, indexed: indexed(id) }])));
  const rows = new Map(live.map(name => [name, indexed(parseSessionId(name))]));
  const storage = new DaemonStorage(
    paths,
    {
      // Only the registry is a document here. A revival also proves the session's own marker — a current one —
      // and finds no config, which is what a session with nothing written yet looks like.
      readText: async (file: string) =>
        file === paths.archivedSessions ? document : file.endsWith(MARKER_FILE) ? '2\n' : undefined,
      // A write takes a turn of the event loop, so two unserialized writers genuinely overlap.
      writeTextAtomic: async (_file: string, text: string) => {
        await Promise.resolve();
        await Promise.resolve();
        document = text;
      },
    } as never,
    {
      findSession: (id: string) => rows.get(id),
      removeSession: (id: string) => rows.delete(id),
      listSessions: () => [...rows.values()],
    } as never,
    { now: () => NOW },
    { runAcross: async (_ids: unknown, work: () => Promise<unknown>) => await work() } as never,
    {} as never,
  );
  // This contract isolates registry ordering; the real journal reindex is exercised by keep-publications.test.ts.
  (storage as unknown as { syncSessionUnlocked(id: SessionId): Promise<void> }).syncSessionUnlocked = async id => {
    rows.set(id, indexed(id));
  };
  await storage.loadArchive();
  const registered = (): string[] => Object.keys(JSON.parse(document).sessions).sort();
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
    should(registered()).deepEqual([]);
  });

  it('should keep a session archived by a pass when an unrelated archived session is revived meanwhile', async () => {
    const { storage, registered, revive } = await archivedStorage(['a-1'], ['c-1']);

    const [, left] = await Promise.all([
      revive('a-1'),
      storage.archiveSessions([parseSessionId('c-1')], async () => ({})),
    ]);

    should(left).deepEqual(['c-1']);
    should(storage.listArchivedSessions().map(row => row.id)).deepEqual(['c-1']);
    should(registered()).deepEqual(['c-1']);
  });

  it('should not bring a revived session back when an archive pass publishes after it', async () => {
    const { storage, registered, revive } = await archivedStorage(['a-1'], ['c-1', 'd-1']);

    await Promise.all([
      storage.archiveSessions([parseSessionId('c-1')], async () => ({})),
      revive('a-1'),
      storage.archiveSessions([parseSessionId('d-1')], async () => ({})),
    ]);

    should(storage.isArchived(parseSessionId('a-1'))).be.false();
    should(registered()).deepEqual(['c-1', 'd-1']);
  });

  it('should publish nothing in memory when the registry write fails, and keep working after', async () => {
    let failing = true;
    let document = serializeArchiveRegistry(new Map());
    const id = parseSessionId('c-1');
    const rows = new Map([[id as string, indexed(id)]]);
    const storage = new DaemonStorage(
      paths,
      {
        readText: async () => document,
        writeTextAtomic: async (_file: string, text: string) => {
          if (failing) throw new Error('disk full');
          document = text;
        },
      } as never,
      {
        findSession: (name: string) => rows.get(name),
        removeSession: (name: string) => rows.delete(name),
        listSessions: () => [...rows.values()],
      } as never,
      { now: () => NOW },
      { runAcross: async (_ids: unknown, work: () => Promise<unknown>) => await work() } as never,
      {} as never,
    );
    await storage.loadArchive();

    await should(storage.archiveSessions([id], async () => ({}))).be.rejectedWith('disk full');
    should(storage.isArchived(id)).be.false();
    should(rows.has('c-1')).be.true();

    failing = false;
    should(await storage.archiveSessions([id], async () => ({}))).deepEqual([id]);
    should(storage.isArchived(id)).be.true();
  });
});

describe('archiving a session lets go of the watches that were held for it', () => {
  it('should close every watch on the session documents it had opened', async () => {
    const id = parseSessionId('old-1');
    const sessionPaths = createSessionPaths(paths, id);
    let subscriptions = 0;
    let closed = 0;
    const rows = new Map([[id as string, indexed(id)]]);
    const storage = new DaemonStorage(
      paths,
      {
        identity: async () => 'same',
        readTextIdentified: async (file: string) => ({
          identity: 'same',
          text: file === sessionPaths.marker ? '2\n' : '{}',
        }),
        writeTextAtomic: async () => undefined,
      } as never,
      {
        findSession: (name: string) => rows.get(name),
        removeSession: (name: string) => rows.delete(name),
        listSessions: () => [...rows.values()],
      } as never,
      { now: () => NOW },
      { runAcross: async (_ids: unknown, work: () => Promise<unknown>) => await work() } as never,
      {} as never,
      {
        subscribe: () => {
          subscriptions += 1;
          return {
            live: () => true,
            close: () => {
              closed += 1;
            },
          };
        },
      },
    );
    await storage.readConfig(id, 'heard');
    await storage.readConfig(id, 'heard');
    should(subscriptions).equal(2);

    await storage.archiveSessions([id], async () => ({}));

    should(closed).equal(2);
  });
});
