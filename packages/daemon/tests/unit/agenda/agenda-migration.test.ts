import { describe, it } from 'bun:test';
import should from 'should';
import {
  type AgendaLedger,
  type AgendaLedgerRepository,
  type AgendaMutation,
  AgendaService,
  migrateToAgendaMode,
} from '../../../src/lib/agenda/index.ts';

const NOW = '2026-10-23T10:00:00.000Z';

class Boards implements AgendaLedgerRepository {
  readonly ledgers = new Map<string, AgendaLedger>();
  unreadable = new Set<string>();

  async read(sessionId: string): Promise<AgendaLedger | null> {
    if (this.unreadable.has(sessionId)) throw new Error('board cannot be read');
    return this.ledgers.get(sessionId) ?? null;
  }

  async transact(sessionId: string, apply: (current: AgendaLedger | null) => AgendaMutation): Promise<AgendaMutation> {
    const mutation = apply(await this.read(sessionId));
    if (mutation.ok && mutation.changed) this.ledgers.set(sessionId, mutation.ledger);
    return mutation;
  }
}

const ASK = {
  surface: true,
  source: 'agent-raised' as const,
  sourceRef: null,
  subject: 'Rebase onto main now?',
  why: 'main moved under the PR.',
  context: 'Finishing the relay PR.',
  howToResolve: 'Pick one.',
  ask: { kind: 'open-question' as const },
};

async function world() {
  const boards = new Boards();
  const agenda = new AgendaService(
    boards,
    { now: () => NOW },
    { has: async () => true },
    { raised: async () => undefined },
    { changed: async () => undefined },
  );
  await agenda.raise('with-item', ASK, { kind: 'agent', sessionId: 'with-item', name: 'Ada' });
  const marker = { recorded: [] as Array<readonly [string, readonly string[]]>, done: false };
  const on = new Set<string>();
  const ports = {
    marker: {
      ran: async () => marker.done,
      record: async (at: string, switchedOn: readonly string[]) => {
        marker.done = true;
        marker.recorded.push([at, switchedOn]);
      },
    },
    boards,
    modes: {
      enabled: async (sessionId: string) => on.has(sessionId),
      enable: async (sessionId: string) => {
        on.add(sessionId);
      },
    },
    now: () => NOW,
  };
  return { ports, marker, on, boards, attention: agenda };
}

describe('migrateToAgendaMode', () => {
  it('should switch on only the ferrets that have an open item, and record that it ran', async () => {
    // Arrange
    const { ports, marker, on } = await world();

    // Act
    const outcome = await migrateToAgendaMode(['with-item', 'empty'], ports);

    // Assert
    should(outcome).deepEqual({ ran: true, switchedOn: ['with-item'] });
    should([...on]).deepEqual(['with-item']);
    should(marker.recorded).deepEqual([[NOW, ['with-item']]]);
  });

  it('should do nothing at the next start, so an owner who turned a ferret off is not overruled', async () => {
    // Arrange
    const { ports, on } = await world();
    await migrateToAgendaMode(['with-item'], ports);
    on.delete('with-item');

    // Act
    const again = await migrateToAgendaMode(['with-item'], ports);

    // Assert
    should(again).deepEqual({ ran: false, switchedOn: [] });
    should([...on]).deepEqual([]);
  });

  it('should leave a ferret already on as it is, and still count it', async () => {
    // Arrange
    const { ports, on } = await world();
    on.add('with-item');
    let enables = 0;
    const counting = {
      ...ports,
      modes: {
        ...ports.modes,
        enable: async () => {
          enables += 1;
        },
      },
    };

    // Act
    const outcome = await migrateToAgendaMode(['with-item'], counting);

    // Assert
    should(outcome.switchedOn).deepEqual(['with-item']);
    should(enables).equal(0);
  });

  it('should not count a notice as an agenda', async () => {
    // Arrange
    const { ports, boards } = await world();
    const ledger = boards.ledgers.get('with-item') as AgendaLedger;
    boards.ledgers.set('with-item', {
      ...ledger,
      entries: ledger.entries.map(entry => ({ ...entry, item: { ...entry.item, notice: true } }) as typeof entry),
    });

    // Act
    const outcome = await migrateToAgendaMode(['with-item'], ports);

    // Assert
    should(outcome.switchedOn).deepEqual([]);
  });

  it('should write no marker when a session could not be handled, and try again at the next start', async () => {
    // Arrange
    const { ports, marker, boards, on } = await world();
    boards.unreadable.add('broken');

    // Act
    const first = await migrateToAgendaMode(['broken', 'with-item'], ports);
    boards.unreadable.clear();
    const second = await migrateToAgendaMode(['broken', 'with-item'], ports);

    // Assert
    should(first.ran).be.false();
    should(first.switchedOn).deepEqual(['with-item']);
    should(marker.recorded.length).equal(1);
    should(second.ran).be.true();
    should([...on]).deepEqual(['with-item']);
  });

  it('should never reject, even when its marker cannot be read', async () => {
    // Arrange
    const { ports } = await world();
    const broken = {
      ...ports,
      marker: {
        ran: async (): Promise<boolean> => {
          throw new Error('disk gone');
        },
        record: ports.marker.record,
      },
    };

    // Act + Assert
    await should(migrateToAgendaMode(['with-item'], broken)).be.fulfilledWith({ ran: false, switchedOn: [] });
  });
});
