import { describe, it } from 'bun:test';
import { AGENDA_OPEN_DEFAULT_LIMIT } from '@ferretry/protocol';
import should from 'should';
import {
  type AgendaLedger,
  type AgendaLedgerRepository,
  type AgendaMutation,
  AgendaRollup,
  AgendaService,
} from '../../../src/lib/agenda/index.ts';

const NOW = '2026-07-31T10:00:00Z';
const LATER = '2026-08-01T09:00:00Z';
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

async function world(sessions: Readonly<Record<string, number>>) {
  const boards = new MemoryBoards();
  const agenda = new AgendaService(
    boards,
    { now: () => NOW },
    { has: async () => true },
    { raised: async () => undefined },
  );
  const ids: Record<string, string[]> = {};
  for (const [sessionId, asks] of Object.entries(sessions)) {
    ids[sessionId] = [];
    for (let n = 0; n < asks; n += 1) {
      const raised = await agenda.raise(sessionId, ask(`Approve release ${sessionId}-${n}?`), {
        kind: 'agent',
        sessionId,
        name: null,
      });
      should(raised.ok).be.true();
      if (raised.ok && raised.item !== undefined) ids[sessionId]?.push(raised.item.id);
    }
  }
  const rollup = new AgendaRollup(boards, () => Object.keys(sessions));
  return { boards, agenda, ids, rollup };
}

const sessionsOf = (page: Awaited<ReturnType<AgendaRollup['page']>>) => page.sessions.map(entry => entry.sessionId);

describe('AgendaRollup', () => {
  it('should list every conversation holding items, in session-id order, and leave out an empty board', async () => {
    // Arrange
    const { rollup } = await world({ zed: 1, alpha: 2, quiet: 0 });

    // Act
    const page = await rollup.page({});

    // Assert
    should(sessionsOf(page)).deepEqual(['alpha', 'zed']);
    should(page.sessions.map(entry => entry.items.length)).deepEqual([2, 1]);
    should(page.next).be.undefined();
  });

  it('should carry parked items — snoozed and replied — with the open ones, so a count of what is listed can be shown', async () => {
    // Arrange
    const { agenda, ids, rollup } = await world({ old: 3 });
    const [first, second] = ids.old ?? [];
    should((await agenda.snooze('old', first as string, LATER, OWNER)).ok).be.true();
    should((await agenda.reply('old', second as string, OWNER)).ok).be.true();

    // Act
    const page = await rollup.page({});

    // Assert
    const items = page.sessions[0]?.items ?? [];
    should(items.map(item => item.parked?.reason)).deepEqual(['snoozed', 'replied', undefined]);
  });

  it('should page by whole conversations and name where to resume', async () => {
    // Arrange
    const { rollup } = await world({ a: 2, b: 2, c: 2, d: 2 });

    // Act
    const first = await rollup.page({ limit: 3 });
    const second = await rollup.page({ limit: 3, after: first.next as string });
    const third = await rollup.page({ limit: 3, after: 'd' });

    // Assert — a page ends once it holds the limit, and never splits a board.
    should([sessionsOf(first), first.next]).deepEqual([['a', 'b'], 'b']);
    should([sessionsOf(second), second.next]).deepEqual([['c', 'd'], undefined]);
    should(third.sessions).deepEqual([]);
  });

  it('should reach a conversation older than any recency window: every session is read', async () => {
    // Arrange — sixty conversations, the last of them the oldest in any list ordered by activity.
    const sessions: Record<string, number> = {};
    for (let n = 0; n < 60; n += 1) sessions[`s${String(n).padStart(2, '0')}`] = 1;
    const { rollup } = await world(sessions);

    // Act
    const everything = [];
    let after: string | undefined;
    do {
      const page = await rollup.page({ limit: 7, ...(after === undefined ? {} : { after }) });
      everything.push(...sessionsOf(page));
      after = page.next;
    } while (after !== undefined);

    // Assert
    should(everything.length).equal(60);
    should(new Set(everything).size).equal(60);
  });

  it('should skip a board it cannot read and keep going', async () => {
    // Arrange
    const { boards, rollup } = await world({ a: 1, b: 1, c: 1 });
    boards.unreadable.add('b');

    // Act
    const page = await rollup.page({});

    // Assert
    should(sessionsOf(page)).deepEqual(['a', 'c']);
  });

  it('should list a session once however often the directory names it, and default its page size', async () => {
    // Arrange
    const { boards } = await world({ a: 1 });
    const rollup = new AgendaRollup(boards, () => ['a', 'a']);

    // Act
    const page = await rollup.page({});

    // Assert
    should(sessionsOf(page)).deepEqual(['a']);
    should(AGENDA_OPEN_DEFAULT_LIMIT).be.above(0);
  });

  it('should answer an empty page when no conversation holds anything', async () => {
    // Arrange
    const { rollup } = await world({});

    // Act + Assert
    should(await rollup.page({})).deepEqual({ sessions: [] });
  });
});
