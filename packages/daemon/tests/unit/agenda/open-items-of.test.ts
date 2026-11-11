import { describe, it } from 'bun:test';
import should from 'should';
import { MACHINE_AGENDA_ID } from '@ferretry/protocol';
import {
  type AgendaLedger,
  type AgendaLedgerRepository,
  type AgendaMutation,
  AgendaService,
  type MachineAgendaPort,
  type RaiseAgendaRequest,
} from '../../../src/lib/agenda/index.ts';

const NOW = '2026-10-01T10:00:00.000Z';

class Ledgers implements AgendaLedgerRepository {
  readonly ledgers = new Map<string, AgendaLedger>();
  async read(sessionId: string): Promise<AgendaLedger | null> {
    return this.ledgers.get(sessionId) ?? null;
  }
  async transact(sessionId: string, apply: (current: AgendaLedger | null) => AgendaMutation): Promise<AgendaMutation> {
    const mutation = apply(this.ledgers.get(sessionId) ?? null);
    if (mutation.ok) this.ledgers.set(sessionId, mutation.ledger);
    return mutation;
  }
}

const request = (overrides: Partial<RaiseAgendaRequest> = {}): RaiseAgendaRequest => ({
  source: 'task',
  sourceRef: 'ref:1',
  subject: 'Something',
  why: 'Because.',
  howToResolve: 'Answer.',
  kind: 'info',
  ...overrides,
});

const build = (machine?: MachineAgendaPort) => {
  const ledgers = new Ledgers();
  const proved: string[] = [];
  const service = new AgendaService(
    ledgers,
    { now: () => NOW },
    {
      has: async id => {
        proved.push(id);
        return true;
      },
    },
    { raised: async () => undefined },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    machine,
  );
  return { service, proved };
};

describe('AgendaService.openItemsOf', () => {
  it('should answer a session with no ledger as no items, without proving it in the directory', async () => {
    // Arrange
    const { service, proved } = build();

    // Act
    const read = await service.openItemsOf('ghost');

    // Assert
    should(read).deepEqual({ ok: true, value: [] });
    should(proved).deepEqual([]);
  });

  it('should answer the items list answers, without proving the session in the directory', async () => {
    // Arrange
    const { service, proved } = build();
    await service.raise('kid', request(), { kind: 'daemon', cause: 'system' });
    proved.length = 0;

    // Act
    const read = await service.openItemsOf('kid');
    const listed = await service.list('kid');

    // Assert
    should(listed.ok).equal(true);
    should(read.ok && read.value).have.length(1);
    should(read).deepEqual({ ok: true, value: listed.ok ? listed.value.items : [] });
    should(proved).deepEqual(['kid']);
  });

  it('should refuse an id no session can have, and the reserved machine ledger', async () => {
    // Arrange
    const port: MachineAgendaPort = {
      raiseOrUpdate: async () => undefined,
      resolve: async () => undefined,
      list: async () => {
        throw new Error('the machine port is not read by a board read');
      },
    };
    const { service } = build(port);

    // Act
    const invalid = await service.openItemsOf('not valid!');
    const machine = await service.openItemsOf(MACHINE_AGENDA_ID);

    // Assert
    should(invalid).match({ ok: false, error: { code: 'invalid' } });
    should(machine).match({ ok: false, error: { code: 'not-found' } });
  });
});
