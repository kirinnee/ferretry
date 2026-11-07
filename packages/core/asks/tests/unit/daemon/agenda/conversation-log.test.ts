import { describe, it } from 'bun:test';
import type { AgendaId, AgendaItem } from '../../../../daemon/lib/protocol/agenda.ts';
import { MAX_AGENDA_BODY_LENGTH } from '../../../../daemon/lib/protocol/agenda.ts';
import should from 'should';
import {
  type AgendaActor,
  type AgendaCommand,
  type AgendaLedger,
  type AgendaMutation,
  applyAgendaCommand,
  applyAgendaCommandToSession,
  type RaiseAgendaRequest,
} from '../../../../daemon/lib/agenda/state-machine.ts';
import { versionDrafts } from '../../../../daemon/lib/agenda/versions.ts';

const SESSION_ID = 'session-1';
const T = (minute: number): string => `2026-07-30T10:${String(minute).padStart(2, '0')}:00Z`;
const HUMAN: AgendaActor = { kind: 'human' };
const AGENT: AgendaActor = { kind: 'agent', sessionId: SESSION_ID, name: 'Ada' };
const DAEMON: AgendaActor = { kind: 'daemon', cause: 'source-reconciliation' };

const request = (overrides: Partial<RaiseAgendaRequest> = {}): RaiseAgendaRequest => ({
  source: 'agent-raised',
  sourceRef: null,
  subject: 'Which region do we deploy to?',
  why: 'The release waits on the region.',
  context: 'The deploy changes the public service.',
  premise: 'A release is ready to go out.',
  howToResolve: 'Answer in words.',
  ask: { kind: 'open-question' },
  ...overrides,
});

const ok = (result: AgendaMutation): Extract<AgendaMutation, { ok: true }> => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result;
};

const bad = (result: AgendaMutation): Extract<AgendaMutation, { ok: false }> => {
  should(result.ok).be.false();
  if (result.ok) throw new Error('expected a refusal');
  return result;
};

const raise = (ledger: AgendaLedger | null, overrides: Partial<RaiseAgendaRequest> = {}, at = T(0)) =>
  ok(
    applyAgendaCommandToSession(ledger, SESSION_ID, { action: 'raise', actor: AGENT, request: request(overrides), at }),
  );

const run = (ledger: AgendaLedger, command: AgendaCommand) => ok(applyAgendaCommand(ledger, command));

const itemOf = (ledger: AgendaLedger, id: AgendaId): AgendaItem => {
  const entry = ledger.entries.find(each => each.item.id === id);
  if (entry === undefined) throw new Error(`no item ${id}`);
  return entry.item as AgendaItem;
};

const lifecycleOf = (ledger: AgendaLedger, id: AgendaId): string =>
  ledger.entries.find(each => each.item.id === id)?.lifecycle ?? 'missing';

