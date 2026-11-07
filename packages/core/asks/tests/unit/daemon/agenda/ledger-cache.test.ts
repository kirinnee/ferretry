import { describe, it } from 'bun:test';
import type { AgendaConversationEntry } from '../../../../daemon/lib/protocol/agenda.ts';
import type { AgendaVersion } from '../../../../daemon/lib/protocol/agenda-versions.ts';
import should from 'should';
import {
  AGENDA_CACHE_LIMIT,
  FileAgendaLedgerRepository,
} from '../../../../daemon/adapters/agenda/file-agenda-ledger-repository.ts';
import { AGENDA_ARCHIVE_FILE, type AgendaArchiveRecord } from '../../../../daemon/lib/agenda/archive.ts';
import { AGENDA_FILES, emptyAgendaLedger } from '../../../../daemon/lib/agenda/index.ts';
import { AgendaService } from '../../../../daemon/lib/agenda/service.ts';
import type { AgendaVersionDraft, AgendaVersionStore } from '../../../../daemon/lib/agenda/versions.ts';
import {
  AGENDA_LEDGER_VERSION,
  type AgendaLedger,
  type AgendaMutation,
  agendaLedgerDocument,
  agendaSnapshot,
  type applyAgendaCommand,
  applyAgendaCommandToSession,
} from '../../../../daemon/lib/agenda/state-machine.ts';

/**
 * The agenda repository's parsed copy: kept per session against the identity of the file it was read from,
 * dropped by every write, and never trusted over the file. The file store here is in memory, and a file
 * changed "outside the daemon" is one given new text and a new identity behind the repository's back.
 */

