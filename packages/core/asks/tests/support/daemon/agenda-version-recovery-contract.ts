import { createHash } from 'node:crypto';
import { describe, it } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { AGENDA_CHANGE_OUTBOX } from '../../../daemon/adapters/agenda/file-agenda-change-outbox.ts';
import {
  AGENDA_VERSION_PENDING,
  FileAgendaLedgerRepository,
  InvalidAgendaLedgerError,
} from '../../../daemon/adapters/agenda/file-agenda-ledger-repository.ts';
import { SqliteAgendaVersionStore } from '../../../daemon/adapters/agenda/sqlite-agenda-versions.ts';
import { AGENDA_ARCHIVE_FILE } from '../../../daemon/lib/agenda/archive.ts';
import type { AgendaBoardChange } from '../../../daemon/lib/agenda/service.ts';
import { AgendaService } from '../../../daemon/lib/agenda/service.ts';
import {
  type AgendaCommand,
  type AgendaLedger,
  type AgendaMutation,
  agendaLedgerDocument,
  agendaSnapshot,
  applyAgendaCommandToSession,
  parseAgendaEntry,
} from '../../../daemon/lib/agenda/state-machine.ts';
import type { AgendaVersionStore } from '../../../daemon/lib/agenda/versions.ts';
import { NO_AGENDA_VERSIONS } from '../../../daemon/lib/agenda/versions.ts';
import { agendaFilePath, agendaFilesAt, asksStateAt } from './agenda-state.ts';

const SESSION = 'session-1';
const AT = '2026-11-03T10:00:00.000Z';
const ACTOR = { kind: 'agent' as const, sessionId: SESSION, name: 'Ada' };
const HUMAN = { kind: 'human' as const };
const REQUEST = {
  source: 'agent-raised' as const,
  sourceRef: null,
  subject: 'Initial',
  why: 'The rollout waits.',
  premise: 'A release is ready.',
  context: 'Choose a region.',
  howToResolve: 'Answer.',
  ask: { kind: 'open-question' as const },
};
const ok = (mutation: AgendaMutation) => {
  if (!mutation.ok) throw new Error(mutation.error.message);
  return mutation;
};
const unchanged = (ledger: AgendaLedger | null): AgendaMutation => {
  if (ledger === null) throw new Error('missing ledger');
  return { ok: true, changed: false, change: 'unchanged', ledger, snapshot: agendaSnapshot(ledger) };
};

