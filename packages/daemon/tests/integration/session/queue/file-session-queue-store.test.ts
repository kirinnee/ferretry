import { afterEach, describe, it } from 'bun:test';
import { appendFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileSessionQueueStore } from '../../../../src/adapters/session/queue/index.ts';
import { KeyedSerialExecutor } from '../../../../src/adapters/index.ts';
import { type QueueEvent, SessionQueueService } from '../../../../src/lib/session/queue/index.ts';
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
