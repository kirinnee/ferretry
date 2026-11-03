import { describe, it } from 'bun:test';
import should from 'should';
import {
  AGENDA_CACHE_LIMIT,
  FileAgendaLedgerRepository,
} from '../../../src/adapters/agenda/file-agenda-ledger-repository.ts';
import { AGENDA_ARCHIVE_FILE } from '../../../src/lib/agenda/archive.ts';
import { AGENDA_FILES, emptyAgendaLedger } from '../../../src/lib/agenda/index.ts';
import { AgendaService } from '../../../src/lib/agenda/service.ts';
import {
  type AgendaLedger,
  type AgendaMutation,
  agendaSnapshot,
  type applyAgendaCommand,
  applyAgendaCommandToSession,
} from '../../../src/lib/agenda/state-machine.ts';

/**
 * The agenda repository's parsed copy: kept per session against the identity of the file it was read from,
 * dropped by every write, and never trusted over the file. The file store here is in memory, and a file
 * changed "outside the daemon" is one given new text and a new identity behind the repository's back.
 */

const NOW = '2026-10-31T10:00:00.000Z';
const SESSION = 'session-1';
const { current, legacy } = AGENDA_FILES.ledger;

class MemoryFiles {
  readonly files = new Map<string, { text: string; identity: string }>();
  parses = 0;
  readonly fullReads: string[] = [];
  readonly tailReads: number[] = [];
  failLedgerWrite = false;
  private stamp = 0;

  file(sessionId: string, name: string): string {
    return `/state/sessions/${sessionId}/${name}`;
  }

  async read(sessionId: string, name: string): Promise<string | undefined> {
    this.fullReads.push(name);
    return this.files.get(`${sessionId}/${name}`)?.text;
  }

  async readAfter(sessionId: string, name: string, bytes: number): Promise<Uint8Array> {
    this.tailReads.push(bytes);
    return Buffer.from(this.files.get(`${sessionId}/${name}`)?.text ?? '').subarray(bytes);
  }

  async appendSynced(sessionId: string, name: string, bytes: Uint8Array): Promise<void> {
    this.put(
      sessionId,
      name,
      (this.files.get(`${sessionId}/${name}`)?.text ?? '') + Buffer.from(bytes).toString('utf8'),
    );
  }

  async writeAtomic(sessionId: string, name: string, text: string): Promise<void> {
    if (this.failLedgerWrite && name === current) {
      this.failLedgerWrite = false;
      throw new Error('ledger commit failed');
    }
    this.put(sessionId, name, text);
  }

  async rename(sessionId: string, from: string, to: string): Promise<void> {
    const file = this.files.get(`${sessionId}/${from}`);
    this.files.delete(`${sessionId}/${from}`);
    if (file !== undefined) this.files.set(`${sessionId}/${to}`, file);
  }

  async remove(sessionId: string, name: string): Promise<void> {
    this.files.delete(`${sessionId}/${name}`);
  }

  async identity(sessionId: string, name: string): Promise<string | undefined> {
    return this.files.get(`${sessionId}/${name}`)?.identity;
  }

  async readIdentified(sessionId: string, name: string) {
    const file = this.files.get(`${sessionId}/${name}`);
    if (file !== undefined) this.parses += 1;
    return file;
  }

  /** A whole new file: what an atomic write, an editor or another process leaves behind. */
  put(sessionId: string, name: string, text: string): void {
    this.stamp += 1;
    this.files.set(`${sessionId}/${name}`, { text, identity: `file-${this.stamp}` });
  }
}

const request = {
  source: 'agent-raised' as const,
  sourceRef: null,
  subject: 'Choose deployment region',
  why: 'The rollout is blocked.',
  premise: 'A rollout is ready.',
  context: 'It cannot start until a region is chosen.',
  howToResolve: 'Choose a region.',
  ask: { kind: 'multiple-choice' as const, options: [{ label: 'eu' }, { label: 'us' }] },
};

const subject = () => {
  const files = new MemoryFiles();
  const repository = new FileAgendaLedgerRepository(id => `/state/sessions/${id}`, undefined, undefined, files);
  const service = new AgendaService(
    repository,
    { now: () => NOW },
    { has: async sessionId => sessionId === SESSION },
    { raised: async () => undefined },
  );
  return { files, repository, service };
};

const raise = async (service: AgendaService, subject = request.subject) =>
  await service.raise(SESSION, { ...request, subject }, { kind: 'agent', sessionId: SESSION, name: 'Ada' });