describe('Agenda conversation', () => {
  it('should keep a long report whole and every reply in order (DoD 8)', () => {
    // Arrange
    const report = `${'a long report line\n'.repeat(9_000)}END`;
    let ledger = raise(null).ledger;
    ledger = run(ledger, { action: 'reply', actor: HUMAN, id: 'A1', note: 'first thing', at: T(1) }).ledger;
    ledger = run(ledger, {
      action: 'edit',
      actor: AGENT,
      id: 'A1',
      patch: { questionAnswer: report },
      at: T(2),
    }).ledger;
    ledger = run(ledger, { action: 'reply', actor: HUMAN, id: 'A1', note: 'second thing', at: T(3) }).ledger;
    ledger = run(ledger, { action: 'reply', actor: HUMAN, id: 'A1', note: 'third thing', at: T(4) }).ledger;

    // Act
    const conversation = ledger.conversations?.A1 ?? [];

    // Assert
    should(report.length).be.below(MAX_AGENDA_BODY_LENGTH);
    should(conversation.map(entry => [entry.by, entry.text.length > 100 ? 'report' : entry.text])).deepEqual([
      ['owner', 'first thing'],
      ['ferret', 'report'],
      ['owner', 'second thing'],
      ['owner', 'third thing'],
    ]);
    should(conversation[1]?.text.endsWith('END')).be.true();
    should(conversation.map(entry => entry.at)).deepEqual([T(1), T(2), T(3), T(4)]);
  });

  it('should log a chat exchange verbatim, tagged from chat, and move state like a reply (DoD 16)', () => {
    // Arrange
    const ledger = raise(null).ledger;
    const chat = { messageId: 'm-7', at: T(5), text: 'Use  eu-west-1,\n  please — not us-east!' };

    // Act
    const logged = run(ledger, {
      action: 'log',
      actor: AGENT,
      id: 'A1',
      mode: 'reply',
      words: 'Understood: eu-west-1.',
      chat,
      at: T(6),
    });
    const item = itemOf(logged.ledger, 'A1');

    // Assert
    should(logged.change).equal('logged');
    should(item.conversation?.map(entry => ({ by: entry.by, text: entry.text, via: entry.via }))).deepEqual([
      { by: 'owner', text: chat.text, via: 'chat-log' },
      { by: 'ferret', text: 'Understood: eu-west-1.', via: 'question-answer' },
    ]);
    should(item.conversation?.[0]?.fromChat).deepEqual({ messageId: 'm-7', at: T(5) });
    should(item.conversation?.[1]?.fromChat).be.undefined();
    should(item.questionAnswer).equal('Understood: eu-west-1.');
    should(item.resting).be.undefined();
  });

  it('should rest the item when the ferret logs the chat with --rest', () => {
    // Arrange
    const ledger = raise(null).ledger;

    // Act
    const logged = run(ledger, {
      action: 'log',
      actor: AGENT,
      id: 'A1',
      mode: 'rest',
      words: 'checking the regions',
      chat: { messageId: 'm-1', at: T(2), text: 'eu-west-1' },
      at: T(3),
    });
    const item = itemOf(logged.ledger, 'A1');

    // Assert
    should(item.resting).be.ok();
    should(item.conversation?.map(entry => [entry.by, entry.via, entry.text])).deepEqual([
      ['owner', 'chat-log', 'eu-west-1'],
      ['ferret', 'rest', 'checking the regions'],
    ]);
  });

  it('should refuse a message that is already logged, a daemon caller, and blank words', () => {
    // Arrange
    const ledger = raise(null).ledger;
    const log = (actor: AgendaActor, words: string, messageId: string) =>
      applyAgendaCommand(ledger, {
        action: 'log',
        actor,
        id: 'A1',
        mode: 'reply',
        words,
        chat: { messageId, at: T(2), text: 'eu-west-1' },
        at: T(3),
      });
    const first = ok(log(AGENT, 'ok', 'm-1'));

    // Act
    const again = bad(
      applyAgendaCommand(first.ledger, {
        action: 'log',
        actor: AGENT,
        id: 'A1',
        mode: 'reply',
        words: 'ok again',
        chat: { messageId: 'm-1', at: T(2), text: 'eu-west-1' },
        at: T(4),
      }),
    );
    const daemon = bad(log(DAEMON, 'ok', 'm-2'));
    const blank = bad(log(AGENT, '   ', 'm-3'));

    // Assert
    should(again.error.code).equal('invalid');
    should(daemon.ok).be.false();
    should(blank.ok).be.false();
    should(itemOf(first.ledger, 'A1').conversation).have.length(2);
  });

  it('should tag a chat reply with its message and log a message only once', () => {
    // Arrange
    const ledger = raise(null).ledger;
    const fromChat = { messageId: 'm-9', at: T(2) };

    // Act
    const replied = run(ledger, { action: 'reply', actor: HUMAN, id: 'A1', note: 'eu-west-1', fromChat, at: T(2) });
    const twice = run(replied.ledger, {
      action: 'reply',
      actor: HUMAN,
      id: 'A1',
      note: 'eu-west-1',
      fromChat,
      at: T(2),
    });
    const logged = applyAgendaCommand(replied.ledger, {
      action: 'log',
      actor: AGENT,
      id: 'A1',
      mode: 'reply',
      words: 'ok',
      chat: { ...fromChat, text: 'eu-west-1' },
      at: T(3),
    });

    // Assert
    should(itemOf(replied.ledger, 'A1').conversation?.map(entry => entry.fromChat?.messageId)).deepEqual(['m-9']);
    should(itemOf(twice.ledger, 'A1').conversation).have.length(1);
    should(logged.ok).be.false();
  });
});

