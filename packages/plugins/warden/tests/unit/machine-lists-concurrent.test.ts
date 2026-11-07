import { describe, it } from 'bun:test';
import { MACHINE_AGENDA_ID } from '../../daemon/lib/protocol.ts';
import should from 'should';
import {
  type AgendaLedger,
  type AgendaLedgerRepository,
  type AgendaMutation,
  AgendaService,
  MachineAgenda,
  type MachineMembersStore,
} from '../../../src/lib/agenda/index.ts';
import { AutoMoveFailures } from '../../daemon/lib/auto-move-failures.ts';

const NOW = '2026-07-31T10:00:00Z';

class MemoryRepository implements AgendaLedgerRepository {
  private ledger: AgendaLedger | null = null;
  async read(): Promise<AgendaLedger | null> {
    return this.ledger;
  }
  async transact(_id: string, apply: (current: AgendaLedger | null) => AgendaMutation): Promise<AgendaMutation> {
    const mutation = apply(this.ledger);
    if (mutation.ok && mutation.changed) this.ledger = mutation.ledger;
    return mutation;
  }
}

class SlowMembers implements MachineMembersStore {
  value: Record<string, readonly string[]> = {};
  async read(): Promise<Readonly<Record<string, readonly string[]>>> {
    const held = this.value;
    await new Promise(resolve => setTimeout(resolve, 5));
    return held;
  }
  async write(members: Readonly<Record<string, readonly string[]>>): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 5));
    this.value = { ...members };
  }
}

describe('the auto-move failures through the real machine agenda', () => {
  it('should list both ferrets when two are noted at the same time', async () => {
    // Arrange
    const service = new AgendaService(
      new MemoryRepository(),
      { now: () => NOW },
      { has: async id => id === MACHINE_AGENDA_ID },
      { raised: async () => undefined },
    );
    const machine = new MachineAgenda(service, new SlowMembers(), { now: () => NOW });
    const facts = {
      current: async (id: string) => ({ agent: 'claude-1', name: `ferret-${id}` }),
      candidate: async () => undefined,
    };
    const failures = new AutoMoveFailures(new SlowMembers(), machine, facts);

    // Act
    await Promise.all([failures.note('a', 'Not moved: cap.'), failures.note('b', 'Not moved: busy.')]);

    // Assert
    const items = (await machine.list()).items;
    should(items).have.length(1);
    should(items[0]?.subject).equal('a, b');
    should(items[0]?.context).containEql('ferret-a (a): Cap. Wait for a login to reset.');
    should(items[0]?.context).containEql('ferret-b (b): Busy. Wait for a login to reset.');
  });
});