async function world() {
  const root = await mkdtemp(join(tmpdir(), 'agenda-version-recovery-'));
  const files = agendaFilesAt(root);
  const backing = new SqliteAgendaVersionStore(asksStateAt(root));
  let now = Date.parse(AT);
  const warnings: string[] = [];
  let fault: 'error' | 'crash' | undefined;
  let after = false;
  let ids = 0;
  /**
   * The archive the repository writes through: the real SQLite store, with one armed failure of `record` — before the
   * archive commit, or after it (the commit landed and only its answer was lost). An `error` and a `crash` both
   * reject the await; the store runs on the daemon's thread, so a crash is what the next start recovers from.
   */
  const versions: AgendaVersionStore = {
    record: async (session, drafts) => {
      if (fault === undefined) return await backing.record(session, drafts);
      const failed = fault;
      fault = undefined;
      if (after) await backing.record(session, drafts);
      throw new Error(failed === 'crash' ? 'archive lost' : 'archive unavailable');
    },
    discard: (session, drafts) => backing.discard(session, drafts),
    list: (session, id) => backing.list(session, id),
    get: (session, id, version) => backing.get(session, id, version),
    conversation: (session, id, version) => backing.conversation(session, id, version),
  };
  const repository = (archive: AgendaVersionStore = versions) =>
    new FileAgendaLedgerRepository(files, () => `id-${String((ids += 1))}`, archive, {
      now: () => now,
      warn: message => {
        warnings.push(message);
      },
    });
  let repo = repository();
  type Timeless<T> = T extends unknown ? Omit<T, 'at'> : never;
  const save = (command: Timeless<AgendaCommand>) =>
    repo.transact(SESSION, current =>
      applyAgendaCommandToSession(current, SESSION, { ...command, at: AT } as AgendaCommand),
    );
  const raise = async (subject = REQUEST.subject) =>
    ok(await save({ action: 'raise', actor: ACTOR, request: { ...REQUEST, subject } }));
  return {
    root,
    files,
    backing,
    warnings,
    advance(ms: number) {
      now += ms;
    },
    versions,
    repository,
    save,
    raise,
    get repo() {
      return repo;
    },
    restart() {
      repo = repository();
    },
    fail(kind: typeof fault, committed = false) {
      fault = kind;
      after = committed;
    },
    close: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Real ledger and SQLite over the kernel state folder, and their recovery, shared with the daemon integration group. */
export function agendaVersionRecoveryContract() {
  describe('recovered agenda change effects', () => {
    it('keeps original chat provenance and raised effects when recovery is triggered by reads', async () => {
      const w = await world();
      const changes: AgendaBoardChange[] = [];
      let created = 0;
      const agenda = new AgendaService(
        w.repo,
        { now: () => AT },
        { has: async () => true },
        {
          raised: async () => {
            created++;
          },
        },
        {
          changed: async (_id, change) => {
            changes.push(change);
          },
        },
      );
      try {
        w.fail('error');
        await should(agenda.raise(SESSION, REQUEST, ACTOR)).be.rejected();
        await agenda.list(SESSION);
        should(created).equal(1);
        should(changes[0]?.actor).deepEqual(ACTOR);
        w.fail('error');
        await should(
          agenda.answer(SESSION, 'A1', { kind: 'open-question', answer: 'From chat' }, HUMAN, null, 'conversation'),
        ).be.rejected();
        await agenda.list(SESSION);
        should(changes[1]?.via).equal('conversation');
        should(changes[1]?.item?.ownerAnswer?.response).deepEqual({ kind: 'open-question', answer: 'From chat' });
      } finally {
        await w.close();
      }
    });

    it('replays daemon confirmation changes with their original cause and affected item', async () => {
      const w = await world();
      const changes: AgendaBoardChange[] = [];
      const agenda = new AgendaService(
        w.repo,
        { now: () => AT },
        { has: async () => true },
        { raised: async () => {} },
        {
          changed: async (_id, change) => {
            changes.push(change);
          },
        },
      );
      const confirms = { path: 'warden.yaml', etag: 'a'.repeat(64), changes: ['Allow reviews'] };
      const newer = { ...confirms, etag: 'b'.repeat(64), changes: ['Allow a different review'] };
      try {
        ok(
          await agenda.raise(
            SESSION,
            {
              ...REQUEST,
              confirms,
              ask: { kind: 'multiple-choice', options: [{ label: 'Allow' }, { label: 'Deny' }] },
            },
            ACTOR,
          ),
        );
        w.fail('error');
        await should(agenda.restateConfirms(SESSION, 'A1', newer, 'The proposal changed.')).be.rejected();
        await agenda.list(SESSION);
        should(changes[1]?.actor).deepEqual({ kind: 'daemon', cause: 'system' });
        should(changes[1]?.item?.confirms).deepEqual({ ...newer, restated: true });
        should(changes[1]?.item?.premise).equal('The proposal changed.');
      } finally {
        await w.close();
      }
    });

    it('retains an event through outbox-copy and intent-cleanup failures and deduplicates its replay', async () => {
      const w = await world();
      const changes: string[] = [];
      const agenda = new AgendaService(
        w.repo,
        { now: () => AT },
        { has: async () => true },
        { raised: async () => {} },
        {
          changed: async (_id, change) => {
            changes.push(change.change);
          },
        },
      );
      try {
        const write = w.files.writeAtomic.bind(w.files);
        w.files.writeAtomic = async (session, name, text) => {
          if (name === AGENDA_CHANGE_OUTBOX) throw new Error('outbox copy failed');
          await write(session, name, text);
        };
        await should(agenda.raise(SESSION, REQUEST, ACTOR)).be.rejectedWith('outbox copy failed');
        w.files.writeAtomic = write;
        const remove = w.files.remove.bind(w.files);
        w.files.remove = async () => {
          throw new Error('intent cleanup failed');
        };
        await should(agenda.list(SESSION)).be.rejectedWith('intent cleanup failed');
        await should(
          w.repo.changeOutbox?.flush(SESSION, {
            changed: async (_id, change) => {
              changes.push(change.change);
            },
          }),
        ).be.rejectedWith('intent cleanup failed');
        should(changes).be.empty();
        w.files.remove = remove;
        await agenda.list(SESSION);
        await agenda.list(SESSION);
        should(changes).deepEqual(['created']);
        should(await w.files.read(SESSION, AGENDA_CHANGE_OUTBOX)).equal('[]');
      } finally {
        await w.close();
      }
    });
  });
  describe('durable agenda version intents', () => {
    for (const failure of ['error', 'crash'] as const)
      for (const after of [false, true]) {
        it(`replays Intermediate after ${failure} ${after ? 'after commit' : 'before commit'}, exactly once`, async () => {
          const w = await world();
          try {
            await w.raise();
            w.fail(failure, after);
            await should(
              w.save({ action: 'edit', actor: ACTOR, id: 'A1', patch: { subject: 'Intermediate' } }),
            ).be.rejected();
            should(JSON.parse(await readFile(agendaFilePath(w.root, SESSION, 'agenda.json'), 'utf8')).entries[0].item.subject).equal('Initial');
            should((await stat(agendaFilePath(w.root, SESSION, AGENDA_VERSION_PENDING))).mode & 0o777).equal(0o600);
            w.restart();
            // A read, not another edit, must recover the intent after daemon restart.
            should((await w.repo.read(SESSION))?.entries[0]?.item.subject).equal('Intermediate');
            ok(await w.save({ action: 'edit', actor: ACTOR, id: 'A1', patch: { subject: 'Later' } }));
            const list = await w.backing.list(SESSION, 'A1');
            const snapshots = await Promise.all(list.map(row => w.backing.get(SESSION, 'A1', row.version)));
            should(snapshots.map(row => row?.item.subject)).deepEqual(['Initial', 'Intermediate', 'Later']);
            should(await w.files.read(SESSION, AGENDA_VERSION_PENDING)).be.undefined();
          } finally {
            await w.close();
          }
        });
      }

    it.each(['merge', 'split'] as const)(
      'recovers every %s draft after the first item commits and acknowledgement is lost',
      async action => {
        const w = await world();
        try {
          await w.raise();
          await w.raise('Second');
          let once = true;
          const interrupted: AgendaVersionStore = {
            ...w.backing,
            record: async (session, drafts) => {
              if (once) {
                once = false;
                await w.backing.record(session, drafts.slice(0, 1));
                throw new Error('partial batch');
              }
              await w.backing.record(session, drafts);
            },
            list: (...args) => w.backing.list(...args),
            get: (...args) => w.backing.get(...args),
          };
          const repo = w.repository(interrupted);
          const command =
            action === 'merge'
              ? { action, actor: ACTOR, id: 'A1', from: 'A2', at: AT }
              : { action, actor: ACTOR, id: 'A1', request: { ...REQUEST, subject: 'Child' }, at: AT };
          await should(
            repo.transact(
              SESSION,
              current => applyAgendaCommandToSession(current, SESSION, command as AgendaCommand),
              'ferret',
              { actor: ACTOR, via: 'board' },
            ),
          ).be.rejectedWith('partial batch');
          const recovered = await w.repo.transact(SESSION, unchanged);
          should(recovered.ok).be.true();
          const child = action === 'split' ? 'A3' : 'A2';
          should((await w.backing.list(SESSION, 'A1')).map(row => row.change)).deepEqual([
            'created',
            action === 'split' ? 'split' : 'merged',
          ]);
          const versions = await w.backing.list(SESSION, child);
          should(versions.at(-1)?.change).equal(action === 'split' ? 'created' : 'merged');
          should((await w.backing.get(SESSION, child, versions.at(-1)?.version ?? 0))?.item).have.property(
            action === 'split' ? 'splitFrom' : 'mergedInto',
            'A1',
          );
          const changes: AgendaBoardChange[] = [];
          const service = new AgendaService(
            w.repo,
            { now: () => AT },
            { has: async () => true },
            { raised: async () => {} },
            {
              changed: async (_id, change) => {
                changes.push(change);
              },
            },
          );
          await service.list(SESSION);
          await service.list(SESSION);
          should(changes).have.length(1);
          should(changes[0]?.change).equal(action === 'merge' ? 'merged' : 'split');
          should(changes[0]?.actor).deepEqual(ACTOR);
          should(changes[0]?.item?.id).equal(action === 'split' ? 'A3' : 'A1');
          if (action === 'merge') should(changes[0]?.addressed?.id).equal('A2');
        } finally {
          await w.close();
        }
      },
    );

    it('replays after hot commit failure and after journal cleanup failure without duplicating versions', async () => {
      const w = await world();
      try {
        await w.raise();
        const write = w.files.writeAtomic.bind(w.files);
        w.files.writeAtomic = async (session, name, text) => {
          if (name === 'agenda.json') throw new Error('hot write failed');
          await write(session, name, text);
        };
        await should(
          w.save({ action: 'edit', actor: ACTOR, id: 'A1', patch: { subject: 'Intermediate' } }),
        ).be.rejectedWith('hot write failed');
        w.files.writeAtomic = write;
        const remove = w.files.remove.bind(w.files);
        w.files.remove = async () => {
          throw new Error('cleanup failed');
        };
        await should(w.repo.read(SESSION)).be.rejectedWith('cleanup failed');
        w.files.remove = remove;
        should((await w.repo.read(SESSION))?.entries[0]?.item.subject).equal('Intermediate');
        should(await w.backing.list(SESSION, 'A1')).have.length(2);
      } finally {
        await w.close();
      }
    });

    it('refuses corrupt prepared entries and ledgers without deleting the intent or replacing current state', async () => {
      const w = await world();
      try {
        await w.raise();
        w.fail('error');
        await should(
          w.save({ action: 'edit', actor: ACTOR, id: 'A1', patch: { subject: 'Intermediate' } }),
        ).be.rejected();
        const archiveAbsent = new FileAgendaLedgerRepository(w.files, () => 'id', NO_AGENDA_VERSIONS, { now: () => 0, warn: () => undefined });
        await should(archiveAbsent.read(SESSION)).be.rejectedWith(/archive is required/u);
        const original = JSON.parse((await w.files.read(SESSION, AGENDA_VERSION_PENDING)) ?? '');
        await w.files.writeAtomic(
          SESSION,
          AGENDA_VERSION_PENDING,
          JSON.stringify({ ...original, drafts: [{ ...original.drafts[0], entry: null }] }),
        );
        await should(w.repo.read(SESSION)).be.rejectedWith(/invalid prepared agenda entry/u);
        await w.files.writeAtomic(SESSION, AGENDA_VERSION_PENDING, JSON.stringify({ ...original, ledger: '{}' }));
        await should(w.repo.read(SESSION)).be.rejectedWith(InvalidAgendaLedgerError);
        await w.files.writeAtomic(SESSION, AGENDA_VERSION_PENDING, JSON.stringify(original));
        await w.repo.readArchive(SESSION);
        should((await w.repo.read(SESSION))?.entries[0]?.item.subject).equal('Intermediate');
      } finally {
        await w.close();
      }
    });

    /** What the previous release (2a) writes over a v4 ledger: version 2 and the cursor kept, the thread fields stripped. */
    const olderDaemonWrites = async (w: Awaited<ReturnType<typeof world>>, subject: string, history: string) => {
      const document = JSON.parse((await w.files.read(SESSION, 'agenda.json')) ?? '{}');
      const cursor = document.archive ?? { bytes: 0, count: 0 };
      const line = `${JSON.stringify({ kind: 'owner-history', id: 'A1', entry: { at: AT, kind: 'replied', note: history } })}\n`;
      await w.files.appendSynced(SESSION, AGENDA_ARCHIVE_FILE, new TextEncoder().encode(line));
      document.entries[0].item.subject = subject;
      delete document.conversations;
      delete document.carriedEntries;
      document.archive = { bytes: cursor.bytes + line.length, count: cursor.count + 1 };
      await w.files.writeAtomic(SESSION, 'agenda.json', JSON.stringify(document));
    };

    it("sets a stale intent aside when an older daemon wrote after it, keeping that daemon's items and history", async () => {
      const w = await world();
      try {
        await w.raise();
        w.fail('error');
        await should(
          w.save({ action: 'edit', actor: ACTOR, id: 'A1', patch: { subject: 'Intermediate' } }),
        ).be.rejected();
        should(await w.files.read(SESSION, AGENDA_VERSION_PENDING)).be.a.String();
        await olderDaemonWrites(w, 'From the older daemon', 'OWNER_WORDS_FROM_2A');
        const sidecar = await w.files.read(SESSION, AGENDA_ARCHIVE_FILE);
        w.restart();

        const read = await w.repo.read(SESSION);

        should(read?.entries[0]?.item.subject).equal('From the older daemon');
        should(await w.files.read(SESSION, AGENDA_ARCHIVE_FILE)).equal(sidecar);
        should(await w.files.read(SESSION, AGENDA_VERSION_PENDING)).be.undefined();
        should(await w.files.read(SESSION, `${AGENDA_VERSION_PENDING}.stale`)).be.a.String();
        should(w.warnings.filter(message => message.includes('stale'))).have.length(1);
        ok(await w.save({ action: 'edit', actor: ACTOR, id: 'A1', patch: { subject: 'Later' } }));
        should(await w.files.read(SESSION, AGENDA_ARCHIVE_FILE)).startWith(sidecar ?? '');
        should(JSON.stringify(await w.repo.readArchive(SESSION))).containEql('OWNER_WORDS_FROM_2A');
      } finally {
        await w.close();
      }
    });

    /** 2a adding an item of its own: the id its counter hands out, which a change that never committed may already have used. */
    const olderDaemonAdds = async (w: Awaited<ReturnType<typeof world>>, subject: string) => {
      const document = JSON.parse((await w.files.read(SESSION, 'agenda.json')) ?? '{}');
      const added = JSON.parse(JSON.stringify(document.entries[0]));
      added.item.id = 'A2';
      added.item.subject = subject;
      for (const key of ['conversation', 'conversationCount', 'conversationLastAt', 'relatedTasks'])
        delete added.item[key];
      for (const key of ['mergedFrom', 'mergedInto', 'splitFrom', 'splitInto']) delete added.item[key];
      document.entries.push(added);
      document.nextId = 3;
      delete document.conversations;
      delete document.carriedEntries;
      await w.files.writeAtomic(SESSION, 'agenda.json', JSON.stringify(document));
    };

    it('voids the versions of a set-aside intent, so an item that took its id never resumes from them', async () => {
      const w = await world();
      try {
        await w.raise();
        w.fail('error', true);
        await should(
          w.save({ action: 'split', actor: ACTOR, id: 'A1', request: { ...REQUEST, subject: 'Stale child' } }),
        ).be.rejected();
        should(await w.backing.list(SESSION, 'A2')).have.length(1);
        await olderDaemonAdds(w, 'Real second item');
        w.restart();

        const read = await w.repo.read(SESSION);

        const [first, second] = read?.entries.map(entry => entry.item) ?? [];
        should(second?.subject).equal('Real second item');
        should(second?.splitFrom).be.undefined();
        should(first?.splitInto).be.undefined();
        should(read?.conversations?.A2 ?? []).be.empty();
        should(await w.backing.list(SESSION, 'A2')).have.length(0);
        should((await w.backing.list(SESSION, 'A1')).map(version => version.change)).deepEqual(['created']);
        should(w.warnings.filter(message => message.includes('voided'))).have.length(1);
        ok(await w.save({ action: 'edit', actor: ACTOR, id: 'A2', patch: { subject: 'Edited' } }));
        should((await w.backing.list(SESSION, 'A2')).map(version => version.version)).deepEqual([1, 2]);
      } finally {
        await w.close();
      }
    });

    it('keeps every set-aside intent: a second one is written beside the first, and the same one is never copied twice', async () => {
      const w = await world();
      try {
        await w.raise();
        const aside = async (subject: string, history: string) => {
          w.fail('error');
          await should(w.save({ action: 'edit', actor: ACTOR, id: 'A1', patch: { subject } })).be.rejected();
          const pending = (await w.files.read(SESSION, AGENDA_VERSION_PENDING)) ?? '';
          await olderDaemonWrites(w, `${subject} on 2a`, history);
          w.restart();
          await w.repo.read(SESSION);
          return pending;
        };
        const firstIntent = await aside('First', 'one');
        const secondIntent = await aside('Second', 'two');
        const named = (text: string) =>
          `${AGENDA_VERSION_PENDING}.stale-${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;

        should(await w.files.read(SESSION, `${AGENDA_VERSION_PENDING}.stale`)).equal(firstIntent);
        should(await w.files.read(SESSION, named(secondIntent))).equal(secondIntent);

        await w.files.writeAtomic(SESSION, AGENDA_VERSION_PENDING, secondIntent);
        await w.repo.read(SESSION);
        should(await w.files.read(SESSION, `${AGENDA_VERSION_PENDING}.stale`)).equal(firstIntent);
        should(await w.files.read(SESSION, named(secondIntent))).equal(secondIntent);
        await w.files.writeAtomic(SESSION, AGENDA_VERSION_PENDING, firstIntent);
        await w.repo.read(SESSION);
        should(await w.files.read(SESSION, named(firstIntent))).be.undefined();
        should(await w.files.read(SESSION, AGENDA_VERSION_PENDING)).be.undefined();
      } finally {
        await w.close();
      }
    });

    it('still replays an intent whose agenda file is the one it was prepared from, and ignores one that already committed', async () => {
      const w = await world();
      try {
        await w.raise();
        w.fail('error');
        await should(
          w.save({ action: 'edit', actor: ACTOR, id: 'A1', patch: { subject: 'Intermediate' } }),
        ).be.rejected();
        w.restart();
        should((await w.repo.read(SESSION))?.entries[0]?.item.subject).equal('Intermediate');
        should(await w.files.read(SESSION, `${AGENDA_VERSION_PENDING}.stale`)).be.undefined();
        should(w.warnings).be.empty();
      } finally {
        await w.close();
      }
    });

    it('does not append or cut the history again for an intent whose agenda file already committed', async () => {
      const w = await world();
      try {
        await w.raise();
        const base = (await w.files.read(SESSION, 'agenda.json')) ?? '';
        const record = {
          kind: 'owner-history' as const,
          id: 'A1',
          entry: { at: AT, kind: 'replied' as const, note: 'committed history' },
        };
        const line = `${JSON.stringify(record)}\n`;
        const result = JSON.stringify({
          ...JSON.parse(base),
          archive: { bytes: new TextEncoder().encode(line).length, count: 1 },
        });
        const digest = (text: string) => createHash('sha256').update(text).digest('hex');
        // The state a crash leaves after the agenda file landed and before the history mark was lifted.
        await w.files.appendSynced(SESSION, AGENDA_ARCHIVE_FILE, new TextEncoder().encode(line));
        await w.files.writeAtomic(SESSION, `${AGENDA_ARCHIVE_FILE}.pending`, JSON.stringify({ bytes: 0 }));
        await w.files.writeAtomic(SESSION, 'agenda.json', result);
        await w.files.writeAtomic(
          SESSION,
          AGENDA_VERSION_PENDING,
          JSON.stringify({
            ledger: result,
            base: digest(base),
            result: digest(result),
            archive: { bytes: 0, count: 0 },
            records: [record],
            drafts: [],
          }),
        );
        const history = await w.files.read(SESSION, AGENDA_ARCHIVE_FILE);
        const refuse = async () => {
          throw new Error('the committed history must not be written again');
        };
        w.files.truncate = refuse;
        w.files.appendSynced = refuse;
        w.restart();

        await w.repo.read(SESSION);

        should(await w.files.read(SESSION, AGENDA_ARCHIVE_FILE)).equal(history);
        should(await w.files.read(SESSION, `${AGENDA_ARCHIVE_FILE}.pending`)).be.undefined();
        should(await w.files.read(SESSION, AGENDA_VERSION_PENDING)).be.undefined();
        should(JSON.stringify(await w.repo.readArchive(SESSION))).containEql('committed history');
      } finally {
        await w.close();
      }
    });
  });

  describe('cold agenda conversations', () => {
    // pr3-r5-unreadable-cold-repro: raw entries stay live even without an older snapshot.
    it.each([
      { archived: true, carried: true },
      { archived: true, carried: false },
      { archived: false, carried: true },
      { archived: false, carried: false },
    ])('keeps unreadable threads live (archived: $archived, carried: $carried)', async ({ archived, carried }) => {
      const w = await world();
      try {
        const raised = await w.raise();
        await w.raise('Second');
        const words = [{ at: AT, by: 'owner' as const, via: 'reply' as const, text: '    exact owner words\n' }];
        const raw = JSON.parse(await readFile(agendaFilePath(w.root, SESSION, 'agenda.json'), 'utf8'));
        raw.entries[0].item.subject = 'x'.repeat(10_000);
        // Other unparseable raw entries must also survive this liveness sweep.
        raw.entries.push(null, { item: { id: 1 } });
        raw.conversations.A1 = words;
        raw.carriedEntries = carried ? { A1: raised.ledger.entries[0] } : {};
        await w.files.writeAtomic(SESSION, 'agenda.json', JSON.stringify(raw));
        if (!archived) await rm(join(w.root, 'state', 'asks', 'versions'), { recursive: true });
        should((await w.repo.read(SESSION))?.unreadable).have.length(3);
        ok(await w.save({ action: 'edit', actor: ACTOR, id: 'A2', patch: { subject: 'Updated second' } }));
        const after = JSON.parse(await readFile(agendaFilePath(w.root, SESSION, 'agenda.json'), 'utf8'));
        should(after.conversations.A1).deepEqual(words);
        should(after.carriedEntries.A1).deepEqual(carried ? raised.ledger.entries[0] : undefined);
        should((await w.backing.list(SESSION, 'A1')).map(each => each.change)).deepEqual(archived ? ['created'] : []);
        after.entries.find((entry: { item?: { id: string } } | null) => entry?.item?.id === 'A1').item.subject =
          REQUEST.subject;
        await w.files.writeAtomic(SESSION, 'agenda.json', JSON.stringify(after));
        const repaired = await w.repo.read(SESSION);
        should(repaired?.entries.find(entry => entry.item.id === 'A1')).not.be.undefined();
        should(repaired?.conversations?.A1).deepEqual(words);
        should(repaired?.carriedEntries?.A1).deepEqual(carried ? raised.ledger.entries[0] : undefined);
      } finally {
        await w.close();
      }
    });
    it('archives a pruned full thread and carried snapshot before dropping hot keys, including a crash before hot commit', async () => {
      const w = await world();
      try {
        const raised = await w.raise();
        const active = raised.ledger.entries[0];
        if (active?.lifecycle !== 'active') throw new Error('missing active fixture');
        const closed = ok(
          applyAgendaCommandToSession(raised.ledger, SESSION, { action: 'resolve', actor: HUMAN, id: 'A1', at: AT }),
        ).ledger.entries[0];
        if (closed === undefined) throw new Error('no closed item');
        const words = Array.from({ length: 130 }, (_, n) => ({
          at: AT,
          by: 'owner' as const,
          via: 'reply' as const,
          text: `${n}:${'雪'.repeat(63_000)}`,
        }));
        const seed: AgendaLedger = {
          ...raised.ledger,
          nextId: 102,
          entries: [
            { ...active, item: { ...active.item, id: 'A101' } },
            ...Array.from(
              { length: 100 },
              (_, n) => ({ ...closed, item: { ...closed.item, id: `A${100 - n}` } }) as never,
            ),
          ],
          conversations: { A1: words },
          carriedEntries: { A1: active },
        };
        await w.files.writeAtomic(SESSION, 'agenda.json', agendaLedgerDocument(seed));
        const write = w.files.writeAtomic.bind(w.files);
        w.files.writeAtomic = async (session, name, text) => {
          if (name === 'agenda.json') throw new Error('crash before dropping hot keys');
          await write(session, name, text);
        };
        await should(w.save({ action: 'resolve', actor: HUMAN, id: 'A101' })).be.rejectedWith(
          'crash before dropping hot keys',
        );
        should(JSON.parse(await readFile(agendaFilePath(w.root, SESSION, 'agenda.json'), 'utf8')).conversations.A1).have.length(words.length);
        w.files.writeAtomic = write;
        w.restart();
        const cold = await w.repo.read(SESSION);
        should(cold?.entries.some(entry => entry.item.id === 'A1')).be.false();
        should(cold?.conversations?.A1).be.undefined();
        should(cold?.carriedEntries?.A1).be.undefined();
        should((await stat(agendaFilePath(w.root, SESSION, 'agenda.json'))).size).be.below(150_000);
        const summaries = await w.backing.list(SESSION, 'A1');
        const latest = summaries.at(-1)?.version ?? 0;
        should(await w.backing.conversation(SESSION, 'A1', latest)).deepEqual(words);
        const service = new AgendaService(
          w.repo,
          { now: () => AT },
          { has: async () => true },
          { raised: async () => {} },
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          w.versions,
        );
        // Use the same public current-thread route and fragment wire for a pruned item.
        const page = await service.conversationOf(SESSION, 'A1');
        should(page.ok).be.true();
        if (page.ok) {
          should(page.value.total).equal(130);
          should(page.value.entry?.text).equal(words[0]?.text.slice(0, 16_384));
        }
        const version = await service.versionOf(SESSION, 'A1', latest);
        should(version.ok && version.value.item.id).equal('A1');
        for (let n = 0; n < 3; n++) {
          const next = await w.raise(`Unrelated ${n}`);
          if (next.item === undefined) throw new Error('missing new item');
          ok(
            await w.save({
              action: 'edit',
              actor: ACTOR,
              id: next.item.id,
              patch: { questionAnswer: `Answer ${n}` },
            }),
          );
        }
        should((await stat(agendaFilePath(w.root, SESSION, 'agenda.json'))).size).be.below(200_000);
        should(await w.backing.list(SESSION, 'A1')).have.length(summaries.length);
        // A cold closed item cannot re-enter through merge or split.
        should((await w.save({ action: 'merge', actor: ACTOR, id: 'A102', from: 'A1' })).ok).be.false();
        should(
          (
            await w.save({
              action: 'split',
              actor: ACTOR,
              id: 'A1',
              request: { ...REQUEST, subject: 'No child' },
            })
          ).ok,
        ).be.false();
      } finally {
        await w.close();
      }
    }, 20_000);

    it.each(['versions', 'legacy', 'pending', 'carried', 'human', 'daemon', 'missing'] as const)(
      'cleans an earlier orphan using its %s snapshot without losing words',
      async source => {
        const w = await world();
        try {
          const raised = await w.raise();
          const entry = raised.ledger.entries[0];
          if (entry?.lifecycle !== 'active') throw new Error('missing fixture');
          const closed = ok(
            applyAgendaCommandToSession(raised.ledger, SESSION, { action: 'resolve', actor: HUMAN, id: 'A1', at: AT }),
          ).ledger.entries[0];
          if (closed === undefined) throw new Error('missing fixture');
          if (source === 'human' || source === 'daemon') {
            const origin = source === 'human' ? HUMAN : { kind: 'daemon' as const, cause: 'system' as const };
            const archived = parseAgendaEntry(
              {
                ...closed,
                origin,
                item: { ...closed.item, raisedBy: source, raisedBySession: null, raisedByName: null },
              },
            );
            if (archived === null) throw new Error('invalid orphan fixture');
            await w.backing.record(SESSION, [
              {
                entry: archived,
                at: AT,
                by: source === 'human' ? 'owner' : 'daemon',
                change: 'closed',
              },
            ]);
          }
          const snapshot = { kind: 'version' as const, id: 'A1', item: closed.item };
          if (!['versions', 'human', 'daemon'].includes(source))
            await rm(join(w.root, 'state', 'asks', 'versions'), { recursive: true });
          const words = [{ at: AT, by: 'owner' as const, via: 'reply' as const, text: '    exact orphan words\n' }];
          // A sidecar record is history only once a ledger cursor commits it (docs/agenda.md § No size limit).
          const line = `${JSON.stringify(snapshot)}\n`;
          await w.files.writeAtomic(
            SESSION,
            'agenda.json',
            agendaLedgerDocument({
              ...raised.ledger,
              entries: [],
              conversations: { A1: words },
              ...(source === 'carried'
                ? { carriedEntries: { A1: { ...entry, item: { ...entry.item, body: 'Original carried report' } } } }
                : {}),
              ...(source === 'pending' ? { archivePending: [snapshot] } : {}),
              ...(source === 'legacy' ? { archive: { bytes: Buffer.byteLength(line), count: 1 } } : {}),
            }),
          );
          if (source === 'legacy') await w.files.writeAtomic(SESSION, AGENDA_ARCHIVE_FILE, line);
          if (source === 'missing') {
            await should(w.raise('New topic')).be.rejectedWith('missing cold agenda snapshot');
            return;
          }
          await w.raise('New topic');
          should((await w.repo.read(SESSION))?.conversations?.A1).be.undefined();
          const summaries = await w.backing.list(SESSION, 'A1');
          if (source === 'carried') {
            const snapshots = await Promise.all(summaries.map(row => w.backing.get(SESSION, 'A1', row.version)));
            should(snapshots.some(row => row?.item.body === 'Original carried report')).be.true();
          }
          const latest = summaries.at(-1)?.version ?? 0;
          should(await w.backing.conversation(SESSION, 'A1', latest)).deepEqual(words);
        } finally {
          await w.close();
        }
      },
    );
  });
}
