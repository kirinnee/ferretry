import { describe, it } from 'bun:test';
import should from 'should';
import type { AgendaLedger, AgendaLedgerRepository, AgendaMutation } from '../../../src/lib/agenda/index.ts';
import { AgendaService } from '../../../src/lib/agenda/service.ts';
import { isAncestorOf, NO_SUB_FERRETS, type SubFerretDirectory } from '../../../src/lib/sub-ferret/index.ts';
import { DIRECTORY } from './support.ts';

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

const build = (directory?: SubFerretDirectory, repository = new MemoryRepository()) =>
  new AgendaService(
    repository,
    { now: () => '2026-10-30T10:00:00Z' },
    { has: async () => true },
    { raised: async () => undefined },
    undefined,
    undefined,
    directory,
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

const agent = (sessionId: string) => ({ kind: 'agent' as const, sessionId, name: sessionId });
const id = 'A1' as never;

/** `child` raised A1 on its own board before the limits applied; the service under test knows the lineage. */
const seeded = async (directory: SubFerretDirectory = DIRECTORY) => {
  const repository = new MemoryRepository();
  await build(undefined, repository).raise('child', request, agent('child'));
  await build(undefined, repository).raise('grandchild', request, agent('grandchild'));
  return build(directory, repository);
};

describe('a lead over its sub-ferret agenda', () => {
  const verbs: readonly [string, (s: AgendaService, session: string, by: string) => Promise<AgendaMutation>][] = [
    ['edit', (s, session, by) => s.edit(session, id, { subject: 'Another' }, agent(by))],
    ['surface', (s, session, by) => s.surface(session, id, agent(by))],
    ['resolve', (s, session, by) => s.resolve(session, id, agent(by), 'No longer needed')],
    ['dismiss', (s, session, by) => s.dismiss(session, id, agent(by))],
  ];

  for (const [verb, run] of verbs) {
    it(`should ${verb} an item in the session it started`, async () => {
      // Act
      const result = await run(await seeded(), 'child', 'lead');

      // Assert
      should(result.ok).be.true();
    });

    it(`should ${verb} an item two levels down, as an ancestor`, async () => {
      // Act
      const result = await run(await seeded(), 'grandchild', 'lead');

      // Assert
      should(result.ok).be.true();
    });

    it(`should be refused ${verb} for a lead that did not start the session`, async () => {
      // Act
      const result = await run(await seeded(), 'child', 'stranger');

      // Assert
      should(result).containDeep({ ok: false, error: { code: 'forbidden' } });
    });

    it(`should be refused ${verb} by a sub-ferret on its lead's board`, async () => {
      // Act
      const result = await run(await seeded(), 'lead', 'child');

      // Assert
      should(result).containDeep({ ok: false, error: { code: 'forbidden' } });
    });

    it(`should be refused ${verb} by a sub-ferret on its sibling's board`, async () => {
      // Arrange
      const directory: SubFerretDirectory = {
        leadOf: async sessionId => ({ child: 'lead', sibling: 'lead' })[sessionId],
        addressOf: async sessionId => sessionId,
      };

      // Act
      const result = await run(await seeded(directory), 'child', 'sibling');

      // Assert
      should(result).containDeep({ ok: false, error: { code: 'forbidden' } });
    });
  }

  it('should let a sub-ferret that leads a deeper session act on that session', async () => {
    // Act
    const result = await (await seeded()).resolve('grandchild', id, agent('child'), 'No longer needed');

    // Assert
    should(result.ok).be.true();
  });

  it('should record the lead as the one who closed the item', async () => {
    // Arrange
    const service = await seeded();

    // Act
    const result = await service.resolve('child', id, agent('lead'), 'No longer needed');

    // Assert
    should(result).containDeep({ ok: true, addressed: { resolvedBySession: 'lead', raisedBySession: 'child' } });
  });

  it("should record a lead's close of an unanswered question as a withdrawal with its reason", async () => {
    // Act
    const result = await (await seeded()).resolve('child', id, agent('lead'), 'No longer needed');

    // Assert
    should(result).containDeep({ ok: true, addressed: { resolutionNote: 'No longer needed' } });
    should((result as { addressed?: { response?: unknown } }).addressed?.response).be.undefined();
  });

  it('should refuse a lead closing its sub-ferret’s unanswered question without a reason', async () => {
    // Act
    const result = await (await seeded()).resolve('child', id, agent('lead'));

    // Assert
    should(result).containDeep({ ok: false, error: { code: 'invalid' } });
  });

  it('should be refused every verb the lineage does not cover', async () => {
    // Arrange
    const service = await seeded();

    // Act
    const results = [
      await service.progress('child', id, 0, true, agent('lead')),
      await service.raise('child', request, agent('lead')),
    ];

    // Assert
    for (const result of results) should(result).containDeep({ ok: false, error: { code: 'forbidden' } });
  });

  it('should be refused when the directory cannot answer', async () => {
    // Arrange
    const broken: SubFerretDirectory = {
      leadOf: async sessionId => {
        if (sessionId === 'child') throw new Error('registry down');
        return undefined;
      },
      addressOf: async sessionId => sessionId,
    };

    // Act
    const result = await (await seeded(broken)).resolve('child', id, agent('lead'));

    // Assert
    should(result).containDeep({ ok: false, error: { code: 'forbidden' } });
  });

  it('should be refused when no directory is wired', async () => {
    // Act
    const result = await (await seeded(NO_SUB_FERRETS)).resolve('child', id, agent('lead'));

    // Assert
    should(result).containDeep({ ok: false, error: { code: 'forbidden' } });
  });

  it("should leave the owner free to close any session's item", async () => {
    // Act
    const result = await (await seeded()).resolve('child', id, { kind: 'human' });

    // Assert
    should(result.ok).be.true();
  });
});

describe('isAncestorOf', () => {
  it('should not follow a cycle forever', async () => {
    // Arrange
    const loop: SubFerretDirectory = {
      leadOf: async sessionId => (sessionId === 'a' ? 'b' : 'a'),
      addressOf: async sessionId => sessionId,
    };

    // Act
    const found = await isAncestorOf(loop, 'z', 'a');

    // Assert
    should(found).be.false();
  });

  it('should stop at a chain deeper than it follows', async () => {
    // Arrange
    const deep: SubFerretDirectory = {
      leadOf: async sessionId => `${sessionId}x`,
      addressOf: async sessionId => sessionId,
    };

    // Act
    const found = await isAncestorOf(deep, 'never', 'a');

    // Assert
    should(found).be.false();
  });

  it('should not count a session as its own ancestor', async () => {
    // Act
    const found = await isAncestorOf(DIRECTORY, 'child', 'child');

    // Assert
    should(found).be.false();
  });
});
