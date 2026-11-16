import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import should from 'should';
import {
  AGENDA_CACHE_LIMIT,
  FileAgendaLedgerRepository,
  InvalidAgendaLedgerError,
} from '../../../../daemon/adapters/agenda/file-agenda-ledger-repository.ts';
import type { StateAgendaFiles } from '../../../../daemon/adapters/agenda/state-agenda-files.ts';
import { AGENDA_ARCHIVE_FILE, type AgendaArchiveRecord } from '../../../../daemon/lib/agenda/archive.ts';
import {
  type AgendaLedger,
  type AgendaMutation,
  agendaSnapshot,
  emptyAgendaLedger,
  NO_AGENDA_VERSIONS,
} from '../../../../daemon/lib/agenda/index.ts';
import { AgendaService } from '../../../../daemon/lib/agenda/service.ts';
import { agendaFilePath, agendaFilesAt, recordingRuntime, setAsidePath } from '../../../support/daemon/agenda-state.ts';

const homes: string[] = [];
let ids = 0;
const uniqueId = (): string => {
  ids += 1;
  return `id-${String(ids)}`;
};

async function createRepository(): Promise<{
  readonly home: string;
  readonly files: StateAgendaFiles;
  readonly repository: FileAgendaLedgerRepository;
}> {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-agenda-'));
  homes.push(home);
  const files = agendaFilesAt(home);
  return {
    home,
    files,
    repository: new FileAgendaLedgerRepository(files, uniqueId, NO_AGENDA_VERSIONS, recordingRuntime().runtime),
  };
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map(async home => await rm(home, { recursive: true, force: true })));
});

const request = {
  source: 'agent-raised' as const,
  sourceRef: null,
  subject: 'Choose deployment region',
  why: 'The rollout is blocked.',
  premise: 'A rollout is ready.',
  context: 'It cannot start until a region is chosen.',
  howToResolve: 'Choose a region.',
  ask: {
    kind: 'multiple-choice' as const,
    options: [{ label: 'eu' }, { label: 'us' }],
  },
};

const service = (repository: FileAgendaLedgerRepository) =>
  new AgendaService(
    repository,
    { now: () => '2026-07-31T10:00:00Z' },
    { has: async sessionId => sessionId === 'session-1' },
    { raised: async () => undefined },
  );

/** A transaction that moves `records` into the history, as a prune does. */
const archiving =
  (records: readonly AgendaArchiveRecord[]) =>
  (ledger: AgendaLedger | null): AgendaMutation => {
    const board = ledger ?? emptyAgendaLedger('session-1', '2026-11-03T08:00:00Z');
    return {
      ok: true,
      changed: true,
      change: 'refreshed',
      ledger: { ...board, archivePending: [...records] },
      snapshot: agendaSnapshot(board),
    };
  };

const ownerRecord = (note: string): AgendaArchiveRecord =>
  ({
    kind: 'owner-history',
    id: 'A1',
    entry: { at: '2026-11-03T08:00:00Z', kind: 'replied', note },
  }) as AgendaArchiveRecord;