describe('Agenda merge', () => {
  const twoItems = (): AgendaLedger => {
    let ledger = raise(null, {
      subject: 'Which region?',
      task: { id: 'F12' },
      links: [{ target: 'https://example.test/a' }],
    }).ledger;
    ledger = raise(
      ledger,
      { subject: 'Region again?', task: { id: 'F13' }, links: [{ target: 'https://example.test/b' }] },
      T(1),
    ).ledger;
    ledger = run(ledger, { action: 'reply', actor: HUMAN, id: 'A1', note: 'one-a', at: T(2) }).ledger;
    ledger = run(ledger, { action: 'reply', actor: HUMAN, id: 'A2', note: 'two-a', at: T(3) }).ledger;
    ledger = run(ledger, { action: 'reply', actor: HUMAN, id: 'A1', note: 'one-b', at: T(4) }).ledger;
    return ledger;
  };

  it('should keep both conversations by time and every card, and close the absorbed item as merged (DoD 10)', () => {
    // Arrange
    const ledger = twoItems();

    // Act
    const merged = run(ledger, { action: 'merge', actor: HUMAN, id: 'A1', from: 'A2', at: T(10) });
    const kept = itemOf(merged.ledger, 'A1');
    const closed = itemOf(merged.ledger, 'A2');

    // Assert
    should(merged.change).equal('merged');
    should(kept.conversation?.map(entry => entry.text)).deepEqual(['one-a', 'two-a', 'one-b']);
    should(kept.mergedFrom).deepEqual(['A2']);
    should([kept.task?.id, ...(kept.relatedTasks ?? []).map(card => card.id)].sort()).deepEqual(['F12', 'F13']);
    should(kept.links?.map(link => link.target)).containEql('https://example.test/a');
    should(kept.links?.map(link => link.target)).containEql('https://example.test/b');
    should(lifecycleOf(merged.ledger, 'A2')).equal('addressed');
    should(closed.mergedInto).equal('A1');
    should(JSON.stringify(closed)).containEql('merged into !A1');
    should(closed.conversation?.map(entry => entry.text)).containEql('two-a');
  });

  it('should refuse merging an item into itself, into a closed item, or a closed item, and a daemon caller', () => {
    // Arrange
    const ledger = twoItems();
    const merged = run(ledger, { action: 'merge', actor: HUMAN, id: 'A1', from: 'A2', at: T(10) });

    // Act
    const results = [
      applyAgendaCommand(ledger, { action: 'merge', actor: HUMAN, id: 'A1', from: 'A1', at: T(10) }),
      applyAgendaCommand(merged.ledger, { action: 'merge', actor: HUMAN, id: 'A2', from: 'A1', at: T(11) }),
      applyAgendaCommand(merged.ledger, { action: 'merge', actor: HUMAN, id: 'A1', from: 'A2', at: T(11) }),
      applyAgendaCommand(ledger, { action: 'merge', actor: DAEMON, id: 'A1', from: 'A2', at: T(10) }),
      applyAgendaCommand(ledger, { action: 'merge', actor: HUMAN, id: 'A1', from: 'A9', at: T(10) }),
    ];

    // Assert
    should(results.map(result => result.ok)).deepEqual([false, false, false, false, false]);
  });

  it('should make a version of each item a merge touched, and none of one it left alone', () => {
    // Arrange
    const ledger = twoItems();
    const merged = run(ledger, { action: 'merge', actor: HUMAN, id: 'A1', from: 'A2', at: T(10) });

    // Act
    const drafts = versionDrafts(ledger, merged, 'owner');

    // Assert
    should(drafts.map(draft => [draft.entry.item.id, draft.change])).deepEqual([
      ['A1', 'merged'],
      ['A2', 'merged'],
    ]);
  });
});

