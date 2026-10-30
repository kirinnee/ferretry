import { describe, it } from 'bun:test';
import { AGENDA_CLEAR_AGENTS_NOTE } from '@ferretry/protocol';
import should from 'should';
import { StorageAgentSessions } from '../../../src/adapters/agenda/storage-agent-sessions.ts';
import {
  AgendaAgentClearer,
  type AgendaLedger,
  type AgendaLedgerRepository,
  type AgendaMutation,
  AgendaService,
  agendaSnapshot,
} from '../../../src/lib/agenda/index.ts';

const NOW = '2026-07-31T10:00:00Z';
const OWNER = { kind: 'human' as const };

class MemoryBoards implements AgendaLedgerRepository {
  readonly ledgers = new Map<string, AgendaLedger>();
  readonly unreadable = new Set<string>();

  async read(sessionId: string): Promise<AgendaLedger | null> {
    if (this.unreadable.has(sessionId)) throw new Error('the ledger on disk is not decodable');
    return this.ledgers.get(sessionId) ?? null;
  }

  async transact(sessionId: string, apply: (current: AgendaLedger | null) => AgendaMutation): Promise<AgendaMutation> {
    const mutation = apply(await this.read(sessionId));
    if (mutation.ok && mutation.changed) this.ledgers.set(sessionId, mutation.ledger);
    return mutation;
  }
}

const ask = (subject: string) => ({
  source: 'agent-raised' as const,
  sourceRef: null,
  subject,
  why: 'It is ready to deploy.',
  premise: 'A release is ready to go out.',
  context: 'It changes the public service.',
  howToResolve: 'Approve or reject it.',
  ask: { kind: 'permission' as const },
});

async function world(sessions: Readonly<Record<string, { mode: unknown; asks: number }>>) {
  const boards = new MemoryBoards();
  const agenda = new AgendaService(
    boards,
    { now: () => NOW },
    { has: async () => true },
    { raised: async () => undefined },
  );
  for (const [id, { asks }] of Object.entries(sessions)) {
    for (let n = 0; n < asks; n += 1) {
      const raised = await agenda.raise(id, ask(`Approve release ${id}-${n}?`), {
        kind: 'agent',
        sessionId: id,
        name: null,
      });
      should(raised.ok).be.true();
    }
  }
  const storage = new StorageAgentSessions({
    listSessions: () => Object.keys(sessions).map(id => ({ id })) as never,
    readConfig: async id => {
      if (id === 'broken') throw new Error('document damaged');
      return { mode: sessions[id]?.mode } as never;
    },
  });
  return { boards, agenda, clearer: new AgendaAgentClearer(storage, boards, agenda) };
}

const open = (boards: MemoryBoards, id: string) => {
  const ledger = boards.ledgers.get(id);
  return ledger === undefined ? 0 : agendaSnapshot(ledger).items.length;
};

describe('StorageAgentSessions', () => {
  it('should list only sessions whose own document says auto, skipping a document it cannot read', async () => {
    // Arrange
    const sessions = new StorageAgentSessions({
      listSessions: () => [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'broken' }, { id: 'gone' }] as never,
      readConfig: async id => {
        if (id === 'broken') throw new Error('document damaged');
        if (id === 'gone') return undefined;
        return { mode: id === 'a' ? 'auto' : id === 'b' ? 'interactive' : undefined } as never;
      },
    });

    // Act + Assert
    should(await sessions.agentSessionIds()).deepEqual(['a']);
  });
});

describe('AgendaAgentClearer', () => {
  it('should count what a clear would dismiss without changing a board', async () => {
    // Arrange
    const { boards, clearer } = await world({
      w1: { mode: 'auto', asks: 2 },
      w2: { mode: 'auto', asks: 1 },
      w3: { mode: 'auto', asks: 0 },
      me: { mode: 'interactive', asks: 3 },
    });

    // Act
    const preview = await clearer.preview();

    // Assert
    should(preview).deepEqual({ cleared: 3, sessions: 2 });
    should([open(boards, 'w1'), open(boards, 'w2'), open(boards, 'me')]).deepEqual([2, 1, 3]);
  });

  it('should dismiss every open item on the agent ferrets’ boards as the owner and leave interactive boards alone', async () => {
    // Arrange
    const { boards, clearer } = await world({
      w1: { mode: 'auto', asks: 2 },
      w2: { mode: 'auto', asks: 1 },
      me: { mode: 'interactive', asks: 3 },
      unset: { mode: undefined, asks: 1 },
    });

    // Act
    const result = await clearer.clear(OWNER);

    // Assert
    should(result).deepEqual({ cleared: 3, sessions: 2 });
    should([open(boards, 'w1'), open(boards, 'w2'), open(boards, 'me'), open(boards, 'unset')]).deepEqual([0, 0, 3, 1]);
    should(JSON.stringify(boards.ledgers.get('w1'))).containEql(AGENDA_CLEAR_AGENTS_NOTE);
    should(await clearer.clear(OWNER)).deepEqual({ cleared: 0, sessions: 0 });
  });

  it('should skip a board it cannot read and not count an item that would not dismiss', async () => {
    // Arrange
    const { boards, clearer: real } = await world({ w1: { mode: 'auto', asks: 1 }, w2: { mode: 'auto', asks: 1 } });
    boards.unreadable.add('w2');
    const dismissals: Array<readonly [string, string]> = [];
    const flaky = new AgendaAgentClearer(
      { agentSessionIds: async () => ['w1', 'w2'] },
      { read: async id => await boards.read(id).catch(() => null) },
      {
        dismiss: async (sessionId, id) => {
          dismissals.push([sessionId, id]);
          if (sessionId === 'w1') throw new Error('disk full');
          return { ok: false, error: { code: 'not-found', message: 'gone' } } as never;
        },
      },
    );

    // Act
    const skipped = await real.preview();
    const result = await flaky.clear(OWNER);

    // Assert
    should(skipped).deepEqual({ cleared: 1, sessions: 1 });
    should(result).deepEqual({ cleared: 0, sessions: 0 });
    should(dismissals).deepEqual([['w1', 'A1']]);
  });

  it('should not count a dismissal that changed nothing', async () => {
    // Arrange
    const { boards } = await world({ w1: { mode: 'auto', asks: 1 } });
    const clearer = new AgendaAgentClearer({ agentSessionIds: async () => ['w1'] }, boards, {
      dismiss: async () => ({ ok: true, changed: false }) as never,
    });

    // Act + Assert
    should(await clearer.clear(OWNER)).deepEqual({ cleared: 0, sessions: 0 });
  });
});
