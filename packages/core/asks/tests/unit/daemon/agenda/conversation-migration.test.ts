import { describe, it } from 'bun:test';
import type { AgendaItem } from '@ferretry/protocol';
import should from 'should';
import { seedConversation } from '../../../src/lib/agenda/item-words.ts';
import {
  type AgendaActor,
  type AgendaCommand,
  type AgendaLedger,
  type AgendaMutation,
  applyAgendaCommand,
  applyAgendaCommandToSession,
  toChannel,
} from '../../../src/lib/agenda/state-machine.ts';

/** THE CONVERSATION'S SEED (docs/agenda.md § The conversation): an item from before it was stored reads with its words. */

const SESSION_ID = 'session-1';
const T = (minute: number): string => `2026-07-30T10:${String(minute).padStart(2, '0')}:00Z`;
const HUMAN: AgendaActor = { kind: 'human' };
const AGENT: AgendaActor = { kind: 'agent', sessionId: SESSION_ID, name: 'Ada' };

const ok = (result: AgendaMutation): Extract<AgendaMutation, { ok: true }> => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result;
};
const run = (ledger: AgendaLedger, command: AgendaCommand) => ok(applyAgendaCommand(ledger, command)).ledger;

/** A ledger as the daemon before this one wrote it: the same words in the history, and no stored conversation. */
function beforeConversation(): AgendaLedger {
  let ledger = ok(
    applyAgendaCommandToSession(null, SESSION_ID, {
      action: 'raise',
      actor: AGENT,
      request: {
        source: 'agent-raised',
        sourceRef: null,
        subject: 'Which region do we deploy to?',
        why: 'The release waits on the region.',
        context: 'The deploy changes the public service.',
        premise: 'A release is ready to go out.',
        howToResolve: 'Answer in words.',
        ask: { kind: 'open-question' },
      },
      at: T(0),
    }),
  ).ledger;
  ledger = run(ledger, { action: 'reply', actor: HUMAN, id: 'A1', note: 'Try eu first', at: T(1) });
  ledger = run(ledger, { action: 'rest', actor: AGENT, id: 'A1', why: 'checking eu', at: T(2) });
  return {
    ...ledger,
    version: 2,
    entries: ledger.entries.map(entry => {
      const { conversation: _conversation, ...item } = entry.item as AgendaItem;
      return { ...entry, item } as typeof entry;
    }),
  };
}

describe('The conversation seed', () => {
  it('should seed every word the history kept, oldest first, and lose none', () => {
    // Arrange
    const ledger = beforeConversation();

    // Act
    const read = toChannel(ledger, true);
    const item = read.entries[0]?.item as AgendaItem;

    // Assert
    should(item.conversation?.map(entry => [entry.by, entry.text])).deepEqual([
      ['owner', 'Try eu first'],
      ['ferret', 'checking eu'],
    ]);
  });

  it('should seed nothing from an item with no words, and read it back unchanged', () => {
    // Arrange
    const item = (beforeConversation().entries[0]?.item ?? {}) as AgendaItem;
    const silent: AgendaItem = { ...item, history: [], ownerAnswer: undefined };

    // Act
    const seeded = seedConversation(silent);

    // Assert
    should(seeded).deepEqual([]);
  });

  it('should be idempotent: a second read changes nothing, and the seed is not added twice', () => {
    // Arrange
    const once = toChannel(beforeConversation(), true);

    // Act
    const twice = toChannel(once, true);

    // Assert
    should(twice).equal(once);
    should((twice.entries[0] as { item: AgendaItem }).item.conversation).have.length(2);
  });
});

it('migrates a valid near-budget legacy item losslessly and validates it on every reread', async () => {
  const { AgendaItemSchema } = await import('@ferretry/protocol');
  const { agendaLedgerDocument, parseAgendaLedger } = await import('../../../src/lib/agenda/state-machine.ts');
  const before = beforeConversation();
  const item = {
    ...before.entries[0]?.item,
    conversation: undefined,
    conversationCount: undefined,
    body: 'b'.repeat(200_000),
    detail: 'd'.repeat(200_000),
    history: [1, 2, 3].map(minute => ({ at: T(minute), kind: 'replied' as const, note: 'r'.repeat(64_000) })),
  } as AgendaItem;
  should(AgendaItemSchema.safeParse(item).success).be.true();
  const legacy = { ...before, conversations: undefined, entries: [{ ...before.entries[0], item }] } as AgendaLedger;
  const migrated = toChannel(legacy, true);
  should(AgendaItemSchema.safeParse(migrated.entries[0]?.item).success).be.true();
  should(migrated.conversations?.A1?.map(entry => entry.text)).deepEqual(Array(3).fill('r'.repeat(64_000)));
  const reread = parseAgendaLedger(JSON.parse(agendaLedgerDocument(migrated)), SESSION_ID);
  should(reread?.entries).have.length(1);
  should(reread?.unreadable).be.undefined();
  should(reread?.conversations).deepEqual(migrated.conversations);
  should(toChannel(migrated, true)).equal(migrated);
});

it('migrates response text from history and ownerAnswer once, including free text without notes', () => {
  const before = beforeConversation();
  const response = { kind: 'open-question' as const, answer: 'Use eu-west, please.' };
  const item = {
    ...before.entries[0]?.item,
    conversation: undefined,
    history: [{ at: T(1), kind: 'replied' as const, response }],
    ownerAnswer: { at: T(1), response, request: 1 },
  } as AgendaItem;
  should(seedConversation(item).map(entry => entry.text)).deepEqual([response.answer]);
});

