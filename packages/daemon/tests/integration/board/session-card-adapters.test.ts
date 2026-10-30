import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UNFILED_PROJECT_ID } from '@ferretry/protocol';
import should from 'should';
import { CatalogProjectNames, UNFILED_BOARD_NAME } from '../../../src/adapters/board/catalog-project-names.ts';
import { SendReopenMessenger } from '../../../src/adapters/board/send-reopen-messenger.ts';
import { latestOwnerMessage, StorageSessionCardFacts } from '../../../src/adapters/board/storage-session-card-facts.ts';
import { FileProjectCatalog } from '../../../src/adapters/catalog/file-project-catalog.ts';
import {
  BunSqliteIndexFactory,
  DaemonStorageFactory,
  KeyedSerialExecutor,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystemFactory,
  StateHomeLayout,
  SystemClock,
} from '../../../src/adapters/index.ts';
import { parseSessionId } from '../../../src/lib/index.ts';
import type { SendMessageRequest, SendOutcome } from '../../../src/lib/session/send/service.ts';
import { SendPending, SendUnconfirmed } from '../../../src/lib/session/send/types.ts';

/**
 * The adapters behind the cards a start makes and the reopens it delivers, over a real state home and real
 * files: a session's facts from its config and inbox log, a board's name from `projects.json`, and a reopen
 * through the send path's dispositions. Temp `FY_HOME`; no daemon, no tmux.
 */

const homes = new Set<string>();
const storages = new Set<{ close(): Promise<void> | void }>();
const NOW = '2026-10-30T10:00:00.000Z';
const PROJECT = '11111111-1111-4111-8111-111111111111';

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'ferretry-session-cards-'));
  homes.add(path);
  return path;
}

async function openStorage(root: string) {
  const factory = new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: root }, () => '/home-must-not-be-used'),
    new StateFileSystemFactory(),
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(() => new Date(NOW)),
    () => new KeyedSerialExecutor(),
  );
  const { storage } = await factory.open();
  storages.add(storage);
  return storage;
}

afterEach(async () => {
  for (const storage of storages) await storage.close();
  storages.clear();
  for (const path of homes) await rm(path, { recursive: true, force: true });
  homes.clear();
});

describe("a session's facts for its card", () => {
  it('should read the name, prompt and parent from the config and the latest owner message from the inbox', async () => {
    // Arrange
    const root = await home();
    const storage = await openStorage(root);
    const id = parseSessionId('lead');
    await storage.writeConfig(id, {
      id: 'lead',
      name: 'Board design',
      prompt: 'design the board',
      parent: 'root',
      agent: '/opt/fleet/bin/claude',
      command: ['/opt/fleet/bin/claude'],
      cwd: '/workspace/project',
      mode: 'auto',
      turn: 1,
      tmuxSession: 'fy-lead',
      createdAt: NOW,
      updatedAt: NOW,
    });
    await storage.writeState(id, { id: 'lead', status: 'running', turn: 1 });
    const directory = (sessionId: string) => join(root, 'dirs', sessionId);
    await mkdir(join(directory('lead'), 'channel'), { recursive: true });
    await writeFile(
      join(directory('lead'), 'channel', 'inbox.jsonl'),
      [
        JSON.stringify({ at: NOW, type: 'message', message: 'flesh out the board' }),
        'not json',
        JSON.stringify({ at: NOW, type: 'message', message: 'from a ferret', from: 'child' }),
        '',
      ].join('\n'),
    );
    const facts = new StorageSessionCardFacts(storage, sessionId => directory(sessionId));

    // Act
    const lead = await facts.facts('lead');
    const unknown = await facts.facts('ghost');
    const unusable = await facts.facts('../escape');

    // Assert
    should(lead).deepEqual({
      name: 'Board design',
      prompt: 'design the board',
      parent: 'root',
      latestOwnerMessage: 'flesh out the board',
    });
    should(unknown).be.undefined();
    should(unusable).be.undefined();
  });

  it('should read no owner message from a session with no inbox, and skip anything that is not one', async () => {
    // Arrange
    const root = await home();
    const storage = await openStorage(root);
    const id = parseSessionId('worker');
    await storage.writeConfig(id, {
      id: 'worker',
      agent: '/opt/fleet/bin/claude',
      command: ['/opt/fleet/bin/claude'],
      cwd: '/workspace/project',
      mode: 'interactive',
      turn: 0,
      tmuxSession: 'fy-worker',
      createdAt: NOW,
      updatedAt: NOW,
    });
    await storage.writeState(id, { id: 'worker', status: 'running', turn: 0 });
    const facts = new StorageSessionCardFacts(storage, sessionId => join(root, 'dirs', sessionId));

    // Act
    const worker = await facts.facts('worker');

    // Assert
    should(worker).deepEqual({
      name: undefined,
      prompt: undefined,
      parent: undefined,
      latestOwnerMessage: undefined,
    });
    should(latestOwnerMessage(JSON.stringify({ type: 'question', message: 'x' }))).be.undefined();
    should(latestOwnerMessage(`${JSON.stringify({ type: 'message', message: '  ' })}\n[1]`)).be.undefined();
  });
});