describe('Agenda split', () => {
  it('should raise a new item linked both ways and move the named cards to it (DoD 15)', () => {
    // Arrange
    const ledger = raise(null, { task: { id: 'F12' }, links: [{ target: 'https://example.test/a' }] }).ledger;
    const withMore: AgendaLedger = {
      ...ledger,
      entries: ledger.entries.map(entry =>
        entry.lifecycle === 'active'
          ? { ...entry, item: { ...entry.item, relatedTasks: [{ id: 'F13' }, { id: 'F14' }] } }
          : entry,
      ),
    };

    // Act
    const split = run(withMore, {
      action: 'split',
      actor: AGENT,
      id: 'A1',
      request: request({ subject: 'Which cloud account?', premise: 'Two asks grew.', context: 'Split off.' }),
      moveCards: [{ id: 'F13' }],
      at: T(2),
    });
    const parent = itemOf(split.ledger, 'A1');
    const child = itemOf(split.ledger, 'A2');

    // Assert
    should(split.change).equal('split');
    should(parent.splitInto).deepEqual(['A2']);
    should(child.splitFrom).equal('A1');
    should([parent.task?.id, ...(parent.relatedTasks ?? []).map(card => card.id)].sort()).deepEqual(['F12', 'F14']);
    should([child.task?.id, ...(child.relatedTasks ?? []).map(card => card.id)].filter(Boolean)).deepEqual(['F13']);
    should(lifecycleOf(split.ledger, 'A2')).equal('active');
    should(lifecycleOf(split.ledger, 'A1')).equal('active');
  });

  it('should move a card named without its machine when the item holds it with one', () => {
    // Arrange
    const ledger = raise(null, { task: { id: 'F12', machineId: 'machine-1' } }).ledger;

    // Act
    const split = run(ledger, {
      action: 'split',
      actor: AGENT,
      id: 'A1',
      request: request({ subject: 'Which cloud account?' }),
      moveCards: [{ id: 'F12' }],
      at: T(2),
    });

    // Assert
    should(itemOf(split.ledger, 'A2').task).deepEqual({ id: 'F12', machineId: 'machine-1' });
    should(itemOf(split.ledger, 'A1').task).be.undefined();
  });

  it('should refuse a split that moves a card the item does not hold', () => {
    // Arrange
    const ledger = raise(null, { task: { id: 'F12' } }).ledger;

    // Act
    const result = applyAgendaCommand(ledger, {
      action: 'split',
      actor: AGENT,
      id: 'A1',
      request: request({ subject: 'Another ask?' }),
      moveCards: [{ id: 'F99' }],
      at: T(2),
    });

    // Assert
    should(result.ok).be.false();
  });
});

