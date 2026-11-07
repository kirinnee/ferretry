import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileAgendaLedgerRepository } from '../../../../src/adapters/agenda/file-agenda-ledger-repository.ts';
import { FileAgentPinRepository } from '../../../../src/adapters/agent-pins/file-agent-pin-repository.ts';
import { FileBoardStore } from '../../../../src/adapters/board/file-board-store.ts';
import {
  BunSqliteIndexFactory,
  DaemonStorageFactory,
  KeyedSerialExecutor,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystem,
  StateHomeLayout,
  SystemClock,
} from '../../../../src/adapters/index.ts';
import type { DaemonStorage } from '../../../../src/adapters/storage/session-storage.ts';
import { AgendaService } from '../../../../src/lib/agenda/service.ts';
import { AgentPinService } from '../../../../src/lib/agent-pins/service.ts';
import { createSessionPaths, parseSessionId } from '../../../../src/lib/index.ts';
import { sessionsOnOpenCards } from '../../../../src/lib/session/archive/open-cards.ts';
import { card } from '../../../unit/board/support.ts';

const homes: string[] = [];
const stores: DaemonStorage[] = [];
const LEAD = parseSessionId('lead-1');
const KID = parseSessionId('kid-1');
const NOW = '2026-11-06T12:00:00.000Z';

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function world() {
  const home = await mkdtemp(join(tmpdir(), 'fy-archive-keeps-'));
  homes.push(home);
  const opened = await new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: home }, () => '/unused'),
    { create: paths => new StateFileSystem(paths) },
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(() => new Date(NOW)),
    () => new KeyedSerialExecutor(),
  ).open();
  const { storage, paths } = opened;
  stores.push(storage);
  for (const id of [LEAD, KID]) {
    await storage.writeConfig(id, { id, mode: 'auto', ...(id === KID ? { parent: LEAD } : {}) });
    await storage.writeState(id, { id, status: 'completed', finishedAt: '2026-11-01T00:00:00Z' });
    await storage.append(id, 'session.created', {});
    await storage.append(id, 'session.note', { kept: 'original journal' });
  }
  await storage.archiveSessions([KID, LEAD], async () => ({}));
  expect(storage.listSessions()).toHaveLength(0);
  return { storage, paths, files: new StateFileSystem(paths) };
}

async function restored(storage: DaemonStorage) {
  expect(storage.archivedCount()).toBe(0);
  expect(
    storage
      .listSessions()
      .map(row => row.id)
      .sort(),
  ).toEqual([KID, LEAD]);
  expect((await storage.replay(KID)).events.map(event => event.type)).toEqual(['session.created', 'session.note']);
}

test('a pin publication alone restores an archived session and its ancestors, including journal pointers', async () => {
  const { storage, paths, files } = await world();
  const pins = new FileAgentPinRepository(paths, files, async id => await storage.retainSession(parseSessionId(id)));
  const entry = [{ sessionId: KID, pinnedAt: NOW }];
  await pins.save(entry);
  await pins.save(entry);
  expect(await pins.load()).toEqual(entry);
  await restored(storage);
});

for (const failAt of [KID, LEAD]) {
  test(`retention retries a journal read EIO at ${failAt} without forgetting archived membership`, async () => {
    const { storage, paths } = await world();
    const files = (storage as unknown as { fileSystem: StateFileSystem }).fileSystem;
    const information = files.information.bind(files);
    let failed = false;
    files.information = async path => {
      if (path === createSessionPaths(paths, failAt).events && !failed) {
        failed = true;
        throw Object.assign(new Error('transient journal read EIO'), { code: 'EIO' });
      }
      return await information(path);
    };
    await expect(storage.retainSession(KID)).rejects.toThrow('transient journal read EIO');
    expect(storage.archivedCount()).toBe(2);
    expect(storage.isArchived(KID)).toBe(true);
    expect(storage.isArchived(LEAD)).toBe(true);
    await storage.retainSession(KID);
    await restored(storage);
  });
}

test('re-pinning retries failed archive retention without rewriting the existing pin document', async () => {
  const { storage, paths, files } = await world();
  const backend = (storage as unknown as { fileSystem: StateFileSystem }).fileSystem;
  const information = backend.information.bind(backend);
  let failed = false;
  backend.information = async path => {
    if (path === createSessionPaths(paths, KID).events && !failed) {
      failed = true;
      throw Object.assign(new Error('transient journal read EIO'), { code: 'EIO' });
    }
    return await information(path);
  };
  const write = files.writeTextAtomic.bind(files);
  let writes = 0;
  files.writeTextAtomic = async (path, text) => {
    writes += 1;
    await write(path, text);
  };
  const repository = new FileAgentPinRepository(
    paths,
    files,
    async id => await storage.retainSession(parseSessionId(id)),
  );
  const pins = new AgentPinService(repository, { now: () => NOW }, new KeyedSerialExecutor());
  await expect(pins.pin(KID)).rejects.toThrow('transient journal read EIO');
  expect(await repository.load()).toEqual([{ sessionId: KID, pinnedAt: NOW }]);
  expect(storage.archivedCount()).toBe(2);
  expect(await pins.pin(KID)).toBe(NOW);
  expect(writes).toBe(1);
  await restored(storage);
});

test('an agenda publication alone restores membership without a state projection or another session write', async () => {
  const { storage, paths } = await world();
  const repository = new FileAgendaLedgerRepository(
    id => createSessionPaths(paths, parseSessionId(id)).directory,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async id => await storage.retainSession(parseSessionId(id)),
  );
  const agenda = new AgendaService(
    repository,
    { now: () => NOW },
    { has: async () => true },
    { raised: async () => {} },
  );
  const result = await agenda.raise(
    KID,
    {
      source: 'agent-raised',
      sourceRef: null,
      subject: 'Choose a region',
      why: 'Ready',
      premise: 'Ready',
      context: 'A region is needed',
      howToResolve: 'Choose',
      ask: { kind: 'permission' },
    },
    { kind: 'agent', sessionId: KID, name: 'Kid' },
  );
  expect(result.ok).toBe(true);
  expect((await repository.read(KID))?.entries.some(item => item.lifecycle === 'active')).toBe(true);
  await restored(storage);
});

test('a card publication restores its archived assignee; a noticed outside card edit uses the same path', async () => {
  const { storage, paths, files } = await world();
  const directory = join(paths.state, 'board');
  const board = new FileBoardStore(directory, files, new KeyedSerialExecutor(), { warn: () => {} }, async task => {
    for (const id of sessionsOnOpenCards([task], new Map())) await storage.retainSession(parseSessionId(id));
  });
  await board.write('F1', async () => ({ task: card({ owner: LEAD, assignee: KID }), result: undefined }));
  await restored(storage);
  await storage.archiveSessions([KID, LEAD], async () => ({}));
  await writeFile(
    join(directory, 'tasks', 'F1.json'),
    JSON.stringify(card({ owner: LEAD, assignee: KID, title: 'Changed' })),
  );
  expect(await board.noticeOutsideEdits()).toEqual(['F1']);
  await restored(storage);
});
