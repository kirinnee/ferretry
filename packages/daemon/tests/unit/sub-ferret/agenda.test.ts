import { describe, it } from 'bun:test';
import should from 'should';
import type { AgendaLedger, AgendaLedgerRepository, AgendaMutation } from '../../../src/lib/agenda/index.ts';
import { AgendaService } from '../../../src/lib/agenda/service.ts';
import { DIRECTORY, REFUSED } from './support.ts';

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

const service = (repository = new MemoryRepository()) =>
  new AgendaService(
    repository,
    { now: () => '2026-10-30T10:00:00Z' },
    { has: async () => true },
    { raised: async () => undefined },
    undefined,
    undefined,
    DIRECTORY,
  );

const request = {
  source: 'agent-raised' as const,
  sourceRef: null,
  subject: 'Approve release?',
  why: 'It is ready to deploy.',
  premise: 'A release is ready to go out.',
  context: 'It changes the public service.',
  howToResolve: 'Approve or reject it.',
  ask: { kind: 'permission' as const },
};

const asChild = { kind: 'agent' as const, sessionId: 'child', name: 'Ada' };
const asLead = { kind: 'agent' as const, sessionId: 'lead', name: 'Lizzette' };
const id = 'A1' as never;

describe('a sub-ferret on the agenda', () => {
  it('should be refused raising an item, and told whom to tell', async () => {
    // Arrange
    const repository = new MemoryRepository();

    // Act
    const raised = await service(repository).raise('child', request, asChild);

    // Assert
    should(raised).containDeep({ ok: false, error: { code: 'forbidden' } });
    should(raised.ok ? '' : raised.error.message).match(REFUSED);
    should(repository.ledgers.size).equal(0);
  });

  const verbs: readonly [string, (s: AgendaService) => Promise<AgendaMutation>][] = [
    ['edit', async s => await s.edit('child', id, { subject: 'Another' }, asChild)],
    ['surface', async s => await s.surface('child', id, asChild)],
    ['resolve', async s => await s.resolve('child', id, asChild)],
    ['dismiss', async s => await s.dismiss('child', id, asChild)],
  ];
  for (const [verb, run] of verbs) {
    it(`should be refused ${verb}`, async () => {
      // Act
      const result = await run(service());

      // Assert
      should(result).containDeep({ ok: false, error: { code: 'forbidden' } });
      should(result.ok ? '' : result.error.message).match(REFUSED);
    });
  }

  it('should leave its lead free to raise', async () => {
    // Act
    const raised = await service().raise('lead', request, asLead);

    // Assert
    should(raised.ok).be.true();
  });

  it('should leave the owner free to answer on its board', async () => {
    // Act
    const result = await service().resolve('child', id, { kind: 'human' });

    // Assert
    should(result.ok ? '' : result.error.message).not.match(/Sub-ferrets/);
  });
});