describe('the agenda files on the kernel state port', () => {
  it('should keep a ferret’s files under state/asks/ferrets/<ferret>/ with the names the engine knows them by', async () => {
    const { home, files } = await createRepository();
    await files.writeAtomic('session-1', 'agenda.json', '{"a":1}\n');
    await files.writeAtomic('session-1', 'agenda-replies.json', '{}\n');
    should(await readFile(agendaFilePath(home, 'session-1', 'agenda.json'), 'utf8')).equal('{"a":1}\n');
    should((await readdir(join(home, 'state', 'asks', 'ferrets', 'session-1'))).toSorted()).deepEqual([
      'agenda-replies.json',
      'agenda.json',
    ]);
    should(files.file('session-1', 'agenda.json')).equal('state/asks/ferrets/session-1/agenda.json');
  });

  it('should append durable UTF-8 bytes and read only a requested suffix, refusing missing committed bytes', async () => {
    const { files } = await createRepository();
    should(await files.readAfter('session-1', AGENDA_ARCHIVE_FILE, 0)).deepEqual(new Uint8Array());
    await should(files.readAfter('session-1', AGENDA_ARCHIVE_FILE, 1)).be.rejectedWith(/cursor exceeds/u);
    const first = Buffer.from('{"words":"雪 🦦"}\n');
    const second = Buffer.from('{"words":"another"}\n');
    await files.appendSynced('session-1', AGENDA_ARCHIVE_FILE, first);
    await files.appendSynced('session-1', AGENDA_ARCHIVE_FILE, second);
    should(Buffer.from(await files.readAfter('session-1', AGENDA_ARCHIVE_FILE, first.length)).toString()).equal(
      second.toString(),
    );
    should((await files.readAfter('session-1', AGENDA_ARCHIVE_FILE, first.length + second.length)).length).equal(0);
    await should(files.readAfter('session-1', AGENDA_ARCHIVE_FILE, first.length + second.length + 1)).be.rejectedWith(
      /cursor exceeds/u,
    );
  });

  it('should cut a file back to its committed bytes, keeping them untouched', async () => {
    const { files } = await createRepository();
    const committed = Buffer.from('{"words":"雪"}\n');
    await files.appendSynced('session-1', AGENDA_ARCHIVE_FILE, committed);
    await files.appendSynced('session-1', AGENDA_ARCHIVE_FILE, Buffer.from('{"words":"rolled back"}\n'));
    await files.truncate('session-1', AGENDA_ARCHIVE_FILE, committed.length);
    should(await files.read('session-1', AGENDA_ARCHIVE_FILE)).equal(committed.toString());
    await should(files.truncate('session-2', AGENDA_ARCHIVE_FILE, 0)).be.rejectedWith(/not there/u);
  });

  it('should read a file with the identity of the very bytes read, and say a missing one has neither', async () => {
    const { files } = await createRepository();
    await files.writeAtomic('session-1', 'agenda.json', '{"a":1}\n');
    const read = await files.readIdentified('session-1', 'agenda.json');
    const identity = await files.identity('session-1', 'agenda.json');
    await files.writeAtomic('session-1', 'agenda.json', '{"a":2}\n');
    should(read).eql({ text: '{"a":1}\n', identity });
    should(await files.identity('session-1', 'agenda.json')).not.equal(identity);
    should(await files.identity('session-2', 'agenda.json')).be.undefined();
    should(await files.readIdentified('session-2', 'agenda.json')).be.undefined();
  });

  it('should set a file aside under set-aside/<ferret>~<name>, the copy landing before the original goes', async () => {
    const { home, files } = await createRepository();
    await files.writeAtomic('session-1', 'agenda-replies.json', 'not json');
    await files.rename('session-1', 'agenda-replies.json', 'agenda-replies.json.damaged-x');
    should(await readFile(setAsidePath(home, 'session-1', 'agenda-replies.json.damaged-x'), 'utf8')).equal('not json');
    should(await files.read('session-1', 'agenda-replies.json')).be.undefined();
  });

  it('should refuse an invalid session id before touching the state folder', async () => {
    const { files } = await createRepository();
    should(() => files.file('../session', 'agenda.json')).throw(/not a valid agenda session id/u);
    await should(files.read('../session', 'agenda.json')).be.rejectedWith(/not a valid agenda session id/u);
  });
});

