import { describe, it } from 'bun:test';
import type { AgendaConversationEntry, AgendaItem } from '@ferretry/protocol';
import should from 'should';
import type { RecordedItem } from '../../../src/lib/agenda/item-words.ts';
import {
  type AgendaActor,
  type AgendaCommand,
  type AgendaLedger,
  type AgendaMutation,
  agendaLedgerDocument,
  applyAgendaCommand,
  applyAgendaCommandToSession,
  parseAgendaLedger,
} from '../../../src/lib/agenda/state-machine.ts';

/**
 * THE ROUND TRIP THROUGH THE PREVIOUS RELEASE (2a): it keeps version 2 and the archive cursor and strips the stored
 * threads and every link. Coming back, the item's latest recorded version still holds the whole tagged thread, so no
 * owner word is lost, repeated or re-dated (docs/agenda.md § Downgrading).
 */

const SESSION = 'session-1';
const T = (minute: number): string => `2026-07-30T10:${String(minute).padStart(2, '0')}:00Z`;
const HUMAN: AgendaActor = { kind: 'human' };
const AGENT: AgendaActor = { kind: 'agent', sessionId: SESSION, name: 'Ada' };
const REQUEST = {
  source: 'agent-raised' as const,
  sourceRef: null,
  subject: 'Which region do we deploy to?',
  why: 'The release waits on the region.',
  context: 'The deploy changes the public service.',
  premise: 'A release is ready to go out.',
  howToResolve: 'Answer in words.',
  ask: { kind: 'open-question' as const },
};

const ok = (result: AgendaMutation): Extract<AgendaMutation, { ok: true }> => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result;
};
const run = (ledger: AgendaLedger, command: AgendaCommand): AgendaLedger =>
  ok(applyAgendaCommand(ledger, command)).ledger;
const raised = (subject = REQUEST.subject, ledger: AgendaLedger | null = null, minute = 0): AgendaLedger =>
  ok(
    applyAgendaCommandToSession(ledger, SESSION, {
      action: 'raise',
      actor: AGENT,
      request: { ...REQUEST, subject },
      at: T(minute),
    }),
  ).ledger;
const log = (ledger: AgendaLedger, id: string, messageId: string, minute: number, text: string, words: string) =>
  run(ledger, {
    action: 'log',
    actor: AGENT,
    id,
    mode: 'reply',
    words,
    chat: { messageId, at: T(minute), text },
    at: T(minute + 1),
  });

type Document = Record<string, unknown> & { entries: { item: Record<string, unknown> }[] };

/** What 2a leaves in `agenda.json` over a v4 document: version 2, the cursor kept, threads and links gone. */
function strippedBy2a(ledger: AgendaLedger, change?: (document: Document) => void): Document {
  const document = JSON.parse(agendaLedgerDocument(ledger)) as Document;
  document.version = 2;
  delete document.conversations;
  delete document.carriedEntries;
  for (const entry of document.entries) {
    for (const key of ['conversation', 'conversationCount', 'conversationLastAt', 'relatedTasks'])
      delete entry.item[key];
    for (const key of ['mergedFrom', 'mergedInto', 'splitFrom', 'splitInto']) delete entry.item[key];
  }
  change?.(document);
  return document;
}

/** What the version store holds for each item at the moment the owner downgrades: its latest version and thread. */
function recordedOf(ledger: AgendaLedger): Record<string, RecordedItem> {
  return Object.fromEntries(
    ledger.entries.map(entry => [
      entry.item.id,
      { at: ledger.updatedAt, item: entry.item, conversation: ledger.conversations?.[entry.item.id] ?? [] },
    ]),
  );
}

const texts = (thread: readonly AgendaConversationEntry[] | undefined): string[] =>
  (thread ?? []).map(entry => entry.text);