describe("a board's name", () => {
  it("should be the registered project's name, Unfiled's own, or the id of one the registry lacks", async () => {
    // Arrange
    const root = await home();
    const file = join(root, 'projects.json');
    await writeFile(file, JSON.stringify([{ id: PROJECT, name: 'Ferretry', path: '/workspace/ferretry' }]));
    const names = new CatalogProjectNames(new FileProjectCatalog(file));
    const unreadable = new CatalogProjectNames({ projects: async () => Promise.reject(new Error('EACCES')) });

    // Act / Assert
    should(await names.nameOf(PROJECT)).equal('Ferretry');
    should(await names.nameOf(UNFILED_PROJECT_ID)).equal(UNFILED_BOARD_NAME);
    should(await names.nameOf('22222222-2222-4222-8222-222222222222')).equal('22222222-2222-4222-8222-222222222222');
    should(await unreadable.nameOf(PROJECT)).equal(PROJECT);
  });
});

describe('a reopen through the send path', () => {
  const sends = (answer: SendOutcome['disposition'] | Error) => {
    const sent: SendMessageRequest[] = [];
    return {
      sent,
      messenger: new SendReopenMessenger({
        send: async request => {
          sent.push(request);
          if (answer instanceof Error) throw answer;
          return { disposition: answer } as SendOutcome;
        },
      }),
    };
  };

  it('should send it as an owner message under its key, and read how it travelled', async () => {
    // Arrange
    const typed = sends('delivered');

    // Act
    const how = await typed.messenger.deliver('child', '[reopened &F1 by owner: no]', 'board-reopen-F1-3');

    // Assert
    should(how).equal('delivered');
    should(typed.sent).deepEqual([
      { id: 'child', sendId: 'board-reopen-F1-3', message: '[reopened &F1 by owner: no]' },
    ]);
    should(await sends('queued').messenger.deliver('child', 'x', 'k')).equal('delivered');
    should(await sends('sent').messenger.deliver('child', 'x', 'k')).equal('delivered');
    should(await sends('revived').messenger.deliver('child', 'x', 'k')).equal('resumed');
    should(await sends('queued-for-revive').messenger.deliver('child', 'x', 'k')).equal('held');
  });

  it('should count a typed but unproven send as delivered, and anything else that failed as absent', async () => {
    // Act / Assert
    should(await sends(new SendUnconfirmed('typed', 'k')).messenger.deliver('child', 'x', 'k')).equal('delivered');
    should(await sends(new SendPending('launching')).messenger.deliver('child', 'x', 'k')).equal('absent');
    should(await sends(new Error('session not found')).messenger.deliver('child', 'x', 'k')).equal('absent');
    should(await sends('delivered').messenger.deliver('../escape', 'x', 'k')).equal('absent');
  });
});
