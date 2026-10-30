import { describe, it } from 'bun:test';
import should from 'should';
import {
  AgendaResurfacer,
  type AgendaLedger,
  type AgendaLedgerRepository,
  type AgendaMutation,
  AgendaService,
  type AgendaSweepTimers,
} from '../../../src/lib/agenda/index.ts';

const SESSION = 'session-1';
const AGENT = { kind: 'agent' as const, sessionId: SESSION, name: 'Ada' };
const HUMAN = { kind: 'human' as const };

class MemoryRepository implements AgendaLedgerRepository {
  readonly ledgers = new Map<string, AgendaLedger>();
  async read(sessionId: string): Promise<AgendaLedger | null> {
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
  subject: 'Which region?',
  why: 'The deploy needs one.',
  howToResolve: 'Name it.',
  ask: { kind: 'open-question' as const },
};

function world(afterMinutes = 30) {
  const repository = new MemoryRepository();
  const clock = { at: '2026-10-23T10:00:00.000Z' };
  const agenda = new AgendaService(
    repository,
    { now: () => clock.at },
    { has: async () => true },
    { raised: async () => undefined },
  );
  const timers = new Timers();
  const resurfacer = new AgendaResurfacer(
    repository,
    agenda,
    () => [SESSION],
    timers,
    () => clock.at,
    afterMinutes,
  );
  return { attention: agenda, clock, resurfacer, timers };
}

describe('Attention resurfacer', () => {
  it('should surface an ask that has sat in discussion since the owner replied past the limit, and say the timer did it', async () => {
    // Arrange
    const { attention: agenda, clock, resurfacer } = world(30);
    await agenda.raise(SESSION, ASK, AGENT);
    await agenda.reply(SESSION, 'A1', HUMAN);
    clock.at = '2026-10-23T10:31:00.000Z';

    // Act
    const moved = await resurfacer.sweep();
    const board = await agenda.list(SESSION);

    // Assert
    should(moved).equal(1);
    should(board).containDeep({ ok: true, value: { items: [{ id: 'A1' }] } });
    const item = board.ok ? board.value.items[0] : undefined;
    should(item?.waitingOn).be.undefined();
    should(item?.history?.at(-1)).containDeep({
      kind: 'surfaced',
      note: 'No reply in 30 minutes: surfaced by the timer.',
    });
  });

  it('should leave an ask that is still inside the limit, one on the owner’s turn, and surface nothing twice', async () => {
    // Arrange
    const { attention: agenda, clock, resurfacer } = world(30);
    await agenda.raise(SESSION, ASK, AGENT);
    await agenda.reply(SESSION, 'A1', HUMAN);
    await agenda.raise(SESSION, { ...ASK, subject: 'Which cluster?' }, AGENT);
    clock.at = '2026-10-23T10:29:00.000Z';

    // Act
    const early = await resurfacer.sweep();
    clock.at = '2026-10-23T11:00:00.000Z';
    const late = await resurfacer.sweep();
    const again = await resurfacer.sweep();

    // Assert
    should([early, late, again]).deepEqual([0, 1, 0]);
  });

  it('should sweep on start, keep sweeping on its interval, and stop on request', async () => {
    // Arrange
    const { attention: agenda, clock, resurfacer, timers } = world(30);
    await agenda.raise(SESSION, ASK, AGENT);
    await agenda.reply(SESSION, 'A1', HUMAN);
    clock.at = '2026-10-23T10:31:00.000Z';

    // Act
    resurfacer.start();
    await new Promise(resolve => setTimeout(resolve, 0));
    timers.callbacks[0]?.();
    await new Promise(resolve => setTimeout(resolve, 0));
    resurfacer.stop();

    // Assert
    should(timers.scheduled).deepEqual([
      { key: 'agenda-resurface', delayMs: 60_000 },
      { key: 'agenda-resurface', delayMs: 60_000 },
    ]);
    should(timers.cancelled).deepEqual(['agenda-resurface']);
  });
});
