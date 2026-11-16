import { describe, it } from 'bun:test';
import should from 'should';
import { MAX_AGENDA_DETAIL_LENGTH } from '../../daemon/lib/protocol.ts';
import {
  MAX_LISTED_ORPHANS,
  type OrphanMemory,
  type WardenBoardPort,
  type WardenBoardRead,
  type WardenFocusCard,
} from '../../daemon/lib/index.ts';
import { lanes, PROJECT } from '../support/board.ts';
import { boardOf, cardView, orphanView } from './board-fixtures.ts';
import { enabled, harness, type JevScript, journalTypes, NOW, no, session, triageable } from './sweep-harness.ts';

/**
 * The Warden reading the board, end to end through the real sweep (`board-design.md` §3.4): an orphaned card
 * is reported beside the ferrets' flags and its owner is told once, and a ferret the Warden starts again is
 * handed its focus card.
 */

const MINUTE = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

/** A board port over a board the test can change between sweeps, and the focus cards it knows. */
const boardPort = (
  initial: WardenBoardRead | undefined,
  cards: Readonly<Record<string, WardenFocusCard>> = {},
): WardenBoardPort & { set(next: WardenBoardRead | undefined): void } => {
  let current = initial;
  return {
    read: async () => current,
    focusCard: async sessionId => cards[sessionId],
    set: next => {
      current = next;
    },
  };
};

const worker = session({ id: 'worker', status: 'stopped' });
const lead = session({ id: 'lead', status: 'awaiting_user', state: { lastActivityAt: iso(NOW - MINUTE) } });