const NOW = '2026-10-31T10:00:00.000Z';
const SESSION = 'session-1';
const current = AGENDA_FILES.ledger;

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

  async truncate(sessionId: string, name: string, bytes: number): Promise<void> {
    this.put(
      sessionId,
      name,
      Buffer.from(this.files.get(`${sessionId}/${name}`)?.text ?? '')
        .subarray(0, bytes)
        .toString('utf8'),
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

/** An in-memory version store that counts how often it is asked, so a test can tell a read that consulted it from one that did not. */
class MemoryVersions implements AgendaVersionStore {
  readonly kept = new Map<string, { snapshot: AgendaVersion; conversation: readonly AgendaConversationEntry[] }[]>();
  private readonly mutations = new Set<string>();
  reads = 0;

  async record(_session: string, drafts: readonly AgendaVersionDraft[]): Promise<void> {
    for (const draft of drafts) {
      if (draft.mutationId !== undefined) {
        const key = `${draft.entry.item.id}:${draft.mutationId}`;
        if (this.mutations.has(key)) continue;
        this.mutations.add(key);
      }
      const versions = this.kept.get(draft.entry.item.id) ?? [];
      // Only the newest version keeps its item and thread: a megabyte item per version would hold gigabytes.
      const previous = versions.at(-1);
      if (previous !== undefined) {
        const { version, at, by, change, lifecycle } = previous.snapshot;
        versions[versions.length - 1] = {
          snapshot: { version, at, by, change, lifecycle } as AgendaVersion,
          conversation: [],
        };
      }
      versions.push({
        snapshot: {
          version: versions.length + 1,
          at: draft.at,
          by: draft.by,
          change: draft.change,
          lifecycle: draft.entry.lifecycle,
          item: draft.entry.item,
        } as AgendaVersion,
        conversation: draft.conversation ?? draft.entry.item.conversation ?? [],
      });
      this.kept.set(draft.entry.item.id, versions);
    }
  }

  async list(_session: string, id: string) {
    this.reads += 1;
    return (this.kept.get(id) ?? []).map(({ snapshot: { version, at, by, change, lifecycle } }) => ({
      version,
      at,
      by,
      change,
      lifecycle,
    }));
  }

  async get(_session: string, id: string, version: number) {
    this.reads += 1;
    return this.kept.get(id)?.[version - 1]?.snapshot;
  }

  async conversation(_session: string, id: string, version: number) {
    this.reads += 1;
    return this.kept.get(id)?.[version - 1]?.conversation;
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

const subject = (versions?: MemoryVersions) => {
  const files = new MemoryFiles();
  const repository = new FileAgendaLedgerRepository(id => `/state/sessions/${id}`, undefined, files, versions);
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

const MARK = `${SESSION}/${AGENDA_ARCHIVE_FILE}.pending`;

/** A transaction that changes nothing: what a read-only command leaves, so only a migration writes. */
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

describe('the private agenda archive', () => {
  const agent = { kind: 'agent' as const, sessionId: SESSION, name: 'Ada' };
  const human = { kind: 'human' as const };
  const ok = (mutation: AgendaMutation) => {
    if (!mutation.ok) throw new Error(mutation.error.message);
    return mutation;
  };
  const save = async (repository: FileAgendaLedgerRepository, command: Parameters<typeof applyAgendaCommand>[1]) =>
    ok(await repository.transact(SESSION, current => applyAgendaCommandToSession(current, SESSION, command)));

  for (const withVersions of [false, true])
    it(`should retain sixty owner rounds with bounded current entries and no reread of archived history, even after pruning${withVersions ? ' (with a version store, six rounds)' : ''}`, async () => {
      const rounds = withVersions ? 6 : 60;
      const { files, repository } = subject(withVersions ? new MemoryVersions() : undefined);
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
      for (let n = 1; n <= rounds; n++) {
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
      // v4 commits full conversations with state. The old whole-file ceiling applies to the current-item view,
      // not the uncapped durable threads; keep the same ceiling and prove every round survives in those threads.
      const { conversations, carriedEntries: _carried, ...currentView } = JSON.parse(hot) as AgendaLedger;
      should(JSON.stringify(currentView).length).be.below(1_100_000);
      should(conversations?.A1).have.length(rounds * 3);
      for (let n = 1; n <= rounds; n++) {
        should(conversations?.A1?.some(entry => entry.text.startsWith(`ANSWER_${n}:`))).be.true();
        should(conversations?.A1?.some(entry => entry.text.startsWith(`NOTE_${n}:`))).be.true();
      }
      should(archived.length).be.above(withVersions ? 500_000 : 7_000_000);
      should(hot).not.containEql('archivePending');
      should(hot).not.containEql('ownerHistory');
      should(files.fullReads).not.containEql(AGENDA_ARCHIVE_FILE);
      should(files.tailReads.filter(offset => offset === 0)).have.length(1);
      const ledger = await repository.read(SESSION);
      if (ledger === null) throw new Error('no board');
      const words = JSON.stringify(await repository.readArchive(SESSION)) + JSON.stringify(agendaSnapshot(ledger));
      for (let n = 1; n <= rounds; n++) {
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
      for (let n = 1; n <= rounds; n++) should(remainingWords).containEql(`ANSWER_${n}:`);
      should(files.files.get(`${SESSION}/${AGENDA_ARCHIVE_FILE}`)?.text).startWith(archived);
    }, 30_000);

  it('should keep the closing note and structured answer of an item whose closed history is pruned', async () => {
    const { repository } = subject();
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
    // Pruning drops the bounded item, while v4 also retains its full conversation outside current entries.
    should(JSON.stringify(ledger.entries)).not.containEql('OWNER_DONE_KEPT');
    should(ledger.conversations?.A1?.some(entry => entry.text === 'OWNER_DONE_KEPT')).be.true();
  });

  it('should never serve a torn history append, and should write it once when its command is retried', async () => {
    const { files, repository } = subject();
    const first = { id: 'A1', entry: { at: NOW, kind: 'replied', note: 'first committed owner record' } };
    const second = { kind: 'owner-history', id: 'A1', entry: { at: NOW, kind: 'replied', note: 'second 雪 record' } };
    files.put(SESSION, current, JSON.stringify({ ...emptyAgendaLedger(SESSION, NOW), ownerHistory: [first] }));
    ok(await repository.transact(SESSION, unchanged));
    const committed = files.files.get(`${SESSION}/${AGENDA_ARCHIVE_FILE}`)?.text ?? '';
    should(files.files.has(MARK)).be.false();
    const text = `${JSON.stringify(second)}\n`;
    // A crash tore the append of `second`: its mark is down, its bytes only partly, its ledger write never ran.
    files.put(SESSION, AGENDA_ARCHIVE_FILE, committed + text.slice(0, 15));
    files.put(SESSION, `${AGENDA_ARCHIVE_FILE}.pending`, JSON.stringify({ bytes: Buffer.byteLength(committed) }));
    const restarted = new FileAgendaLedgerRepository(id => `/state/sessions/${id}`, undefined, files);
    ok(await restarted.transact(SESSION, unchanged));
    should(await restarted.readArchive(SESSION)).deepEqual([{ kind: 'owner-history', ...first }]);
    should(files.files.get(`${SESSION}/${AGENDA_ARCHIVE_FILE}`)?.text).equal(committed + text.slice(0, 15));

    ok(
      await restarted.transact(SESSION, ledger => {
        if (ledger === null) throw new Error('no board');
        const retried = { ...ledger, archivePending: [second as AgendaArchiveRecord] };
        return { ok: true, changed: true, change: 'refreshed', ledger: retried, snapshot: agendaSnapshot(ledger) };
      }),
    );

    should(files.files.get(`${SESSION}/${AGENDA_ARCHIVE_FILE}`)?.text).equal(committed + text);
    should(await restarted.readArchive(SESSION)).deepEqual([{ kind: 'owner-history', ...first }, second]);
    should(files.files.has(MARK)).be.false();
  });

  it('should move the history of a ledger written before the cursor existed exactly once, however often its commit fails', async () => {
    const { files, repository } = subject();
    const records = ['ONE', 'TWO'].map(note => ({ id: 'A1', entry: { at: NOW, kind: 'replied', note } }));
    // The file as a daemon before this one left it: no version, no cursor, owner history still inside.
    files.put(
      SESSION,
      current,
      JSON.stringify({ sessionId: SESSION, nextId: 2, entries: [], updatedAt: NOW, ownerHistory: records }),
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      files.failLedgerWrite = true;
      await should(repository.transact(SESSION, unchanged)).be.rejectedWith('ledger commit failed');
      should(await repository.readArchive(SESSION)).deepEqual([]);
    }
    should(files.files.get(`${SESSION}/${AGENDA_ARCHIVE_FILE}`)?.text.split('\n').filter(Boolean)).have.length(2);

    const restarted = new FileAgendaLedgerRepository(id => `/state/sessions/${id}`, undefined, files);
    const migrated = ok(await restarted.transact(SESSION, unchanged));

    should(migrated.ledger.archive?.count).equal(2);
    should(await restarted.readArchive(SESSION)).deepEqual(
      records.map(record => ({ kind: 'owner-history', ...record })),
    );
    should(files.files.get(`${SESSION}/${AGENDA_ARCHIVE_FILE}`)?.text.split('\n').filter(Boolean)).have.length(2);
    should(files.files.get(`${SESSION}/${current}`)?.text).not.containEql('ownerHistory');
    should(files.files.has(MARK)).be.false();
  });

  describe('a transaction whose ledger write failed after its history append', () => {
    const SATURATED_CLOSED = 100;
    const resolveA1 = (note: string) =>
      ({ action: 'resolve', actor: human, at: NOW, id: 'A1', note }) as Parameters<typeof applyAgendaCommand>[1];
    const dismissA1 = (note: string) =>
      ({ action: 'dismiss', actor: human, at: NOW, id: 'A1', note }) as Parameters<typeof applyAgendaCommand>[1];

    /** A board whose closed items fill the hot file, so closing A1 prunes it into the sidecar at once. */
    const saturated = async () => {
      const harness = subject();
      await save(harness.repository, { action: 'raise', actor: agent, at: NOW, request });
      const ledger = await harness.repository.read(SESSION);
      if (ledger === null) throw new Error('no board');
      const filler = Array.from({ length: SATURATED_CLOSED }, (_, n) => ({
        lifecycle: 'addressed',
        origin: human,
        item: { id: `A${n + 2}`, invalidFutureItem: true },
      }));
      harness.files.put(
        SESSION,
        current,
        JSON.stringify({ ...ledger, nextId: SATURATED_CLOSED + 2, entries: [...ledger.entries, ...filler] }),
      );
      return harness;
    };
    const command = (command: Parameters<typeof applyAgendaCommand>[1]) => (ledger: AgendaLedger | null) =>
      applyAgendaCommandToSession(ledger, SESSION, command);
    const words = async (repository: FileAgendaLedgerRepository) =>
      JSON.stringify(await repository.readArchive(SESSION));
    /** How many history records carry `text`: a closed item's snapshot holds its closing note twice, as the note and in its conversation. */
    const recordsWith = async (repository: FileAgendaLedgerRepository, text: string) =>
      (await repository.readArchive(SESSION)).filter(record => JSON.stringify(record).includes(text)).length;

    it('should not serve its record as history, and should drop it when a different command commits', async () => {
      const { files, repository } = await saturated();
      files.failLedgerWrite = true;
      await should(repository.transact(SESSION, command(dismissA1('PHANTOM_DISMISS')))).be.rejectedWith(
        'ledger commit failed',
      );
      should((await repository.read(SESSION))?.entries.some(entry => entry.lifecycle === 'active')).be.true();
      should(files.files.get(`${SESSION}/${AGENDA_ARCHIVE_FILE}`)?.text).containEql('PHANTOM_DISMISS');
      should(await words(repository)).not.containEql('PHANTOM_DISMISS');

      ok(await repository.transact(SESSION, command(resolveA1('REAL_RESOLVE'))));

      const history = await words(repository);
      should(history).containEql('REAL_RESOLVE');
      should(history).not.containEql('PHANTOM_DISMISS');
      should(files.files.get(`${SESSION}/${AGENDA_ARCHIVE_FILE}`)?.text).not.containEql('PHANTOM_DISMISS');
    });

    it('should reuse its record once when the same command is retried', async () => {
      const { files, repository } = await saturated();
      files.failLedgerWrite = true;
      await should(repository.transact(SESSION, command(resolveA1('SAME_COMMAND')))).be.rejected();
      const appended = files.files.get(`${SESSION}/${AGENDA_ARCHIVE_FILE}`)?.text;

      ok(await repository.transact(SESSION, command(resolveA1('SAME_COMMAND'))));

      should(files.files.get(`${SESSION}/${AGENDA_ARCHIVE_FILE}`)?.text).equal(appended);
      should(await recordsWith(repository, 'SAME_COMMAND')).equal(1);
    });

    it('should fail closed when the sidecar is shorter than the ledger cursor says', async () => {
      const { files, repository } = await saturated();
      ok(await repository.transact(SESSION, command(resolveA1('COMMITTED'))));
      files.put(SESSION, AGENDA_ARCHIVE_FILE, '');
      await should(repository.readArchive(SESSION)).be.rejectedWith('incomplete agenda history');
      files.files.delete(`${SESSION}/${AGENDA_ARCHIVE_FILE}`);
      await should(repository.readArchive(SESSION)).be.rejectedWith('incomplete agenda history');
    });

    /** What an older daemon's next write leaves: the fields it knows, none of the cursor or the version. */
    const rewrittenByOlderDaemon = (files: ReturnType<typeof subject>['files'], keep: readonly string[] = []) => {
      const document = JSON.parse(files.files.get(`${SESSION}/${current}`)?.text ?? '{}') as Record<string, unknown>;
      for (const key of ['archive', 'version']) if (!keep.includes(key)) delete document[key];
      files.put(SESSION, current, JSON.stringify(document));
      return new FileAgendaLedgerRepository(id => `/state/sessions/${id}`, undefined, files);
    };

    it('should keep the committed history across a downgrade and an upgrade, serving it at once and through the next prune', async () => {
      const { files, repository } = await saturated();
      ok(await repository.transact(SESSION, command(resolveA1('OWNER_WORDS'))));
      const before = files.files.get(`${SESSION}/${AGENDA_ARCHIVE_FILE}`)?.text ?? '';
      const upgraded = rewrittenByOlderDaemon(files);
      should(JSON.parse(files.files.get(`${SESSION}/${current}`)?.text ?? '{}')).not.have.property('archive');

      should(await words(upgraded)).containEql('OWNER_WORDS');

      const raised = ok(await upgraded.transact(SESSION, command({ action: 'raise', actor: agent, at: NOW, request })));
      ok(
        await upgraded.transact(
          SESSION,
          command({ action: 'resolve', actor: human, at: NOW, id: raised.item?.id ?? 'missing', note: 'NEXT_WORDS' }),
        ),
      );
      const history = await words(upgraded);
      should(history).containEql('OWNER_WORDS');
      should(history).containEql('NEXT_WORDS');
      should(files.files.get(`${SESSION}/${AGENDA_ARCHIVE_FILE}`)?.text).startWith(before);
    });

    it('should adopt the history of a rewrite by an older daemon when the next write has nothing to add to it', async () => {
      const { files, repository } = await saturated();
      ok(await repository.transact(SESSION, command(resolveA1('OWNER_WORDS'))));
      const upgraded = rewrittenByOlderDaemon(files);
      const unchanged = ok(
        await upgraded.transact(SESSION, ledger => ({
          ok: true as const,
          changed: true,
          change: 'refreshed' as const,
          ledger: ledger ?? emptyAgendaLedger(SESSION, NOW),
          snapshot: agendaSnapshot(ledger ?? emptyAgendaLedger(SESSION, NOW)),
        })),
      );
      should(unchanged.ledger.archive?.count).equal(1);
      should(JSON.parse(files.files.get(`${SESSION}/${current}`)?.text ?? '{}').archive.count).equal(1);
    });

    it('should still cut an uncommitted tail when a ledger names its cursor, whatever version it is', async () => {
      const { files, repository } = await saturated();
      ok(await repository.transact(SESSION, command(resolveA1('COMMITTED'))));
      const raised = ok(
        await repository.transact(SESSION, command({ action: 'raise', actor: agent, at: NOW, request })),
      );
      files.failLedgerWrite = true;
      await should(
        repository.transact(
          SESSION,
          command({ action: 'resolve', actor: human, at: NOW, id: raised.item?.id ?? 'missing', note: 'PHANTOM' }),
        ),
      ).be.rejectedWith('ledger commit failed');
      should(files.files.get(`${SESSION}/${AGENDA_ARCHIVE_FILE}`)?.text).containEql('PHANTOM');

      const versionless = rewrittenByOlderDaemon(files, ['archive']);
      const history = await words(versionless);
      should(history).containEql('COMMITTED');
      should(history).not.containEql('PHANTOM');
    });

    const sidecar = (files: ReturnType<typeof subject>['files']) =>
      files.files.get(`${SESSION}/${AGENDA_ARCHIVE_FILE}`)?.text ?? '';
    const resolve = (id: string, note: string) =>
      command({ action: 'resolve', actor: human, at: NOW, id, note } as Parameters<typeof applyAgendaCommand>[1]);
    const dismiss = (id: string, note: string) =>
      command({ action: 'dismiss', actor: human, at: NOW, id, note } as Parameters<typeof applyAgendaCommand>[1]);
    /** A saturated board as a daemon before the cursor wrote it, optionally with history an upgrade adopted. */
    const preCursor = async (withHistory: boolean) => {
      const harness = await saturated();
      let next = 'A1';
      if (withHistory) {
        ok(await harness.repository.transact(SESSION, command(resolveA1('OWNER_WORDS'))));
        const raised = ok(
          await harness.repository.transact(SESSION, command({ action: 'raise', actor: agent, at: NOW, request })),
        );
        next = raised.item?.id ?? 'missing';
      }
      return { ...harness, next, before: sidecar(harness.files), repository: rewrittenByOlderDaemon(harness.files) };
    };

    for (const withHistory of [false, true]) {
      const board = withHistory ? 'a board an upgrade adopted history for' : 'a board from before the cursor';
      it(`should not serve the first prune of ${board} when its ledger write fails`, async () => {
        const { files, repository, next, before } = await preCursor(withHistory);
        files.failLedgerWrite = true;
        await should(repository.transact(SESSION, resolve(next, 'PHANTOM_FIRST'))).be.rejectedWith(
          'ledger commit failed',
        );
        should(sidecar(files)).containEql('PHANTOM_FIRST');

        const history = await words(repository);
        const restarted = await words(new FileAgendaLedgerRepository(id => `/state/sessions/${id}`, undefined, files));

        should(history).not.containEql('PHANTOM_FIRST');
        should(restarted).not.containEql('PHANTOM_FIRST');
        should(history.includes('OWNER_WORDS')).equal(withHistory);
        should(sidecar(files)).startWith(before);
      });

      it(`should write a retried first prune of ${board} exactly once`, async () => {
        const { files, repository, next, before } = await preCursor(withHistory);
        files.failLedgerWrite = true;
        await should(repository.transact(SESSION, resolve(next, 'SAME_COMMAND'))).be.rejected();
        const appended = sidecar(files);

        ok(await repository.transact(SESSION, resolve(next, 'SAME_COMMAND')));

        should(sidecar(files)).equal(appended);
        should(sidecar(files)).startWith(before);
        should(await recordsWith(repository, 'SAME_COMMAND')).equal(1);
        should(files.files.has(MARK)).be.false();
      });

      it(`should cut the failed first prune of ${board} when a different command commits`, async () => {
        const { files, repository, next, before } = await preCursor(withHistory);
        files.failLedgerWrite = true;
        await should(repository.transact(SESSION, resolve(next, 'PHANTOM_FIRST'))).be.rejected();

        ok(await repository.transact(SESSION, dismiss(next, 'REAL_DISMISS')));

        const history = await words(repository);
        should(history).containEql('REAL_DISMISS');
        should(history).not.containEql('PHANTOM_FIRST');
        should(history.includes('OWNER_WORDS')).equal(withHistory);
        should(sidecar(files)).startWith(before);
        should(sidecar(files)).not.containEql('PHANTOM_FIRST');
      });
    }

    it('should go by the cursor, not a mark a crash left after the commit landed, and drop the mark on the next write', async () => {
      const { files, repository } = await saturated();
      ok(await repository.transact(SESSION, command(resolveA1('COMMITTED'))));
      // The crash came between the ledger commit and the removal of the mark the append put down at byte 0.
      files.put(SESSION, `${AGENDA_ARCHIVE_FILE}.pending`, JSON.stringify({ bytes: 0 }));
      const restarted = new FileAgendaLedgerRepository(id => `/state/sessions/${id}`, undefined, files);

      should(await words(restarted)).containEql('COMMITTED');
      ok(await restarted.transact(SESSION, command({ action: 'raise', actor: agent, at: NOW, request })));

      should(files.files.has(MARK)).be.false();
      should(await words(restarted)).containEql('COMMITTED');
    });

    it('should not adopt across a downgrade an append whose mark is still down', async () => {
      const { files, repository } = await saturated();
      ok(await repository.transact(SESSION, command(resolveA1('COMMITTED'))));
      const raised = ok(
        await repository.transact(SESSION, command({ action: 'raise', actor: agent, at: NOW, request })),
      );
      files.failLedgerWrite = true;
      await should(repository.transact(SESSION, resolve(raised.item?.id ?? 'missing', 'PHANTOM'))).be.rejected();

      const history = await words(rewrittenByOlderDaemon(files));

      should(history).containEql('COMMITTED');
      should(history).not.containEql('PHANTOM');
    });

    it('should adopt across a downgrade a failed append a later commit outlived (the declared limit)', async () => {
      const { files, repository } = await saturated();
      ok(await repository.transact(SESSION, command(resolveA1('COMMITTED'))));
      const raised = ok(
        await repository.transact(SESSION, command({ action: 'raise', actor: agent, at: NOW, request })),
      );
      files.failLedgerWrite = true;
      await should(repository.transact(SESSION, resolve(raised.item?.id ?? 'missing', 'PHANTOM'))).be.rejected();
      should(await words(repository)).not.containEql('PHANTOM');
      // A commit that appends nothing lands and lifts the mark; only the cursor it wrote still excludes the tail.
      const other = { ...request, subject: 'Choose a second region' };
      ok(await repository.transact(SESSION, command({ action: 'raise', actor: agent, at: NOW, request: other })));
      should(files.files.has(MARK)).be.false();
      should(await words(repository)).not.containEql('PHANTOM');

      const history = await words(rewrittenByOlderDaemon(files));

      should(history).containEql('COMMITTED');
      should(history).containEql('PHANTOM');
    });

    it('should leave out a torn last line of an adopted sidecar and cut it at the next prune, keeping the rest', async () => {
      const { files, repository } = await saturated();
      ok(await repository.transact(SESSION, command(resolveA1('OWNER_WORDS'))));
      const before = sidecar(files);
      files.put(SESSION, AGENDA_ARCHIVE_FILE, `${before}{"kind":"owner-history","torn`);
      const upgraded = rewrittenByOlderDaemon(files);
      should(await words(upgraded)).containEql('OWNER_WORDS');
      const raised = ok(await upgraded.transact(SESSION, command({ action: 'raise', actor: agent, at: NOW, request })));

      ok(await upgraded.transact(SESSION, resolve(raised.item?.id ?? 'missing', 'NEXT_WORDS')));

      const history = await words(upgraded);
      should(history).containEql('OWNER_WORDS');
      should(history).containEql('NEXT_WORDS');
      should(sidecar(files)).startWith(before);
      should(sidecar(files)).not.containEql('torn');
    });

    for (const withVersions of [false, true])
      it(`should seed an upgraded board's conversation from the history it adopts, once, never from an uncommitted append${withVersions ? ' (with a version store)' : ''}`, async () => {
        // Arrange — a board as a daemon before the cursor and the conversation left it: no version, cursor or thread.
        const versions = withVersions ? new MemoryVersions() : undefined;
        const { files, repository } = subject(versions);
        const raised = ok(
          await repository.transact(SESSION, command({ action: 'raise', actor: agent, at: NOW, request })),
        );
        const document = JSON.parse(agendaLedgerDocument(raised.ledger)) as Record<string, unknown> & {
          entries: { item: Record<string, unknown> }[];
        };
        for (const key of ['version', 'archive', 'conversations', 'carriedEntries']) delete document[key];
        for (const entry of document.entries) {
          delete entry.item.conversation;
          delete entry.item.conversationCount;
        }
        files.put(SESSION, current, JSON.stringify(document));
        const record = (note: string) =>
          `${JSON.stringify({ kind: 'owner-history', id: 'A1', entry: { at: '2026-10-31T10:05:00.000Z', kind: 'replied', note } })}\n`;
        const committed = record('ADOPTED_WORDS');
        // The second record's append never committed: its mark is still down where it began.
        files.put(SESSION, AGENDA_ARCHIVE_FILE, committed + record('UNCOMMITTED_WORDS'));
        files.put(SESSION, `${AGENDA_ARCHIVE_FILE}.pending`, JSON.stringify({ bytes: Buffer.byteLength(committed) }));
        const upgraded = new FileAgendaLedgerRepository(id => `/state/sessions/${id}`, undefined, files, versions);

        // Act
        const read = await upgraded.read(SESSION);
        ok(
          await upgraded.transact(SESSION, ledger => {
            if (ledger === null) throw new Error('no board');
            return { ok: true, changed: true, change: 'refreshed', ledger, snapshot: agendaSnapshot(ledger) };
          }),
        );
        const askedBefore = versions?.reads ?? 0;
        const reread = await new FileAgendaLedgerRepository(
          id => `/state/sessions/${id}`,
          undefined,
          files,
          versions,
        ).read(SESSION);

        // Assert — one adoption feeds the one migration; the persisted version-4 board never reads the sidecar again,
        // nor does it ask the version store to seed it a second time.
        should(versions?.reads ?? 0).equal(askedBefore);
        should(read?.archive).deepEqual({ bytes: Buffer.byteLength(committed), count: 1 });
        should(read?.conversations?.A1?.map(entry => entry.text)).deepEqual(['ADOPTED_WORDS']);
        should(reread?.version).equal(AGENDA_LEDGER_VERSION);
        should(reread?.archive).deepEqual(read?.archive);
        should(reread?.conversations?.A1?.map(entry => entry.text)).deepEqual(['ADOPTED_WORDS']);
        should(JSON.stringify(await upgraded.readArchive(SESSION))).not.containEql('UNCOMMITTED_WORDS');
      });

    describe('a cold thread whose snapshot only the history file holds', () => {
      /** A board whose only thread belongs to an item no longer on it, with no version kept anywhere but the sidecar. */
      const orphaned = async (cursor: 'covers' | 'none') => {
        const versions = new MemoryVersions();
        const { files, repository } = subject(versions);
        ok(await repository.transact(SESSION, command({ action: 'raise', actor: agent, at: NOW, request })));
        ok(await repository.transact(SESSION, command(resolveA1('ORPHAN_WORDS'))));
        const ledger = await repository.read(SESSION);
        const item = ledger?.entries[0]?.item;
        if (ledger === null || item === undefined) throw new Error('no board');
        const {
          conversation: _thread,
          conversationCount: _count,
          conversationLastAt: _last,
          ...stored
        } = item as unknown as Record<string, unknown>;
        const line = `${JSON.stringify({ kind: 'version', id: 'A1', item: stored })}\n`;
        const document = JSON.parse(agendaLedgerDocument(ledger)) as Record<string, unknown>;
        document.entries = [];
        delete document.archive;
        if (cursor === 'covers') document.archive = { bytes: Buffer.byteLength(line), count: 1 };
        files.put(SESSION, current, JSON.stringify(document));
        files.put(SESSION, AGENDA_ARCHIVE_FILE, line);
        versions.kept.clear();
        const reopened = new FileAgendaLedgerRepository(id => `/state/sessions/${id}`, undefined, files, versions);
        return { reopened, versions };
      };
      const refresh = (ledger: AgendaLedger | null): AgendaMutation => {
        if (ledger === null) throw new Error('no board');
        return { ok: true, changed: true, change: 'refreshed', ledger, snapshot: agendaSnapshot(ledger) };
      };

      it('should archive the thread from a history line the ledger cursor covers', async () => {
        const { reopened, versions } = await orphaned('covers');

        ok(await reopened.transact(SESSION, refresh));

        should(versions.kept.get('A1')?.map(each => each.snapshot.change)).deepEqual(['archived']);
        should(versions.kept.get('A1')?.[0]?.conversation.map(each => each.text)).containEql('ORPHAN_WORDS');
      });

      it('should refuse to use a history line no cursor covers, and archive nothing', async () => {
        const { reopened, versions } = await orphaned('none');

        await should(reopened.transact(SESSION, refresh)).be.rejectedWith('missing cold agenda snapshot');

        should(versions.kept.size).equal(0);
      });
    });

    it('should serve no history from a rewrite by an older daemon when there is no sidecar', async () => {
      const { files, repository } = subject();
      files.put(SESSION, current, JSON.stringify({ sessionId: SESSION, nextId: 1, entries: [], updatedAt: NOW }));
      should(await repository.readArchive(SESSION)).deepEqual([]);
    });

    it('should serve no history for a session with no ledger, whatever the sidecar holds', async () => {
      const { files, repository } = subject();
      files.put(SESSION, AGENDA_ARCHIVE_FILE, '{"stray":true}\n');
      should(await repository.readArchive(SESSION)).deepEqual([]);
    });
  });

  it('should migrate in-ledger owner history once and replay an append whose cursor commit failed', async () => {
    const { files, repository } = subject();
    const record = { id: 'A1', entry: { at: NOW, kind: 'replied', note: 'Owner 雪 words' } };
    files.put(SESSION, current, JSON.stringify({ ...emptyAgendaLedger(SESSION, NOW), ownerHistory: [record] }));
    should(await repository.readArchive(SESSION)).deepEqual([]);
    files.failLedgerWrite = true;
    await should(repository.transact(SESSION, unchanged)).be.rejectedWith('ledger commit failed');
    const appended = files.files.get(`${SESSION}/${AGENDA_ARCHIVE_FILE}`)?.text;
    const restarted = new FileAgendaLedgerRepository(id => `/state/sessions/${id}`, undefined, files);
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
