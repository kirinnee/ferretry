import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileAttentionOutboxRepository } from '../../../src/adapters/attention/file-attention-outbox-repository.ts';
import { AttentionReplyBatcher, emptyAttentionOutbox } from '../../../src/lib/attention/index.ts';

const homes: string[] = [];
const SESSION = 'session-1';
const AT = '2026-10-28T17:00:00.000Z';

async function createRepository() {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-attention-outbox-'));
  homes.push(home);
  const directory = (sessionId: string) => join(home, 'sessions', sessionId);
  return { home, directory, repository: new FileAttentionOutboxRepository(directory, () => 'fixed') };
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map(async home => await rm(home, { recursive: true, force: true })));
});

describe('FileAttentionOutboxRepository', () => {
  it('should read nothing before the first answer, then keep what it wrote beside the board', async () => {
    // Arrange
    const { repository, directory } = await createRepository();
    const outbox = {
      ...emptyAttentionOutbox(SESSION),
      pending: [{ id: 'A1', message: '[answer to !A1 «Ship?»] Yes', at: AT }],
    };

    // Act
    const before = await repository.read(SESSION);
    await repository.write(outbox);
    const after = await repository.read(SESSION);

    // Assert
    should(before).be.null();
    should(after).deepEqual(outbox);
    should(repository.file(SESSION)).equal(join(directory(SESSION), 'attention-replies.json'));
    should((await stat(repository.file(SESSION))).mode & 0o777).equal(0o600);
    should(await readdir(directory(SESSION))).deepEqual(['attention-replies.json']);
  });

  it('should set a damaged outbox aside and start fresh, so later answers still reach the ferret', async () => {
    // Arrange
    const { repository, directory } = await createRepository();
    await mkdir(directory(SESSION), { recursive: true });
    await writeFile(repository.file(SESSION), '{ not json');
    await mkdir(directory('session-2'), { recursive: true });
    await writeFile(
      repository.file('session-2'),
      JSON.stringify({ ...emptyAttentionOutbox('someone-else'), sessionId: 'someone-else' }),
    );

    // Act
    const damaged = await repository.read(SESSION);
    const misfiled = await repository.read('session-2');

    // Assert
    should(damaged).be.null();
    should(misfiled).be.null();
    should(await readdir(directory(SESSION))).deepEqual(['attention-replies.json.damaged-fixed']);
  });

  it('should refuse a session id that could leave the session tree', async () => {
    // Arrange
    const { repository } = await createRepository();

    // Act + Assert
    should(() => repository.file('../escape')).throw(/not a valid attention session id/u);
  });

  it('should leave no temporary file behind when a write fails', async () => {
    // Arrange — the outbox's place is taken by a directory, so the rename over it fails.
    const { repository, directory } = await createRepository();
    await mkdir(join(repository.file(SESSION), 'blocker'), { recursive: true });

    // Act + Assert
    await should(repository.write(emptyAttentionOutbox(SESSION))).be.rejected();
    should(await readdir(directory(SESSION))).deepEqual(['attention-replies.json']);
  });

  it('should carry a held answer across a restart and deliver it once', async () => {
    // Arrange — the first daemon holds an answer and stops before its window ends.
    const { directory } = await createRepository();
    const sent: string[] = [];
    const timers = { schedule: () => undefined, cancel: () => undefined };
    const serial = { run: async <T>(_key: string, task: () => Promise<T>): Promise<T> => await task() };
    const messenger = { send: async (_sessionId: string, _message: string, sendId: string) => void sent.push(sendId) };
    const first = new AttentionReplyBatcher(new FileAttentionOutboxRepository(directory), messenger, timers, serial, {
      now: () => AT,
    });
    await first.add(SESSION, 'A1', '[answer to !A1 «Ship?»] Yes');

    // Act — the next daemon, over the same files, resumes and then flushes twice.
    const second = new AttentionReplyBatcher(new FileAttentionOutboxRepository(directory), messenger, timers, serial, {
      now: () => '2026-10-28T17:05:00.000Z',
    });
    await second.resume([SESSION]);
    await second.flush(SESSION);
    await second.flush(SESSION);

    // Assert
    should(sent).deepEqual(['attention-session-1-A1']);
  });
});