describe('an orphaned card', () => {
  it('should be reported beside the ferrets’ flags, and its live owner ferret told once', async () => {
    // Arrange
    const board = boardPort(boardOf(orphanView()));
    const subject = harness({ config: enabled(), fleet: [worker, lead], board });

    // Act
    const first = await subject.service.run({ force: false });
    const second = await subject.service.run({ force: false });

    // Assert
    should(first.anomalies.map(anomaly => anomaly.kind)).eql(['orphaned_card']);
    should(first.anomalies[0]).containDeep({ sessionId: 'worker', fleetKey: 'card:F1', task: { id: 'F1' } });
    should(second.anomalies.map(anomaly => anomaly.kind)).eql(['orphaned_card']);
    should(subject.state().lastAnomalies?.map(anomaly => anomaly.kind)).eql(['orphaned_card']);
    should(subject.remedies.map(remedy => [remedy.action, remedy.sessionId])).eql([['nudge', 'lead']]);
    should(subject.remedies[0]?.detail).containEql('Your card &F1 "Board store" has no ferret working on it');
    should(subject.state().orphans).eql({ F1: { assignee: 'worker', via: 'owner', to: 'lead', at: iso(NOW) } });
    should(journalTypes(subject).filter(type => type === 'fleet.warden_orphan_told')).have.length(1);
    should(subject.orphanItem.current).be.undefined();
  });

  it('should never be put to Jev or an investigation, nor hold the ferrets’ fingerprint', async () => {
    // Arrange
    const subject = harness({
      config: enabled({ layers: { jev: true, llm: true } }),
      fleet: [worker, lead],
      board: boardPort(boardOf(orphanView())),
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.spawns).be.empty();
    should(subject.guarded).be.empty();
    should(subject.raises).be.empty();
    should(subject.state().lastFingerprint).equal('');
  });

  it('should be listed on the machine item when no owner ferret is alive — and the item closes once a ferret is back', async () => {
    // Arrange
    const board = boardPort(boardOf(orphanView()));
    const subject = harness({ config: enabled(), fleet: [worker], board });

    // Act
    await subject.service.run({ force: false });
    const listed = subject.orphanItem.current;
    board.set(boardOf(cardView({ assignee: 'worker' }, { activity: 'active' })));
    await subject.service.run({ force: false });

    // Assert
    should(listed?.subject).equal('A card has nobody working on it');
    should(listed?.context).containEql('&F1 Board store is waiting in Implement');
    should(subject.orphanItem.current).be.undefined();
    should(subject.orphanItem.writes).equal(2);
    should(subject.state()).not.have.property('orphans');
    should(subject.resolved).be.empty();
  });

  it('should be shown but told to nobody while the Warden is off', async () => {
    // Arrange
    const subject = harness({
      config: enabled({ enabled: false }),
      fleet: [worker, lead],
      board: boardPort(boardOf(orphanView())),
    });

    // Act
    const run = await subject.service.run({ force: false });

    // Assert
    should(run.anomalies.map(anomaly => anomaly.kind)).eql(['orphaned_card']);
    should(subject.remedies).be.empty();
    should(subject.orphanItem.current).be.undefined();
  });

  it('should keep what it told and touch no item while the board cannot be read, saying so', async () => {
    // Arrange
    const told: OrphanMemory = { F1: { assignee: 'worker', via: 'list', to: 'machine-agenda', at: iso(NOW - MINUTE) } };
    const subject = harness({
      config: enabled(),
      fleet: [worker],
      state: { orphans: told },
      board: boardPort(undefined),
    });

    // Act
    const run = await subject.service.run({ force: false });

    // Assert
    should(run.anomalies).be.empty();
    should(subject.resolved).be.empty();
    should(subject.orphanItem.syncs).equal(0);
    should(subject.state().orphans).eql(told);
    should(journalTypes(subject)).containEql('fleet.warden_board_blind');
  });

  it('should put a message it could not type on the list instead, and not type it again', async () => {
    // Arrange — the message was refused by a composer the reader could not place. Not remembered, it was
    // typed again every sweep: nine messages every two minutes, crowding out the owner's own message.
    const subject = harness({
      config: enabled(),
      fleet: [worker, lead],
      board: boardPort(boardOf(orphanView())),
      remedyFails: 'nudge',
    });

    // Act
    await subject.service.run({ force: false });
    await subject.service.run({ force: false });

    // Assert
    should(subject.orphanItem.current?.subject).equal('A card has nobody working on it');
    should(subject.orphanItem.opened).equal(1);
    should(subject.state().orphans?.F1).containEql({ via: 'list', to: 'machine-agenda' });
    should(journalTypes(subject)).not.containEql('fleet.warden_orphan_failed');
  });

  it('should never type into an interactive owner’s chat: the card is listed', async () => {
    // Arrange
    const chat = session({ id: 'lead', status: 'running', mode: 'interactive' });
    const subject = harness({ config: enabled(), fleet: [worker, chat], board: boardPort(boardOf(orphanView())) });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.remedies).be.empty();
    should(subject.orphanItem.current?.context).containEql('&F1');
    should(subject.state().orphans?.F1).containEql({ via: 'list' });
  });

  it('should list a card even when no ferret on this machine can be told', async () => {
    // Arrange
    const subject = harness({ config: enabled(), fleet: [], board: boardPort(boardOf(orphanView())) });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.orphanItem.current?.context).containEql('&F1');
  });
});

/** `count` cards, each left by a ferret of its own among `ferrets`, none with a live owner: a roster of finished ferrets. */
const orphans = (count: number, ferrets: number, from = 1): WardenBoardRead =>
  boardOf(
    ...Array.from({ length: count }, (_, index) =>
      orphanView({ id: `F${String(from + index)}`, owner: 'gone', assignee: `w${String(index % ferrets)}` }),
    ),
  );

const finished = (ferrets: number) =>
  Array.from({ length: ferrets }, (_, index) => session({ id: `w${String(index)}`, status: 'stopped' }));

