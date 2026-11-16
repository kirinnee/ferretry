import { afterEach, describe, it } from 'bun:test';
import { appendFile, mkdtemp, readFile, rename, rm, stat, truncate, writeFile } from 'node:fs/promises';
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

describe('a queue log read again after it grew (&F4319)', () => {
  const moved = (id: string, state: 'typing' | 'delivered' | 'read'): QueueEvent => ({
    v: 1,
    kind: 'moved',
    at: AT,
    id,
    state,
  });

  it('should hand back the events it already parsed, and parse only the lines appended since', async () => {
    const { store: subject } = await store();
    await subject.append(ID, enqueued);
    const first = await subject.read(ID);

    await subject.append(ID, moved('m1', 'typing'));
    const second = await subject.read(ID);

    should(second).deepEqual([enqueued, moved('m1', 'typing')]);
    should(second[0]).equal(first[0]);
    should(foldQueue(second).map(message => [message.id, message.state, message.version])).eql([['m1', 'typing', 2]]);
  });

  it('should read a whole file again when it was replaced, even with as many bytes as before', async () => {
    const { store: subject } = await store();
    await subject.append(ID, moved('m1', 'typing'));
    await subject.append(ID, enqueued);
    await subject.read(ID);

    // Same length, new file: the kept prefix belongs to the old inode.
    const replacement = `${JSON.stringify(enqueued)}\n${JSON.stringify(moved('m1', 'typing'))}\n`;
    await writeFile(`${subject.file(ID)}.next`, replacement);
    await rename(`${subject.file(ID)}.next`, subject.file(ID));

    should(foldQueue(await subject.read(ID)).map(message => message.state)).eql(['typing']);
  });

  it('should read a whole file again when it shrank', async () => {
    const { store: subject } = await store();
    await subject.append(ID, enqueued);
    await subject.append(ID, moved('m1', 'typing'));
    await subject.read(ID);

    await truncate(subject.file(ID), (await readFile(subject.file(ID), 'utf8')).indexOf('\n') + 1);

    should(await subject.read(ID)).deepEqual([enqueued]);
  });

  it('should read a whole file again when the kept prefix no longer ends a line where it did', async () => {
    const { store: subject } = await store();
    await subject.append(ID, enqueued);
    await subject.read(ID);

    // Rewritten in place and longer: the byte the kept prefix ended on is now inside a line.
    const rewritten = `${JSON.stringify({ ...enqueued, at: `${AT} ` })}\n${JSON.stringify(moved('m1', 'read'))}\n`;
    await writeFile(subject.file(ID), rewritten);

    should((await subject.read(ID)).map(event => event.kind)).eql(['moved']);
  });

  it('should read a whole file again when it was rewritten in place with exactly as many bytes', async () => {
    // Same inode, same length, a newline at the same place: only the bytes themselves differ.
    const { store: subject } = await store();
    const other = {
      ...enqueued,
      message: { ...(enqueued.kind === 'enqueued' ? enqueued.message : ({} as never)), id: 'm2' },
    };
    await subject.append(ID, enqueued);
    await subject.read(ID);
    const before = await stat(subject.file(ID));

    await writeFile(subject.file(ID), `${JSON.stringify(other)}\n`);
    const after = await stat(subject.file(ID));

    should([after.ino, after.size]).eql([before.ino, before.size]);
    should(foldQueue(await subject.read(ID)).map(message => message.id)).eql(['m2']);
  });

  it('should read a whole file again when a long log is rewritten in place and grows, even ending a line where it did', async () => {
    // Past the sampled bytes: a different first line is what gives the rewrite away.
    const { store: subject } = await store();
    for (let n = 0; n < 200; n++) await subject.append(ID, moved('m1', 'typing'));
    await subject.append(ID, enqueued);
    await subject.read(ID);
    const size = (await stat(subject.file(ID))).size;

    const fresh = `${JSON.stringify(enqueued)}\n${JSON.stringify(moved('m1', 'typing'))}\n`.padEnd(size + 10, '\n');
    await writeFile(subject.file(ID), fresh);

    should(foldQueue(await subject.read(ID)).map(message => message.state)).eql(['typing']);
  });

  it('should agree with a fresh store after an equal-length rewrite deep inside a long log', async () => {
    // Sixty enqueues; only the middle id changes, to one exactly as long, so both ends and the size stay the same.
    const { home, store: subject } = await store();
    const base = enqueued.kind === 'enqueued' ? enqueued.message : (undefined as never);
    const ids = Array.from({ length: 60 }, (_, n) => `m${String(n).padStart(2, '0')}`);
    for (const id of ids) await subject.append(ID, { ...enqueued, message: { ...base, id } });
    should(foldQueue(await subject.read(ID))).have.length(60);
    const original = await readFile(subject.file(ID), 'utf8');

    await writeFile(subject.file(ID), original.replace('"id":"m30"', '"id":"nw"'.padEnd('"id":"m30"'.length, ' ')));

    const cached = foldQueue(await subject.read(ID)).map(message => message.id);
    const fresh = foldQueue(await new FileSessionQueueStore(id => join(home, id)).read(ID)).map(message => message.id);
    should((await stat(subject.file(ID))).size).equal(Buffer.byteLength(original));
    should(cached).eql(fresh);
    should(cached).containEql('nw');
    should(cached).not.containEql('m30');
  });

  it('should keep its parse across its own appends, and drop it for a write it did not make', async () => {
    const { store: subject } = await store();
    await subject.append(ID, enqueued);
    const first = await subject.read(ID);
    await subject.append(ID, moved('m1', 'typing'));
    const own = await subject.read(ID);

    await appendFile(subject.file(ID), `${JSON.stringify(moved('m1', 'delivered'))}\n`);
    const foreign = await subject.read(ID);

    should(own[0]).equal(first[0]);
    should(foreign[0]).not.equal(first[0]);
    should(foreign).deepEqual([enqueued, moved('m1', 'typing'), moved('m1', 'delivered')]);
  });

  it('should keep following a long log as it grows', async () => {
    const { store: subject } = await store();
    await subject.append(ID, enqueued);
    for (let round = 0; round < 3; round++) {
      for (let n = 0; n < 100; n++) await subject.append(ID, moved('m1', 'typing'));
      const events = await subject.read(ID);
      should(events).have.length(1 + 100 * (round + 1));
    }
    should(foldQueue(await subject.read(ID)).map(message => message.state)).eql(['typing']);
  });

  it('should read a torn final line once it is whole, and never keep it while torn', async () => {
    const { store: subject } = await store();
    await subject.append(ID, enqueued);
    const line = JSON.stringify(moved('m1', 'typing'));
    await appendFile(subject.file(ID), line.slice(0, 20));
    should(await subject.read(ID)).deepEqual([enqueued]);

    await appendFile(subject.file(ID), `${line.slice(20)}\n`);

    should(await subject.read(ID)).deepEqual([enqueued, moved('m1', 'typing')]);
  });

  it('should still parse a final line that is whole but has no newline, as before', async () => {
    const { store: subject } = await store();
    await subject.append(ID, enqueued);
    await appendFile(subject.file(ID), JSON.stringify(moved('m1', 'typing')));

    should(await subject.read(ID)).deepEqual([enqueued, moved('m1', 'typing')]);
    await appendFile(subject.file(ID), `\n${JSON.stringify(moved('m1', 'delivered'))}\n`);
    should(foldQueue(await subject.read(ID)).map(message => message.state)).eql(['delivered']);
  });

  it('should answer a log removed after it was read as empty, and one written again from scratch', async () => {
    const { store: subject } = await store();
    await subject.append(ID, enqueued);
    await subject.append(ID, moved('m1', 'typing'));
    await subject.read(ID);

    await rm(subject.file(ID));
    should(await subject.read(ID)).be.empty();
    await subject.append(ID, enqueued);

    should(await subject.read(ID)).deepEqual([enqueued]);
  });

  it('should keep every answer right when more logs are read than it keeps', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ferretry-queue-test-'));
    homes.add(home);
    const subject = new FileSessionQueueStore(id => join(home, id), 1);
    const other = parseSessionId('session-2');
    await subject.append(ID, enqueued);
    await subject.append(other, enqueued);

    for (let round = 0; round < 3; round++) {
      await subject.append(ID, moved('m1', 'typing'));
      should(await subject.read(ID)).have.length(2 + round);
      should(await subject.read(other)).have.length(1);
    }
  });

  it('should answer two reads of the same log at once with the same events', async () => {
    const { store: subject } = await store();
    await subject.append(ID, enqueued);
    await subject.read(ID);
    await subject.append(ID, moved('m1', 'typing'));

    const [a, b] = await Promise.all([subject.read(ID), subject.read(ID)]);

    should(a).deepEqual(b);
    should(a).have.length(2);
  });
});
