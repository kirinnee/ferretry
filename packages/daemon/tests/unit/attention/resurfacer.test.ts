import { describe, it } from 'bun:test';
import should from 'should';
import {
  AttentionResurfacer,
  type AttentionLedger,
  type AttentionLedgerRepository,
  type AttentionMutation,
  AttentionService,
  type AttentionSweepTimers,
} from '../../../src/lib/attention/index.ts';

const SESSION = 'session-1';
const AGENT = { kind: 'agent' as const, sessionId: SESSION, name: 'Ada' };
const HUMAN = { kind: 'human' as const };

class MemoryRepository implements AttentionLedgerRepository {
  readonly ledgers = new Map<string, AttentionLedger>();
  async read(sessionId: string): Promise<AttentionLedger | null> {
    return this.ledgers.get(sessionId) ?? null;
  }
  async transact(
    sessionId: string,
    apply: (current: AttentionLedger | null) => AttentionMutation,
  ): Promise<AttentionMutation> {
    const mutation = apply(await this.read(sessionId));
    if (mutation.ok && mutation.changed) this.ledgers.set(sessionId, mutation.ledger);
    return mutation;
  }
}

class Timers implements AttentionSweepTimers {
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
  const attention = new AttentionService(
    repository,
    { now: () => clock.at },
    { has: async () => true },
    { raised: async () => undefined },
  );
  const timers = new Timers();
  const resurfacer = new AttentionResurfacer(
    repository,
    attention,
    () => [SESSION],
    timers,
    () => clock.at,
    afterMinutes,
  );
  return { attention, clock, resurfacer, timers };
}

describe('Attention resurfacer', () => {
  it('should surface an ask that has sat in discussion since the owner replied past the limit, and say the timer did it', async () => {
    // Arrange
    const { attention, clock, resurfacer } = world(30);
    await attention.raise(SESSION, ASK, AGENT);
    await attention.reply(SESSION, 'A1', HUMAN);
    clock.at = '2026-10-23T10:31:00.000Z';

    // Act
    const moved = await resurfacer.sweep();
    const board = await attention.list(SESSION);

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
    const { attention, clock, resurfacer } = world(30);
    await attention.raise(SESSION, ASK, AGENT);
    await attention.reply(SESSION, 'A1', HUMAN);
    await attention.raise(SESSION, { ...ASK, subject: 'Which cluster?' }, AGENT);
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
    const { attention, clock, resurfacer, timers } = world(30);
    await attention.raise(SESSION, ASK, AGENT);
    await attention.reply(SESSION, 'A1', HUMAN);
    clock.at = '2026-10-23T10:31:00.000Z';

    // Act
    resurfacer.start();
    await new Promise(resolve => setTimeout(resolve, 0));
    timers.callbacks[0]?.();
    await new Promise(resolve => setTimeout(resolve, 0));
    resurfacer.stop();

    // Assert
    should(timers.scheduled).deepEqual([
      { key: 'attention-resurface', delayMs: 60_000 },
      { key: 'attention-resurface', delayMs: 60_000 },
    ]);
    should(timers.cancelled).deepEqual(['attention-resurface']);
  });
});