const upgraded = (document: Document, recorded?: Record<string, RecordedItem>): AgendaLedger => {
  const ledger = parseAgendaLedger(document, SESSION, [], recorded);
  if (ledger === null) throw new Error('the ledger did not parse');
  return ledger;
};
const itemOf = (ledger: AgendaLedger, id: string): AgendaItem => {
  const found = ledger.entries.find(entry => entry.item.id === id);
  if (found === undefined) throw new Error(`no ${id}`);
  return found.item as AgendaItem;
};

describe('A v4 ledger taken through 2a and back', () => {
  function conversationLedger(): AgendaLedger {
    let ledger = raised();
    ledger = log(ledger, 'A1', 'm1', 1, 'owner words one', 'ferret answer one');
    ledger = log(ledger, 'A1', 'm2', 3, 'owner words two', 'ferret answer two');
    return run(ledger, {
      action: 'reply',
      actor: HUMAN,
      id: 'A1',
      note: 'owner words three',
      fromChat: { messageId: 'm3', at: T(6) },
      at: T(6),
    });
  }

  it('should return every word once, in order, with its chat tags, and let a re-log be refused', () => {
    // Arrange
    const before = conversationLedger();
    const thread = before.conversations?.A1 ?? [];
    should(texts(thread)).containDeepOrdered(['owner words one', 'ferret answer one', 'owner words two']);

    // Act
    const back = upgraded(strippedBy2a(before), recordedOf(before));

    // Assert
    should(back.conversations?.A1).deepEqual(thread);
    should(
      (back.conversations?.A1 ?? []).flatMap(entry => (entry.fromChat === undefined ? [] : [entry.fromChat.messageId])),
    ).deepEqual(['m1', 'm2', 'm3']);
    const again = applyAgendaCommand(back, {
      action: 'log',
      actor: AGENT,
      id: 'A1',
      mode: 'reply',
      words: 'ferret answer one',
      chat: { messageId: 'm1', at: T(1), text: 'owner words one' },
      at: T(9),
    });
    should(again.ok).be.false();
  });

  it('should keep owner words said in 2a once, after the thread, and nothing twice on a later reread', () => {
    // Arrange
    const before = conversationLedger();
    const document = strippedBy2a(before, each => {
      const item = each.entries[0]?.item as { history?: unknown[] };
      item.history = [...(item.history ?? []), { at: T(20), kind: 'replied', note: 'said while on 2a' }];
    });

    // Act
    const back = upgraded(document, recordedOf(before));
    const reread = upgraded(JSON.parse(agendaLedgerDocument(back)), recordedOf(back));

    // Assert
    const thread = texts(back.conversations?.A1);
    should(thread.filter(text => text === 'said while on 2a')).have.length(1);
    should(thread.at(-1)).equal('said while on 2a');
    should(thread.slice(0, -1)).deepEqual(texts(before.conversations?.A1));
    should(reread.conversations?.A1).deepEqual(back.conversations?.A1);
  });

  it('should return chat text over the history bound verbatim', () => {
    // Arrange
    const long = `${'x'.repeat(70_000)}END`;
    const before = log(raised(), 'A1', 'm1', 1, long, 'noted');

    // Act
    const back = upgraded(strippedBy2a(before), recordedOf(before));

    // Assert
    should(back.conversations?.A1?.some(entry => entry.text === long)).be.true();
    should(back.conversations?.A1).deepEqual(before.conversations?.A1);
  });

  it('should restore merge, split and related-task links the previous release stripped', () => {
    // Arrange
    let before = raised('First');
    before = raised('Second', before, 1);
    before = run(before, { action: 'merge', actor: AGENT, id: 'A1', from: 'A2', at: T(2) });
    before = run(before, {
      action: 'split',
      actor: AGENT,
      id: 'A1',
      request: { ...REQUEST, subject: 'Child' },
      at: T(3),
    });
    const links = (ledger: AgendaLedger) =>
      ledger.entries.map(entry => {
        const { id, mergedFrom, mergedInto, splitFrom, splitInto, relatedTasks } = entry.item as AgendaItem;
        return { id, mergedFrom, mergedInto, splitFrom, splitInto, relatedTasks };
      });
    should(links(before).some(each => each.mergedInto === 'A1')).be.true();
    should(links(before).some(each => each.splitFrom === 'A1')).be.true();

    // Act
    const stripped = upgraded(strippedBy2a(before));
    const back = upgraded(strippedBy2a(before), recordedOf(before));

    // Assert
    should(links(stripped).some(each => each.mergedInto !== undefined)).be.false();
    should(links(back)).deepEqual(links(before));
  });

  it('should keep a merged item that one chat message named twice from repeating the owner words', () => {
    // Arrange
    let ledger = raised('First');
    ledger = raised('Second', ledger, 1);
    ledger = log(ledger, 'A1', 'm1', 2, 'both of these', 'noted');
    ledger = log(ledger, 'A2', 'm1', 2, 'both of these', 'noted');

    // Act
    const merged = run(ledger, { action: 'merge', actor: AGENT, id: 'A1', from: 'A2', at: T(5) });

    // Assert
    const owner = (merged.conversations?.A1 ?? []).filter(entry => entry.fromChat?.messageId === 'm1');
    should(owner).have.length(1);
  });
});

