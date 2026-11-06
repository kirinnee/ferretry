import { afterEach, describe, it } from 'bun:test';
import { appendFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileSessionQueueStore } from '../../../../src/adapters/session/queue/index.ts';
import { KeyedSerialExecutor } from '../../../../src/adapters/index.ts';
import {
  foldQueue,
  NotifyingSessionQueueStore,
  type QueueEvent,
  queuePage,
  SessionQueueService,
} from '../../../../src/lib/session/queue/index.ts';
import { parseSessionId } from '../../../../src/lib/session-id.ts';

/**
 * A session's queue on disk: `channel/queue.jsonl` beside the session, appended to and read back.
 *
 * Everything runs in a temp directory. Nothing here starts a daemon or reaches tmux.
 */

const homes = new Set<string>();
const ID = parseSessionId('session-1');
const AT = '2026-10-30T13:05:37.000Z';

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

async function store(): Promise<{ readonly home: string; readonly store: FileSessionQueueStore }> {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-queue-test-'));
  homes.add(home);
  return { home, store: new FileSessionQueueStore(id => join(home, id)) };
}

const enqueued: QueueEvent = {
  v: 1,
  kind: 'enqueued',
  at: AT,
  message: {
    v: 1,
    id: 'm1',
    sender: 'human',
    text: 'I woke up to a broken ferretry!\n\nlots of ferrets are stuck too.',
    attachmentIds: ['att-1'],
    enqueuedAt: AT,
    state: 'queued',
    stateAt: AT,
    revision: 1,
  },
};

describe('FileSessionQueueStore', () => {
  it('should read a session that has never queued anything as an empty log', async () => {
    const { store: subject } = await store();

    should(await subject.read(ID)).be.empty();
  });

  it('should append beside the session, owner-only, and read the events back in order', async () => {
    const { home, store: subject } = await store();
    const typing: QueueEvent = { v: 1, kind: 'moved', at: AT, id: 'm1', state: 'typing' };

    await subject.append(ID, enqueued);
    await subject.append(ID, typing);

    should(subject.file(ID)).equal(join(home, ID, 'channel', 'queue.jsonl'));
    should(await subject.read(ID)).deepEqual([enqueued, typing]);
    should((await stat(subject.file(ID))).mode & 0o777).equal(0o600);
    should((await readFile(subject.file(ID), 'utf8')).split('\n')).have.length(3);
  });

  it('should skip a torn final line and a line that is not an event, keeping everything else', async () => {
    const { store: subject } = await store();
    await subject.append(ID, enqueued);
    await appendFile(subject.file(ID), '{"v":1,"kind":"moved","state":"sideways"}\n\n{"v":1,"kind":"mov');

    should(await subject.read(ID)).deepEqual([enqueued]);
  });

  it('should keep a message across a fresh service, as after a daemon restart', async () => {
    const { home } = await store();
    const service = (): SessionQueueService =>
      new SessionQueueService({
        store: new FileSessionQueueStore(id => join(home, id)),
        clock: { now: () => AT },
        serial: new KeyedSerialExecutor(),
      });

    await service().enqueue(ID, { id: 'm1', sender: 'human', text: 'ship it' });
    const reborn = await service().list(ID);

    should(reborn.map(message => [message.id, message.state])).eql([['m1', 'queued']]);
  });

  it('should refuse to read a queue file it cannot open, rather than answer it empty', async () => {
    const { store: subject } = await store();
    // The queue's path is a directory: a read error that is not "no such file" must surface.
    await subject.append(ID, enqueued);
    const blocked = new FileSessionQueueStore(id => join(subject.file(ID), id));

    const outcome = await blocked.read(ID).then(
      () => 'read',
      (error: unknown) => (error as NodeJS.ErrnoException).code,
    );

    should(outcome).equal('ENOTDIR');
  });
});