it('seeds a closing note exactly once with the actual closing speaker', () => {
  // Arrange
  const item = {
    ...beforeConversation().entries[0]?.item,
    conversation: undefined,
    history: undefined,
    resolvedAt: T(3),
    resolutionNote: 'Finished checking regions.',
    resolvedBy: 'agent',
    resolvedBySession: SESSION_ID,
    resolvedByName: 'Ada',
    disposition: 'done',
  } as const;

  // Act
  const seeded = seedConversation(item as Parameters<typeof seedConversation>[0]);

  // Assert
  should(seeded.map(entry => [entry.by, entry.via, entry.text])).deepEqual([
    ['ferret', 'close', 'Finished checking regions.'],
  ]);
});

it('keeps a full original snapshot when migration metadata displaces revisions at the transport bound', async () => {
  // Arrange
  const { AgendaItemSchema } = await import('@ferretry/protocol');
  const { agendaLedgerDocument, parseAgendaLedger } = await import('../../../src/lib/agenda/state-machine.ts');
  const before = beforeConversation();
  const first = before.entries[0];
  if (first === undefined) throw new Error('missing migration fixture');
  const {
    conversation: _conversation,
    conversationCount: _count,
    conversationLastAt: _last,
    stage: _stage,
    stages: _stages,
    ...base
  } = first.item;
  const item: AgendaItem = {
    ...base,
    body: 'b'.repeat(200_000),
    detail: 'd'.repeat(200_000),
    history: Array.from({ length: 8 }, (_, index) => ({ at: T(index), kind: 'replied', note: 'r'.repeat(64_000) })),
    revisions: [{ at: T(1), by: 'agent', changed: ['body'], previous: { body: 'v' } }],
  };
  const previousBody = 'v'.repeat(1 + 999_999 - JSON.stringify(item).length);
  const original = {
    ...item,
    revisions: [{ at: T(1), by: 'agent', changed: ['body'], previous: { body: previousBody } }],
  } as AgendaItem;
  should(AgendaItemSchema.safeParse(original).success).be.true();
  const legacy = {
    ...before,
    conversations: undefined,
    entries: [{ ...before.entries[0], item: original }],
  } as AgendaLedger;

  // Act
  const migrated = toChannel(legacy, true);
  const reread = parseAgendaLedger(JSON.parse(agendaLedgerDocument(migrated)), SESSION_ID);

  // Assert
  should(AgendaItemSchema.safeParse(migrated.entries[0]?.item).success).be.true();
  should(migrated.carriedEntries?.A1?.item.revisions?.[0]?.previous.body).equal(previousBody);
  should(reread?.carriedEntries?.A1?.item).deepEqual(original);
  should(toChannel(migrated, true)).equal(migrated);
});

it('projects every legacy discussion path and orphaned textual answer into the thread', () => {
  const before = beforeConversation();
  const item = {
    ...before.entries[0]?.item,
    conversation: undefined,
    questionAnswer: 'Ferret answer',
    history: [
      { at: T(1), kind: 'needs-info', note: 'More details' },
      { at: T(2), kind: 'discuss', note: 'Talk it through' },
      { at: T(3), kind: 'surfaced', note: 'Needs a decision' },
      { at: T(4), kind: 'updated', note: 'working: checking regions' },
      { at: T(5), kind: 'gate-answered', note: 'gate:F12' },
    ],
    ownerAnswer: {
      at: T(6),
      response: { kind: 'open-question', answer: 'Owner answer' },
      request: 1,
      note: 'Owner note',
    },
    resolvedAt: T(7),
    resolvedBy: 'human',
    resolvedBySession: null,
    resolvedByName: null,
    response: { kind: 'open-question', answer: 'Closed answer' },
    resolutionNote: 'Closed note',
    disposition: 'done',
  } as Parameters<typeof seedConversation>[0];
  should(seedConversation(item).map(entry => entry.text)).deepEqual([
    'More details',
    'Talk it through',
    'Needs a decision',
    'checking regions',
    'Ferret answer',
    'Owner answer',
    'Owner note',
    'Closed answer',
    'Closed note',
  ]);
});

it('rejects an invalid migration archive without replacing the durable ledger', async () => {
  const { parseAgendaLedger } = await import('../../../src/lib/agenda/state-machine.ts');
  should(parseAgendaLedger({ ...beforeConversation(), carriedEntries: [] }, SESSION_ID)).equal(null);
});

it('seeds owner records archived by the base migration before the bounded live history, without duplicating them on reread', async () => {
  // Arrange
  const { agendaLedgerDocument, parseAgendaLedger } = await import('../../../src/lib/agenda/state-machine.ts');
  const before = beforeConversation();
  const answer = 'Archived owner answer';
  const legacy: AgendaLedger = {
    ...before,
    conversations: undefined,
    archivePending: [
      {
        kind: 'owner-history',
        id: 'A1',
        entry: { at: T(1), kind: 'replied', response: { kind: 'open-question', answer }, note: 'Archived note' },
      },
    ],
    entries: before.entries.map(
      entry =>
        ({
          ...entry,
          item: {
            ...entry.item,
            conversation: undefined,
            conversationCount: undefined,
            history: [{ at: T(2), kind: 'updated' as const, note: 'working: checking eu' }],
          },
        }) as typeof entry,
    ),
  };

  // Act
  const migrated = toChannel(legacy, true);
  const reread = parseAgendaLedger(JSON.parse(agendaLedgerDocument(migrated)), SESSION_ID);

  // Assert
  should(migrated.conversations?.A1?.map(entry => entry.text)).deepEqual([answer, 'Archived note', 'checking eu']);
  should(reread?.conversations).deepEqual(migrated.conversations);
  should(reread?.archivePending).deepEqual(legacy.archivePending);
});
