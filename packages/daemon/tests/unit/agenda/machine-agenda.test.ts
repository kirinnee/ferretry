import { describe, it } from 'bun:test';
import { MACHINE_AGENDA_ID } from '@ferretry/protocol';
import should from 'should';
import {
  type AgendaLedger,
  type AgendaLedgerRepository,
  type AgendaMutation,
  AgendaService,
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

  it('should raise again when a member that left comes back after the owner dismissed the item', async () => {
    // Arrange
    const { machine, service } = fixture();
    await machine.raiseOrUpdate('warden:orphans', request('both'), ['a', 'b']);
    const [item] = await open(machine);
    await service.dismiss(MACHINE_AGENDA_ID, item!.id, { kind: 'human' });

    // Act: a leaves, the owner's dismissal still stands, then a fails again.
    await machine.raiseOrUpdate('warden:orphans', request('only b'), ['b']);
    should(await open(machine)).be.empty();
    await machine.raiseOrUpdate('warden:orphans', request('a is back'), ['a', 'b']);

    // Assert
    should((await open(machine)).map(found => found.subject)).eql(['a is back']);
  });

  it('should wake a snoozed item as the daemon itself, never as the owner', async () => {
    // Arrange
    const { machine, service } = fixture();
    const actors: unknown[] = [];
    const unsnooze = service.unsnooze.bind(service);
    service.unsnooze = async (...args: Parameters<typeof service.unsnooze>) => {
      actors.push(args[2]);
      return await unsnooze(...args);
    };
    const { notice: _notice, ...asks } = request('one');
    await machine.raiseOrUpdate('warden:orphans', asks, ['F1']);
    const [item] = await open(machine);
    await service.snooze(MACHINE_AGENDA_ID, item!.id, '2026-08-01T10:00:00Z', { kind: 'human' });

    // Act
    await machine.raiseOrUpdate('warden:orphans', { ...asks, subject: 'two' }, ['F1', 'F2']);

    // Assert
    should(actors).eql([{ kind: 'daemon', cause: 'system' }]);
    should((await open(machine))[0]?.parked).be.undefined();
  });

  it('should keep two homes’ notices of one cause as ONE item holding both, when they arrive at the same time', async () => {
    // Arrange
    const { machine, members } = fixture();
    const noticeOf = (home: string) => request(`${home} could not move its ferret`);

    // Act: two homes tell the same cause at once, each listing only its own ferret plus what it already knew.
    await Promise.all([
      machine.raiseOrUpdate('warden:auto-move-failed', noticeOf('home-a'), ['a']),
      machine.raiseOrUpdate('warden:auto-move-failed', noticeOf('home-b'), ['a', 'b']),
    ]);

    // Assert: one item, and the members file holds the latest list, not a half-written one.
    const items = await open(machine);
    should(items).have.length(1);
    should(items[0]?.subject).equal('home-b could not move its ferret');
    should(members.value['warden:auto-move-failed']).eql(['a', 'b']);
  });

  it('should keep one item per login per window however many anchors tell it', async () => {
    // Arrange
    const { machine } = fixture();
    const ref = 'budget:claude-1:daily:2026-08-01T00:00:00.000Z';

    // Act: two anchored ferrets, two notices for the same login and window; the next window is another item.
    await Promise.all([
      machine.raiseOrUpdate(ref, request('claude-1 hit its daily limit')),
      machine.raiseOrUpdate(ref, request('claude-1 hit its daily limit')),
    ]);
    await machine.raiseOrUpdate('budget:claude-1:daily:2026-08-02T00:00:00.000Z', request('again tomorrow'));

    // Assert
    const items = await open(machine);
    should(items.map(found => found.sourceRef).sort()).eql([ref, 'budget:claude-1:daily:2026-08-02T00:00:00.000Z']);
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
