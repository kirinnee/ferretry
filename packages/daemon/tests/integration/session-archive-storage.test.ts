/**
 * A SESSION THAT LEFT THE LIVE SET IS STILL THERE — AND COMES BACK WHEN SOMETHING WRITES TO IT.
 *
 * Archiving takes a session out of the index, the sessions-directory walks and the survey, and records it in one
 * registry document. Nothing on disk moves. These pin what that promises: the live set shrinks, an archived session
 * stays readable, replayable and findable, the registry survives a reopen, a write brings the session back, and a
 * session that changed since the decision is not archived (docs/session-archive.md).
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  BunSqliteIndexFactory,
  type DaemonStorage,
  DaemonStorageFactory,
  KeyedSerialExecutor,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystem,
  StateHomeLayout,
  SystemClock,
} from '../../src/adapters/index.ts';
import { createSessionPaths, type FoundationPaths, parseSessionId } from '../../src/lib/index.ts';

const homes: string[] = [];
const stores: DaemonStorage[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close().catch(() => undefined);
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function open(existing?: string) {
  const home = existing ?? (await mkdtemp(join(tmpdir(), 'fy-session-archive-')));
  if (existing === undefined) homes.push(home);
  const factory = new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: home }, () => '/home-must-not-be-used'),
    { create: (paths: FoundationPaths) => new StateFileSystem(paths) },
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(),
    () => new KeyedSerialExecutor(),
  );
  const opened = await factory.open();
  stores.push(opened.storage);
  return { home, storage: opened.storage, paths: opened.paths };
}

const OLD = parseSessionId('old-1');
const LIVE = parseSessionId('live-1');

async function seeded() {
  const opened = await open();
  for (const [id, status] of [
    [OLD, 'completed'],
    [LIVE, 'running'],
  ] as const) {
    await opened.storage.writeConfig(id, { id, mode: 'auto' });
    await opened.storage.writeState(id, { id, status, finishedAt: '2026-11-01T00:00:00.000Z' });
    await opened.storage.append(id, 'session.created', { n: 1 });
    await opened.storage.append(id, 'session.note', { n: 2 });
  }
  return opened;
}

const always = async (): Promise<{ name?: string }> => ({});

describe('archiving a session in storage', () => {
  it('should take the session out of the live list and the survey, and leave its directory where it was', async () => {
    const { storage, paths } = await seeded();

    const left = await storage.archiveSessions([OLD], always);

    should(left).deepEqual([OLD]);
    should(storage.listSessions().map(session => session.id)).deepEqual([LIVE]);
    should((await storage.surveySessionDirectories()).map(session => session.id)).deepEqual([LIVE]);
    should(storage.archivedCount()).equal(1);
    should(storage.isArchived(OLD)).be.true();
    should((await stat(createSessionPaths(paths, OLD).directory)).isDirectory()).be.true();
  });

  it('should still find the session, read its documents and replay its journal', async () => {
    const { storage } = await seeded();
    await storage.archiveSessions([OLD], always);

    const found = storage.findSession(OLD);
    const state = await storage.readState(OLD);
    const config = await storage.readConfig(OLD);
    const page = await storage.replay(OLD);

    should(found?.id).equal(OLD);
    should(found?.lastSequence).equal(2);
    should((state as Record<string, unknown>).status).equal('completed');
    should((config as Record<string, unknown>).mode).equal('auto');
    should(page.events.map(event => event.type)).deepEqual(['session.created', 'session.note']);
    should(page.hasMore).be.false();
    should((await storage.replay(OLD, 1)).events.map(event => event.sequence)).deepEqual([2]);
  });

  it('should list the archived sessions with the instant each left', async () => {
    const { storage } = await seeded();
    await storage.archiveSessions([OLD], always);

    const [only] = storage.listArchivedSessions();

    should(only?.id).equal(OLD);
    should(typeof only?.archivedAt).equal('string');
    should(only?.name).be.undefined();
  });

  it('should not archive a session the check no longer vouches for', async () => {
    const { storage } = await seeded();

    const left = await storage.archiveSessions([OLD, LIVE], async id => (id === OLD ? { name: 'mika' } : undefined));

    should(left).deepEqual([OLD]);
    should(storage.listArchivedSessions()[0]?.name).equal('mika');
    should(storage.listSessions().map(session => session.id)).deepEqual([LIVE]);
    should(await storage.archiveSessions([LIVE], async () => undefined)).deepEqual([]);
    should(storage.archivedCount()).equal(1);
  });

  it('should archive nothing for an id the index does not hold, and nothing twice', async () => {
    const { storage } = await seeded();

    should(await storage.archiveSessions([parseSessionId('ghost-1')], always)).deepEqual([]);
    should(await storage.archiveSessions([OLD], always)).deepEqual([OLD]);
    should(await storage.archiveSessions([OLD], always)).deepEqual([]);
    should(storage.archivedCount()).equal(1);
  });

  it('should not bring an archived session back by rebuilding or reconciling the index', async () => {
    const { storage } = await seeded();
    await storage.archiveSessions([OLD], always);

    await storage.rebuildIndex();
    await storage.reconcile();

    should(storage.listSessions().map(session => session.id)).deepEqual([LIVE]);
    should(storage.isArchived(OLD)).be.true();
  });

  it('should bring the session back when something appends to it', async () => {
    const { storage } = await seeded();
    await storage.archiveSessions([OLD], always);

    await storage.append(OLD, 'session.note', { n: 3 });

    should(storage.isArchived(OLD)).be.false();
    should(storage.archivedCount()).equal(0);
    should(
      storage
        .listSessions()
        .map(session => session.id)
        .sort(),
    ).deepEqual([LIVE, OLD]);
    should(storage.findSession(OLD)?.lastSequence).equal(3);
    should((await storage.replay(OLD)).events).have.length(3);
  });

  it('should bring the session back when its state or config is written', async () => {
    const { storage } = await seeded();
    await storage.archiveSessions([OLD], always);
    await storage.updateState(OLD, current => ({ ...(current as Record<string, unknown>), status: 'running' }));
    should(storage.isArchived(OLD)).be.false();
    should(storage.listSessions().map(session => session.id)).containEql(OLD);

    await storage.archiveSessions([OLD], always);
    await storage.updateConfig(OLD, current => ({ ...(current as Record<string, unknown>), mode: 'interactive' }));
    should(storage.isArchived(OLD)).be.false();

    await storage.archiveSessions([OLD], always);
    await storage.writeState(OLD, { id: OLD, status: 'running' });
    should(storage.isArchived(OLD)).be.false();
  });

  it('should not bring the session back by reading it', async () => {
    const { storage } = await seeded();
    await storage.archiveSessions([OLD], always);

    await storage.readState(OLD);
    await storage.readConfig(OLD);
    await storage.replay(OLD);

    should(storage.isArchived(OLD)).be.true();
  });

  it('should remember the archive across a reopen, and keep its sessions out of the index', async () => {
    const first = await seeded();
    await first.storage.archiveSessions([OLD], always);
    await first.storage.close();

    const second = await open(first.home);

    should(second.storage.archivedCount()).equal(1);
    should(second.storage.listSessions().map(session => session.id)).deepEqual([LIVE]);
    should((await second.storage.replay(OLD)).events).have.length(2);
    await second.storage.append(OLD, 'session.note', { n: 3 });
    should(second.storage.isArchived(OLD)).be.false();
  });

  it('should write the registry as one document in the state home', async () => {
    const { storage, paths } = await seeded();
    await storage.archiveSessions([OLD], always);

    const document = JSON.parse(await readFile(paths.archivedSessions, 'utf8')) as {
      version: number;
      sessions: Record<string, { lastSequence: number }>;
    };

    should(document.version).equal(1);
    should(Object.keys(document.sessions)).deepEqual([OLD]);
    should(document.sessions[OLD]?.lastSequence).equal(2);
  });

  it('should start with every session live when the registry is damaged', async () => {
    const first = await seeded();
    await first.storage.archiveSessions([OLD], always);
    await first.storage.close();
    await writeFile(first.paths.archivedSessions, '{ torn');

    const second = await open(first.home);
    await second.storage.reconcile();

    should(second.storage.archivedCount()).equal(0);
    should(
      second.storage
        .listSessions()
        .map(session => session.id)
        .sort(),
    ).deepEqual([LIVE, OLD]);
  });

  it('should let go of an index row a crash left behind an archive', async () => {
    const first = await seeded();
    await first.storage.close();
    // The registry was written; the process died before the index row went.
    await writeFile(
      first.paths.archivedSessions,
      JSON.stringify({
        version: 1,
        sessions: {
          [OLD]: {
            archivedAt: '2026-11-06T00:00:00.000Z',
            lastSequence: 2,
            journalLine: 3,
            journal: null,
          },
        },
      }),
    );

    const second = await open(first.home);

    should(second.storage.listSessions().map(session => session.id)).deepEqual([LIVE]);
    should(second.storage.isArchived(OLD)).be.true();
  });
});
