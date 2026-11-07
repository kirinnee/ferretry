import { createHash } from 'node:crypto';
import { describe, it, spyOn } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  type AgendaVersionsRequest,
  type AgendaVersionsResponse,
  type AgendaVersionsScope,
  serveAgendaVersions,
} from '../../../daemon/adapters/agenda/agenda-versions-program.ts';
import {
  AGENDA_CHANGE_MAX_ATTEMPTS,
  AGENDA_CHANGE_OUTBOX,
  AGENDA_CHANGE_RETRY_MS,
  FileAgendaChangeOutbox,
} from '../../../daemon/adapters/agenda/file-agenda-change-outbox.ts';
import { FileAgendaFileStore } from '../../../daemon/adapters/agenda/file-agenda-file-store.ts';
import {
  AGENDA_VERSION_PENDING,
  FileAgendaLedgerRepository,
  InvalidAgendaLedgerError,
} from '../../../daemon/adapters/agenda/file-agenda-ledger-repository.ts';
import { FileAgendaOutboxRepository } from '../../../daemon/adapters/agenda/file-agenda-outbox-repository.ts';
import { SqliteAgendaVersionStore } from '../../../daemon/adapters/agenda/sqlite-agenda-versions.ts';
import { FileAgendaVersionStore } from '../../../daemon/adapters/agenda/worker-agenda-versions.ts';
import type { HostedWorker } from '../../src/adapters/runtime/bundled-worker-host.ts';
import { AGENDA_ARCHIVE_FILE } from '../../../daemon/lib/agenda/archive.ts';
import { AgendaChangeFanout, AgendaReplyDelivery } from '../../../daemon/lib/agenda/observers.ts';
import { AgendaReplyBatcher } from '../../../daemon/lib/agenda/reply-batch.ts';
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

