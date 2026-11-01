import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { StorageSessionParents } from '../../../src/adapters/board/session-board-adapters.ts';
import { OWNER_TURNS_KEPT, SessionOwnerWords } from '../../../src/adapters/board/session-owner-words.ts';
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
import { FileResumeTurnStore } from '../../../src/adapters/session/resume/file-resume-turn-store.ts';
import { FileSendLedger } from '../../../src/adapters/session/send/file-send-ledger.ts';
import { decideAskedBy } from '../../../src/lib/board/index.ts';
import { SessionQueueService } from '../../../src/lib/session/queue/index.ts';
import { parseSessionId } from '../../../src/lib/session-id.ts';

/**
 * What the owner said to a session, read from a real queue log, a real send ledger, real turn documents and the
 * real lineage in a temp state home. No daemon.
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
  const ledger = new FileSendLedger(id => join(sessions, id), new SystemClock(() => new Date(NOW)));
  const turnsOf = (id: string) => join(sessions, id, 'turns');
  const words = new SessionOwnerWords(queue, ledger, parents, turnsOf);
  const turnStore = new FileResumeTurnStore(id => join(sessions, id));
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
  const turn = async (id: string, number: number, text: string, by?: object) =>
    await turnStore.writeTurn(parseSessionId(id), number, `${text}\n`, by as never);
  const sent = async (id: string, sendId: string, text: string, extra: object = {}) =>
    await ledger.accept(parseSessionId(id), {
      sendId,
      acceptedAt: NOW,
      acceptedTurn: 1,
      path: 'turn-file',
      message: text,
      fate: 'accepted',
      ...extra,
    } as never);
  return { words, ledger, open, turnOne, turn, sent, say, parents, turnsOf };
}

afterEach(async () => {
  for (const storage of storages) await storage.close();
  storages.clear();
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

describe('SessionOwnerWords over a real state home', () => {
  it('should read the owner queued messages and the first turn of a session the owner started', async () => {
    const { words, open, turnOne, say } = await fixture();
    await open('lead');
    await turnOne('lead', 'the owner started this');
    await say('lead', 'm1', OWNER_ASK);
    await say('lead', 'm2', 'a ferret wrote this', 'human', { kind: 'ferret', name: 'jaeda' });
    await say('lead', 'm3', 'an agent reply', 'agent');

    should(await words.said('lead')).eql([OWNER_ASK, 'the owner started this']);
  });

  it("should read a lead's turns: the owner's, never a ferret's message or Ferretry's notice", async () => {
    const { words, open, turn } = await fixture();
    await open('mvgt2oz9-04e28935');
    const lead = 'mvgt2oz9-04e28935';
    await turn(lead, 1, '# Assigned task\n\nthe owner started the lead with this');
    await turn(lead, 500, 'problem -- inbox has TOO much cards\n\ntask cards -- only those that humans created');
    await turn(
      lead,
      501,
      '[message from ferret avary (session mvwxb65n-e0d0150d) — not from the owner]\n\n&B119 is green',
    );
    await turn(lead, 502, '&B123 PR #1275 CI is red. Fix it, or note on the card why it can stay red.');
    await turn(lead, 503, 'the Warden revived it', { kind: 'ferretry', feature: 'Warden' });

    should([...(await words.said(lead))].sort()).eql(
      [
        '# Assigned task\n\nthe owner started the lead with this',
        'problem -- inbox has TOO much cards\n\ntask cards -- only those that humans created',
      ].sort(),
    );

    const decide = async (text: string) =>
      await decideAskedBy(
        { createdBy: { kind: 'ferret', sessionId: lead }, ask: { text, source: `session:${lead}` } } as never,
        false,
        async id => await words.said(id),
      );
    should(await decide('problem -- inbox has TOO much cards. task cards -- only those that humans created')).eql(
      'person',
    );
    should(await decide('&B123 PR #1275 CI is red. Fix it, or note on the card why it can stay red.')).eql('agent');
    should(await decide('&B119 is green, so hand it to the reviewer now')).eql('agent');
  });

  it("should take the ledger's word for who sent a turn, and read a send that started none", async () => {
    const { words, open, turn, sent } = await fixture();
    await open('lead');
    await turn('lead', 7, 'Lead: a message a ferret sent without the wrapper');
    await sent('lead', 's7', 'Lead: a message a ferret sent without the wrapper', {
      turn: 7,
      senderKind: 'agent',
      from: 'worker',
    });
    await sent('lead', 's8', 'typed into a busy pane, so it started no turn', { path: 'native-inline' });

    should(await words.said('lead')).eql(['typed into a busy pane, so it started no turn']);
  });

  it('should see a turn written after it last looked', async () => {
    const { words, open, turn } = await fixture();
    await open('lead');
    await turn('lead', 2, 'the first thing the owner said');
    should(await words.said('lead')).eql(['the first thing the owner said']);
    await turn('lead', 3, 'and the next');
    should(await words.said('lead')).eql(['the first thing the owner said', 'and the next']);
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
    const { open, turnOne, parents, ledger, turnsOf } = await fixture();
    await open('lead');
    await turnOne('lead', 'the owner started this');
    const torn = new SessionOwnerWords(
      {
        list: async () => {
          throw new Error('queue.jsonl unreadable');
        },
      },
      ledger,
      parents,
      turnsOf,
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

  it('should answer what it can read when the ledger or the turns directory is not a file it can read', async () => {
    const { words, open, turn, say, turnsOf } = await fixture();
    await open('lead');
    await turn('lead', 2, 'turn words the owner said');
    await mkdir(join(turnsOf('lead'), '..', 'channel', 'sends.jsonl'), { recursive: true });
    should(await words.said('lead')).eql(['turn words the owner said']);

    await open('other');
    await say('other', 'm1', 'queued words the owner said');
    await mkdir(join(turnsOf('other'), '..'), { recursive: true });
    await writeFile(turnsOf('other'), 'a file where the turns directory should be');
    should(await words.said('other')).eql(['queued words the owner said']);
  });

  it('should skip a turn it cannot read and a torn author file, and keep the rest', async () => {
    const { words, open, turn, turnsOf } = await fixture();
    await open('lead');
    await turn('lead', 2, 'the owner said this');
    await mkdir(join(turnsOf('lead'), 'turn-003.md'));
    await turn('lead', 4, 'an author file that does not parse');
    await writeFile(join(turnsOf('lead'), 'turn-004.by.json'), '{ torn');

    should(await words.said('lead')).eql(['the owner said this', 'an author file that does not parse']);
  });

  it('should leave the first turn out when the lineage cannot be read', async () => {
    const { ledger, open, turnOne, turn, turnsOf } = await fixture();
    await open('lead');
    await turnOne('lead', 'a brief nobody can prove the owner wrote');
    await turn('lead', 2, 'the owner said this');
    const queue = { list: async () => [] };
    const lineage = {
      parentOf: async (): Promise<string | undefined> => {
        throw new Error('config.json unreadable');
      },
    };

    should(await new SessionOwnerWords(queue, ledger, lineage, turnsOf).said('lead')).eql(['the owner said this']);
  });

  it('should keep a bounded number of sessions read and read one let go again in full', async () => {
    const { ledger, parents, turnsOf } = await fixture();
    const ids = Array.from({ length: OWNER_TURNS_KEPT + 1 }, (_, n) => `s${String(n)}`);
    for (const id of ids) {
      await mkdir(turnsOf(id), { recursive: true });
      await writeFile(join(turnsOf(id), 'turn-002.md'), `words of ${id}`);
    }
    const words = new SessionOwnerWords({ list: async () => [] }, ledger, parents, turnsOf);
    for (const id of ids) should(await words.said(id)).eql([`words of ${id}`]);

    should(await words.said(ids[0] ?? '')).eql(['words of s0']);
  });
});
