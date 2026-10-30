import { describe, it } from 'bun:test';
import should from 'should';
import {
  type AgendaLedger,
  type AgendaLedgerRepository,
  type AgendaMutation,
  AgendaService,
  type AgendaSweepTimers,
  AgendaWaker,
  WAKE_SWEEP_MS,
} from '../../../src/lib/agenda/index.ts';

const SESSION = 'session-1';
const OTHER_SESSION = 'session-2';
const BROKEN_SESSION = 'session-3';
const AGENT = { kind: 'agent' as const, sessionId: SESSION, name: 'Ada' };
const OTHER_AGENT = { kind: 'agent' as const, sessionId: OTHER_SESSION, name: 'Grace' };
const HUMAN = { kind: 'human' as const };

class MemoryRepository implements AgendaLedgerRepository {
  readonly ledgers = new Map<string, AgendaLedger>();
  async read(sessionId: string): Promise<AgendaLedger | null> {
    if (sessionId === BROKEN_SESSION) throw new Error('board unreadable');
    return this.ledgers.get(sessionId) ?? null;
  }
  async transact(sessionId: string, apply: (current: AgendaLedger | null) => AgendaMutation): Promise<AgendaMutation> {
    const mutation = apply(await this.read(sessionId));
    if (mutation.ok && mutation.changed) this.ledgers.set(sessionId, mutation.ledger);
    return mutation;
  }
}

class Timers implements AgendaSweepTimers {
  readonly scheduled: Array<{ key: string; delayMs: number }> = [];
  readonly cancelled: string[] = [];
  readonly callbacks: Array<() => void> = [];
  schedule(key: string, delayMs: number, run: () => void): void {
    this.scheduled.push({ key, delayMs });
    this.callbacks.push(run);
  }
  cancel(key: string): void {
    this.cancelled.push(key);
  }
}

const ASK = {
  source: 'agent-raised' as const,
  sourceRef: null,
  subject: 'Approve the deploy?',
  why: 'The release waits on it.',
  premise: 'A release is ready.',
  context: 'It changes the public service.',
  howToResolve: 'Approve or reject.',
  ask: { kind: 'permission' as const },
};

const START = '2026-10-23T10:00:00.000Z';
const HOUR_LATER = '2026-10-23T11:00:00.000Z';
const TWO_HOURS_LATER = '2026-10-23T12:00:00.000Z';