async function world(timeoutMs = 30_000) {
  const root = await mkdtemp(join(tmpdir(), 'agenda-version-recovery-'));
  const files = new FileAgendaFileStore(() => root);
  const backing = new SqliteAgendaVersionStore(() => root);
  let now = Date.parse(AT);
  const warnings: string[] = [];
  let fault: 'error' | 'crash' | 'timeout' | undefined;
  let after = false;
  const versions = new FileAgendaVersionStore(() => root, {
    timeoutMs,
    spawn: () => {
      const scope: AgendaVersionsScope = {
        onmessage: null,
        postMessage: data => worker.onmessage?.({ data } as MessageEvent<AgendaVersionsResponse>),
      };
      const worker: HostedWorker<AgendaVersionsRequest, AgendaVersionsResponse> = {
        onmessage: null,
        onerror: null,
        postMessage: data => {
          if ('kind' in data && data.kind === 'record' && fault !== undefined) {
            const fail = fault;
            fault = undefined;
            const reject = () => {
              if (fail === 'error') scope.postMessage({ id: data.id, ok: false, error: 'archive unavailable' });
              if (fail === 'crash') worker.onerror?.({ message: 'worker died' } as ErrorEvent);
            };
            if (after) void backing.record(data.sessionId, data.drafts).then(reject);
            else reject();
            return;
          }
          scope.onmessage?.({ data } as MessageEvent<AgendaVersionsRequest>);
        },
        terminate: () => {
          scope.onmessage = null;
        },
      };
      serveAgendaVersions(scope, () => backing);
      return worker;
    },
  });
  const repository = (archive: AgendaVersionStore = versions) =>
    new FileAgendaLedgerRepository(() => root, undefined, files, archive, {
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
      versions.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Real ledger/SQLite and actual worker-host recovery, shared with the daemon integration group. */
export function agendaVersionRecoveryContract() {
  describe('recovered agenda change effects', () => {
    it('acknowledges presentation failures without holding a committed event', async () => {
      // Arrange
      const w = await world();
      const agenda = new AgendaService(
        w.repo,
        { now: () => AT },
        { has: async () => true },
        {
          raised: async () => {
            throw new Error('raise presentation failed');
          },
        },
        {
          changed: async () => {
            throw new Error('change presentation failed');
          },
        },
      );
      try {
        // Act
        should(ok(await agenda.raise(SESSION, REQUEST, ACTOR)).changed).be.true();
        // Assert
        should(await w.files.read(SESSION, AGENDA_CHANGE_OUTBOX)).equal('[]');
        should(w.warnings).be.empty();
      } finally {
        await w.close();
      }
    });

    // Round-6 reviewer reproductions: normal closure and archive-recovery delivery through the production fanout.
    for (const recovered of [false, true])
      for (const action of ['resolve', 'answer'] as const)
        it(`retains a failed real reply write for ${recovered ? 'recovered' : 'normal'} ${action}`, async () => {
          // Arrange
          const w = await world();
          const outboxes = new FileAgendaOutboxRepository(() => w.root);
          const write = outboxes.write.bind(outboxes);
          let fail = false;
          let writes = 0;
          outboxes.write = async outbox => {
            writes++;
            if (fail) {
              fail = false;
              throw new Error('reply write failed');
            }
            await write(outbox);
          };
          const replies = new AgendaReplyBatcher(
            outboxes,
            { send: async () => {} },
            { schedule: () => {}, cancel: () => {} },
            { run: async (_key, work) => await work() },
            { now: () => AT },
          );
          let presented = 0;
          const service = () =>
            new AgendaService(
              w.repo,
              { now: () => AT },
              { has: async () => true },
              { raised: async () => {} },
              new AgendaChangeFanout([
                {
                  changed: async () => {
                    throw new Error('presentation failed');
                  },
                },
                new AgendaReplyDelivery(replies, 'fy'),
                {
                  changed: async () => {
                    presented++;
                  },
                },
              ]),
            );
          let agenda = service();
          const mutate = () =>
            action === 'resolve'
              ? agenda.resolve(SESSION, 'A1', HUMAN, 'All done')
              : agenda.answer(SESSION, 'A1', { kind: 'open-question', answer: 'eu' }, HUMAN);
          try {
            ok(await agenda.raise(SESSION, REQUEST, ACTOR));
            // Act: fail just the reply file, or fail the archive first and the reply during read recovery.
            if (recovered) {
              w.fail('error');
              await should(mutate()).be.rejected();
              fail = true;
              should((await agenda.list(SESSION)).ok).be.true();
            } else {
              fail = true;
              should(ok(await mutate()).changed).be.true();
            }
            // Assert: the board committed; failed acceptance did not retire its original effect.
            should(writes).equal(1);
            should(await outboxes.read(SESSION)).be.null();
            const held = JSON.parse((await w.files.read(SESSION, AGENDA_CHANGE_OUTBOX)) ?? '[]');
            should(held).have.length(1);
            should(held[0].event.actor).deepEqual(HUMAN);
            should(held[0].event.change).equal(action === 'resolve' ? 'resolved' : 'answered');
            should(held[0].retry.attempts).equal(1);
            should(presented).equal(2); // A failed critical observer never silences later presentation.
            await agenda.list(SESSION);
            if (action === 'resolve') should(ok(await mutate()).changed).be.false();
            should(writes).equal(1); // Repeated requests cannot spin during backoff.
            w.restart();
            agenda = service();
            await agenda.list(SESSION);
            should(writes).equal(1); // Backoff survives restart.
            w.advance(AGENDA_CHANGE_RETRY_MS);
            if (action === 'resolve') should(ok(await mutate()).changed).be.false();
            else await agenda.list(SESSION);
            const queued = await outboxes.read(SESSION);
            should(queued?.pending.map(each => each.id)).deepEqual([action === 'resolve' ? 'A1' : 'A1~1']);
            should(queued?.pending[0]?.message).containEql(action === 'resolve' ? 'All done' : 'eu');
            should(writes).equal(2);
            should(await w.files.read(SESSION, AGENDA_CHANGE_OUTBOX)).equal('[]');
            await agenda.list(SESSION);
            should(writes).equal(2);
            should(presented).equal(3);
            should(w.warnings).have.length(1);
          } finally {
            await w.close();
          }
        });

    it('deduplicates acceptance whose reply-file commit succeeded but acknowledgement failed', async () => {
      // Arrange
      const w = await world();
      const outboxes = new FileAgendaOutboxRepository(() => w.root);
      const write = outboxes.write.bind(outboxes);
      let writes = 0;
      outboxes.write = async outbox => {
        writes++;
        await write(outbox);
        throw new Error('reply acknowledgement lost');
      };
      const replies = new AgendaReplyBatcher(
        outboxes,
        { send: async () => {} },
        { schedule: () => {}, cancel: () => {} },
        { run: async (_key, work) => await work() },
        { now: () => AT },
      );
      const agenda = new AgendaService(
        w.repo,
        { now: () => AT },
        { has: async () => true },
        { raised: async () => {} },
        new AgendaChangeFanout([new AgendaReplyDelivery(replies, 'fy')]),
      );
      try {
        // Act
        ok(await agenda.raise(SESSION, REQUEST, ACTOR));
        ok(await agenda.resolve(SESSION, 'A1', HUMAN, 'All done'));
        w.advance(AGENDA_CHANGE_RETRY_MS);
        await agenda.list(SESSION);
        // Assert
        should(writes).equal(1);
        should((await outboxes.read(SESSION))?.pending.map(each => each.id)).deepEqual(['A1']);
        should(await w.files.read(SESSION, AGENDA_CHANGE_OUTBOX)).equal('[]');
      } finally {
        await w.close();
      }
    });

    // Round-7 repro: acceptance order must also be the order in the actual batched message.
    for (const topology of ['same', 'merged', 'merge-chain', 'split'] as const)
      it(`delivers successive instructions in order after a reply-write failure (${topology})`, async () => {
        // Arrange: real ledger, SQLite, reply repository, service/fanout and batcher.
        const w = await world();
        let now = Date.parse(AT);
        const clock = { now: () => new Date(now).toISOString() };
        const advance = (ms: number) => {
          now += ms;
          w.advance(ms);
        };
        const outboxes = new FileAgendaOutboxRepository(() => w.root);
        const write = outboxes.write.bind(outboxes);
        let fail = true;
        outboxes.write = async outbox => {
          if (fail) {
            fail = false;
            throw new Error('transient reply write failure');
          }
          await write(outbox);
        };
        const sent: string[] = [];
        const replies = new AgendaReplyBatcher(
          outboxes,
          {
            send: async (_session, message) => {
              sent.push(message);
            },
          },
          { schedule: () => {}, cancel: () => {} },
          { run: async (_key, work) => await work() },
          clock,
        );
        const service = () =>
          new AgendaService(
            w.repo,
            clock,
            { has: async () => true },
            { raised: async () => {} },
            new AgendaChangeFanout([new AgendaReplyDelivery(replies, 'fy')]),
          );
        let agenda = service();
        try {
          ok(await agenda.raise(SESSION, REQUEST, ACTOR));
          const merged = topology === 'merged' || topology === 'merge-chain';
          if (merged) ok(await agenda.raise(SESSION, { ...REQUEST, subject: 'Second' }, ACTOR));
          if (topology === 'merge-chain') ok(await agenda.raise(SESSION, { ...REQUEST, subject: 'Third' }, ACTOR));
          const first = topology === 'merge-chain' ? 'A3' : merged ? 'A2' : 'A1';
          // Act: fail the old instruction, then make a correction halfway through its backoff.
          ok(await agenda.answer(SESSION, first, { kind: 'open-question', answer: 'Deploy to EU.' }, HUMAN));
          advance(500);
          if (topology === 'merge-chain') ok(await agenda.merge(SESSION, 'A2', 'A3', ACTOR));
          if (merged) ok(await agenda.merge(SESSION, 'A1', 'A2', ACTOR));
          if (topology === 'split') {
            ok(await agenda.split(SESSION, 'A1', { ...REQUEST, subject: 'Independent child' }, ACTOR));
            ok(await agenda.answer(SESSION, 'A2', { kind: 'open-question', answer: 'Child can proceed.' }, HUMAN));
          } else {
            const raised = ok(await agenda.raise(SESSION, { ...REQUEST, subject: 'Unrelated' }, ACTOR));
            if (raised.item === undefined) throw new Error('missing unrelated item');
            ok(
              await agenda.answer(
                SESSION,
                raised.item.id,
                { kind: 'open-question', answer: 'Other can proceed.' },
                HUMAN,
              ),
            );
          }
          ok(
            await agenda.answer(
              SESSION,
              'A1',
              { kind: 'open-question', answer: 'Correction: deploy to US instead.' },
              HUMAN,
            ),
          );
          // Assert: unrelated items bypass; the correction cannot pass the retained original.
          const before = await outboxes.read(SESSION);
          should(before?.pending).have.length(1);
          should(before?.pending[0]?.message).containEql('can proceed.');
          w.restart();
          agenda = service();
          await agenda.list(SESSION);
          should((await outboxes.read(SESSION))?.pending).have.length(1);
          advance(500);
          await agenda.list(SESSION);
          const queued = (await outboxes.read(SESSION))?.pending ?? [];
          should(queued).have.length(3);
          should(queued[1]?.message).containEql('Deploy to EU.');
          should(queued[2]?.message).containEql('Correction: deploy to US instead.');
          should(await w.files.read(SESSION, AGENDA_CHANGE_OUTBOX)).equal('[]');
          advance(10_000);
          await replies.flush(SESSION);
          should(sent).have.length(1);
          should(sent[0]?.indexOf('Deploy to EU.')).be.above(-1);
          should(sent[0]?.indexOf('Correction: deploy to US instead.')).be.above(
            sent[0]?.indexOf('Deploy to EU.') ?? -1,
          );
        } finally {
          await w.close();
        }
      });

    it('keeps a visible parked barrier across restart until explicitly rearmed, while unrelated replies bypass', async () => {
      // Arrange
      const w = await world();
      let broken = true;
      let attempts = 0;
      const accepted: string[] = [];
      const service = () =>
        new AgendaService(
          w.repo,
          { now: () => AT },
          { has: async () => true },
          { raised: async () => {} },
          new AgendaChangeFanout([
            new AgendaReplyDelivery(
              {
                add: async (_session, key, message) => {
                  attempts++;
                  if (broken && key === 'A1~1') throw new Error('broken delivery');
                  accepted.push(message);
                },
              },
              'fy',
            ),
          ]),
        );
      try {
        let agenda = service();
        ok(await agenda.raise(SESSION, REQUEST, ACTOR));
        ok(await agenda.answer(SESSION, 'A1', { kind: 'open-question', answer: 'Deploy to EU.' }, HUMAN));
        for (let attempt = 1; attempt < AGENDA_CHANGE_MAX_ATTEMPTS; attempt++) {
          w.advance(AGENDA_CHANGE_RETRY_MS * 2 ** (attempt - 1));
          await agenda.list(SESSION);
        }
        // Act: the newer instruction must stay blocked even after the old one exhausts retries.
        ok(
          await agenda.answer(
            SESSION,
            'A1',
            { kind: 'open-question', answer: 'Correction: deploy to US instead.' },
            HUMAN,
          ),
        );
        ok(await agenda.raise(SESSION, { ...REQUEST, subject: 'Other' }, ACTOR));
        ok(await agenda.answer(SESSION, 'A2', { kind: 'open-question', answer: 'Unrelated' }, HUMAN));
        w.restart();
        agenda = service();
        w.advance(1_000_000);
        w.warnings.length = 0;
        await agenda.list(SESSION);
        // Assert: restart reports the barrier through the same diagnostic sink as parking.
        should(attempts).equal(AGENDA_CHANGE_MAX_ATTEMPTS + 1);
        should(accepted).have.length(1);
        should(accepted[0]).containEql('Unrelated');
        const pending = JSON.parse((await w.files.read(SESSION, AGENDA_CHANGE_OUTBOX)) ?? '[]');
        should(pending).have.length(2);
        should(w.warnings.join('\n')).containEql(`blocked behind parked change ${pending[0].id}`);
        should(w.warnings.join('\n')).containEql(`${SESSION}/${pending[1].id}`);
        should(w.warnings.join('\n')).containEql(AGENDA_CHANGE_OUTBOX);
        should(pending[1]).not.have.property('retry');
        broken = false;
        delete pending[0].retry;
        await w.files.writeAtomic(SESSION, AGENDA_CHANGE_OUTBOX, JSON.stringify(pending));
        await agenda.list(SESSION);
        should(accepted).have.length(3);
        should(accepted[1]).containEql('Deploy to EU.');
        should(accepted[2]).containEql('Correction: deploy to US instead.');
        should(await w.files.read(SESSION, AGENDA_CHANGE_OUTBOX)).equal('[]');
      } finally {
        await w.close();
      }
    });

    it('parks exhausted effects durably, logs them, and drains later healthy events without spinning', async () => {
      // Arrange
      const w = await world();
      let attempts = 0;
      const accepted: string[] = [];
      const agenda = () =>
        new AgendaService(
          w.repo,
          { now: () => AT },
          { has: async () => true },
          { raised: async () => {} },
          new AgendaChangeFanout([
            new AgendaReplyDelivery(
              {
                add: async (_session, key) => {
                  if (key === 'A1') {
                    attempts++;
                    throw new Error('poison delivery');
                  }
                  accepted.push(key);
                },
              },
              'fy',
            ),
          ]),
        );
      try {
        // Act
        const service = agenda();
        ok(await service.raise(SESSION, REQUEST, ACTOR));
        ok(await service.resolve(SESSION, 'A1', HUMAN, 'All done'));
        ok(await service.raise(SESSION, { ...REQUEST, subject: 'Later' }, ACTOR));
        ok(await service.resolve(SESSION, 'A2', HUMAN, 'Later done'));
        should(accepted).deepEqual(['A2']);
        for (let attempt = 1; attempt < AGENDA_CHANGE_MAX_ATTEMPTS; attempt++) {
          w.advance(AGENDA_CHANGE_RETRY_MS * 2 ** (attempt - 1) - 1);
          await service.list(SESSION);
          should(attempts).equal(attempt);
          w.advance(1);
          await service.list(SESSION);
          should(attempts).equal(attempt + 1);
        }
        w.restart();
        w.advance(1_000_000);
        await agenda().list(SESSION);
        // Assert
        should(attempts).equal(AGENDA_CHANGE_MAX_ATTEMPTS);
        const pending = JSON.parse((await w.files.read(SESSION, AGENDA_CHANGE_OUTBOX)) ?? '[]');
        should(pending).have.length(1);
        should(pending[0].event.addressed.resolutionNote).equal('All done');
        should(pending[0].retry.attempts).equal(AGENDA_CHANGE_MAX_ATTEMPTS);
        should(w.warnings).have.length(AGENDA_CHANGE_MAX_ATTEMPTS);
        should(w.warnings.at(-1)).containEql('parked in agenda-changes.pending.json');
        should(w.warnings.at(-1)).containEql(SESSION);
        should(w.warnings.at(-1)).containEql(pending[0].id);
        // Explicit repair can rearm the same event; appending its recovered intent must retain retry state.
        await w.repo.changeOutbox?.append(SESSION, { id: pending[0].id, event: pending[0].event });
        should(await w.files.read(SESSION, AGENDA_CHANGE_OUTBOX)).equal(JSON.stringify(pending));
        delete pending[0].retry;
        await w.files.writeAtomic(SESSION, AGENDA_CHANGE_OUTBOX, JSON.stringify(pending));
        await w.repo.changeOutbox?.flush(SESSION, { changed: async () => {} });
        should(await w.files.read(SESSION, AGENDA_CHANGE_OUTBOX)).equal('[]');
      } finally {
        await w.close();
      }
    });

    it('logs a retained delivery failure with the default adapter runtime', async () => {
      // Arrange
      const w = await world();
      const warn = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await w.raise();
        const ledger = await w.repo.read(SESSION);
        if (ledger === null) throw new Error('missing ledger');
        const event: AgendaBoardChange = {
          change: 'resolved',
          actor: HUMAN,
          via: 'board',
          snapshot: agendaSnapshot(ledger),
        };
        const outbox = new FileAgendaChangeOutbox(w.files, async (_session, work) => await work());
        await outbox.append(SESSION, { id: 'effect', event });
        // Act
        await outbox.flush(SESSION, {
          changed: async () => {
            throw new Error('delivery failed');
          },
        });
        // Assert
        should(warn.mock.calls.flat().join(' ')).containEql('delivery failed');
        should(JSON.parse((await w.files.read(SESSION, AGENDA_CHANGE_OUTBOX)) ?? '[]').at(0).retry.attempts).equal(1);
      } finally {
        warn.mockRestore();
        await w.close();
      }
    });

    for (const failure of ['error', 'crash', 'timeout'] as const)
      for (const after of [false, true])
        it(`delivers original answer/closure effects after ${failure} ${after ? 'after' : 'before'} archive commit`, async () => {
          const w = await world(failure === 'timeout' ? 300 : 30_000);
          const delivered: string[] = [];
          const changes: AgendaBoardChange[] = [];
          const raised: string[] = [];
          const service = () =>
            new AgendaService(
              w.repo,
              { now: () => AT },
              { has: async () => true },
              {
                raised: async (_id, item) => {
                  raised.push(item.id);
                },
              },
              new AgendaChangeFanout([
                new AgendaReplyDelivery(
                  {
                    add: async (_id, key) => {
                      delivered.push(key);
                    },
                  },
                  'fy',
                ),
                {
                  changed: async (_id, change) => {
                    // Real projection observers read the repository: this must run outside its transaction queue.
                    await w.repo.read(SESSION);
                    changes.push(change);
                  },
                },
              ]),
            );
          try {
            let agenda = service();
            ok(await agenda.raise(SESSION, REQUEST, ACTOR));
            w.fail(failure, after);
            await should(agenda.answer(SESSION, 'A1', { kind: 'open-question', answer: 'eu' }, HUMAN)).be.rejected();
            should(delivered).be.empty();
            w.restart();
            agenda = service();
            const recovered = await agenda.list(SESSION);
            should(recovered.ok).be.true();
            if (recovered.ok) should(recovered.value.items[0]?.resting?.sub).equal('waiting-on-ferret');
            should(delivered).deepEqual(['A1~1']);
            should(changes.map(each => each.change)).deepEqual(['created', 'answered']);
            should(changes[1]?.actor).deepEqual(HUMAN);
            should(changes[1]?.via).equal('board');
            should(changes[1]?.item?.ownerAnswer?.response).deepEqual({ kind: 'open-question', answer: 'eu' });
            w.fail(failure, after);
            await should(agenda.resolve(SESSION, 'A1', HUMAN, 'All done')).be.rejected();
            // An unchanged retry must flush the ORIGINAL resolve, even without an intervening list.
            const retry = ok(await agenda.resolve(SESSION, 'A1', HUMAN, 'All done'));
            should(retry.changed).be.false();
            should(delivered).deepEqual(['A1~1', 'A1']);
            should(changes.map(each => each.change)).deepEqual(['created', 'answered', 'resolved']);
            should(changes[2]?.addressed?.resolutionNote).equal('All done');
            should(changes[2]?.actor).deepEqual(HUMAN);
            await agenda.list(SESSION);
            should(changes).have.length(3);
            should(raised).deepEqual(['A1']);
            should((await w.backing.list(SESSION, 'A1')).map(each => each.change)).deepEqual([
              'created',
              'answered',
              'resolved',
            ]);
          } finally {
            await w.close();
          }
        });

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

    it('replays an unacknowledged effect idempotently and preserves events appended by an observer', async () => {
      const w = await world();
      const delivered = new Set<string>();
      const attempts: string[] = [];
      const agenda = new AgendaService(
        w.repo,
        { now: () => AT },
        { has: async () => true },
        { raised: async () => {} },
        new AgendaReplyDelivery(
          {
            add: async (_id, key) => {
              delivered.add(key);
            },
          },
          'fy',
        ),
      );
      try {
        ok(await agenda.raise(SESSION, REQUEST, ACTOR));
        w.fail('error');
        await should(agenda.answer(SESSION, 'A1', { kind: 'open-question', answer: 'eu' }, HUMAN)).be.rejected();
        await w.repo.read(SESSION);
        const outbox = w.repo.changeOutbox;
        if (outbox === undefined) throw new Error('missing outbox');
        const delivery = new AgendaReplyDelivery(
          {
            add: async (_id, key) => {
              delivered.add(key);
              attempts.push(key);
            },
          },
          'fy',
        );
        const write = w.files.writeAtomic.bind(w.files);
        w.files.writeAtomic = async (session, name, text) => {
          if (name === AGENDA_CHANGE_OUTBOX) throw new Error('ack failed');
          await write(session, name, text);
        };
        await should(outbox.flush(SESSION, delivery)).be.rejectedWith('ack failed');
        w.files.writeAtomic = write;
        await outbox.flush(SESSION, {
          changed: async (session, change) => {
            await delivery.changed(session, change);
            if (change.change === 'answered') ok(await agenda.resolve(SESSION, 'A1', HUMAN, 'All done'));
          },
        });
        should(attempts).deepEqual(['A1~1', 'A1~1', 'A1']);
        should([...delivered]).deepEqual(['A1~1', 'A1']);
        await w.files.writeAtomic(SESSION, AGENDA_CHANGE_OUTBOX, '[{}]');
        await should(outbox.flush(SESSION, delivery)).be.rejected();
      } finally {
        await w.close();
      }
    });
  });
  describe('durable agenda version intents', () => {
    for (const failure of ['error', 'crash', 'timeout'] as const)
      for (const after of [false, true]) {
        it(`replays Intermediate after ${failure} ${after ? 'after commit' : 'before commit'}, exactly once`, async () => {
          const w = await world(failure === 'timeout' ? 300 : 30_000);
          try {
            await w.raise();
            w.fail(failure, after);
            await should(
              w.save({ action: 'edit', actor: ACTOR, id: 'A1', patch: { subject: 'Intermediate' } }),
            ).be.rejected();
            should(JSON.parse(await readFile(w.repo.file(SESSION), 'utf8')).entries[0].item.subject).equal('Initial');
            should((await stat(join(w.root, AGENDA_VERSION_PENDING))).mode & 0o777).equal(0o600);
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
        const archiveAbsent = new FileAgendaLedgerRepository(() => w.root);
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
      document.version = 2;
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
      document.version = 2;
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

    it('does not bring back an owner reply a set-aside intent recorded and the owner then retyped on 2a', async () => {
      const w = await world();
      try {
        await w.raise();
        w.fail('error', true);
        await should(w.save({ action: 'reply', actor: HUMAN, id: 'A1', note: 'STALE owner reply' })).be.rejected();
        await olderDaemonWrites(w, 'From the older daemon', 'retyped on 2a');
        w.restart();

        const read = await w.repo.read(SESSION);

        should((read?.conversations?.A1 ?? []).map(word => word.text)).deepEqual(['retyped on 2a']);
        should((await w.backing.list(SESSION, 'A1')).map(version => version.change)).deepEqual(['created']);
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

    /** The previous release (2a) rewrites the board as it understands it: threads, links and the chat tags are gone. */
    const olderDaemonStrips = async (w: Awaited<ReturnType<typeof world>>) => {
      const document = JSON.parse((await w.files.read(SESSION, 'agenda.json')) ?? '{}');
      document.version = 2;
      delete document.conversations;
      delete document.carriedEntries;
      for (const entry of document.entries) {
        for (const key of ['conversation', 'conversationCount', 'conversationLastAt', 'relatedTasks'])
          delete entry.item[key];
        for (const key of ['mergedFrom', 'mergedInto', 'splitFrom', 'splitInto']) delete entry.item[key];
      }
      await w.files.writeAtomic(SESSION, 'agenda.json', JSON.stringify(document));
    };
    const splitChild = (w: Awaited<ReturnType<typeof world>>) =>
      w.repo.transact(
        SESSION,
        current =>
          applyAgendaCommandToSession(current, SESSION, {
            action: 'split',
            actor: ACTOR,
            id: 'A1',
            request: { ...REQUEST, subject: 'Child' },
            at: AT,
          }),
        'ferret',
        { actor: ACTOR, via: 'board' },
      );
    const logChat = (w: Awaited<ReturnType<typeof world>>) =>
      w.repo.transact(
        SESSION,
        current =>
          applyAgendaCommandToSession(current, SESSION, {
            action: 'log',
            actor: ACTOR,
            id: 'A1',
            mode: 'reply',
            words: 'ferret answer',
            chat: { messageId: 'm1', at: '2026-11-03T10:00:30.000Z', text: 'owner chat words' },
            at: '2026-11-03T10:01:00.000Z',
          }),
        'ferret',
        { actor: ACTOR, via: 'conversation' },
      );
    /** Fails the next write or removal of `name` once, as a disk hiccup or a SIGTERM after the agenda file landed would. */
    const failOnce = (
      w: Awaited<ReturnType<typeof world>>,
      how: 'writeAtomic' | 'remove',
      matches: (name: string, text?: string) => boolean,
    ) => {
      const real = w.files[how].bind(w.files) as (...args: string[]) => Promise<void>;
      let armed = true;
      (w.files as unknown as Record<string, unknown>)[how] = async (session: string, name: string, text?: string) => {
        if (armed && matches(name, text)) {
          armed = false;
          throw new Error(`${how} ${name} failed`);
        }
        await real(...(text === undefined ? [session, name] : [session, name, text]));
      };
    };
    const outboxChanges = async (w: Awaited<ReturnType<typeof world>>): Promise<string[]> =>
      (JSON.parse((await w.files.read(SESSION, AGENDA_CHANGE_OUTBOX)) ?? '[]') as { event: { change: string } }[]).map(
        effect => effect.event.change,
      );

    for (const failing of ['the intent cannot be removed', 'the change event cannot be copied'] as const) {
      it(`keeps a split that committed when ${failing} and the previous release then writes: links, versions and the event`, async () => {
        const w = await world();
        try {
          await w.raise();
          if (failing === 'the intent cannot be removed')
            failOnce(w, 'remove', name => name === AGENDA_VERSION_PENDING);
          else failOnce(w, 'writeAtomic', name => name === AGENDA_CHANGE_OUTBOX);
          await should(splitChild(w)).be.rejected();
          await olderDaemonStrips(w);
          w.restart();

          const read = await w.repo.read(SESSION);

          const [parent, child] = read?.entries.map(entry => entry.item) ?? [];
          should(parent?.splitInto).deepEqual(['A2']);
          should(child?.splitFrom).equal('A1');
          should((await w.backing.list(SESSION, 'A1')).map(version => version.change)).deepEqual(['created', 'split']);
          should((await w.backing.list(SESSION, 'A2')).map(version => version.change)).deepEqual(['created']);
          should(await outboxChanges(w)).deepEqual(['split']);
          should(await w.files.read(SESSION, AGENDA_VERSION_PENDING)).be.undefined();
          should(await w.files.read(SESSION, `${AGENDA_VERSION_PENDING}.stale`)).be.undefined();
          should(w.warnings).be.empty();
          ok(await w.save({ action: 'edit', actor: ACTOR, id: 'A2', patch: { subject: 'Edited' } }));
          should((await w.backing.list(SESSION, 'A2')).map(version => version.version)).deepEqual([1, 2]);
        } finally {
          await w.close();
        }
      });

      it(`keeps a chat log that committed when ${failing} and the previous release then writes: tags, times and the event`, async () => {
        const w = await world();
        try {
          await w.raise();
          if (failing === 'the intent cannot be removed')
            failOnce(w, 'remove', name => name === AGENDA_VERSION_PENDING);
          else failOnce(w, 'writeAtomic', name => name === AGENDA_CHANGE_OUTBOX);
          await should(logChat(w)).be.rejected();
          const versions = await w.backing.list(SESSION, 'A1');
          const thread = await w.backing.conversation(SESSION, 'A1', versions.at(-1)?.version ?? 0);
          should(thread?.map(word => word.fromChat?.messageId)).containEql('m1');
          await olderDaemonStrips(w);
          w.restart();

          const read = await w.repo.read(SESSION);

          should(read?.conversations?.A1).deepEqual(thread);
          should((await w.backing.list(SESSION, 'A1')).map(version => version.change)).deepEqual(['created', 'logged']);
          should(await outboxChanges(w)).deepEqual(['logged']);
          should(await w.files.read(SESSION, AGENDA_VERSION_PENDING)).be.undefined();
          should(w.warnings).be.empty();
        } finally {
          await w.close();
        }
      });
    }

    it('keeps a change that committed even when the intent was not yet marked committed, finding it in the file the previous release wrote', async () => {
      const w = await world();
      try {
        await w.raise();
        failOnce(
          w,
          'writeAtomic',
          (name, text) => name === AGENDA_VERSION_PENDING && text?.includes('"committed"') === true,
        );
        await should(splitChild(w)).be.rejected();
        should(await w.files.read(SESSION, AGENDA_VERSION_PENDING)).containEql('"drafts"');
        await olderDaemonStrips(w);
        w.restart();

        const read = await w.repo.read(SESSION);

        const [parent, child] = read?.entries.map(entry => entry.item) ?? [];
        should(parent?.splitInto).deepEqual(['A2']);
        should(child?.splitFrom).equal('A1');
        should((await w.backing.list(SESSION, 'A2')).map(version => version.change)).deepEqual(['created']);
        should(await outboxChanges(w)).deepEqual(['split']);
        should(await w.files.read(SESSION, AGENDA_VERSION_PENDING)).be.undefined();
        should(await w.files.read(SESSION, `${AGENDA_VERSION_PENDING}.stale`)).be.undefined();
        should(w.warnings.filter(message => message.includes('were kept'))).have.length(1);
        should(w.warnings.filter(message => message.includes('voided'))).be.empty();
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
        const raw = JSON.parse(await readFile(w.repo.file(SESSION), 'utf8'));
        raw.entries[0].item.subject = 'x'.repeat(10_000);
        // Other unparseable raw entries must also survive this liveness sweep.
        raw.entries.push(null, { item: { id: 1 } });
        raw.conversations.A1 = words;
        raw.carriedEntries = carried ? { A1: raised.ledger.entries[0] } : {};
        await w.files.writeAtomic(SESSION, 'agenda.json', JSON.stringify(raw));
        if (!archived) await rm(join(w.root, 'agenda-versions'), { recursive: true });
        should((await w.repo.read(SESSION))?.unreadable).have.length(3);
        ok(await w.save({ action: 'edit', actor: ACTOR, id: 'A2', patch: { subject: 'Updated second' } }));
        const after = JSON.parse(await readFile(w.repo.file(SESSION), 'utf8'));
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
        should(JSON.parse(await readFile(w.repo.file(SESSION), 'utf8')).conversations.A1).have.length(words.length);
        w.files.writeAtomic = write;
        w.restart();
        const cold = await w.repo.read(SESSION);
        should(cold?.entries.some(entry => entry.item.id === 'A1')).be.false();
        should(cold?.conversations?.A1).be.undefined();
        should(cold?.carriedEntries?.A1).be.undefined();
        should((await stat(w.repo.file(SESSION))).size).be.below(150_000);
        const summaries = await w.backing.list(SESSION, 'A1');
        const latest = summaries.at(-1)?.version ?? 0;
        should(await w.versions.conversation(SESSION, 'A1', latest)).deepEqual(words);
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
        should((await stat(w.repo.file(SESSION))).size).be.below(200_000);
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
              false,
              [],
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
            await rm(join(w.root, 'agenda-versions'), { recursive: true });
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
