import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  AGENDA_CHANGE_OUTBOX,
  type AgendaChangeEffect,
  FileAgendaChangeOutbox,
} from '../../../../daemon/adapters/agenda/file-agenda-change-outbox.ts';
import type { AgendaBoardChange, AgendaChangeObserver } from '../../../../daemon/lib/agenda/service.ts';
import { type AgendaLedger, applyAgendaCommandToSession } from '../../../../daemon/lib/agenda/state-machine.ts';
import { agendaFilesAt } from '../../../support/daemon/agenda-state.ts';

const SESSION = 'session-1';
const AT = '2026-11-03T10:00:00.000Z';
const AGENT = { kind: 'agent' as const, sessionId: SESSION, name: 'Ada' };
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map(async home => await rm(home, { recursive: true, force: true })));
});

/** The change event of raising one item, as the engine hands it to the outbox. */
const raisedEvent = (
  subject: string,
  after: AgendaLedger | null = null,
): { event: AgendaBoardChange; ledger: AgendaLedger } => {
  const mutation = applyAgendaCommandToSession(after, SESSION, {
    action: 'raise',
    actor: AGENT,
    request: {
      source: 'agent-raised',
      sourceRef: null,
      subject,
      why: 'The rollout waits.',
      premise: 'A release is ready.',
      context: 'Choose a region.',
      howToResolve: 'Answer.',
      ask: { kind: 'open-question' },
    },
    at: AT,
  });
  if (!mutation.ok) throw new Error(mutation.error.message);
  const change: AgendaBoardChange = {
    change: 'created',
    actor: AGENT,
    via: 'board',
    snapshot: mutation.snapshot,
    ...(mutation.item === undefined ? {} : { item: mutation.item }),
  };
  return { event: change, ledger: mutation.ledger };
};

async function world() {
  const home = await mkdtemp(join(tmpdir(), 'agenda-change-outbox-'));
  homes.push(home);
  const files = agendaFilesAt(home);
  let now = Date.parse(AT);
  const warnings: string[] = [];
  const outbox = new FileAgendaChangeOutbox(files, async (_session, work) => await work(), {
    now: () => now,
    warn: message => void warnings.push(message),
  });
  const effect = (id: string, subject: string, after: AgendaLedger | null = null): AgendaChangeEffect => {
    const { event } = raisedEvent(subject, after);
    return { id, event: event as unknown as AgendaChangeEffect['event'] };
  };
  const stored = async (): Promise<AgendaChangeEffect[]> =>
    JSON.parse((await files.read(SESSION, AGENDA_CHANGE_OUTBOX)) ?? '[]') as AgendaChangeEffect[];
  return {
    outbox,
    warnings,
    effect,
    stored,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** An observer that records what it was told, and fails while `failing` holds. */
const observer = (failing: () => boolean) => {
  const told: string[] = [];
  const watcher: AgendaChangeObserver = {
    changed: async (_session, change) => {
      if (failing()) throw new Error('delivery refused');
      told.push(change.item?.subject ?? change.change);
    },
  };
  return { told, watcher };
};

describe('the agenda change outbox', () => {
  it('should deliver a retained event once and leave an empty outbox behind', async () => {
    // Arrange
    const w = await world();
    const { told, watcher } = observer(() => false);
    await w.outbox.append(SESSION, w.effect('e1', 'First'));
    await w.outbox.append(SESSION, w.effect('e1', 'First'));

    // Act
    await w.outbox.flush(SESSION, watcher);
    await w.outbox.flush(SESSION, watcher);

    // Assert
    should(told).deepEqual(['First']);
    should(await w.stored()).deepEqual([]);
  });

  it('should keep a refused event with a doubling backoff, and deliver it on the first drain after the wait', async () => {
    // Arrange
    const w = await world();
    let failing = true;
    const { told, watcher } = observer(() => failing);
    await w.outbox.append(SESSION, w.effect('e1', 'First'));

    // Act
    await w.outbox.flush(SESSION, watcher);
    const afterFirst = (await w.stored())[0]?.retry;
    await w.outbox.flush(SESSION, watcher);
    w.advance(1_000);
    await w.outbox.flush(SESSION, watcher);
    const afterSecond = (await w.stored())[0]?.retry;
    failing = false;
    w.advance(1_999);
    await w.outbox.flush(SESSION, watcher);
    const stillWaiting = await w.stored();
    w.advance(1);
    await w.outbox.flush(SESSION, watcher);

    // Assert
    should(afterFirst).match({ attempts: 1, error: 'Error: delivery refused' });
    should(afterSecond).match({ attempts: 2 });
    should((afterSecond?.nextAttemptAt ?? 0) - (afterFirst?.nextAttemptAt ?? 0)).equal(2_000 - 1_000 + 1_000);
    should(stillWaiting).have.length(1);
    should(told).deepEqual(['First']);
    should(await w.stored()).deepEqual([]);
    should(w.warnings[0]).containEql('attempt 1/5; kept in agenda-changes.pending.json; retry on a drain after');
  });

  it('should park an event after five refusals, hold its thread, and still deliver another thread', async () => {
    // Arrange
    const w = await world();
    const { told, watcher } = observer(() => true);
    const first = w.effect('e1', 'First');
    const second = w.effect('e2', 'First, again');
    const other = w.effect('e3', 'Other', raisedEvent('First').ledger);
    // The second event and the first are about the same item (both numbered A1 in their own snapshots).
    await w.outbox.append(SESSION, first);
    await w.outbox.append(SESSION, second);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await w.outbox.flush(SESSION, watcher);
      w.advance(60_000);
    }
    const parked = (await w.stored())[0]?.retry;
    await w.outbox.append(SESSION, other);
    const { told: deliveredAfter, watcher: working } = observer(() => false);

    // Act
    await w.outbox.flush(SESSION, working);
    await w.outbox.flush(SESSION, working);

    // Assert
    should(told).deepEqual([]);
    should(parked).match({ attempts: 5 });
    should(w.warnings.filter(message => message.includes('parked in agenda-changes.pending.json'))).have.length(1);
    should(w.warnings.filter(message => message.includes('session-1/e2: blocked behind parked change e1'))).have.length(
      3,
    );
    should(w.warnings.filter(message => message.includes('session-1/e3'))).have.length(0);
    should(deliveredAfter).deepEqual(['Other']);
    should((await w.stored()).map(each => each.id)).deepEqual(['e1', 'e2']);
  });
});