describe('the agenda repository cache', () => {
  it('should parse an unchanged agenda once, and hand every reader the same frozen copy', async () => {
    // Arrange
    const { files, repository, service } = subject();
    await raise(service);
    const parsed = files.parses;

    // Act
    const first = await repository.read(SESSION);
    const second = await repository.read(SESSION);

    // Assert
    should(files.parses).equal(parsed + 1);
    should(second).equal(first);
    should(Object.isFrozen(first)).be.true();
    should(Object.isFrozen(first?.entries[0]?.item)).be.true();
  });

  it('should see an agenda rewritten outside the daemon on the next read', async () => {
    // Arrange
    const { files, repository, service } = subject();
    await raise(service);
    should((await repository.read(SESSION))?.entries).have.length(1);

    // Act — a person (or another process) empties the file.
    files.put(SESSION, current, `${JSON.stringify(emptyAgendaLedger(SESSION, NOW))}\n`);
    const read = await repository.read(SESSION);

    // Assert
    should(read?.entries).have.length(0);
  });

  it("should see the daemon's own write at once, though a copy was kept a moment before", async () => {
    // Arrange
    const { repository, service } = subject();
    await raise(service);
    should((await service.list(SESSION)).ok).be.true();

    // Act
    await raise(service, 'Choose a second region');
    const listed = await service.list(SESSION);

    // Assert
    should(listed.ok && listed.value.count).equal(2);
    should((await repository.read(SESSION))?.entries).have.length(2);
  });

  it('should read the old name when only it exists, and nothing once neither does', async () => {
    // Arrange
    const { files, repository, service } = subject();
    await raise(service);
    await files.rename(SESSION, current, legacy);

    // Act
    const fromLegacy = await repository.read(SESSION);
    await files.remove(SESSION, legacy);
    const gone = await repository.read(SESSION);

    // Assert
    should(fromLegacy?.entries).have.length(1);
    should(gone).be.null();
  });

  it('should refuse a damaged agenda every time it is read, never serving the last good copy', async () => {
    // Arrange
    const { files, repository, service } = subject();
    await raise(service);
    await repository.read(SESSION);

    // Act
    files.put(SESSION, current, '{ "not": "a ledger"');

    // Assert
    await should(repository.read(SESSION)).be.rejectedWith({ name: 'Error', file: files.file(SESSION, current) });
    await should(repository.read(SESSION)).be.rejectedWith({ file: files.file(SESSION, current) });
  });
});

describe('the agenda repository cache limit', () => {
  const seed = (files: MemoryFiles, count: number) => {
    for (let n = 0; n < count; n += 1) {
      const id = `bounded-${n}`;
      files.put(id, current, `${JSON.stringify(emptyAgendaLedger(id, NOW))}\n`);
    }
  };

  it('should drop the session read longest ago when full, and keep every other copy', async () => {
    // Arrange
    const { files, repository } = subject();
    seed(files, AGENDA_CACHE_LIMIT + 1);
    for (let n = 0; n < AGENDA_CACHE_LIMIT; n += 1) await repository.read(`bounded-${n}`);
    const parsed = files.parses;

    // Act
    await repository.read(`bounded-${AGENDA_CACHE_LIMIT}`);
    await repository.read('bounded-1');
    const keptParses = files.parses;
    await repository.read('bounded-0');

    // Assert
    should(keptParses).equal(parsed + 1);
    should(files.parses).equal(keptParses + 1);
  });

  it('should keep a session that was read again recently, and drop the next oldest instead', async () => {
    // Arrange
    const { files, repository } = subject();
    seed(files, AGENDA_CACHE_LIMIT + 1);
    for (let n = 0; n < AGENDA_CACHE_LIMIT; n += 1) await repository.read(`bounded-${n}`);
    await repository.read('bounded-0');
    const parsed = files.parses;

    // Act
    await repository.read(`bounded-${AGENDA_CACHE_LIMIT}`);
    await repository.read('bounded-0');
    const keptParses = files.parses;
    await repository.read('bounded-1');

    // Assert
    should(keptParses).equal(parsed + 1);
    should(files.parses).equal(keptParses + 1);
  });
});