describe('Owner history shed when an old item is brought up to date', () => {
  it('should be queued for the history file, so the previous release dropping its copy loses nothing', () => {
    // Arrange: a version-2 item just under the item bound, its oldest entry an owner reply; the recent tail that
    // the new format adds to it is what pushes it over.
    const R0 = `R0 owner words that must survive ${'r'.repeat(28_000)}`;
    const document = strippedBy2a(raised());
    const item = document.entries[0]?.item as { history?: unknown[] };
    item.history = [
      { at: T(1), kind: 'replied', note: R0 },
      ...Array.from({ length: 15 }, (_, index) => ({
        at: T(2 + index),
        kind: 'replied',
        note: `${'y'.repeat(63_990)}${index}`,
      })),
      ...Array.from({ length: 4 }, (_, index) => ({
        at: T(20 + index),
        kind: 'replied',
        note: `small ${index} ${'z'.repeat(2_000)}`,
      })),
    ];
    should(JSON.stringify(document.entries[0]).length).be.within(990_000, 1_000_000);

    // Act
    const back = upgraded(document);

    // Assert: the entry left the item's history, is queued once for the sidecar, and is still in the thread.
    should(JSON.stringify(itemOf(back, 'A1').history)).not.containEql('R0 owner words');
    const queued = (back.archivePending ?? []).flatMap(record =>
      record.kind === 'owner-history' && record.entry.note === R0 ? [record] : [],
    );
    should(queued).have.length(1);
    should(back.conversations?.A1?.some(word => word.text === R0)).be.true();
  });
});

describe('A recorded version that predates the words an old item kept', () => {
  it('should not swallow the owner words its thread never held', () => {
    // Arrange: version 1 was recorded when the item was raised, so its thread is empty; the file's history is older.
    const raisedLedger = raised();
    const document = strippedBy2a(raisedLedger, each => {
      const item = each.entries[0]?.item as { history?: unknown[] };
      item.history = [
        { at: '2026-07-30T09:01:00Z', kind: 'replied', note: 'first old reply' },
        { at: '2026-07-30T09:02:00Z', kind: 'replied', note: 'second old reply' },
      ];
    });

    // Act
    const back = upgraded(document, recordedOf(raisedLedger));

    // Assert
    should(texts(back.conversations?.A1)).deepEqual(['first old reply', 'second old reply']);
  });
});

