import { describe, it } from 'bun:test';
import {
  type AgendaCardAsk,
  type AgendaGate,
  type AgendaItem,
  agendaState,
  cardAgendaReference,
  cardAskReference,
  gateReference,
  MAX_AGENDA_CARD_ASKS,
} from '@ferretry/protocol';
import should from 'should';
import { joinCardAsks, leaveCardAsks, sealCardAsks, withoutCardAsks } from '../../../src/lib/agenda/card-asks.ts';
import {
  type AgendaActor,
  type AgendaLedger,
  type AgendaMutation,
  applyAgendaCommand,
  applyAgendaCommandToSession,
  type RaiseAgendaRequest,
} from '../../../src/lib/agenda/state-machine.ts';

/**
 * CARD ASKS ACROSS MERGE AND SPLIT (docs/agenda.md § Merge and split): a merge keeps every card ask of both items, once
 * per card and entry; a split with `moveCards` takes a moved card's asks to the new item. The pure half first, then
 * through the real state machine.
 */

const START = Date.parse('2026-11-03T10:00:00Z');
const minute = (offset: number): string => new Date(START + offset * 60_000).toISOString();
const SESSION = 'session-1';
const HUMAN: AgendaActor = { kind: 'human' };
const AGENT: AgendaActor = { kind: 'agent', sessionId: SESSION, name: 'Ada' };
const SYSTEM: AgendaActor = { kind: 'daemon', cause: 'system' };

const gate = (cardId: string, entry = 2): AgendaGate => ({
  cardId,
  laneId: 'tested',
  laneName: 'Ready to try',
  entry,
  projectId: 'p1',
  cardTitle: 'Badge',
  options: [
    { id: 'o0', label: 'Done', outcome: 'close' },
    { id: 'o1', label: 'Not good', outcome: 'reopen-with-agenda' },
  ],
});

const ask = (cardId: string, at: number, extra: Partial<AgendaCardAsk> = {}): AgendaCardAsk => ({
  gate: gate(cardId),
  at: minute(at),
  ...extra,
});

const answered = (cardId: string, at: number): AgendaCardAsk =>
  ask(cardId, at, {
    answer: {
      at: minute(at + 1),
      response: { kind: 'multiple-choice', choice: 'Done' },
      receipt: 'a'.repeat(64),
    },
  });

const thread = (extra: Partial<AgendaItem> = {}): AgendaItem =>
  ({
    id: 'A1',
    source: 'agent-raised',
    sourceRef: null,
    // A line that only repeats the card ask (docs/agenda.md § One ask): the card asks are all the thread asks.
    subject: 'Try it: Badge',
    title: 'Badge',
    why: 'w',
    howToResolve: 'h',
    waitingSince: minute(0),
    raisedBy: 'agent',
    raisedBySession: SESSION,
    raisedByName: 'Ada',
    ...extra,
  }) as AgendaItem;

const resting = (extra: Partial<AgendaItem> = {}): AgendaItem =>
  thread({
    waitingOn: 'ferret',
    askedAt: minute(1),
    waitingFor: 'discussion',
    resting: { sub: 'working', at: minute(1) },
    ...extra,
  });

/** The stage move the state machine lends, reduced to a marker the tests can read. */
const stage = (item: AgendaItem, to: 'test' | 'plan'): AgendaItem => ({ ...item, stage: to });

const moved = (outcome: ReturnType<typeof joinCardAsks>): AgendaItem => {
  if (outcome.kind !== 'moved') throw new Error(`expected the asks to move: ${outcome.message}`);
  return outcome.into;
};

const references = (item: AgendaItem): string[] => (item.cardAsks ?? []).map(cardAskReference);