describe('FileAgendaLedgerRepository', () => {
  it('should never serve a torn history append, and write it once when its command is retried', async () => {
    const { home, repository } = await createRepository();
    const first = ownerRecord('雪 owner words');
    const second = ownerRecord('second 雪 record');
    await repository.transact('session-1', archiving([first]));
    const history = agendaFilePath(home, 'session-1', AGENDA_ARCHIVE_FILE);
    const committed = await readFile(history, 'utf8');
    should(committed).equal(`${JSON.stringify(first)}\n`);
    // A crash tore the append of `second`: its mark is down, its bytes only partly, its ledger write never ran.
    const text = `${JSON.stringify(second)}\n`;
    await writeFile(history, committed + text.slice(0, 15));
    await writeFile(
      agendaFilePath(home, 'session-1', `${AGENDA_ARCHIVE_FILE}.pending`),
      JSON.stringify({ bytes: Buffer.byteLength(committed) }),
    );
    should(await repository.readArchive('session-1')).deepEqual([first]);

    await repository.transact('session-1', archiving([second]));

    should(await readFile(history, 'utf8')).equal(committed + text);
    should(await repository.readArchive('session-1')).deepEqual([first, second]);
    should((await repository.read('session-1'))?.archive).deepEqual({
      bytes: Buffer.byteLength(committed + text),
      count: 2,
    });
    should(await readdir(dirname(history))).not.containEql(`${AGENDA_ARCHIVE_FILE}.pending`);
    await writeFile(history, 'partial');
    await should(repository.readArchive('session-1')).be.rejectedWith('incomplete agenda history');
  });

  it('should keep serving correct agendas past its cache limit, dropping only the copy read longest ago', async () => {
    // Arrange
    const { home, repository } = await createRepository();
    const sessions = Array.from({ length: AGENDA_CACHE_LIMIT + 1 }, (_, n) => `bounded-${n}`);
    await Promise.all(
      sessions.map(async id => {
        const file = agendaFilePath(home, id, 'agenda.json');
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, `${JSON.stringify(emptyAgendaLedger(id, '2026-07-31T10:00:00Z'))}\n`);
      }),
    );

    // Act — fill the cache, touch the oldest again, push one more in, then change the oldest on disk.
    for (const id of sessions.slice(0, AGENDA_CACHE_LIMIT)) await repository.read(id);
    const touched = await repository.read('bounded-0');
    const pushed = await repository.read(`bounded-${AGENDA_CACHE_LIMIT}`);
    await writeFile(
      agendaFilePath(home, 'bounded-1', 'agenda.json'),
      `${JSON.stringify(emptyAgendaLedger('bounded-1', '2026-07-31T10:05:00Z'))}\n`,
    );
    const evicted = await repository.read('bounded-1');

    // Assert
    should(touched?.sessionId).equal('bounded-0');
    should(pushed?.sessionId).equal(`bounded-${AGENDA_CACHE_LIMIT}`);
    should(evicted?.sessionId).equal('bounded-1');
    should(evicted?.updatedAt).equal('2026-07-31T10:05:00Z');
    should(await repository.read('bounded-0')).equal(touched);
  });

  it('should see a ledger rewritten on disk outside the daemon on the next read, though it read it a moment before', async () => {
    const { home, repository } = await createRepository();
    await service(repository).raise('session-1', request, { kind: 'agent', sessionId: 'session-1', name: 'Ada' });
    should((await repository.read('session-1'))?.entries).have.length(1);
    should((await repository.read('session-1'))?.entries).have.length(1);

    // An editor empties the file in place.
    await writeFile(
      agendaFilePath(home, 'session-1', 'agenda.json'),
      `${JSON.stringify(emptyAgendaLedger('session-1', '2026-07-31T10:01:00Z'), null, 2)}\n`,
    );

    should((await repository.read('session-1'))?.entries).have.length(0);
  });

  it('should atomically persist and reload lifecycle state in the ferret’s own folder', async () => {
    const { home, repository } = await createRepository();
    const agenda = service(repository);
    const created = await agenda.raise('session-1', request, { kind: 'agent', sessionId: 'session-1', name: 'Ada' });
    const listed = await agenda.list('session-1');
    const text = await readFile(agendaFilePath(home, 'session-1', 'agenda.json'), 'utf8');

    should(created).containDeep({ ok: true, change: 'created', snapshot: { count: 1 } });
    should(listed).containDeep({ ok: true, value: { count: 1, items: [{ id: 'A1', subject: request.subject }] } });
    should(JSON.parse(text)).containDeep({ sessionId: 'session-1', nextId: 2, version: 1 });
    // The kernel's atomic write leaves no temporary file behind.
    should(await readdir(dirname(agendaFilePath(home, 'session-1', 'agenda.json')))).deepEqual(['agenda.json']);
  });

  it('should serialize concurrent mutations so no ask is lost', async () => {
    const { repository } = await createRepository();
    const agenda = service(repository);
    await Promise.all(
      Array.from(
        { length: 5 },
        async (_, index) =>
          await agenda.raise(
            'session-1',
            { ...request, subject: `Choose deployment region ${index}` },
            { kind: 'agent', sessionId: 'session-1', name: 'Ada' },
          ),
      ),
    );
    const listed = await agenda.list('session-1');
    should(listed).containDeep({ ok: true, value: { count: 5 } });
    if (!listed.ok) throw new Error(listed.error.message);
    should(listed.value.items.map(item => item.id)).deepEqual(['A1', 'A2', 'A3', 'A4', 'A5']);
  });

  it('should refuse malformed durable state instead of overwriting it as an empty board', async () => {
    const { home, repository } = await createRepository();
    const file = agendaFilePath(home, 'session-1', 'agenda.json');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, '{not json');
    const failure = await repository.read('session-1').then(
      () => undefined,
      error => error as Error,
    );
    should(failure instanceof InvalidAgendaLedgerError).be.true();
    should(await readFile(file, 'utf8')).equal('{not json');
  });

  it('should refuse a board written at any format but 1', async () => {
    const { home, repository } = await createRepository();
    const file = agendaFilePath(home, 'session-1', 'agenda.json');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ ...emptyAgendaLedger('session-1', '2026-11-03T08:00:00Z'), version: 2 }));
    await should(repository.read('session-1')).be.rejectedWith(InvalidAgendaLedgerError);
  });

  it('should surface a read failure that is not a missing file instead of treating the board as empty', async () => {
    // The board's place is taken by a directory, so reading it fails with something other than "not there".
    const { home, repository } = await createRepository();
    await mkdir(agendaFilePath(home, 'session-1', 'agenda.json'), { recursive: true });
    const failure = await repository.read('session-1').then(
      () => undefined,
      error => error as Error,
    );
    should(failure).not.be.undefined();
    should(failure instanceof InvalidAgendaLedgerError).be.false();
    should(failure?.message).match(/state\/asks\/ferrets\/session-1\/agenda\.json/u);
  });

  it('should let the next mutation proceed after one that throws', async () => {
    const { repository } = await createRepository();
    const failure = await repository
      .transact('session-1', () => {
        throw new Error('apply refused');
      })
      .then(
        () => undefined,
        error => error as Error,
      );
    const next = await repository.transact('session-1', current => {
      should(current).be.null();
      return { ok: false, error: { code: 'not_found', message: 'nothing here' } } as unknown as AgendaMutation;
    });
    should(failure?.message).equal('apply refused');
    should(next.ok).be.false();
  });
});

describe('where a ferret’s agenda file lives', () => {
  it('should name it by its state path, and refuse an id that is not a ferret’s', async () => {
    const { repository } = await createRepository();
    should(repository.file('session-1')).equal('state/asks/ferrets/session-1/agenda.json');
    should(() => repository.file('../escape')).throw('not a valid agenda session id: ../escape');
  });
});
