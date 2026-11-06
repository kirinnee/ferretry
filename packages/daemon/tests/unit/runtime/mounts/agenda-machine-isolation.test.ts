import { describe, it } from 'bun:test';
import { MACHINE_AGENDA_ID } from '@ferretry/protocol';
import should from 'should';
import type {
  AgendaActor,
  AgendaLedger,
  AgendaLedgerRepository,
  AgendaMutation,
} from '../../../../src/lib/agenda/index.ts';
import {
  assertMachineAgendaIsolation,
  assertOwnerAndSessionRoutes,
  ASK,
  machineAgendaWorld,
} from '../../../support/machine-agenda-isolation.ts';

class MemoryLedgers implements AgendaLedgerRepository {
  private readonly ledgers = new Map<string, AgendaLedger>();
  async read(id: string): Promise<AgendaLedger | null> {
    return this.ledgers.get(id) ?? null;
  }
  async transact(id: string, apply: (current: AgendaLedger | null) => AgendaMutation): Promise<AgendaMutation> {
    const mutation = apply(await this.read(id));
    if (mutation.ok && mutation.changed) this.ledgers.set(id, mutation.ledger);
    return mutation;
  }
}
const world = async () => await machineAgendaWorld(new MemoryLedgers(), new MemoryLedgers());

describe('the reserved machine agenda is never a session route', () => {
  it('refuses every session route and action before reading the body, touching a service or sending replies', async () => {
    await assertMachineAgendaIsolation(await world());
  });

  it('keeps the owner machine routes and ordinary session routes working with separate ledgers', async () => {
    await assertOwnerAndSessionRoutes(await world());
  });

  it('refuses direct session-service machine reads, count and writes without touching the machine port', async () => {
    const fixture = await world();
    const service = fixture.service;
    const id = MACHINE_AGENDA_ID;
    const before = await fixture.machine.list();
    const reads = [
      () => service.list(id),
      () => service.list(id, { kind: 'human' }),
      () => service.list(id, { kind: 'agent', sessionId: 's1', name: null }),
      () => service.count(id),
      () => service.versionsOf(id, 'A1', 'host'),
      () => service.versionOf(id, 'A1', 1),
      () => service.conversationOf(id, 'A1', 0, 0),
      () => service.markSeen(id, 'A1', 1, 'host'),
    ];
    for (const read of reads) should(await read()).match({ ok: false, error: { code: 'not-found' } });
    const actors: AgendaActor[] = [
      { kind: 'human' },
      { kind: 'agent', sessionId: 's1', name: null },
      { kind: 'agent', sessionId: id, name: null },
    ];
    for (const actor of actors) {
      const writes = [
        () => service.raise(id, { source: 'agent-raised', sourceRef: 'attempt', ...ASK }, actor),
        () => service.resolveSource(id, 'agent-raised', 'warden:orphans', actor),
        () => service.answer(id, 'A1', { kind: 'open-question', answer: 'eu' }, actor),
        () => service.edit(id, 'A1', { subject: 'Changed' }, actor),
        () => service.progress(id, 'A1', 0, true, actor),
        () => service.needsInfo(id, 'A1', actor),
        () => service.discuss(id, 'A1', actor),
        () => service.log(id, 'A1', 'reply', 'Understood.', actor),
        () => service.merge(id, 'A1', 'A2', actor),
        () => service.split(id, 'A1', { source: 'agent-raised', sourceRef: null, ...ASK }, actor),
        () => service.surface(id, 'A1', actor),
        () => service.rest(id, 'A1', 'Working', actor),
        () => service.snooze(id, 'A1', '2026-11-07T10:00:00.000Z', actor),
        () => service.unsnooze(id, 'A1', actor),
        () => service.resolve(id, 'A1', actor),
        () => service.dismiss(id, 'A1', actor),
      ];
      for (const write of writes) should(await write()).match({ ok: false, error: { code: 'not-found' } });
    }
    should(fixture.effects).be.empty();
    should(await fixture.machine.list()).deepEqual(before);
  });
});
