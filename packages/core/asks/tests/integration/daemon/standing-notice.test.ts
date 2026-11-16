import { standingConformance } from '../../../contract/testing/index.ts';
import { asksPort } from '../../../daemon/adapters/asks-port.ts';
import { AgendaService, isAgendaSessionId } from '../../../daemon/lib/agenda/index.ts';
import type { AgendaMutation } from '../../../daemon/lib/agenda/index.ts';
import { FakeLedgerRepository } from './routes/support.ts';

/** The in-memory ledger, counting every transaction that changed it: a board write. */
class CountingLedger extends FakeLedgerRepository {
  writes = 0;
  override async transact(
    sessionId: string,
    apply: Parameters<FakeLedgerRepository['transact']>[1],
  ): Promise<AgendaMutation> {
    const mutation = await super.transact(sessionId, apply);
    if (mutation.ok && mutation.changed) this.writes += 1;
    return mutation;
  }
}

// The real port over the real engine, built the way the Asks daemon builds it (a well-formed id has a board). The
// SAME cases run on the in-memory fake in contract.test.ts: the two must agree on what a standing notice is.
standingConformance('asksPort over the engine', () => {
  const ledger = new CountingLedger();
  const asks = asksPort(
    new AgendaService(
      ledger,
      { now: () => '2024-05-01T10:00:00.000Z' },
      { has: async ferret => isAgendaSessionId(ferret) },
      { raised: async () => undefined },
    ),
    { ferrets: async () => ['machine-agenda'] },
    () => 'unavailable',
  );
  return { asks, boardWrites: () => ledger.writes };
});
