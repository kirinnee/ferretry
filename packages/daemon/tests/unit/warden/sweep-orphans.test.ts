import { describe, it } from 'bun:test';
import should from 'should';
import { NUDGE_MESSAGES, TRIAGE_CRITERIA, type TriageDecision } from '../../../src/lib/speedups/jev.ts';
import type { OrphanMemory, WardenBoardPort, WardenBoardRead, WardenFocusCard } from '../../../src/lib/warden/index.ts';
import { lanes, PROJECT } from '../board/support.ts';
import { boardOf, cardView, orphanView } from './board-fixtures.ts';
import { enabled, harness, JEV_SKIP, journalTypes, NOW, session, triageable } from './sweep-harness.ts';

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
    should(subject.remedies[0]?.detail).containEql('Your card &F1 “Board store” has nobody on it');
    should(subject.state().orphans).eql({ F1: { assignee: 'worker', via: 'owner', to: 'lead', at: iso(NOW) } });
    should(journalTypes(subject).filter(type => type === 'fleet.warden_orphan_told')).have.length(1);
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

  it('should notify the owner, tied to the card, when no owner ferret is alive — and clear it once a ferret is back', async () => {
    // Arrange
    const board = boardPort(boardOf(orphanView()));
    const subject = harness({ config: enabled(), fleet: [worker], board });

    // Act
    await subject.service.run({ force: false });
    const raised = subject.board('worker');
    board.set(boardOf(cardView({ assignee: 'worker' }, { activity: 'active' })));
    await subject.service.run({ force: false });

    // Assert
    should(subject.notices).have.length(1);
    should(subject.notices[0]).containDeep({ sessionId: 'worker', notice: { task: { id: 'F1' } } });
    should(raised.map(item => item.sourceRef)).eql(['warden-orphan:F1']);
    should(subject.resolved.map(entry => [entry.sessionId, entry.sourceRef])).eql([['worker', 'warden-orphan:F1']]);
    should(subject.board('worker')).be.empty();
    should(subject.state()).not.have.property('orphans');
    should(journalTypes(subject)).containEql('fleet.warden_orphan_cleared');
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
    should(subject.notices).be.empty();
  });

  it('should keep what it told and clear nothing while the board cannot be read, saying so', async () => {
    // Arrange
    const told: OrphanMemory = { F1: { assignee: 'worker', via: 'notice', to: 'worker', at: iso(NOW - MINUTE) } };
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
    should(subject.state().orphans).eql(told);
    should(journalTypes(subject)).containEql('fleet.warden_board_blind');
  });

  it('should put a message it could not type on the owner ferret’s board instead, and not type it again', async () => {
    // Arrange — the message was refused by a composer the reader could not place. Not remembered, it was
    // typed again every sweep: nine notices every two minutes, crowding out the owner's own message.
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
    should(subject.notices).have.length(1);
    should(subject.notices[0]).containDeep({ sessionId: 'lead', notice: { task: { id: 'F1' } } });
    should(subject.state().orphans?.F1).containEql({ via: 'notice', to: 'lead' });
    should(journalTypes(subject)).not.containEql('fleet.warden_orphan_failed');
  });

  it('should try again next sweep when neither the message nor the notice landed', async () => {
    // Arrange
    const message = harness({
      config: enabled(),
      fleet: [worker, lead],
      board: boardPort(boardOf(orphanView())),
      remedyFails: 'nudge',
      noticeWrite: 'rejected',
    });
    const notice = harness({
      config: enabled(),
      fleet: [worker],
      board: boardPort(boardOf(orphanView())),
      noticeWrite: 'rejected',
    });

    // Act
    await message.service.run({ force: false });
    await notice.service.run({ force: false });

    // Assert
    for (const subject of [message, notice]) {
      should(subject.state()).not.have.property('orphans');
      should(journalTypes(subject)).containEql('fleet.warden_orphan_failed');
    }
  });

  it('should never type into an interactive owner’s chat: the notice goes on its board', async () => {
    // Arrange
    const chat = session({ id: 'lead', status: 'running', mode: 'interactive' });
    const subject = harness({ config: enabled(), fleet: [worker, chat], board: boardPort(boardOf(orphanView())) });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.remedies).be.empty();
    should(subject.notices).have.length(1);
    should(subject.notices[0]).containDeep({ sessionId: 'lead', notice: { task: { id: 'F1' } } });
    should(subject.state().orphans?.F1).containEql({ via: 'notice', to: 'lead' });
  });

  it('should say so when nobody on this machine can be told', async () => {
    // Arrange
    const subject = harness({ config: enabled(), fleet: [], board: boardPort(boardOf(orphanView())) });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.notices).be.empty();
    should(journalTypes(subject)).containEql('fleet.warden_orphan_unreported');
  });

  it('should name the machine in the notice when it has a name', async () => {
    // Arrange
    const subject = harness({
      config: enabled(),
      fleet: [worker],
      board: boardPort(boardOf(orphanView())),
      settings: { machineName: () => 'mac' },
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.notices[0]?.notice.premise).containEql(' on mac, in Implement');
  });
});

describe('a ferret the Warden starts again', () => {
  const card: WardenFocusCard = { task: cardView({ title: 'Ship the thing' }), laneSet: lanes(PROJECT) };
  const jev = (verdict: TriageDecision['verdict'], confidence: number): TriageDecision => ({
    ...JEV_SKIP,
    verdict,
    confidence,
    reason: TRIAGE_CRITERIA[verdict],
    ...(verdict === 'nudge'
      ? { nudge: { id: 'stuck_command' as const, message: NUDGE_MESSAGES.stuck_command, confidence } }
      : {}),
  });
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
    should(subject.remedies[0]?.detail).containEql('The Warden resumed you:');
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
    should(subject.remedies[0]?.detail).containEql('The Warden restarted you with your conversation intact:');
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