describe("The ferret's answer given on 2a", () => {
  /** What 2a leaves of an edit to the answer: the new text on the item and the revision that wrote it. */
  const answeredOn2a = (document: Document, answer: string, minute: number, history?: unknown[]): void => {
    const item = document.entries[0]?.item as { questionAnswer?: string; revisions?: unknown[]; history?: unknown[] };
    item.questionAnswer = answer;
    item.revisions = [
      ...(item.revisions ?? []),
      { at: T(minute), by: 'agent', changed: ['questionAnswer'], previous: {} },
    ];
    if (history !== undefined) item.history = [...(item.history ?? []), ...history];
  };

  it('should come back after the owner words it answers when the version held only the owner', () => {
    // Arrange: the owner replied on 4.x, so the version's thread has owner words and no ferret words.
    const before = run(raised(), { action: 'reply', actor: HUMAN, id: 'A1', note: 'q1', at: T(1) });
    should((before.conversations?.A1 ?? []).map(entry => entry.by)).deepEqual(['owner']);
    const document = strippedBy2a(before, each => answeredOn2a(each, 'ans', 5));

    // Act
    const back = upgraded(document, recordedOf(before));

    // Assert
    const thread = back.conversations?.A1 ?? [];
    should(texts(thread)).deepEqual(['q1', 'ans']);
    should(thread.at(-1)).match({ at: T(5), by: 'ferret', via: 'question-answer' });
  });

  it('should come back after the owner words it answers when the edit that dated it is gone', () => {
    // Arrange: the version holds only the owner (q1 at T1); the answer was edited in on 2a, and more than ten later
    // edits pushed that revision out, so only the item's own times are left, and the earliest is before the version.
    const before = run(raised(), { action: 'reply', actor: HUMAN, id: 'A1', note: 'q1', at: T(1) });
    const document = strippedBy2a(before, each => {
      (each.entries[0]?.item as { questionAnswer?: string }).questionAnswer = 'ans';
    });

    // Act
    const back = upgraded(document, recordedOf(before));

    // Assert
    const thread = back.conversations?.A1 ?? [];
    should(texts(thread)).deepEqual(['q1', 'ans']);
    should(thread.at(-1)).match({ at: before.updatedAt, by: 'ferret', via: 'question-answer' });
    should(upgraded(JSON.parse(agendaLedgerDocument(back)), recordedOf(back)).conversations?.A1).deepEqual(thread);
  });

  it('should keep an answer dated after the version where the version held no words at all', () => {
    // Arrange: a version with an empty thread has nothing to come after.
    const before = raised();
    const document = strippedBy2a(before, each => {
      (each.entries[0]?.item as { questionAnswer?: string }).questionAnswer = 'ans';
    });

    // Act
    const back = upgraded(document, { A1: { ...recordedOf(before).A1!, conversation: [] } });

    // Assert
    should(back.conversations?.A1?.at(-1)).match({ at: T(0), via: 'question-answer' });
  });

  it('should come back after the owner words said on 2a before it, not at the version it replaces', () => {
    // Arrange: the version holds the ferret's first answer (T2); on 2a the owner wrote q2 (T5), then the ferret a2 (T6).
    const before = log(raised(), 'A1', 'm1', 1, 'q1', 'a1');
    const document = strippedBy2a(before, each =>
      answeredOn2a(each, 'a2', 6, [{ at: T(5), kind: 'replied', note: 'q2' }]),
    );

    // Act
    const back = upgraded(document, recordedOf(before));

    // Assert
    const thread = back.conversations?.A1 ?? [];
    should(texts(thread)).deepEqual(['q1', 'a1', 'q2', 'a2']);
    should(thread.at(-1)).match({ at: T(6), by: 'ferret', via: 'question-answer' });
    should(upgraded(JSON.parse(agendaLedgerDocument(back)), recordedOf(back)).conversations?.A1).deepEqual(thread);
  });

  it('should not move an answer the version already holds, whatever its revision says', () => {
    // Arrange: nothing was said on 2a; the answer's text and its revision are the ones the version has.
    const before = log(raised(), 'A1', 'm1', 1, 'q1', 'a1');
    const document = strippedBy2a(before);

    // Act
    const back = upgraded(document, recordedOf(before));

    // Assert
    should(back.conversations?.A1).deepEqual(before.conversations?.A1);
  });
});
