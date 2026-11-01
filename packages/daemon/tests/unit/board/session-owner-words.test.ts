import { describe, it } from 'bun:test';
import type { QueuedMessage } from '@ferretry/protocol';
import should from 'should';
import {
  OWNER_TURNS_KEPT,
  ownerPartOf,
  SessionOwnerWords,
  type TurnFiles,
} from '../../../src/adapters/board/session-owner-words.ts';
import type { SessionParents } from '../../../src/lib/board/index.ts';
import type { SendRecord } from '../../../src/lib/session/send/types.ts';

const SESSION = 'mvuc7tsf-0c3d50df';
const SUB = 'mvvilibo-3df19c85';

const message = (id: string, text: string, extra: Partial<QueuedMessage> = {}): QueuedMessage => ({
  v: 1,
  id,
  sender: 'human',
  text,
  attachmentIds: [],
  enqueuedAt: '2026-10-30T10:00:00.000Z',
  state: 'read',
  stateAt: '2026-10-30T10:00:00.000Z',
  revision: 1,
  ...extra,
});

const send = (sendId: string, text: string, extra: Partial<SendRecord> = {}): SendRecord => ({
  sendId,
  acceptedAt: '2026-10-30T10:00:00.000Z',
  acceptedTurn: 1,
  path: 'turn-file',
  message: text,
  fate: 'delivered',
  ...extra,
});

const parents: SessionParents = { parentOf: async id => (id === SUB ? SESSION : undefined) };

/** Files in memory, each with a time; every read is counted. */
class MemoryTurnFiles implements TurnFiles {
  readonly reads: string[] = [];
  readonly times = new Map<string, number>();
  constructor(readonly files: Map<string, string> = new Map()) {}

  put(file: string, text: string, time = 1): void {
    this.files.set(file, text);
    this.times.set(file, time);
    const directory = file.slice(0, file.lastIndexOf('/'));
    this.times.set(directory, (this.times.get(directory) ?? 0) + 1);
  }

  async modified(path: string): Promise<number | undefined> {
    return this.times.get(path);
  }

  async list(directory: string): Promise<readonly string[]> {
    return [...this.files.keys()]
      .filter(file => file.startsWith(`${directory}/`))
      .map(file => file.slice(directory.length + 1));
  }

  async read(file: string): Promise<string> {
    this.reads.push(file);
    const text = this.files.get(file);
    if (text === undefined) throw new Error('ENOENT');
    return text;
  }
}

const turns = (id: string) => `/sessions/${id}/turns`;

const words = ({
  queue = [],
  sends = [],
  files = new MemoryTurnFiles(),
  lineage = parents,
}: {
  queue?: readonly QueuedMessage[] | Error;
  sends?: readonly SendRecord[] | Error;
  files?: MemoryTurnFiles;
  lineage?: SessionParents;
} = {}) =>
  new SessionOwnerWords(
    {
      list: async () => {
        if (queue instanceof Error) throw queue;
        return queue;
      },
    },
    {
      list: async () => {
        if (sends instanceof Error) throw sends;
        return sends;
      },
    },
    lineage,
    turns,
    files,
  );

describe('ownerPartOf', () => {
  it("should answer nothing for a ferret's message, whatever follows the wrapper", () => {
    should(ownerPartOf('[message from ferret avary (session mvwx)] — not from the owner]\n\nfix the inbox')).be.null();
    should(ownerPartOf('[reply from ferret lizzette (session mvgt)]\n\ndone')).be.null();
  });

  it("should drop Ferretry's notices and keep the owner's paragraphs handed in the same delivery", () => {
    should(ownerPartOf('&B121 PR #1263 CI is red. Fix it, or note on the card why it can stay red.')).be.null();
    should(ownerPartOf('You changed code this turn without a card. Create one')).be.null();
    should(ownerPartOf('&F331 has had no activity for 2h in Implement.')).be.null();
    should(ownerPartOf('Ferretry changed part of the instructions you were started with.')).be.null();
    should(ownerPartOf('[board] &F30 done: U8 PR · &F32 done\n\nI woke up to a broken ferretry!\n\nlots stuck')).equal(
      'I woke up to a broken ferretry!\n\nlots stuck',
    );
  });

  it("should keep the owner's agenda answers", () => {
    should(ownerPartOf('[answer to !A205 «Which swipe?»] Right = Done')).equal(
      '[answer to !A205 «Which swipe?»] Right = Done',
    );
    should(ownerPartOf('[re !A199 «Tasks»] !A199 can you prioritize this')).equal(
      '[re !A199 «Tasks»] !A199 can you prioritize this',
    );
  });
});

