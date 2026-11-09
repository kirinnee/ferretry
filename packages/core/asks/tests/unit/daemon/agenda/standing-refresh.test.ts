import { describe, it } from 'bun:test';
import should from 'should';
import {
  type AgendaLedger,
  type AgendaLedgerRepository,
  type AgendaMutation,
  AgendaService,
  isAgendaSessionId,
  type RaiseAgendaRequest,
} from '../../../../daemon/lib/agenda/index.ts';

/**
 * The agenda engine's own `refreshStable` path, through the REAL service over an in-memory ledger (no fake engine): what
 * `AsksApi.standing` stands on. A standing notice rides a `standing:` reference, so the engine refreshes the open
 * item in place and never remembers a closed one for life (`raisedObligations` holds `ask:` references only).
 */

const BOARD = 'machine-agenda';
const DAEMON = { kind: 'daemon' as const, cause: 'system' as const };
const STANDING = 'standing:daemon:warden.orphans';

class CountingLedger implements AgendaLedgerRepository {
  ledger: AgendaLedger | null = null;
  writes = 0;
  async read(): Promise<AgendaLedger | null> {
    return this.ledger;
  }
  async transact(_sessionId: string, apply: (current: AgendaLedger | null) => AgendaMutation): Promise<AgendaMutation> {
    const mutation = apply(this.ledger);
    if (mutation.ok && mutation.changed) {
      this.ledger = mutation.ledger;
      this.writes += 1;
    }
    return mutation;
  }
}

const world = () => {
  const ledger = new CountingLedger();
  const service = new AgendaService(
    ledger,
    { now: () => '2026-07-31T10:00:00Z' },
    { has: async id => isAgendaSessionId(id) },
    { raised: async () => undefined },
  );
  return { ledger, service };
};

const standing = (subject: string, context = 'F1'): RaiseAgendaRequest => ({
  source: 'question',
  sourceRef: STANDING,
  subject,
  why: 'Nobody is on these cards.',
  howToResolve: 'Start a ferret on each.',
  kind: 'info',
  context,
  notice: true,
});

describe('a standing notice through the real agenda engine', () => {
  it('should be rewritten in place when its wording changes: the same item, restated whole', async () => {
    // Arrange
    const { service, ledger } = world();
    const first = await service.raise(BOARD, standing('2 cards', 'F1\nF2'), DAEMON);

    // Act
    const second = await service.raise(BOARD, standing('3 cards', 'F1\nF2\nF3'), DAEMON);
    const third = await service.raise(BOARD, standing('1 card', 'F2'), DAEMON);

    // Assert
    should(first.ok && first.change).equal('created');
    should(second.ok && second.change).equal('refreshed');
    should(third.ok && third.change).equal('refreshed');
    const ids = [first, second, third].map(mutation => (mutation.ok ? mutation.item?.id : undefined));
    should(new Set(ids).size).equal(1);
    const open = ledger.ledger?.entries.filter(entry => entry.lifecycle === 'active') ?? [];
    should(open).have.length(1);
    should(open[0]?.item).containDeep({ subject: '1 card', context: 'F2' });
    should(ledger.writes).equal(3);
  });

  it('should write nothing when the wording is unchanged', async () => {
    // Arrange
    const { service, ledger } = world();
    await service.raise(BOARD, standing('2 cards'), DAEMON);

    // Act
    const again = await Promise.all(
      Array.from({ length: 10 }, async () => await service.raise(BOARD, standing('2 cards'), DAEMON)),
    );

    // Assert
    should(again.every(mutation => mutation.ok && mutation.change === 'unchanged' && !mutation.changed)).be.true();
    should(ledger.writes).equal(1);
  });

  it('should not bring a closed standing item back: the closed one stays closed and a new notice raises afresh', async () => {
    // Arrange
    const { service, ledger } = world();
    const first = await service.raise(BOARD, standing('2 cards', 'F1\nF2'), DAEMON);
    const firstId = first.ok ? first.item?.id : undefined;
    if (firstId === undefined) throw new Error('the first raise made no item');
    await service.resolve(BOARD, firstId, DAEMON, 'a ferret is on every card again');
    const afterClose = ledger.writes;

    // Act — nothing of the old item is refreshed: the same wording raises a NEW item, not a no-op on the closed one.
    const again = await service.raise(BOARD, standing('2 cards', 'F1\nF2'), DAEMON);
    const changed = await service.raise(BOARD, standing('5 cards', 'F1\nF2\nF3\nF4\nF5'), DAEMON);

    // Assert
    const againId = again.ok ? again.item?.id : undefined;
    should(again.ok && again.change).equal('created');
    should(againId).not.equal(undefined);
    should(againId).not.equal(firstId);
    should(changed.ok && changed.change).equal('refreshed');
    should(changed.ok ? changed.item?.id : undefined).equal(againId);
    const entries = ledger.ledger?.entries ?? [];
    should(entries.filter(entry => entry.lifecycle === 'active')).have.length(1);
    const closed = entries.filter(entry => entry.lifecycle !== 'active');
    should(closed).have.length(1);
    should(closed[0]?.item).containDeep({ id: firstId, subject: '2 cards' });
    should(ledger.writes).equal(afterClose + 2);
    should(await service.raisedObligation(BOARD, STANDING)).be.undefined();
  });
});
