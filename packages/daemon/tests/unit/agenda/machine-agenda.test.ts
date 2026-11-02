import { describe, it } from 'bun:test';
import should from 'should';
import {
  type AgendaLedger,
  type AgendaLedgerRepository,
  type AgendaMutation,
  AgendaService,
  MACHINE_AGENDA_ID,
  MachineAgenda,
  type MachineMembersStore,
} from '../../../src/lib/agenda/index.ts';

const NOW = '2026-07-31T10:00:00Z';

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

class Members implements MachineMembersStore {
  value: Record<string, readonly string[]> = {};
  async read(): Promise<Readonly<Record<string, readonly string[]>>> {
    return this.value;
  }
  async write(members: Readonly<Record<string, readonly string[]>>): Promise<void> {
    this.value = { ...members };
  }
}

const request = (subject: string) => ({
  subject,
  why: 'Because.',
  premise: 'A premise.',
  context: 'Some context.',
  howToResolve: 'Do it.',
  waitingSince: NOW,
  notice: true as const,
  kind: 'info' as const,
});

function fixture(options: { readonly failRaise?: boolean } = {}) {
  const repository = new MemoryRepository();
  const failing: AgendaLedgerRepository = {
    read: async id => await repository.read(id),
    transact: async (id, apply) =>
      options.failRaise === true
        ? { ok: false, error: { code: 'full', message: 'full' } }
        : await repository.transact(id, apply),
  };
  const service = new AgendaService(
    failing,
    { now: () => NOW },
    { has: async id => id === MACHINE_AGENDA_ID },
    { raised: async () => undefined },
  );
  const members = new Members();
  return { service, members, machine: new MachineAgenda(service, members, { now: () => NOW }) };
}

const open = async (machine: MachineAgenda) => (await machine.list()).items;

describe('the machine agenda', () => {
  it('should raise one item per cause and refresh it in place', async () => {
    const { machine } = fixture();
    await machine.raiseOrUpdate('warden:orphans', request('one'), ['F1']);
    await machine.raiseOrUpdate('warden:orphans', request('two'), ['F1', 'F2']);
    await machine.raiseOrUpdate('budget:a', request('budget'));
    const items = await open(machine);
    should(items.map(item => item.subject).sort()).eql(['budget', 'two']);
  });

  it('should close the item when the cause has no members left', async () => {
    const { machine, members } = fixture();
    await machine.raiseOrUpdate('warden:orphans', request('one'), ['F1']);
    await machine.raiseOrUpdate('warden:orphans', request('none'), []);
    should(await open(machine)).be.empty();
    should(members.value).eql({});
  });

  it('should resolve by ref, and do nothing when nothing is open', async () => {
    const { machine } = fixture();
    await machine.resolve('warden:orphans', 'nothing to do');
    await machine.raiseOrUpdate('budget:a', request('budget'));
    await machine.resolve('budget:a', 'reset');
    should(await open(machine)).be.empty();
  });

  it('should not raise again for members the owner already cleared', async () => {
    const { machine, service } = fixture();
    await machine.raiseOrUpdate('warden:orphans', request('one'), ['F1']);
    const [item] = await open(machine);
    await service.dismiss(MACHINE_AGENDA_ID, item!.id, { kind: 'human' });
    await machine.raiseOrUpdate('warden:orphans', request('one'), ['F1']);
    should(await open(machine)).be.empty();
    await machine.raiseOrUpdate('warden:orphans', request('two'), ['F1', 'F2']);
    should(await open(machine)).have.length(1);
  });

  it('should wake a snoozed item when a member is added, and not when it shrinks', async () => {
    const { machine, service } = fixture();
    const asks = (subject: string) => {
      const { notice: _notice, ...rest } = request(subject);
      return rest;
    };
    await machine.raiseOrUpdate('warden:orphans', asks('one'), ['F1', 'F2']);
    const [item] = await open(machine);
    const snoozed = await service.snooze(MACHINE_AGENDA_ID, item!.id, '2026-08-01T10:00:00Z', { kind: 'human' });
    should(snoozed.ok).be.true();
    await machine.raiseOrUpdate('warden:orphans', asks('one'), ['F1']);
    should((await open(machine))[0]?.parked?.reason).equal('snoozed');
    await machine.raiseOrUpdate('warden:orphans', asks('three'), ['F1', 'F3']);
    should((await open(machine))[0]?.parked).be.undefined();
  });

  it('should say so when the ledger refuses a raise', async () => {
    const { machine } = fixture({ failRaise: true });
    await should(machine.raiseOrUpdate('budget:a', request('budget'))).be.rejectedWith('full');
    await machine.raiseOrUpdate('budget:b', request('budget'), []).catch(() => undefined);
  });

  it('should keep working after one call failed', async () => {
    const { machine } = fixture();
    await machine.raiseOrUpdate('x', { ...request('bad'), subject: '' }).catch(() => undefined);
    await machine.raiseOrUpdate('budget:a', request('budget'));
    should(await open(machine)).have.length(1);
  });

  it('should read as empty when the ledger cannot be read', async () => {
    const service = new AgendaService(
      { read: async () => null, transact: async () => ({ ok: false, error: { code: 'corrupt', message: 'x' } }) },
      { now: () => NOW },
      { has: async () => false },
      { raised: async () => undefined },
    );
    const machine = new MachineAgenda(service, new Members(), { now: () => NOW });
    should((await machine.list()).items).be.empty();
  });
});