describe('SessionOwnerWords', () => {
  it('should answer the owner messages in the queue in any state, and no one else', async () => {
    const said = await words({
      queue: [
        message('a', 'first from the owner', { state: 'queued' }),
        message('b', 'second from the app', { by: { kind: 'owner' } }),
        message('c', 'a lead ferret wrote this', { sender: 'agent', by: { kind: 'ferret', name: 'jaeda' } }),
        message('d', 'a human-sender message on a ferret behalf', { by: { kind: 'ferret', name: 'jaeda' } }),
        message('e', 'the daemon notice', { by: { kind: 'ferretry', feature: 'Board' } }),
        message('f', '&B1 PR #2 CI is red. Fix it, or note on the card why it can stay red.'),
      ],
    }).said(SESSION);
    should(said).eql(['first from the owner', 'second from the app']);
  });

  it("should answer the owner's sends from the ledger, and no ferret's or Ferretry's", async () => {
    const said = await words({
      sends: [
        send('a', 'an owner send from before the queue'),
        send('b', 'an owner send the app attributed', { senderKind: 'human', by: { kind: 'owner' } }),
        send('c', 'a peer message', { senderKind: 'agent', from: 'mvwxb65n-e0d0150d', fromName: 'avary' }),
        send('d', 'a board reopen', { senderKind: 'daemon', by: { kind: 'ferretry', feature: 'Board' } }),
        send('e', '&B1 PR #2 CI is red. Fix it, or note on the card why it can stay red.', { senderKind: 'human' }),
        send('f', 'a withdrawn owner send is still words the owner said', { fate: 'withdrawn' }),
      ],
    }).said(SESSION);
    should(said).eql([
      'an owner send from before the queue',
      'an owner send the app attributed',
      'a withdrawn owner send is still words the owner said',
    ]);
  });

  it("should read every turn document as the owner's unless something says otherwise (the lead fixture)", async () => {
    const files = new MemoryTurnFiles();
    files.put(`${turns(SESSION)}/turn-001.md`, 'the owner started the lead with this brief\n');
    files.put(`${turns(SESSION)}/turn-500.md`, 'problem -- inbox has TOO much cards\n');
    files.put(`${turns(SESSION)}/turn-501.md`, '[message from ferret avary (session mvwx)]\n\n&B119 PR is green\n');
    files.put(
      `${turns(SESSION)}/turn-502.md`,
      '&B123 PR #1275 CI is red. Fix it, or note on the card why it can stay red.\n',
    );
    files.put(`${turns(SESSION)}/turn-503.md`, 'a revive the owner asked for\n');
    files.put(`${turns(SESSION)}/turn-503.by.json`, '{"kind":"owner"}\n');
    files.put(`${turns(SESSION)}/turn-504.md`, 'the Warden revived it\n');
    files.put(`${turns(SESSION)}/turn-504.by.json`, '{"kind":"ferretry","feature":"Warden"}\n');
    files.put(`${turns(SESSION)}/turn-1768.md`, 'a four-digit turn\n');
    files.put(`${turns(SESSION)}/notes.md`, 'not a turn\n');

    const said = await words({ files }).said(SESSION);

    should([...said].sort()).eql(
      [
        'the owner started the lead with this brief',
        'problem -- inbox has TOO much cards',
        'a revive the owner asked for',
        'a four-digit turn',
      ].sort(),
    );
  });

  it('should let the ledger decide the turns its sends started', async () => {
    const files = new MemoryTurnFiles();
    files.put(`${turns(SESSION)}/turn-007.md`, 'Lead: a lead message with no wrapper\n');
    files.put(`${turns(SESSION)}/turn-008.md`, 'the owner said this\n');
    const said = await words({
      files,
      sends: [
        send('a', 'Lead: a lead message with no wrapper', { turn: 7, senderKind: 'agent', from: SUB }),
        send('b', 'the owner said this', { turn: 8 }),
      ],
    }).said(SESSION);
    should(said).eql(['the owner said this']);
  });

  it('should leave the first turn out when a ferret started the session, or its lineage cannot be read', async () => {
    const files = new MemoryTurnFiles();
    files.put(`${turns(SUB)}/turn-001.md`, "the lead's brief");
    files.put(`${turns(SUB)}/turn-002.md`, 'the owner talking to the sub-ferret directly');
    should(await words({ files }).said(SUB)).eql(['the owner talking to the sub-ferret directly']);

    const broken: SessionParents = {
      parentOf: async () => {
        throw new Error('no config');
      },
    };
    files.put(`${turns(SESSION)}/turn-001.md`, 'the brief');
    should(await words({ files, lineage: broken }).said(SESSION)).eql([]);
  });

  it('should answer what it can read when the queue or the ledger cannot be read', async () => {
    const files = new MemoryTurnFiles();
    files.put(`${turns(SESSION)}/turn-001.md`, 'the brief');
    should(await words({ queue: new Error('torn'), sends: new Error('torn'), files }).said(SESSION)).eql(['the brief']);
  });

  it('should answer each text once, though the queue, the ledger and a turn all hold it', async () => {
    const files = new MemoryTurnFiles();
    files.put(`${turns(SESSION)}/turn-002.md`, 'hello there\n');
    should(
      await words({ queue: [message('a', 'hello there')], sends: [send('a', 'hello there')], files }).said(SESSION),
    ).eql(['hello there']);
  });

  it('should answer nothing for an id that is not a session id, or a session with no records', async () => {
    should(await words({ queue: [message('a', 'hello')] }).said('not a session')).eql([]);
    should(await words().said(SESSION)).eql([]);
  });

  it('should read a turn document once, and again only when it changed', async () => {
    const files = new MemoryTurnFiles();
    files.put(`${turns(SESSION)}/turn-001.md`, 'the brief');
    files.put(`${turns(SESSION)}/turn-002.md`, 'first');
    const owner = words({ files });

    should(await owner.said(SESSION)).eql(['the brief', 'first']);
    should(await owner.said(SESSION)).eql(['the brief', 'first']);
    should(files.reads.length).equal(2);

    files.put(`${turns(SESSION)}/turn-003.md`, 'second');
    should(await owner.said(SESSION)).eql(['the brief', 'first', 'second']);
    should(files.reads.length).equal(3);

    files.put(`${turns(SESSION)}/turn-001.md`, 'the brief, rewritten', 2);
    should(await owner.said(SESSION)).eql(['the brief, rewritten', 'first', 'second']);
    should(files.reads.length).equal(4);
  });

  it('should keep at most a bounded number of sessions read', async () => {
    const files = new MemoryTurnFiles();
    const ids = Array.from({ length: OWNER_TURNS_KEPT + 1 }, (_, n) => `mv${String(n).padStart(6, '0')}-0c3d50df`);
    for (const id of ids) files.put(`${turns(id)}/turn-002.md`, `words of ${id}`);
    const owner = words({ files });
    for (const id of ids) await owner.said(id);
    const before = files.reads.length;

    await owner.said(ids[ids.length - 1] ?? '');
    should(files.reads.length).equal(before);
    await owner.said(ids[0] ?? '');
    should(files.reads.length).equal(before + 1);
  });
});
