import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import should from 'should';
import { FileAgendaFileStore } from '../../../../daemon/adapters/agenda/file-agenda-file-store.ts';
import {
  AGENDA_CACHE_LIMIT,
  FileAgendaLedgerRepository,
  InvalidAgendaLedgerError,
} from '../../../../daemon/adapters/agenda/file-agenda-ledger-repository.ts';
import { AGENDA_ARCHIVE_FILE } from '../../../../daemon/lib/agenda/archive.ts';
import {
  AGENDA_LEDGER_VERSION,
  type AgendaMutation,
  agendaSnapshot,
  emptyAgendaLedger,
} from '../../../../daemon/lib/agenda/index.ts';
import { AgendaService } from '../../../../daemon/lib/agenda/service.ts';

const homes: string[] = [];

async function createRepository(): Promise<{
  readonly home: string;
  readonly repository: FileAgendaLedgerRepository;
}> {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-agenda-'));
  homes.push(home);
  return {
    home,
    repository: new FileAgendaLedgerRepository(sessionId => join(home, 'sessions', sessionId)),
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

describe('the agenda file store, read with its identity', () => {
  it('should append durable UTF-8 bytes and read only a requested suffix, refusing missing committed bytes', async () => {
    const { home } = await createRepository();
    const store = new FileAgendaFileStore(id => join(home, 'sessions', id));
    should(await store.readAfter('session-1', 'history.jsonl', 0)).deepEqual(new Uint8Array());
    await should(store.readAfter('session-1', 'history.jsonl', 1)).be.rejectedWith({ code: 'ENOENT' });
    const first = Buffer.from('{"words":"雪 🦦"}\n');
    const second = Buffer.from('{"words":"another"}\n');
    await store.appendSynced('session-1', 'history.jsonl', first);
    await store.appendSynced('session-1', 'history.jsonl', second);
    should(Buffer.from(await store.readAfter('session-1', 'history.jsonl', first.length)).toString()).equal(
      second.toString(),
    );
    should(Buffer.from(await store.readAfter('session-1', 'history.jsonl', first.length + second.length)).length).equal(
      0,
    );
    await should(store.readAfter('session-1', 'history.jsonl', first.length + second.length + 1)).be.rejectedWith(
      /cursor exceeds/u,
    );
    await mkdir(store.file('session-1', 'directory'));
    await should(store.readAfter('session-1', 'directory', 0)).be.rejected();
  });
  it('should cut a file back to its committed bytes, keeping them untouched', async () => {
    const { home } = await createRepository();
    const store = new FileAgendaFileStore(id => join(home, 'sessions', id));
    const committed = Buffer.from('{"words":"雪"}\n');
    await store.appendSynced('session-1', 'history.jsonl', committed);
    await store.appendSynced('session-1', 'history.jsonl', Buffer.from('{"words":"rolled back"}\n'));
    await store.truncate('session-1', 'history.jsonl', committed.length);
    should(await store.read('session-1', 'history.jsonl')).equal(committed.toString());
    await should(store.truncate('session-1', 'absent.jsonl', 0)).be.rejectedWith({ code: 'ENOENT' });
  });
  it('should read a file with the identity of the very file read, and say a missing one has neither', async () => {
    // Arrange
    const home = await mkdtemp(join(tmpdir(), 'ferretry-agenda-'));
    homes.push(home);
    const store = new FileAgendaFileStore(sessionId => join(home, 'sessions', sessionId));
    await store.writeAtomic('session-1', 'agenda.json', '{"a":1}\n');

    // Act
    const read = await store.readIdentified('session-1', 'agenda.json');
    const identity = await store.identity('session-1', 'agenda.json');
    await store.writeAtomic('session-1', 'agenda.json', '{"a":2}\n');
    const replaced = await store.identity('session-1', 'agenda.json');

    // Assert
    should(read).eql({ text: '{"a":1}\n', identity });
    should(replaced).not.equal(identity);
    should(await store.identity('session-1', 'missing.json')).be.undefined();
    should(await store.readIdentified('session-1', 'missing.json')).be.undefined();
  });

  it('should refuse, not call missing, a file that cannot be read for any other reason', async () => {
    // Arrange — the session "directory" is a regular file, so every path below it is ENOTDIR.
    const home = await mkdtemp(join(tmpdir(), 'ferretry-agenda-'));
    homes.push(home);
    await writeFile(join(home, 'session-1'), 'not a directory');
    const store = new FileAgendaFileStore(sessionId => join(home, sessionId));

    // Act / Assert
    await should(store.identity('session-1', 'agenda.json')).be.rejectedWith({ code: 'ENOTDIR' });
    await should(store.readIdentified('session-1', 'agenda.json')).be.rejectedWith({ code: 'ENOTDIR' });
  });
});

describe('FileAgendaLedgerRepository', () => {
  it('should durably migrate owner history to a private append-only sidecar, replacing a torn UTF-8 append', async () => {
    const { repository } = await createRepository();
    const file = repository.file('session-1');
    const directory = dirname(file);
    await mkdir(directory, { recursive: true });
    const record = {
      kind: 'owner-history',
      id: 'A1',
      entry: { at: '2026-11-03T08:00:00Z', kind: 'replied', note: '雪 owner words' },
    };
    const text = `${JSON.stringify(record)}\n`;
    const firstByteOfSnow = Buffer.from(text).indexOf(Buffer.from('雪'));
    await writeFile(join(directory, AGENDA_ARCHIVE_FILE), Buffer.from(text).subarray(0, firstByteOfSnow + 1));
    await writeFile(join(directory, `${AGENDA_ARCHIVE_FILE}.pending`), JSON.stringify({ bytes: 0 }));
    await writeFile(
      file,
      JSON.stringify({
        ...emptyAgendaLedger('session-1', '2026-11-03T08:00:00Z'),
        ownerHistory: [{ id: record.id, entry: record.entry }],
      }),
    );
    await repository.transact('session-1', current => {
      if (current === null) throw new Error('no ledger');
      return { ok: true, changed: false, change: 'unchanged', ledger: current, snapshot: agendaSnapshot(current) };
    });
    should(await readFile(join(directory, AGENDA_ARCHIVE_FILE), 'utf8')).equal(text);
    should(await repository.readArchive('session-1')).deepEqual([record]);
    should((await repository.read('session-1'))?.archive).deepEqual({ bytes: Buffer.byteLength(text), count: 1 });
    should(await readFile(file, 'utf8')).not.containEql('ownerHistory');
    should(await readdir(directory)).not.containEql(`${AGENDA_ARCHIVE_FILE}.pending`);
    should(await repository.readArchive('no-history')).deepEqual([]);
    await writeFile(join(directory, AGENDA_ARCHIVE_FILE), 'partial');
    await should(repository.readArchive('session-1')).be.rejectedWith('incomplete agenda history');
  });
  it('should adopt the sidecar history of a ledger an older daemon rewrote without its cursor or version', async () => {
    const { repository } = await createRepository();
    const file = repository.file('session-1');
    const directory = dirname(file);
    await mkdir(directory, { recursive: true });
    const record = {
      kind: 'owner-history',
      id: 'A1',
      entry: { at: '2026-11-03T08:00:00Z', kind: 'replied', note: '雪 owner words' },
    };
    const text = `${JSON.stringify(record)}\n`;
    await writeFile(join(directory, AGENDA_ARCHIVE_FILE), `${text}{"torn":`);
    const { version: _version, ...older } = emptyAgendaLedger('session-1', '2026-11-03T08:00:00Z');
    await writeFile(file, JSON.stringify(older));
    should(await repository.readArchive('session-1')).deepEqual([record]);
    should((await repository.read('session-1'))?.archive).deepEqual({ bytes: Buffer.byteLength(text), count: 1 });
  });
  it('should adopt only the history before an append whose mark says its commit never landed', async () => {
    const { repository } = await createRepository();
    const file = repository.file('session-1');
    const directory = dirname(file);
    await mkdir(directory, { recursive: true });
    const record = {
      kind: 'owner-history',
      id: 'A1',
      entry: { at: '2026-11-03T08:00:00Z', kind: 'replied', note: '雪 owner words' },
    };
    const text = `${JSON.stringify(record)}\n`;
    const phantom = `${JSON.stringify({ ...record, entry: { ...record.entry, note: 'PHANTOM' } })}\n`;
    await writeFile(join(directory, AGENDA_ARCHIVE_FILE), text + phantom);
    await writeFile(
      join(directory, `${AGENDA_ARCHIVE_FILE}.pending`),
      JSON.stringify({ bytes: Buffer.byteLength(text) }),
    );
    const { version: _version, ...older } = emptyAgendaLedger('session-1', '2026-11-03T08:00:00Z');
    await writeFile(file, JSON.stringify(older));
    should(await repository.readArchive('session-1')).deepEqual([record]);
    await repository.transact('session-1', current => {
      if (current === null) throw new Error('no ledger');
      return { ok: true, changed: true, change: 'refreshed', ledger: current, snapshot: agendaSnapshot(current) };
    });
    should(await readdir(directory)).not.containEql(`${AGENDA_ARCHIVE_FILE}.pending`);
    should(JSON.parse(await readFile(file, 'utf8'))).containDeep({
      version: AGENDA_LEDGER_VERSION,
      archive: { bytes: Buffer.byteLength(text), count: 1 },
    });
    should(await repository.readArchive('session-1')).deepEqual([record]);
  });

  it('should keep serving correct agendas past its cache limit, dropping only the copy read longest ago', async () => {
    // Arrange
    const { repository } = await createRepository();
    const ids = Array.from({ length: AGENDA_CACHE_LIMIT + 1 }, (_, n) => `bounded-${n}`);
    await Promise.all(
      ids.map(async id => {
        await mkdir(dirname(repository.file(id)), { recursive: true });
        await writeFile(repository.file(id), `${JSON.stringify(emptyAgendaLedger(id, '2026-07-31T10:00:00Z'))}\n`);
      }),
    );

    // Act — fill the cache, touch the oldest again, push one more in, then change the oldest on disk.
    for (const id of ids.slice(0, AGENDA_CACHE_LIMIT)) await repository.read(id);
    const touched = await repository.read('bounded-0');
    const pushed = await repository.read(`bounded-${AGENDA_CACHE_LIMIT}`);
    await writeFile(
      repository.file('bounded-1'),
      `${JSON.stringify(emptyAgendaLedger('bounded-1', '2026-07-31T10:05:00Z'))}\n`,
    );
    const evicted = await repository.read('bounded-1');

    // Assert
    should(touched?.sessionId).equal('bounded-0');
    should(pushed?.sessionId).equal(`bounded-${AGENDA_CACHE_LIMIT}`);
    should(evicted?.sessionId).equal('bounded-1');
    should(await repository.read('bounded-0')).equal(touched);
  });

  it('should see a ledger rewritten on disk outside the daemon on the next read, though it read it a moment before', async () => {
    // Arrange
    const { repository } = await createRepository();
    const service = new AgendaService(
      repository,
      { now: () => '2026-07-31T10:00:00Z' },
      { has: async sessionId => sessionId === 'session-1' },
      { raised: async () => undefined },
    );
    await service.raise('session-1', request, { kind: 'agent', sessionId: 'session-1', name: 'Ada' });
    should((await repository.read('session-1'))?.entries).have.length(1);
    should((await repository.read('session-1'))?.entries).have.length(1);

    // Act — an editor empties the file in place.
    await writeFile(
      repository.file('session-1'),
      `${JSON.stringify(emptyAgendaLedger('session-1', '2026-07-31T10:01:00Z'), null, 2)}\n`,
    );
    const read = await repository.read('session-1');

    // Assert
    should(read?.entries).have.length(0);
  });

  it('should atomically persist and reload lifecycle state below the injected session directory', async () => {
    // Arrange
    const { repository } = await createRepository();
    const service = new AgendaService(
      repository,
      { now: () => '2026-07-31T10:00:00Z' },
      { has: async sessionId => sessionId === 'session-1' },
      { raised: async () => undefined },
    );

    // Act
    const created = await service.raise('session-1', request, {
      kind: 'agent',
      sessionId: 'session-1',
      name: 'Ada',
    });
    const listed = await service.list('session-1');
    const text = await readFile(repository.file('session-1'), 'utf8');

    // Assert
    should(created).containDeep({
      ok: true,
      change: 'created',
      snapshot: { count: 1 },
    });
    should(listed).containDeep({
      ok: true,
      value: { count: 1, items: [{ id: 'A1', subject: request.subject }] },
    });
    should(JSON.parse(text)).containDeep({ sessionId: 'session-1', nextId: 2 });
  });

  it('should serialize concurrent mutations so no attention item is lost', async () => {
    // Arrange
    const { repository } = await createRepository();
    const service = new AgendaService(
      repository,
      { now: () => '2026-07-31T10:00:00Z' },
      { has: async sessionId => sessionId === 'session-1' },
      { raised: async () => undefined },
    );

    // Act
    await Promise.all(
      Array.from(
        { length: 5 },
        async (_, index) =>
          await service.raise(
            'session-1',
            { ...request, subject: `Choose deployment region ${index}` },
            { kind: 'agent', sessionId: 'session-1', name: 'Ada' },
          ),
      ),
    );
    const listed = await service.list('session-1');

    // Assert
    should(listed).containDeep({ ok: true, value: { count: 5 } });
    if (!listed.ok) throw new Error(listed.error.message);
    should(listed.value.items.map(item => item.id)).deepEqual(['A1', 'A2', 'A3', 'A4', 'A5']);
  });

  it('should refuse malformed durable state instead of overwriting it as an empty board', async () => {
    // Arrange
    const { repository } = await createRepository();
    const file = repository.file('session-1');
    await mkdir(dirname(file), { recursive: true });
    await Bun.write(file, '{not json');

    // Act + Assert
    await repository.read('session-1').then(
      () => {
        throw new Error('expected corrupt ledger to reject');
      },
      error => should(error instanceof InvalidAgendaLedgerError).be.true(),
    );
  });

  it('should reject invalid session paths before touching the filesystem', async () => {
    // Arrange
    const { home, repository } = await createRepository();

    // Act + Assert
    should(() => repository.file('../session')).throw(/not a valid agenda session id/u);
    await writeFile(join(home, 'sentinel'), 'safe');
    should(await Bun.file(join(home, 'sentinel')).text()).equal('safe');
  });

  it('should surface a read failure that is not a missing file instead of treating the board as empty', async () => {
    // Arrange — the board's place is taken by a directory, so reading it fails with something other than ENOENT.
    const { repository } = await createRepository();
    await mkdir(repository.file('session-1'), { recursive: true });

    // Act
    const failure = await repository.read('session-1').then(
      () => undefined,
      error => error as NodeJS.ErrnoException,
    );

    // Assert
    should(failure).not.be.undefined();
    should(failure instanceof InvalidAgendaLedgerError).be.false();
    should(failure?.code).equal('EISDIR');
  });

  it('should remove its temporary file and rethrow when the write fails', async () => {
    // Arrange — the temporary name is already taken, so the exclusive create fails.
    const home = await mkdtemp(join(tmpdir(), 'ferretry-agenda-'));
    homes.push(home);
    const repository = new FileAgendaLedgerRepository(
      sessionId => join(home, 'sessions', sessionId),
      () => 'fixed',
    );
    const directory = dirname(repository.file('session-1'));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, '.agenda-fixed.tmp'), 'squatter');
    const service = new AgendaService(
      repository,
      { now: () => '2026-07-31T10:00:00Z' },
      { has: async sessionId => sessionId === 'session-1' },
      { raised: async () => undefined },
    );

    // Act
    const failure = await service
      .raise('session-1', request, {
        kind: 'agent',
        sessionId: 'session-1',
        name: 'Ada',
      })
      .then(
        () => undefined,
        error => error as NodeJS.ErrnoException,
      );

    // Assert
    should(failure?.code).equal('EEXIST');
    should(await readdir(directory)).deepEqual([]);
  });

  it('should let the next mutation proceed after one that throws', async () => {
    // Arrange
    const { repository } = await createRepository();
    const failing = repository.transact('session-1', () => {
      throw new Error('apply refused');
    });

    // Act
    const failure = await failing.then(
      () => undefined,
      error => error as Error,
    );
    const next = await repository.transact('session-1', current => {
      should(current).be.null();
      return {
        ok: false,
        error: { code: 'not_found', message: 'nothing here' },
      } as unknown as AgendaMutation;
    });

    // Assert
    should(failure?.message).equal('apply refused');
    should(next.ok).be.false();
  });
});
