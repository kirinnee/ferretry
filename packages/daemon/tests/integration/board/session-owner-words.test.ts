import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { StorageSessionParents } from '../../../src/adapters/board/session-board-adapters.ts';
import { QueueOwnerWords } from '../../../src/adapters/board/session-owner-words.ts';
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
import { FileSessionQueueStore } from '../../../src/adapters/session/queue/index.ts';
import { decideAskedBy } from '../../../src/lib/board/index.ts';
import { SessionQueueService } from '../../../src/lib/session/queue/index.ts';
import { parseSessionId } from '../../../src/lib/session-id.ts';

/**
 * What the owner said to a session, read from a real queue log, a real first-turn file and the real lineage in a
 * temp state home. No daemon.
 */

const homes = new Set<string>();
const storages = new Set<{ close(): Promise<void> | void }>();
const NOW = '2026-10-30T10:00:00.000Z';
const OWNER_ASK = 'inbox has TOO much cards. only those that humans created should be part of it';

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-owner-words-'));
  homes.add(home);
  const factory = new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: home }, () => '/home-must-not-be-used'),
    new StateFileSystemFactory(),
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(() => new Date(NOW)),
    () => new KeyedSerialExecutor(),
  );
  const { storage } = await factory.open();
  storages.add(storage);
  const sessions = join(home, 'sessions');
  const queue = new SessionQueueService({
    store: new FileSessionQueueStore(id => join(sessions, id)),
    clock: new SystemClock(() => new Date(NOW)),
    serial: new KeyedSerialExecutor(),
  });
  const firstTurn = (id: string) => join(sessions, id, 'turns', 'turn-001.md');
  const parents = new StorageSessionParents(storage);
  const words = new QueueOwnerWords(queue, parents, id => firstTurn(id));
  const open = async (id: string, parent?: string) => {
    await storage.writeConfig(parseSessionId(id), {
      id,
      name: id,
      agent: '/opt/fleet/bin/claude',
      command: ['/opt/fleet/bin/claude'],
      cwd: '/workspace/project',
      mode: 'auto',
      turn: 1,
      tmuxSession: `fy-${id}`,
      createdAt: NOW,
      updatedAt: NOW,
      ...(parent === undefined ? {} : { parent }),
    });
  };
  const turnOne = async (id: string, text: string) => {
    await mkdir(join(sessions, id, 'turns'), { recursive: true });
    await writeFile(firstTurn(id), text);
  };
  const say = async (id: string, key: string, text: string, sender: 'human' | 'agent' = 'human', by?: object) =>
    await queue.enqueue(parseSessionId(id), { id: key, sender, text, ...(by === undefined ? {} : { by }) } as never);
  return { words, open, turnOne, say, parents, firstTurn: (id: string) => firstTurn(id) };
}

afterEach(async () => {
  for (const storage of storages) await storage.close();
  storages.clear();
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

describe('QueueOwnerWords over a real state home', () => {
  it('should read the owner queued messages and the first turn of a session the owner started', async () => {
    const { words, open, turnOne, say } = await fixture();
    await open('lead');
    await turnOne('lead', 'the owner started this');
    await say('lead', 'm1', OWNER_ASK);
    await say('lead', 'm2', 'a ferret wrote this', 'human', { kind: 'ferret', name: 'jaeda' });
    await say('lead', 'm3', 'an agent reply', 'agent');

    should(await words.said('lead')).eql([OWNER_ASK, 'the owner started this']);
  });

  it('should leave out the first turn of a session a ferret started', async () => {
    const { words, open, turnOne, say } = await fixture();
    await open('lead');
    await open('worker', 'lead');
    await turnOne('worker', "the lead's brief");
    await say('worker', 'm1', 'owner words');

    should(await words.said('worker')).eql(['owner words']);
  });

  it('should answer nothing for a missing session and for an id it cannot parse', async () => {
    const { words } = await fixture();

    should(await words.said('ghost')).eql([]);
    should(await words.said('')).eql([]);
  });

  it('should still read the first turn when the queue cannot be read', async () => {
    const { open, turnOne, parents, firstTurn } = await fixture();
    await open('lead');
    await turnOne('lead', 'the owner started this');
    const torn = new QueueOwnerWords(
      {
        list: async () => {
          throw new Error('queue.jsonl unreadable');
        },
      },
      parents,
      firstTurn,
    );

    should(await torn.said('lead')).eql(['the owner started this']);
  });

  it('should decide a lead-relayed card is a person ask only when the owner said it verbatim', async () => {
    const { words, open, say } = await fixture();
    await open('lead');
    await say('lead', 'm1', OWNER_ASK);
    const decide = async (ask: string) =>
      await decideAskedBy(
        {
          createdBy: { kind: 'ferret', sessionId: 'lead', name: 'lizzette' },
          ask: { text: ask, source: 'session:lead' },
        } as never,
        false,
        async id => await words.said(id),
      );

    should(await decide(OWNER_ASK)).eql('person');
    should(await decide(`Owner (verbatim): "${OWNER_ASK}" and more words around it`)).eql('person');
    should(await decide('a different, unrelated ask entirely from the lead')).eql('agent');
  });
});