describe('orphaned cards on the one machine item', () => {
  it('should be ONE item for 31 cards of several ferrets and sessions, showing the first dozen and "+M more"', async () => {
    // Arrange — the 31 cards that were all refused as one board's twenty-first item.
    const subject = harness({ config: enabled(), fleet: finished(4), board: boardPort(orphans(31, 4)) });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.orphanItem.opened).equal(1);
    should(subject.orphanItem.current?.subject).equal('31 cards have nobody working on them');
    const rows = subject.orphanItem.current?.context.split('\n') ?? [];
    should(rows).have.length(MAX_LISTED_ORPHANS + 1);
    should(rows.at(-1)).equal('…and 19 more.');
    should(Object.keys(subject.state().orphans ?? {})).have.length(31);
    should(subject.raises).be.empty();
    should(journalTypes(subject)).not.containEql('fleet.warden_orphan_failed');
  });

  it('should say the same list on every sweep without writing the board again', async () => {
    // Arrange
    const subject = harness({ config: enabled(), fleet: finished(3), board: boardPort(orphans(31, 3)) });

    // Act
    for (let sweep = 0; sweep < 6; sweep += 1) await subject.service.run({ force: false });

    // Assert
    should(subject.orphanItem.syncs).equal(6);
    should(subject.orphanItem.writes).equal(1);
    should(subject.orphanItem.opened).equal(1);
  });

  it('should update the SAME item when the list changes: one card added, one recovered', async () => {
    // Arrange
    const board = boardPort(orphans(3, 3));
    const subject = harness({ config: enabled(), fleet: finished(4), board });
    await subject.service.run({ force: false });
    const before = subject.orphanItem.current;

    // Act — F1 recovers, F4 is orphaned.
    board.set(
      boardOf(
        cardView({ id: 'F1', assignee: 'w0' }, { activity: 'active' }),
        ...orphans(3, 3).views.slice(1),
        orphanView({ id: 'F4', owner: 'gone', assignee: 'w3' }),
      ),
    );
    await subject.service.run({ force: false });

    // Assert
    should(subject.orphanItem.opened).equal(1);
    should(subject.orphanItem.writes).equal(2);
    should(before?.context).containEql('&F1');
    should(subject.orphanItem.current?.subject).equal('3 cards have nobody working on them');
    should(subject.orphanItem.current?.context).not.containEql('&F1 ');
    should(subject.orphanItem.current?.context).containEql('&F4');
  });

  it('should CLEAR the item when every card recovered, and open a NEW one when cards are orphaned again', async () => {
    // Arrange
    const board = boardPort(orphans(2, 2));
    const subject = harness({ config: enabled(), fleet: finished(2), board });
    await subject.service.run({ force: false });

    // Act
    board.set(boardOf(cardView({ id: 'F1', assignee: 'w0' }, { activity: 'active' })));
    await subject.service.run({ force: false });
    const cleared = subject.orphanItem.current;
    board.set(orphans(1, 2, 7));
    await subject.service.run({ force: false });

    // Assert
    should(cleared).be.undefined();
    should(subject.orphanItem.opened).equal(2);
    should(subject.orphanItem.current?.subject).equal('A card has nobody working on it');
    should(subject.orphanItem.current?.context).containEql('&F7');
  });

  it('should stay closed once the owner closed it ("Got it"), until a card joins the list', async () => {
    // Arrange
    const board = boardPort(orphans(3, 3));
    const subject = harness({ config: enabled(), fleet: finished(4), board });
    await subject.service.run({ force: false });

    // Act — the owner closes the item; the same three cards stay orphaned for many sweeps.
    const subjectNow = (): string | undefined => subject.orphanItem.current?.subject;
    subject.orphanItem.current = undefined;
    for (let sweep = 0; sweep < 4; sweep += 1) await subject.service.run({ force: false });
    const quiet = { opened: subject.orphanItem.opened, current: subject.orphanItem.current };
    board.set(boardOf(...orphans(3, 3).views, orphanView({ id: 'F4', owner: 'gone', assignee: 'w3' })));
    await subject.service.run({ force: false });

    // Assert
    should(quiet).eql({ opened: 1, current: undefined });
    should(subject.orphanItem.opened).equal(2);
    should(subjectNow()).equal('4 cards have nobody working on them');
    // The sweep wrote the item twice: when it first opened, and when a card joined after the owner closed it.
    should(subject.orphanItem.writes).equal(2);
  });

  it('should keep the body bounded for 10,000 orphans', async () => {
    // Arrange
    const subject = harness({ config: enabled(), fleet: finished(5), board: boardPort(orphans(10_000, 5)) });

    // Act
    await subject.service.run({ force: false });

    // Assert
    const body = subject.orphanItem.current?.context ?? '';
    should(subject.orphanItem.current?.subject).equal('10000 cards have nobody working on them');
    should(body.split('\n')).have.length(MAX_LISTED_ORPHANS + 1);
    should(body.endsWith('…and 9988 more.')).be.true();
    should(body.length <= MAX_AGENDA_DETAIL_LENGTH).be.true();
  });

  it('should close the per-card asks an earlier Warden left on ferret boards, once, on the first sweep', async () => {
    // Arrange — F1 and F2 were told by an ask each, on the boards of `w0` and `w1`.
    const earlier: OrphanMemory = {
      F1: { assignee: 'w0', via: 'notice', to: 'w0', at: iso(NOW - 10 * MINUTE) },
      F2: { assignee: 'w1', via: 'notice', to: 'w1', at: iso(NOW - 10 * MINUTE) },
    };
    const subject = harness({
      config: enabled(),
      fleet: finished(2),
      state: { orphans: earlier },
      board: boardPort(orphans(2, 2)),
    });

    // Act
    await subject.service.run({ force: false });
    const closed = subject.resolved.map(entry => [entry.sessionId, entry.sourceRef]);
    await subject.service.run({ force: false });

    // Assert
    should(closed).eql([
      ['w0', 'warden-orphan:F1'],
      ['w1', 'warden-orphan:F2'],
    ]);
    should(subject.resolved).have.length(2);
    should(journalTypes(subject).filter(type => type === 'fleet.warden_orphan_cleared')).have.length(2);
    should(subject.orphanItem.current?.subject).equal('2 cards have nobody working on them');
    should(subject.state().orphans?.F1).containEql({ via: 'list', to: 'machine-agenda' });
    should(subject.state().orphans?.F2).containEql({ via: 'list', to: 'machine-agenda' });
  });

  it('should say nothing cleared, and still list the card, when the Agenda refuses to close the earlier ask', async () => {
    // Arrange
    const earlier: OrphanMemory = { F1: { assignee: 'w0', via: 'notice', to: 'w0', at: iso(NOW - 10 * MINUTE) } };
    const subject = harness({
      config: enabled(),
      fleet: finished(1),
      state: { orphans: earlier },
      board: boardPort(orphans(1, 1)),
      removeFails: true,
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(journalTypes(subject)).not.containEql('fleet.warden_orphan_cleared');
    should(subject.orphanItem.current?.context).containEql('&F1');
  });

  it('should drop a recovered card’s earlier per-card ask with it', async () => {
    // Arrange
    const earlier: OrphanMemory = { F1: { assignee: 'w0', via: 'notice', to: 'w0', at: iso(NOW - 10 * MINUTE) } };
    const subject = harness({
      config: enabled(),
      fleet: finished(1),
      state: { orphans: earlier },
      board: boardPort(boardOf(cardView({ id: 'F1', assignee: 'w0' }, { activity: 'active' }))),
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.resolved.map(entry => [entry.sessionId, entry.sourceRef])).eql([['w0', 'warden-orphan:F1']]);
    should(subject.state()).not.have.property('orphans');
    should(subject.orphanItem.current).be.undefined();
  });
});

describe('the orphaned cards item the Agenda refuses', () => {
  it('should be tried again next sweep — one attempt of one item, never one per card — and said once per reason', async () => {
    // Arrange — 31 cards, the machine board refuses the one item.
    let reason: string | undefined = 'this session already has 20 unresolved items';
    const subject = harness({
      config: enabled(),
      fleet: finished(3),
      board: boardPort(orphans(31, 3)),
      itemRefusal: () => reason,
    });

    // Act
    for (let sweep = 0; sweep < 4; sweep += 1) await subject.service.run({ force: false });
    reason = 'the Agenda could not be written';
    await subject.service.run({ force: false });
    const refused = subject.journal.filter(entry => entry.type === 'fleet.warden_orphan_failed');
    // Not remembered as told while the item has not landed: every card is still news when it does.
    const rememberedWhileRefused = subject.state().orphans;
    reason = undefined;
    await subject.service.run({ force: false });
    await subject.service.run({ force: false });

    // Assert
    should(subject.orphanItem.syncs).equal(7);
    should(refused.map(entry => entry.data.reason)).eql([
      'this session already has 20 unresolved items',
      'the Agenda could not be written',
    ]);
    should(refused[0]?.data.cards).equal(31);
    should(subject.journal.filter(entry => entry.type === 'fleet.warden_orphan_failed')).have.length(2);
    should(subject.orphanItem.current?.subject).equal('31 cards have nobody working on them');
    should(subject.orphanItem.opened).equal(1);
    should(rememberedWhileRefused).be.undefined();
    should(Object.keys(subject.state().orphans ?? {})).have.length(31);
  });
});

describe('a ferret the Warden starts again', () => {
  const card: WardenFocusCard = { task: cardView({ title: 'Ship the thing' }), laneSet: lanes(PROJECT) };
  /**
   * Jev's answers that walk the tree to the act: a ferret parked on its quota did not finish on purpose
   * (resume); a running one, silent, waits on nothing real (restart).
   */
  const jev = (act: 'resume' | 'restart', confidence: number): JevScript =>
    act === 'resume'
      ? { answers: { finished_on_purpose: no(confidence) } }
      : { answers: { waiting_on_real: no(confidence) } };
  const config = enabled({
    layers: { jev: true, llm: true },
    mayActAlone: { ...enabled().mayActAlone, resume: true, restart: true },
  });

  it('should be resumed onto its focus card', async () => {
    // Arrange
    const subject = harness({
      config,
      fleet: [triageable('q1')],
      guard: [jev('resume', 0.95)],
      board: boardPort(boardOf(), { q1: card }),
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.remedies.map(remedy => remedy.action)).eql(['resume']);
    should(subject.remedies[0]?.detail).containEql("Ferretry's Warden resumed you:");
    should(subject.remedies[0]?.detail).containEql('Your card: &F1 — Ship the thing');
  });

  it('should be restarted onto its focus card', async () => {
    // Arrange
    const stuck = session({
      id: 's1',
      status: 'running',
      state: {
        turn: 4,
        turnState: 'working',
        startedAt: iso(NOW - 86_400_000),
        lastSubprocessAt: iso(NOW - 5_000),
        subprocessSince: iso(NOW - 20 * MINUTE),
        subprocessKey: 'pid:40',
      },
    });
    const subject = harness({
      config,
      fleet: [stuck],
      guard: [jev('restart', 0.99)],
      board: boardPort(boardOf(), { s1: card }),
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.remedies.map(remedy => remedy.action)).eql(['restart']);
    should(subject.remedies[0]?.detail).containEql("Ferretry's Warden restarted you with your conversation intact:");
    should(subject.remedies[0]?.detail).containEql('Your card: &F1 — Ship the thing');
  });

  it('should keep the resume domain’s own turn for a ferret with no card, and for an interactive one', async () => {
    // Arrange
    const none = harness({
      config,
      fleet: [triageable('q1')],
      guard: [jev('resume', 0.95)],
      board: boardPort(boardOf()),
    });
    const unreadable = harness({
      config,
      fleet: [triageable('q1')],
      guard: [jev('resume', 0.95)],
      board: { read: async () => boardOf(), focusCard: async () => await Promise.reject(new Error('unreadable')) },
    });
    const human = triageable('q1');
    const interactive = harness({
      config,
      fleet: [{ ...human, config: { ...human.config, mode: 'interactive' } }],
      guard: [jev('resume', 0.95)],
      board: boardPort(boardOf(), { q1: card }),
    });

    // Act
    await none.service.run({ force: false });
    await unreadable.service.run({ force: false });
    await interactive.service.run({ force: false });

    // Assert
    should(none.remedies).eql([{ action: 'resume', sessionId: 'q1', detail: '' }]);
    should(unreadable.remedies).eql([{ action: 'resume', sessionId: 'q1', detail: '' }]);
    should(interactive.remedies).eql([]);
  });
});