describe('the private agenda archive', () => {
  const agent = { kind: 'agent' as const, sessionId: SESSION, name: 'Ada' };
  const human = { kind: 'human' as const };
  const ok = (mutation: AgendaMutation) => {
    if (!mutation.ok) throw new Error(mutation.error.message);
    return mutation;
  };
  const save = async (repository: FileAgendaLedgerRepository, command: Parameters<typeof applyAgendaCommand>[1]) =>
    ok(await repository.transact(SESSION, current => applyAgendaCommandToSession(current, SESSION, command)));

  it('should retain sixty owner rounds without growing or rereading the hot archive, even after the item is pruned', async () => {
    const { files, repository } = subject();
    await save(repository, {
      action: 'raise',
      actor: agent,
      at: NOW,
      request: {
        ...request,
        ask: { kind: 'open-question' },
        body: 'b'.repeat(200_000),
        whereWeAre: 'w'.repeat(200_000),
        detail: 'd'.repeat(118_000),
        context: 'c'.repeat(40_000),
      },
    });
    for (let n = 1; n <= 60; n++) {
      await save(repository, {
        action: 'answer',
        actor: human,
        at: NOW,
        id: 'A1',
        response: { kind: 'open-question', answer: `ANSWER_${n}:${'a'.repeat(63_970)}` },
        note: `NOTE_${n}:${'n'.repeat(63_970)}`,
      });
      await save(repository, {
        action: 'edit',
        actor: agent,
        at: NOW,
        id: 'A1',
        patch: { questionAnswer: `Round ${n}` },
      });
    }
    const hot = files.files.get(`${SESSION}/${current}`)?.text ?? '';
    const archived = files.files.get(`${SESSION}/${AGENDA_ARCHIVE_FILE}`)?.text ?? '';
    should(hot.length).be.below(1_100_000);
    should(archived.length).be.above(7_000_000);
    should(hot).not.containEql('archivePending');
    should(hot).not.containEql('ownerHistory');
    should(files.fullReads).not.containEql(AGENDA_ARCHIVE_FILE);
    should(files.tailReads.filter(offset => offset === 0)).have.length(2);
    const ledger = await repository.read(SESSION);
    if (ledger === null) throw new Error('no board');
    const words = JSON.stringify(await repository.readArchive(SESSION)) + JSON.stringify(agendaSnapshot(ledger));
    for (let n = 1; n <= 60; n++) {
      should(words).containEql(`ANSWER_${n}:`);
      should(words).containEql(`NOTE_${n}:`);
    }
    const closed = await save(repository, { action: 'resolve', actor: agent, at: NOW, id: 'A1' });
    const entry = closed.ledger.entries[0];
    if (entry?.lifecycle !== 'addressed') throw new Error('not closed');
    const {
      body: _body,
      whereWeAre: _where,
      detail: _detail,
      history: _history,
      revisions: _revisions,
      ownerAnswer: _answer,
      ...small
    } = entry.item;
    const full: AgendaLedger = {
      ...closed.ledger,
      nextId: 101,
      entries: [...Array.from({ length: 99 }, (_, n) => ({ ...entry, item: { ...small, id: `A${n + 2}` } })), entry],
    };
    files.put(SESSION, current, JSON.stringify(full));
    await save(repository, { action: 'raise', actor: agent, at: NOW, request });
    const pruned = await save(repository, { action: 'resolve', actor: human, at: NOW, id: 'A101' });
    should(pruned.ledger.entries.some(entry => entry.item.id === 'A1')).be.false();
    const remainingWords = JSON.stringify(await repository.readArchive(SESSION));
    for (let n = 1; n <= 60; n++) should(remainingWords).containEql(`ANSWER_${n}:`);
    should(files.files.get(`${SESSION}/${AGENDA_ARCHIVE_FILE}`)?.text).startWith(archived);
  });

  it('should keep the closing note and structured answer of an item whose closed history is pruned', async () => {
    const { files, repository } = subject();
    await save(repository, { action: 'raise', actor: agent, at: NOW, request: { ...request, ask: { kind: 'task' } } });
    await save(repository, { action: 'reply', actor: human, at: NOW, id: 'A1', note: 'OWNER_REPLY_KEPT' });
    await save(repository, { action: 'resolve', actor: human, at: NOW, id: 'A1', note: 'OWNER_DONE_KEPT' });
    await save(repository, {
      action: 'raise',
      actor: { kind: 'daemon', cause: 'system' },
      at: NOW,
      request: {
        ...request,
        ask: { kind: 'multiple-choice', options: [{ label: 'CHOICE_KEPT' }, { label: 'other' }] },
      },
    });
    await save(repository, {
      action: 'answer',
      actor: human,
      at: NOW,
      id: 'A2',
      response: { kind: 'multiple-choice', choice: 'CHOICE_KEPT' },
      note: 'OWNER_ANSWER_NOTE_KEPT',
    });
    for (let n = 0; n < 100; n++) {
      const raised = await save(repository, { action: 'raise', actor: agent, at: NOW, request });
      await save(repository, { action: 'resolve', actor: human, at: NOW, id: raised.item?.id ?? 'missing' });
    }
    const ledger = await repository.read(SESSION);
    if (ledger === null) throw new Error('no board');
    should(ledger.entries.some(entry => entry.item.id === 'A1' || entry.item.id === 'A2')).be.false();
    const kept = JSON.stringify(await repository.readArchive(SESSION));
    for (const words of [
      'OWNER_REPLY_KEPT',
      'OWNER_DONE_KEPT',
      'OWNER_ANSWER_NOTE_KEPT',
      '"response":{"kind":"multiple-choice","choice":"CHOICE_KEPT"}',
    ]) {
      should(kept).containEql(words);
    }
    should(files.files.get(`${SESSION}/${current}`)?.text).not.containEql('OWNER_DONE_KEPT');
  });

  it('should finish a torn history append when history is read, with no archive-producing action in between', async () => {
    const { files, repository } = subject();
    const first = { id: 'A1', entry: { at: NOW, kind: 'replied', note: 'first committed owner record' } };
    const second = { kind: 'owner-history', id: 'A1', entry: { at: NOW, kind: 'replied', note: 'second 雪 record' } };
    files.put(SESSION, current, JSON.stringify({ ...emptyAgendaLedger(SESSION, NOW), ownerHistory: [first] }));
    const unchanged = (current: AgendaLedger | null) => {
      if (current === null) throw new Error('no board');
      return {
        ok: true as const,
        changed: false,
        change: 'unchanged' as const,
        ledger: current,
        snapshot: agendaSnapshot(current),
      };
    };
    ok(await repository.transact(SESSION, unchanged));
    const committed = files.files.get(`${SESSION}/${AGENDA_ARCHIVE_FILE}`)?.text ?? '';
    const text = `${JSON.stringify(second)}\n`;
    files.put(SESSION, AGENDA_ARCHIVE_FILE, committed + text.slice(0, 15));
    files.put(SESSION, `${AGENDA_ARCHIVE_FILE}.pending`, JSON.stringify({ bytes: Buffer.byteLength(committed), text }));
    const restarted = new FileAgendaLedgerRepository(id => `/state/sessions/${id}`, undefined, undefined, files);
    ok(await restarted.transact(SESSION, unchanged));
    should(files.files.has(`${SESSION}/${AGENDA_ARCHIVE_FILE}.pending`)).be.true();
    const records = await restarted.readArchive(SESSION);
    should(records).deepEqual([{ kind: 'owner-history', ...first }, second]);
    should(files.files.has(`${SESSION}/${AGENDA_ARCHIVE_FILE}.pending`)).be.false();
    should(files.files.get(`${SESSION}/${AGENDA_ARCHIVE_FILE}`)?.text).equal(committed + text);
  });

  it('should migrate in-ledger owner history once and replay an append whose cursor commit failed', async () => {
    const { files, repository } = subject();
    const record = { id: 'A1', entry: { at: NOW, kind: 'replied', note: 'Owner 雪 words' } };
    files.put(SESSION, current, JSON.stringify({ ...emptyAgendaLedger(SESSION, NOW), ownerHistory: [record] }));
    should(await repository.readArchive(SESSION)).deepEqual([]);
    files.failLedgerWrite = true;
    const unchanged = (current: AgendaLedger | null) => {
      if (current === null) throw new Error('no board');
      return {
        ok: true as const,
        changed: false,
        change: 'unchanged' as const,
        ledger: current,
        snapshot: agendaSnapshot(current),
      };
    };
    await should(repository.transact(SESSION, unchanged)).be.rejectedWith('ledger commit failed');
    const appended = files.files.get(`${SESSION}/${AGENDA_ARCHIVE_FILE}`)?.text;
    const restarted = new FileAgendaLedgerRepository(id => `/state/sessions/${id}`, undefined, undefined, files);
    const migrated = ok(await restarted.transact(SESSION, unchanged));
    should(migrated.ledger.archivePending).be.undefined();
    should(migrated.ledger.archive?.count).equal(1);
    should(files.files.get(`${SESSION}/${AGENDA_ARCHIVE_FILE}`)?.text).equal(appended);
    should(await restarted.readArchive(SESSION)).deepEqual([{ kind: 'owner-history', ...record }]);
    should(files.files.get(`${SESSION}/${current}`)?.text).not.containEql('ownerHistory');
    await restarted.transact(SESSION, unchanged);
    should(files.files.get(`${SESSION}/${AGENDA_ARCHIVE_FILE}`)?.text).equal(appended);
  });
});
