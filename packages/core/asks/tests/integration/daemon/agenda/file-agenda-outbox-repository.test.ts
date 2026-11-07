import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileAgendaOutboxRepository } from '../../../../daemon/adapters/agenda/file-agenda-outbox-repository.ts';
import { AgendaReplyBatcher, emptyAgendaOutbox } from '../../../../daemon/lib/agenda/index.ts';
import { agendaFilePath, agendaFilesAt, setAsidePath } from '../../../support/daemon/agenda-state.ts';

const homes: string[] = [];
const SESSION = 'session-1';
const AT = '2026-10-28T17:00:00.000Z';

async function createRepository() {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-agenda-outbox-'));
  homes.push(home);
  const directory = (sessionId: string) => join(home, 'state', 'asks', 'ferrets', sessionId);
  const outboxFile = (sessionId: string) => agendaFilePath(home, sessionId, 'agenda-replies.json');
  return {
    home,
    directory,
    outboxFile,
    repository: new FileAgendaOutboxRepository(agendaFilesAt(home), () => 'fixed'),
  };
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map(async home => await rm(home, { recursive: true, force: true })));
});

describe('FileAgendaOutboxRepository', () => {
  it('should read nothing before the first answer, then keep what it wrote beside the board', async () => {
    // Arrange
    const { repository, directory } = await createRepository();
    const outbox = {
      ...emptyAgendaOutbox(SESSION),
      pending: [{ id: 'A1', message: '[answer to !A1 «Ship?»] Yes', at: AT }],
    };

    // Act
    const before = await repository.read(SESSION);
    await repository.write(outbox);
    const after = await repository.read(SESSION);

    // Assert
    should(before).be.null();
    should(after).deepEqual(outbox);
    should(repository.file(SESSION)).equal('state/asks/ferrets/session-1/agenda-replies.json');
    should((await stat(join(directory(SESSION), 'agenda-replies.json'))).mode & 0o777).equal(0o600);
    should(await readdir(directory(SESSION))).deepEqual(['agenda-replies.json']);
  });

  it('should keep a needs-info request key beside an answer key across a restart', async () => {
    // Arrange
    const { repository } = await createRepository();
    const outbox = {
      ...emptyAgendaOutbox(SESSION),
      pending: [
        {
          id: 'A3~2',
          message: '[needs more info !A3 «Log in»] Which account?',
          at: AT,
        },
      ],
      sending: [
        {
          sendId: 'attention-session-1-A1-A3~1',
          ids: ['A1', 'A3~1'],
          message: 'm',
        },
      ],
      delivered: ['A1', 'A3~1'],
    };

    // Act
    await repository.write(outbox);

    // Assert
    should(await repository.read(SESSION)).deepEqual(outbox);
  });

  it('should set a damaged outbox aside and start fresh, so later answers still reach the ferret', async () => {
    // Arrange
    const { home, repository, directory, outboxFile } = await createRepository();
    await mkdir(directory(SESSION), { recursive: true });
    await writeFile(outboxFile(SESSION), '{ not json');
    await mkdir(directory('session-2'), { recursive: true });
    await writeFile(
      outboxFile('session-2'),
      JSON.stringify({
        ...emptyAgendaOutbox('someone-else'),
        sessionId: 'someone-else',
      }),
    );

    // Act
    const damaged = await repository.read(SESSION);
    const misfiled = await repository.read('session-2');

    // Assert
    should(damaged).be.null();
    should(misfiled).be.null();
    should(await readdir(directory(SESSION))).deepEqual([]);
    should(await Bun.file(setAsidePath(home, SESSION, 'agenda-replies.json.damaged-fixed')).text()).equal('{ not json');
  });

  it('should surface a read failure that is not a missing file rather than discarding the outbox', async () => {
    // Arrange — the outbox's place is taken by a directory, so reading it fails with something other than "not there".
    const { repository, outboxFile } = await createRepository();
    await mkdir(outboxFile(SESSION), { recursive: true });

    // Act
    const failure = await repository.read(SESSION).then(
      () => undefined,
      error => error as Error,
    );

    // Assert
    should(failure?.message).match(/agenda-replies\.json/u);
  });

  it('should refuse a session id that could leave the session tree', async () => {
    // Arrange
    const { repository } = await createRepository();

    // Act + Assert
    should(() => repository.file('../escape')).throw(/not a valid agenda session id/u);
  });

  it('should carry a held answer across a restart and deliver it once', async () => {
    // Arrange — the first daemon holds an answer and stops before its window ends.
    const { home } = await createRepository();
    const sent: string[] = [];
    const timers = { schedule: () => undefined, cancel: () => undefined };
    const serial = {
      run: async <T>(_key: string, task: () => Promise<T>): Promise<T> => await task(),
    };
    const messenger = {
      send: async (_sessionId: string, _message: string, sendId: string) => void sent.push(sendId),
    };
    const first = new AgendaReplyBatcher(new FileAgendaOutboxRepository(agendaFilesAt(home), () => 'fixed'), messenger, timers, serial, {
      now: () => AT,
    });
    await first.add(SESSION, 'A1', '[answer to !A1 «Ship?»] Yes');

    // Act — the next daemon, over the same files, resumes and then flushes twice.
    const second = new AgendaReplyBatcher(new FileAgendaOutboxRepository(agendaFilesAt(home), () => 'fixed'), messenger, timers, serial, {
      now: () => '2026-10-28T17:05:00.000Z',
    });
    await second.resume([SESSION]);
    await second.flush(SESSION);
    await second.flush(SESSION);

    // Assert — one message, under the id the second daemon stamped when it began the batch.
    should(sent).deepEqual([`agenda-session-1-A1-${Date.parse('2026-10-28T17:05:00.000Z').toString(36)}`]);
  });
});
