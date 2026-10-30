import { describe, it } from 'bun:test';
import { type AgendaItem, AgendaItemSchema } from '@ferretry/protocol';
import should from 'should';
import { AgendaImportAgenda } from '../../../src/adapters/board-import/index.ts';
import type { AgendaLedgerRepository } from '../../../src/lib/agenda/service.ts';
import type { AgendaLedger, AgendaMutation } from '../../../src/lib/agenda/state-machine.ts';

const T0 = '2026-10-30T10:00:00.000Z';
const T1 = '2026-10-30T11:00:00.000Z';

const item = (id: string, extra: Record<string, unknown> = {}): AgendaItem =>
  AgendaItemSchema.parse({
    id,
    source: 'agent-raised',
    sourceRef: null,
    subject: `Ask ${id}`,
    why: 'Because.',
    waitingSince: T0,
    howToResolve: 'Pick one.',
    ask: { kind: 'open-question' },
    raisedBy: 'agent',
    raisedBySession: 's1',
    raisedByName: 'Ada',
    ...extra,
  });

const ledger = (...items: AgendaItem[]): AgendaLedger =>
  ({
    sessionId: 's1',
    nextId: 10,
    entries: items.map(each => ({ lifecycle: 'active', origin: 'raised', item: each })),
    updatedAt: T0,
  }) as unknown as AgendaLedger;

class MemoryLedgers implements AgendaLedgerRepository {
  writes = 0;
  failWith: { code: string; message: string } | undefined;

  constructor(public current: AgendaLedger | null) {}

  async read(): Promise<AgendaLedger | null> {
    return this.current;
  }

  async transact(_sessionId: string, apply: (c: AgendaLedger | null) => AgendaMutation): Promise<AgendaMutation> {
    if (this.failWith !== undefined) return { ok: false, error: this.failWith } as unknown as AgendaMutation;
    const mutation = apply(this.current);
    if (mutation.ok && mutation.changed) {
      this.current = mutation.ledger;
      this.writes += 1;
    }
    return mutation;
  }
}

const agenda = (ledgers: MemoryLedgers) => new AgendaImportAgenda(ledgers, () => T1);

describe('AgendaImportAgenda', () => {
  it('should list the open items that name no card', async () => {
    const ledgers = new MemoryLedgers(ledger(item('A1'), item('A2', { task: { id: 'F1' } })));
    should(await agenda(ledgers).unlinked('s1')).eql([{ id: 'A1' }]);
  });

  it('should list nothing for a session with no agenda', async () => {
    should(await agenda(new MemoryLedgers(null)).unlinked('s1')).eql([]);
  });

  it('should point each named item at its card, marking blocking ones, and count them', async () => {
    const ledgers = new MemoryLedgers(ledger(item('A1'), item('A2')));
    const linked = await agenda(ledgers).link('s1', [
      { id: 'A1', task: { id: 'F5' }, blocking: true },
      { id: 'A2', task: { id: 'F6' }, blocking: false },
    ]);
    should(linked).equal(2);
    const [first, second] = (ledgers.current as AgendaLedger).entries.map(entry => entry.item);
    should(first?.task).eql({ id: 'F5' });
    should(first?.blockingNow).equal(true);
    should(second?.task).eql({ id: 'F6' });
    should(second?.blockingNow).equal(undefined);
    should((ledgers.current as AgendaLedger).updatedAt).equal(T1);
  });

  it('should change nothing on a second pass', async () => {
    const ledgers = new MemoryLedgers(ledger(item('A1')));
    const links = [{ id: 'A1', task: { id: 'F5' }, blocking: false }] as const;
    await agenda(ledgers).link('s1', links);
    should(await agenda(ledgers).link('s1', links)).equal(0);
    should(ledgers.writes).equal(1);
  });

  it('should tolerate a session that has no agenda', async () => {
    should(await agenda(new MemoryLedgers(null)).link('s1', [{ id: 'A1', task: { id: 'F5' }, blocking: false }])).equal(
      0,
    );
  });

  it('should tolerate the repository reporting the agenda as not found', async () => {
    const ledgers = new MemoryLedgers(ledger(item('A1')));
    ledgers.failWith = { code: 'not-found', message: 'gone' };
    should(await agenda(ledgers).link('s1', [{ id: 'A1', task: { id: 'F5' }, blocking: false }])).equal(0);
  });

  it('should throw when the repository fails for any other reason', async () => {
    const ledgers = new MemoryLedgers(ledger(item('A1')));
    ledgers.failWith = { code: 'unavailable', message: 'disk full' };
    await agenda(ledgers)
      .link('s1', [{ id: 'A1', task: { id: 'F5' }, blocking: false }])
      .then(
        () => should.fail(undefined, undefined, 'expected a throw'),
        error => should((error as Error).message).equal('disk full'),
      );
  });
});