describe('Conversation regression findings', () => {
  it('keeps multi-megabyte threads outside the item and remembers every logged id', () => {
    let ledger = raise(null, { body: 'b'.repeat(200_000), detail: 'd'.repeat(200_000) }).ledger;
    const source = `    ${'x'.repeat(200_000)}Z\n`;
    for (let index = 0; index < 7; index += 1) {
      ledger = run(ledger, {
        action: 'log',
        actor: AGENT,
        id: 'A1',
        mode: 'reply',
        words: 'OK',
        chat: { messageId: `large-${index}`, at: T(index + 1), text: source },
        at: T(index + 10),
      }).ledger;
    }
    const stored = ledger.conversations?.A1 ?? [];
    should(stored.filter(entry => entry.by === 'owner').map(entry => entry.text)).deepEqual(Array(7).fill(source));
    should(stored.filter(entry => entry.by === 'ferret')).have.length(7);
    should(itemOf(ledger, 'A1').conversationCount).equal(14);
    should(JSON.stringify(itemOf(ledger, 'A1')).length).be.below(1_000_000);
    const duplicate = applyAgendaCommand(ledger, {
      action: 'log',
      actor: AGENT,
      id: 'A1',
      mode: 'reply',
      words: 'OK',
      chat: { messageId: 'large-0', at: T(1), text: source },
      at: T(20),
    });
    should(duplicate.ok).be.false();
  });

  it('records a normal Inbox free-text answer without a note', () => {
    const ledger = raise(null).ledger;
    const answer = run(ledger, {
      action: 'answer',
      actor: HUMAN,
      id: 'A1',
      response: { kind: 'open-question', answer: 'Use eu-west, please.' },
      at: T(1),
    });
    should(answer.ledger.conversations?.A1?.map(entry => entry.text)).deepEqual(['Use eu-west, please.']);
  });

  it('keeps identical accepted replies and inserts backdated words chronologically, stable on ties', () => {
    let ledger = raise(null).ledger;
    for (const [messageId, at] of [
      ['newer', T(5)],
      ['older', T(1)],
      ['tie', T(5)],
    ] as const) {
      ledger = run(ledger, {
        action: 'log',
        actor: AGENT,
        id: 'A1',
        mode: 'reply',
        words: 'OK',
        chat: { messageId, at, text: messageId },
        at: T(9),
      }).ledger;
    }
    should(ledger.conversations?.A1?.map(entry => entry.text)).deepEqual(['older', 'newer', 'tie', 'OK', 'OK', 'OK']);
  });

  it('refuses an unstorable exchange before consuming the message id or changing state', () => {
    const ledger = raise(null).ledger;
    const command = {
      action: 'log' as const,
      actor: AGENT,
      id: 'A1',
      mode: 'reply' as const,
      words: 'a'.repeat(200_001),
      chat: { messageId: 'retry', at: T(1), text: '    untouched\n' },
      at: T(2),
    };
    should(applyAgendaCommand(ledger, command).ok).be.false();
    const retry = run(ledger, { ...command, words: 'OK' });
    should(retry.ledger.conversations?.A1?.[0]?.text).equal(command.chat.text);
    should(ledger.conversations?.A1 ?? []).have.length(0);
  });
});

it('accepts a 100k ferret answer below the own-content budget without counting its conversation copy twice', () => {
  // Arrange
  const ledger = raise(null, { body: 'b'.repeat(200_000), detail: 'd'.repeat(200_000) }).ledger;
  const text = 'a'.repeat(100_000);

  // Act
  const result = run(ledger, { action: 'edit', actor: AGENT, id: 'A1', patch: { questionAnswer: text }, at: T(1) });

  // Assert
  should(result.item?.questionAnswer).equal(text);
  should(result.ledger.conversations?.A1?.[0]?.text).equal(text);
});

it('refuses overlong rest notes and invalid source timestamps atomically', async () => {
  const { MAX_AGENDA_REST_WHY_LENGTH } = await import('../../../../daemon/lib/protocol/agenda-state.ts');
  const ledger = raise(null).ledger;
  const base = {
    action: 'log' as const,
    actor: AGENT,
    id: 'A1',
    mode: 'rest' as const,
    chat: { messageId: 'm', at: T(1), text: 'owner words' },
    at: T(2),
  };
  should(
    bad(applyAgendaCommand(ledger, { ...base, words: 'x'.repeat(MAX_AGENDA_REST_WHY_LENGTH + 1) })).error.code,
  ).equal('too-long');
  should(
    bad(applyAgendaCommand(ledger, { ...base, words: 'checking', chat: { ...base.chat, at: 'bad-time' } })).error.code,
  ).equal('invalid');
  should(ledger.conversations?.A1 ?? []).have.length(0);
});