describe('a long-lived session queue read as a window', () => {
  /** A log shaped like the measured lead's: every message enqueued, moved to typing, delivered and read, but a few left waiting. */
  async function longLog(subject: FileSessionQueueStore, count: number, waiting: ReadonlySet<number>): Promise<void> {
    const lines: string[] = [];
    for (let n = 0; n < count; n++) {
      const id = `m${String(n).padStart(4, '0')}`;
      const at = new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString();
      const base = enqueued.kind === 'enqueued' ? enqueued.message : undefined;
      if (base === undefined) throw new Error('the fixture message is an enqueue');
      lines.push(JSON.stringify({ v: 1, kind: 'enqueued', at, message: { ...base, id, enqueuedAt: at, stateAt: at } }));
      if (waiting.has(n)) continue;
      for (const state of ['typing', 'delivered', 'read'] as const)
        lines.push(JSON.stringify({ v: 1, kind: 'moved', at, id, state }));
    }
    await subject.append(ID, enqueued);
    await appendFile(subject.file(ID), `${lines.join('\n')}\n`);
  }

  it('should answer the newest page and every waiting message, then walk the rest once, off the real log', async () => {
    // Arrange — the first line is the shared fixture's m1; the long log follows it.
    const { store: subject } = await store();
    const waiting = new Set([3, 40, 300, 1_500, 2_947]);
    await longLog(subject, 2_948, waiting);
    const messages = foldQueue(await subject.read(ID));

    // Act
    let page = queuePage(messages, { limit: 100 }, ID);
    const first = page;
    const seen = [...(page?.messages ?? [])];
    while (page?.nextCursor != null) {
      page = queuePage(messages, { limit: 100, before: page.nextCursor }, ID);
      seen.push(...(page?.messages ?? []));
    }

    // Assert — m1 plus 2,948 messages; the window is 100 newest plus the 4 older waiting ones.
    should(messages).have.length(2_949);
    should(first?.messages).have.length(104);
    should(first?.messages.filter(message => message.state === 'queued')).have.length(6);
    should(new Set(seen.map(message => message.id)).size).equal(2_949);
    should(seen).have.length(2_949);
    should(JSON.stringify({ messages: first?.messages }).length).be.below(JSON.stringify({ messages }).length / 20);
  });
});

const EARLY = new Date(Date.UTC(2026, 9, 1, 0, 0, 2)).toISOString();

describe('a queue change on the real log is announced after it is on disk, and a walk survives it', () => {
  it('should announce the change only once the line is in the file, and meet a message cancelled mid-walk once', async () => {
    // Arrange — the real file store behind the notifying decorator, the real service on top.
    const { store: file } = await store();
    const onDisk: number[] = [];
    const announced: string[] = [];
    const notifying = new NotifyingSessionQueueStore(file, {
      publish: async (_id, _type, data) => {
        onDisk.push((await file.read(ID)).length);
        announced.push(`${data.change}:${data.messageId}`);
      },
    });
    let seconds = 0;
    const service = new SessionQueueService({
      store: notifying,
      clock: { now: () => new Date(Date.UTC(2026, 9, 1, 0, 0, seconds++)).toISOString() },
      serial: new KeyedSerialExecutor(),
    });
    for (const id of ['a', 'b', 'c']) await service.enqueue(ID, { id, sender: 'human', text: `words of ${id}` });
    await file.append(ID, { v: 1, kind: 'moved', at: EARLY, id: 'b', state: 'typing' });
    await file.append(ID, { v: 1, kind: 'moved', at: EARLY, id: 'b', state: 'delivered' });
    await file.append(ID, { v: 1, kind: 'moved', at: EARLY, id: 'b', state: 'read' });
    await file.append(ID, { v: 1, kind: 'moved', at: EARLY, id: 'c', state: 'typing' });
    await file.append(ID, { v: 1, kind: 'moved', at: EARLY, id: 'c', state: 'delivered' });
    await file.append(ID, { v: 1, kind: 'moved', at: EARLY, id: 'c', state: 'read' });

    // Act — the first page of one carries a; a is cancelled; the walk goes on.
    const first = queuePage(await service.list(ID), { limit: 1 }, ID);
    await service.cancel(ID, 'a');
    const older = queuePage(await service.list(ID), { limit: 5, before: first?.nextCursor ?? '' }, ID);

    // Assert
    should(announced).eql(['enqueued:a', 'enqueued:b', 'enqueued:c', 'moved:a']);
    should(onDisk).eql([1, 2, 3, 10]);
    should(first?.messages.map(message => message.id)).eql(['a', 'c']);
    should(older?.messages.map(message => message.id)).eql(['b']);
  });
});
