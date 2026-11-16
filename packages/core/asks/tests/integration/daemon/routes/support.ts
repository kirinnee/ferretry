/**
 * The agenda test harness the integration tests of Asks' port share: an agenda service over an in-memory ledger with a
 * fixed instant. The domain rules are real, the storage is not.
 */
import {
  type AgendaLedger,
  type AgendaLedgerRepository,
  type AgendaMutation,
  AgendaService,
} from '../../../../daemon/lib/agenda/index.ts';

const AT = '2024-05-01T10:00:00.000Z';
const FERRET_SESSION = 'ferret-own';

/** A ledger under the test's control: the domain rules are real, the storage is not. */
export class FakeLedgerRepository implements AgendaLedgerRepository {
  constructor(private ledger: AgendaLedger | null = null) {}

  async read(): Promise<AgendaLedger | null> {
    return this.ledger;
  }

  async transact(_sessionId: string, apply: (current: AgendaLedger | null) => AgendaMutation): Promise<AgendaMutation> {
    const mutation = apply(this.ledger);
    if (mutation.ok) this.ledger = mutation.ledger;
    return mutation;
  }
}

/** An agenda service over an in-memory ledger, with a fixed instant. */
export function agendaService(repository: AgendaLedgerRepository = new FakeLedgerRepository()): AgendaService {
  return new AgendaService(
    repository,
    { now: () => AT },
    { has: async sessionId => sessionId === 's1' || sessionId === FERRET_SESSION },
    { raised: async () => undefined },
  );
}