it('refuses merging foreign items, notices and more cards than one item can carry', async () => {
  const { MAX_AGENDA_CARDS } = await import('../../../../daemon/lib/protocol/agenda.ts');
  let ledger = raise(null).ledger;
  ledger = raise(ledger, { subject: 'Which quota?' }).ledger;
  const foreign = {
    ...ledger,
    entries: ledger.entries.map(entry =>
      entry.lifecycle === 'active' && entry.item.id === 'A2'
        ? {
            ...entry,
            origin: { kind: 'agent' as const, sessionId: 'other', name: 'Bo' },
            item: { ...entry.item, raisedBy: 'agent' as const, raisedBySession: 'other', raisedByName: 'Bo' },
          }
        : entry,
    ),
  };
  const notice = {
    ...ledger,
    entries: ledger.entries.map(entry =>
      entry.lifecycle === 'active' && entry.item.id === 'A2'
        ? { ...entry, item: { ...entry.item, notice: true as const } }
        : entry,
    ),
  };
  const full = {
    ...ledger,
    entries: ledger.entries.map((entry, itemIndex) =>
      entry.lifecycle === 'active'
        ? {
            ...entry,
            item: {
              ...entry.item,
              relatedTasks: Array.from({ length: MAX_AGENDA_CARDS }, (_, index) => ({
                id: `F${itemIndex * MAX_AGENDA_CARDS + index + 1}`,
              })),
            },
          }
        : entry,
    ),
  };
  const merge = (current: AgendaLedger) =>
    applyAgendaCommand(current, { action: 'merge', actor: AGENT, id: 'A1', from: 'A2', at: T(2) });
  should(bad(merge(foreign)).error.code).equal('forbidden');
  should(bad(merge(notice)).error.code).equal('invalid');
  should(bad(merge(full)).error.code).equal('full');
});

it('refuses splitting a daemon-acted card, a foreign item and an ask that already exists', () => {
  const ledger = raise(null).ledger;
  const command = { action: 'split' as const, actor: AGENT, id: 'A1', request: request(), at: T(2) };
  should(bad(applyAgendaCommand(ledger, { ...command, actor: DAEMON })).error.code).equal('forbidden');
  const notice = {
    ...ledger,
    entries: ledger.entries.map(entry =>
      entry.lifecycle === 'active' ? { ...entry, item: { ...entry.item, notice: true as const } } : entry,
    ),
  };
  should(bad(applyAgendaCommand(notice, command)).error.code).equal('invalid');
  should(bad(applyAgendaCommand(ledger, command)).error.code).equal('invalid');
});

it('moves primary cards and inline rows together when splitting', () => {
  const ledger = raise(null, {
    kind: 'info',
    ask: undefined,
    task: { id: 'F12' },
    cards: [
      { task: { id: 'F12' }, line: 'Deploy' },
      { task: { id: 'F13' }, line: 'Check' },
    ],
  }).ledger;
  const result = run(ledger, {
    action: 'split',
    actor: AGENT,
    id: 'A1',
    request: request({ subject: 'Which quota?', kind: 'info', ask: undefined }),
    moveCards: [{ id: 'F12' }],
    at: T(2),
  });
  should(result.item?.task?.id).equal('F12');
  should(result.item?.cards?.map(row => row.task.id)).deepEqual(['F12']);
  should(itemOf(result.ledger, 'A1').cards?.map(row => row.task.id)).deepEqual(['F13']);
});

it('creates no version for a separately allocated but unchanged item', () => {
  const mutation = raise(null);
  const copied = {
    ...mutation,
    change: 'refreshed' as const,
    ledger: { ...mutation.ledger, entries: structuredClone(mutation.ledger.entries) },
  };
  should(versionDrafts(mutation.ledger, copied, 'ferret')).have.length(0);
});

it('keeps unrelated active items unchanged when another thread splits', () => {
  let ledger = raise(null).ledger;
  ledger = raise(ledger, { subject: 'Which quota?' }).ledger;
  const before = itemOf(ledger, 'A2');
  const split = run(ledger, {
    action: 'split',
    actor: AGENT,
    id: 'A1',
    request: request({ subject: 'Which cache?' }),
    at: T(3),
  });
  should(itemOf(split.ledger, 'A2')).deepEqual(before);
});

it('keeps an oversized closed item closed when delivery retry cannot safely reopen it', () => {
  const closed = run(raise(null).ledger, { action: 'dismiss', actor: HUMAN, id: 'A1', at: T(1) });
  const corrupted: AgendaLedger = {
    ...closed.ledger,
    entries: closed.ledger.entries.map(entry =>
      entry.lifecycle === 'addressed' ? { ...entry, item: { ...entry.item, body: 'x'.repeat(200_001) } } : entry,
    ),
  };
  const retry = run(corrupted, { action: 'undelivered', actor: DAEMON, id: 'A1', reason: 'delivery failed', at: T(2) });
  should(retry.changed).be.false();
  should(lifecycleOf(retry.ledger, 'A1')).equal('addressed');
});