describe('joining card asks onto an item (the pure half)', () => {
  it('keeps every ask of both, once per card and entry, in the order they were put', () => {
    // Arrange — both carry F2's entry 2: the absorbed one holds the owner's answer to it
    const into = thread({ cardAsks: [ask('F1', 1), ask('F2', 3)] });

    // Act
    const joined = moved(joinCardAsks(into, [answered('F2', 2), ask('F3', 2)], minute(10), stage));

    // Assert — one F2, the answered one; ordered by when each was put
    should(references(joined)).eql([gateReference(gate('F1')), gateReference(gate('F2')), gateReference(gate('F3'))]);
    should(joined.cardAsks?.[1]?.answer?.receipt).equal('a'.repeat(64));
    should(joined.gateAttached).eql(gate('F1'));
  });

  it('keeps the survivor’s ask on a tie, and a Not yet over an ask nobody looked at', () => {
    // Arrange
    const notYet = ask('F2', 2, { notYet: { at: minute(4) } });
    const into = thread({ cardAsks: [ask('F1', 1, { howToTest: 'mine' }), ask('F2', 1)] });

    // Act
    const joined = moved(joinCardAsks(into, [ask('F1', 0, { howToTest: 'theirs' }), notYet], minute(10), stage));

    // Assert
    should(joined.cardAsks?.find(each => each.gate.cardId === 'F1')?.howToTest).equal('mine');
    should(joined.cardAsks?.find(each => each.gate.cardId === 'F2')?.notYet).eql({ at: minute(4) });
    should(joined.cardAsks).have.length(2);
  });

  it('keeps two entries of one card apart: each is its own ask', () => {
    // Act
    const joined = moved(
      joinCardAsks(
        thread({ cardAsks: [answered('F1', 1)] }),
        [{ ...ask('F1', 5), gate: gate('F1', 7) }],
        minute(10),
        stage,
      ),
    );

    // Assert
    should(joined.cardAsks?.map(each => each.gate.entry)).eql([2, 7]);
  });

  it('leaves an item exactly as it was when nothing comes', () => {
    // Arrange
    const into = thread();

    // Act
    const outcome = joinCardAsks(into, [], minute(10), stage);

    // Assert
    should(outcome).eql({ kind: 'moved', into });
  });

  it('refuses more open asks than one agenda carries, and an item that cannot carry one', () => {
    // Arrange
    const half = Math.ceil((MAX_AGENDA_CARD_ASKS + 1) / 2);
    const mine = Array.from({ length: half }, (_, index) => ask(`F${String(index + 1)}`, index));
    const theirs = Array.from({ length: half }, (_, index) => ask(`F${String(index + 100)}`, index));

    // Act
    const full = joinCardAsks(thread({ cardAsks: mine }), theirs, minute(10), stage);
    const input = joinCardAsks(thread({ kind: 'input' }), [ask('F1', 1)], minute(10), stage);
    const notice = joinCardAsks(thread({ notice: true }), [ask('F1', 1)], minute(10), stage);

    // Assert
    should(full).match({ kind: 'refused', code: 'full' });
    should(input).match({ kind: 'refused', code: 'invalid', message: /A1 cannot carry a card's ask \(&F1\)/u });
    should(notice).match({ kind: 'refused', code: 'invalid' });
  });

  it('refuses answered asks past what one agenda carries too, and drops no answer or receipt to fit', () => {
    // Arrange — all answered: 18 would not fit, and no receipt may be the one that goes; exactly 16 fit
    const half = Math.ceil((MAX_AGENDA_CARD_ASKS + 1) / 2);
    const mine = Array.from({ length: half }, (_, index) => answered(`F${String(index + 1)}`, index));
    const theirs = Array.from({ length: half }, (_, index) => answered(`F${String(index + 100)}`, index));
    const exactly = Array.from({ length: MAX_AGENDA_CARD_ASKS - half }, (_, index) =>
      answered(`F${String(index + 200)}`, index),
    );

    // Act
    const over = joinCardAsks(thread({ cardAsks: mine }), theirs, minute(10), stage);
    const at = joinCardAsks(thread({ cardAsks: mine }), exactly, minute(10), stage);

    // Assert
    should(over).match({ kind: 'refused', code: 'full' });
    should(at).match({ kind: 'moved' });
    should(at.kind === 'moved' ? at.into.cardAsks?.filter(each => each.answer !== undefined) : []).have.length(
      MAX_AGENDA_CARD_ASKS,
    );
  });

  it('wakes an item off the owner’s turn into Needs you, at the ask’s stage, remembering the turn it ended', () => {
    // Arrange — a resting thread takes an ask still waiting on the owner
    const into = resting();
    const incoming = ask('F1', 5, { woke: { waitingSince: minute(-30) } });

    // Act
    const joined = moved(joinCardAsks(into, [incoming], minute(10), stage));

    // Assert — the ask's own turn is the survivor's, not the absorbed item's
    should(agendaState(joined).state).equal('needs-you');
    should(joined.stage).equal('test');
    should(joined.waitingSince).equal(minute(5));
    should(joined.cardAsks?.[0]?.woke).eql({
      waitingSince: minute(0),
      resting: { sub: 'working', at: minute(1) },
      waitingOn: 'ferret',
      askedAt: minute(1),
      waitingFor: 'discussion',
    });
  });

  it('leaves the state of an item already on the owner’s turn, or already asking, as it is', () => {
    // Arrange
    const onTurn = thread({ stage: 'question' });
    const asking = resting({ cardAsks: [ask('F1', 1, { woke: { waitingSince: minute(-9) } })] });
    const awake = { ...asking, waitingOn: undefined, askedAt: undefined, waitingFor: undefined, resting: undefined };

    // Act
    const first = moved(joinCardAsks(onTurn, [ask('F2', 5)], minute(10), stage));
    const second = moved(joinCardAsks(awake as AgendaItem, [ask('F2', 5)], minute(10), stage));

    // Assert — the first takes the ask's stage and keeps its place; the newcomer to the second remembers the turn the
    // first waiting ask ended, as a second ask put on would, and changes nothing else
    should(first.stage).equal('test');
    should(first.waitingSince).equal(minute(0));
    should(second.stage).be.undefined();
    should(first.cardAsks?.[0]?.woke).eql({ waitingSince: minute(0) });
    should(second.cardAsks?.map(each => each.woke)).eql([{ waitingSince: minute(-9) }, { waitingSince: minute(-9) }]);
  });

  it('takes asks onto the card’s own agenda without a turn to go back to, and answered asks without waking it', () => {
    // Arrange
    const card = resting({ raisedBy: 'daemon', source: 'task', sourceRef: cardAgendaReference('F1') });

    // Act
    const waiting = moved(
      joinCardAsks(card, [ask('F1', 5, { woke: { waitingSince: minute(-1) } })], minute(10), stage),
    );
    const quiet = moved(joinCardAsks(resting(), [answered('F1', 5)], minute(10), stage));

    // Assert
    should(waiting.cardAsks?.[0]?.woke).be.undefined();
    should(agendaState(waiting).state).equal('needs-you');
    should(agendaState(quiet).state).equal('resting');
    should(quiet.cardAsks).have.length(1);
    should(quiet.gateAttached).be.undefined();
  });
});

describe('leaving card asks behind (the pure half)', () => {
  it('leaves an item with none of the moved cards as it is', () => {
    // Arrange
    const item = thread({ cardAsks: [ask('F1', 1)] });

    // Act
    const { left, moved: gone } = leaveCardAsks(item, each => each.gate.cardId === 'F9', minute(10));

    // Assert
    should(left).equal(item);
    should(gone).be.empty();
  });

  it('puts a thread that asked nothing else back on the turn the first moved ask ended', () => {
    // Arrange — F1's ask woke a resting thread; nothing else was asked since
    const woke = {
      waitingSince: minute(-5),
      resting: { sub: 'working' as const, at: minute(-5) },
      waitingOn: 'ferret' as const,
      askedAt: minute(-5),
      waitingFor: 'discussion' as const,
    };
    const item = sealCardAsks(thread({ waitingSince: minute(1), cardAsks: [ask('F1', 1, { woke })] }));

    // Act
    const { left, moved: gone } = leaveCardAsks(item, each => each.gate.cardId === 'F1', minute(10));

    // Assert
    should(gone.map(cardAskReference)).eql([gateReference(gate('F1'))]);
    should(left.cardAsks).be.undefined();
    should(left.gateAttached).be.undefined();
    should(agendaState(left)).match({ state: 'resting', sub: 'working' });
    should(left.waitingSince).equal(minute(-5));
  });

  it('rests the card’s own agenda, and a thread whose moved ask names no turn, on its ferret', () => {
    // Arrange
    const card = thread({
      raisedBy: 'daemon',
      source: 'task',
      sourceRef: cardAgendaReference('F1'),
      waitingSince: minute(1),
      cardAsks: [ask('F1', 1)],
    });
    const old = sealCardAsks(thread({ waitingSince: minute(1), cardAsks: [ask('F1', 1)] }));

    // Act
    const fromCard = leaveCardAsks(card, () => true, minute(10)).left;
    const fromOld = leaveCardAsks(old, () => true, minute(10)).left;

    // Assert
    should(agendaState(fromCard)).match({ state: 'resting', sub: 'waiting-on-ferret' });
    should(agendaState(fromOld)).match({ state: 'resting', sub: 'waiting-on-ferret' });
  });

  it('leaves the state alone when another ask still waits, the thread asked something of its own, or it rests', () => {
    // Arrange
    const two = thread({ waitingSince: minute(1), cardAsks: [ask('F1', 1), ask('F2', 1)] });
    const own = sealCardAsks(
      thread({ subject: 'Should keyboard focus change too?', waitingSince: minute(5), cardAsks: [ask('F1', 1)] }),
    );
    const rested = resting({ cardAsks: [ask('F1', 0)] });

    // Act
    const results = [two, own, rested].map(item => leaveCardAsks(item, each => each.gate.cardId === 'F1', minute(10)));

    // Assert
    should(results.map(result => agendaState(result.left).state)).eql(['needs-you', 'needs-you', 'resting']);
    should(results[0]?.left.cardAsks?.map(cardAskReference)).eql([gateReference(gate('F2'))]);
  });

  it('strips every ask, its mirror, its stamp and the seal off an item whose asks went elsewhere', () => {
    // Arrange
    const item = thread({
      cardAsks: [ask('F1', 1)],
      gateAttached: gate('F1'),
      gateAttachedChangedAt: minute(1),
      cardAsksSeal: '0'.repeat(32),
    });

    // Act
    const bare = withoutCardAsks(item);

    // Assert
    should(bare).eql(thread());
  });
});

// —— Through the real state machine ——

const ok = (result: AgendaMutation): Extract<AgendaMutation, { ok: true }> => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result;
};

const request = (overrides: Partial<RaiseAgendaRequest> = {}): RaiseAgendaRequest => ({
  source: 'agent-raised',
  sourceRef: null,
  subject: 'Is the badge right?',
  why: 'It changed.',
  context: 'On the card.',
  premise: 'The badge changed.',
  howToResolve: 'Say what you think.',
  ask: { kind: 'open-question' },
  ...overrides,
});

const itemOf = (ledger: AgendaLedger, id: string): AgendaItem => {
  const entry = ledger.entries.find(each => each.item.id === id);
  if (entry === undefined) throw new Error(`no item ${id}`);
  return entry.item as AgendaItem;
};

const lifecycleOf = (ledger: AgendaLedger, id: string): string =>
  ledger.entries.find(each => each.item.id === id)?.lifecycle ?? 'missing';

/** Two of the ferret's threads, A1 and A2, each carrying the asks the daemon put on it. */
const twoThreads = (first: readonly AgendaGate[], second: readonly AgendaGate[], firstLine?: string): AgendaLedger => {
  let ledger = ok(
    applyAgendaCommandToSession(null, SESSION, {
      action: 'raise',
      actor: AGENT,
      request: request(firstLine === undefined ? {} : { subject: firstLine }),
      at: minute(0),
    }),
  ).ledger;
  ledger = ok(
    applyAgendaCommand(ledger, {
      action: 'raise',
      actor: AGENT,
      request: request({ subject: 'Is the menu right?' }),
      at: minute(1),
    }),
  ).ledger;
  const put = (id: 'A1' | 'A2', gates: readonly AgendaGate[], from: number) => {
    gates.forEach((each, index) => {
      ledger = ok(
        applyAgendaCommand(ledger, {
          action: 'card-ask',
          actor: SYSTEM,
          id,
          operation: { kind: 'attach', ask: { gate: each } },
          at: minute(from + index),
        }),
      ).ledger;
    });
  };
  put('A1', first, 2);
  put('A2', second, 5);
  return ledger;
};

const answer = (ledger: AgendaLedger, id: 'A1' | 'A2', of: AgendaGate, at: number): AgendaLedger =>
  ok(
    applyAgendaCommand(ledger, {
      action: 'card-ask',
      actor: SYSTEM,
      id,
      operation: {
        kind: 'answered',
        reference: gateReference(of),
        answer: { at: minute(at), response: { kind: 'multiple-choice', choice: 'Done' }, receipt: 'b'.repeat(64) },
      },
      at: minute(at),
    }),
  ).ledger;

describe('a merge carries card asks', () => {
  it('keeps every card ask of both items on the one it keeps, and the absorbed item carries none', () => {
    // Arrange
    const ledger = twoThreads([gate('F1')], [gate('F2')]);

    // Act
    const merged = ok(
      applyAgendaCommand(ledger, { action: 'merge', actor: HUMAN, id: 'A1', from: 'A2', at: minute(9) }),
    );
    const kept = itemOf(merged.ledger, 'A1');
    const closed = itemOf(merged.ledger, 'A2');

    // Assert
    should(references(kept)).eql([gateReference(gate('F1')), gateReference(gate('F2'))]);
    should(kept.gateAttached).eql(gate('F1'));
    should(agendaState(kept).state).equal('needs-you');
    should(lifecycleOf(merged.ledger, 'A2')).equal('addressed');
    should(closed.mergedInto).equal('A1');
    should(closed.cardAsks).be.undefined();
    should(closed.gateAttached).be.undefined();
  });

  it('never doubles an ask for the same card and entry: the one the owner answered is the one kept', () => {
    // Arrange — both items carry F1's entry 2, answered on A2
    const ledger = answer(twoThreads([gate('F1')], [gate('F1'), gate('F2')]), 'A2', gate('F1'), 8);

    // Act
    const merged = ok(
      applyAgendaCommand(ledger, { action: 'merge', actor: AGENT, id: 'A1', from: 'A2', at: minute(9) }),
    );
    const kept = itemOf(merged.ledger, 'A1');

    // Assert
    should(references(kept)).eql([gateReference(gate('F1')), gateReference(gate('F2'))]);
    should(kept.cardAsks?.[0]?.answer?.receipt).equal('b'.repeat(64));
    should(kept.gateAttached).eql(gate('F2'));
  });

  it('wakes a resting item that takes an ask still waiting on the owner', () => {
    // Arrange — A1 rests on its ferret and carries no ask; A2 carries F2's
    let ledger = twoThreads([], [gate('F2')]);
    ledger = ok(
      applyAgendaCommand(ledger, { action: 'rest', actor: AGENT, id: 'A1', why: 'checking', at: minute(7) }),
    ).ledger;
    should(agendaState(itemOf(ledger, 'A1')).state).equal('resting');

    // Act
    const merged = ok(
      applyAgendaCommand(ledger, { action: 'merge', actor: AGENT, id: 'A1', from: 'A2', at: minute(9) }),
    );
    const kept = itemOf(merged.ledger, 'A1');

    // Assert
    should(agendaState(kept).state).equal('needs-you');
    should(kept.stage).equal('test');
    should(kept.cardAsks?.[0]?.woke).match({ resting: { sub: 'working' } });
  });

  it('refuses a merge that would carry more asks than one agenda does, and writes nothing', () => {
    // Arrange
    const half = Math.ceil((MAX_AGENDA_CARD_ASKS + 1) / 2);
    const ledger = twoThreads(
      Array.from({ length: half }, (_, index) => gate(`F${String(index + 1)}`)),
      Array.from({ length: half }, (_, index) => gate(`F${String(index + 100)}`)),
    );

    // Act
    const result = applyAgendaCommand(ledger, { action: 'merge', actor: HUMAN, id: 'A1', from: 'A2', at: minute(30) });

    // Assert
    should(result).match({ ok: false, error: { code: 'full' } });
  });

  it('still refuses a gate item from before card asks and a notice', () => {
    // Arrange
    const ledger = twoThreads([gate('F1')], []);
    const asNotice: AgendaLedger = {
      ...ledger,
      entries: ledger.entries.map(entry =>
        entry.item.id === 'A2' ? { ...entry, item: { ...entry.item, notice: true } } : entry,
      ) as AgendaLedger['entries'],
    };
    const asGate: AgendaLedger = {
      ...ledger,
      entries: ledger.entries.map(entry =>
        entry.item.id === 'A2' ? { ...entry, item: { ...entry.item, source: 'task', gate: gate('F3') } } : entry,
      ) as AgendaLedger['entries'],
    };

    // Act
    const results = [asNotice, asGate].map(each =>
      applyAgendaCommand(each, { action: 'merge', actor: HUMAN, id: 'A1', from: 'A2', at: minute(9) }),
    );

    // Assert
    for (const result of results) should(result).match({ ok: false, error: { code: 'invalid' } });
  });
});

describe('a split carries a moved card’s asks', () => {
  it('moves the asks of the cards it moves to the new item, and the original keeps the rest', () => {
    // Arrange — A1 carries F1's and F2's asks, without holding either card otherwise
    const ledger = twoThreads([gate('F1'), gate('F2')], []);

    // Act
    const split = ok(
      applyAgendaCommand(ledger, {
        action: 'split',
        actor: AGENT,
        id: 'A1',
        request: request({ subject: 'Is F2 right on its own?' }),
        moveCards: [{ id: 'F2' }],
        at: minute(9),
      }),
    );
    const parent = itemOf(split.ledger, 'A1');
    const child = itemOf(split.ledger, 'A3');

    // Assert
    should(references(parent)).eql([gateReference(gate('F1'))]);
    should(parent.gateAttached).eql(gate('F1'));
    should(references(child)).eql([gateReference(gate('F2'))]);
    should(child.gateAttached).eql(gate('F2'));
    should(child.splitFrom).equal('A1');
    should(child.stage).equal('test');
    should(agendaState(child).state).equal('needs-you');
  });

  it('puts the original back where it was when it asked nothing but the asks that moved', () => {
    // Arrange — A1's line only repeats F1's card ask; A1 rested, then F1's ask woke it
    let ledger = twoThreads([], [], 'Try it: Badge');
    ledger = ok(
      applyAgendaCommand(ledger, { action: 'rest', actor: AGENT, id: 'A1', why: 'checking', at: minute(2) }),
    ).ledger;
    ledger = ok(
      applyAgendaCommand(ledger, {
        action: 'card-ask',
        actor: SYSTEM,
        id: 'A1',
        operation: { kind: 'attach', ask: { gate: gate('F1') } },
        at: minute(3),
      }),
    ).ledger;
    should(agendaState(itemOf(ledger, 'A1')).state).equal('needs-you');

    // Act
    const split = ok(
      applyAgendaCommand(ledger, {
        action: 'split',
        actor: AGENT,
        id: 'A1',
        request: request({ subject: 'Is F1 right on its own?' }),
        moveCards: [{ id: 'F1' }],
        at: minute(9),
      }),
    );

    // Assert
    should(agendaState(itemOf(split.ledger, 'A1')).state).equal('resting');
    should(itemOf(split.ledger, 'A1').cardAsks).be.undefined();
    should(references(itemOf(split.ledger, 'A3'))).eql([gateReference(gate('F1'))]);
  });

  it('refuses to move a card’s ask onto a new item that cannot carry it, and writes nothing', () => {
    // Arrange — the card's own agenda, raised by the daemon: a split off it is the daemon's item, not a card agenda
    const ledger = ok(
      applyAgendaCommandToSession(null, SESSION, {
        action: 'raise',
        actor: SYSTEM,
        request: request({ source: 'task', sourceRef: cardAgendaReference('F1'), task: { id: 'F1' } }),
        at: minute(0),
      }),
    ).ledger;
    const asked = ok(
      applyAgendaCommand(ledger, {
        action: 'card-ask',
        actor: SYSTEM,
        id: 'A1',
        operation: { kind: 'attach', ask: { gate: gate('F1') } },
        at: minute(1),
      }),
    ).ledger;

    // Act
    const result = applyAgendaCommand(asked, {
      action: 'split',
      actor: HUMAN,
      id: 'A1',
      request: request({ subject: 'Something else' }),
      moveCards: [{ id: 'F1' }],
      at: minute(9),
    });

    // Assert
    should(result).match({ ok: false, error: { code: 'invalid', message: /cannot carry a card's ask/u } });
  });
});