function world(sessions: readonly string[] = [SESSION, OTHER_SESSION, BROKEN_SESSION]) {
  const repository = new MemoryRepository();
  const clock = { at: START };
  const agenda = new AgendaService(
    repository,
    { now: () => clock.at },
    { has: async () => true },
    { raised: async () => undefined },
  );
  const timers = new Timers();
  const waker = new AgendaWaker(
    repository,
    agenda,
    () => sessions,
    timers,
    () => clock.at,
  );
  return { agenda, clock, repository, timers, waker };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('Agenda waker', () => {
  it('should wake every snoozed item that is due, across sessions, fresh on the owner’s queue', async () => {
    // Arrange
    const { agenda, clock, waker } = world();
    await agenda.raise(SESSION, ASK, AGENT);
    await agenda.raise(SESSION, { ...ASK, subject: 'Which region?' }, AGENT);
    await agenda.raise(OTHER_SESSION, ASK, OTHER_AGENT);
    await agenda.snooze(SESSION, 'A1', HOUR_LATER, HUMAN);
    await agenda.snooze(SESSION, 'A2', TWO_HOURS_LATER, HUMAN);
    await agenda.snooze(OTHER_SESSION, 'A1', HOUR_LATER, HUMAN);
    clock.at = HOUR_LATER;

    // Act
    const woken = await waker.sweep();

    // Assert
    const first = await agenda.list(SESSION);
    const other = await agenda.list(OTHER_SESSION);
    should(woken).equal(2);
    if (!first.ok || !other.ok) throw new Error('board unreadable');
    should(first.value.items.map(item => [item.id, item.parked?.reason ?? null])).deepEqual([
      ['A2', 'snoozed'],
      ['A1', null],
    ]);
    should(first.value.items[1]?.waitingSince).equal(HOUR_LATER);
    should(other.value.items[0]?.parked).be.undefined();
  });

  it('should wake an item at its deadline when that comes before the snooze ends', async () => {
    // Arrange
    const { agenda, clock, waker } = world();
    await agenda.raise(SESSION, { ...ASK, neededBy: '2026-10-23T10:30:00.000Z' }, AGENT);
    await agenda.snooze(SESSION, 'A1', TWO_HOURS_LATER, HUMAN);

    // Act
    clock.at = '2026-10-23T10:29:00.000Z';
    const early = await waker.sweep();
    clock.at = '2026-10-23T10:30:00.000Z';
    const due = await waker.sweep();

    // Assert
    should([early, due]).deepEqual([0, 1]);
  });

  it('should leave items that are not snoozed alone, and wake nothing twice', async () => {
    // Arrange
    const { agenda, clock, waker } = world();
    await agenda.raise(SESSION, ASK, AGENT);
    await agenda.raise(SESSION, { ...ASK, subject: 'Which region?' }, AGENT);
    await agenda.reply(SESSION, 'A2', HUMAN);
    await agenda.raise(SESSION, { ...ASK, subject: 'Which cluster?' }, AGENT);
    await agenda.snooze(SESSION, 'A3', HOUR_LATER, HUMAN);
    clock.at = TWO_HOURS_LATER;

    // Act
    const first = await waker.sweep();
    const again = await waker.sweep();

    // Assert
    should([first, again]).deepEqual([1, 0]);
  });

  it('should skip a board it cannot read and a session with no board, and sweep the rest', async () => {
    // Arrange
    const { agenda, clock, waker } = world([BROKEN_SESSION, 'session-missing', SESSION]);
    await agenda.raise(SESSION, ASK, AGENT);
    await agenda.snooze(SESSION, 'A1', HOUR_LATER, HUMAN);
    clock.at = HOUR_LATER;

    // Act
    const woken = await waker.sweep();

    // Assert
    should(woken).equal(1);
  });

  it('should not count a wake that fails, is refused or changes nothing', async () => {
    // Arrange
    const { agenda, clock, repository, timers } = world();
    await agenda.raise(SESSION, ASK, AGENT);
    await agenda.raise(SESSION, { ...ASK, subject: 'Which region?' }, AGENT);
    await agenda.raise(SESSION, { ...ASK, subject: 'Which cluster?' }, AGENT);
    for (const id of ['A1', 'A2', 'A3'] as const) await agenda.snooze(SESSION, id, HOUR_LATER, HUMAN);
    clock.at = HOUR_LATER;
    const outcomes: Record<string, () => Promise<unknown>> = {
      A1: async () => {
        throw new Error('disk full');
      },
      A2: async () => ({ ok: false, error: { code: 'forbidden', message: 'no' } }),
      A3: async () => ({ ok: true, change: 'unchanged' }),
    };
    const waker = new AgendaWaker(
      repository,
      { wake: async (_session, id) => (await outcomes[id]?.()) as AgendaMutation },
      () => [SESSION],
      timers,
      () => clock.at,
    );

    // Act
    const woken = await waker.sweep();

    // Assert
    should(woken).equal(0);
  });

  it('should sweep on start, keep sweeping on its interval, and stop on request', async () => {
    // Arrange
    const { agenda, clock, timers, waker } = world([SESSION]);
    await agenda.raise(SESSION, ASK, AGENT);
    await agenda.snooze(SESSION, 'A1', HOUR_LATER, HUMAN);
    clock.at = HOUR_LATER;

    // Act
    waker.start();
    await settle();
    const board = await agenda.list(SESSION);
    timers.callbacks[0]?.();
    await settle();
    waker.stop();

    // Assert
    should(board).containDeep({ ok: true, value: { items: [{ id: 'A1' }] } });
    should(board.ok ? board.value.items[0]?.parked : 'unreadable').be.undefined();
    should(timers.scheduled).deepEqual([
      { key: 'agenda-wake', delayMs: WAKE_SWEEP_MS },
      { key: 'agenda-wake', delayMs: WAKE_SWEEP_MS },
    ]);
    should(timers.cancelled).deepEqual(['agenda-wake']);
  });

  it('should keep its schedule when a sweep throws, and honour a custom interval', async () => {
    // Arrange
    const { repository, timers, clock } = world();
    const waker = new AgendaWaker(
      repository,
      { wake: async () => ({ ok: true, change: 'unchanged' }) as unknown as AgendaMutation },
      () => {
        throw new Error('sessions unreadable');
      },
      timers,
      () => clock.at,
      5_000,
    );

    // Act
    waker.start();
    await settle();

    // Assert
    should(timers.scheduled).deepEqual([{ key: 'agenda-wake', delayMs: 5_000 }]);
    should(WAKE_SWEEP_MS).equal(60_000);
  });
});
