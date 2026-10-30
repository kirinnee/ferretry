import { describe, it } from 'bun:test';
import should from 'should';
import {
  detectOrphanedCards,
  fingerprintAnomalies,
  type OrphanMemory,
  type OrphanPlanInput,
  orphanFleetKey,
  orphanNoticeSourceRef,
  planOrphanEscalations,
  WARDEN_LABEL,
  type WardenAnomaly,
} from '../../../src/lib/warden/index.ts';
import { boardOf, cardView, orphanView } from './board-fixtures.ts';
import { NOW, session } from './sweep-harness.ts';

const worker = session({ id: 'worker', status: 'stopped' });
const lead = session({ id: 'lead', status: 'running' });

describe('detectOrphanedCards', () => {
  it('should flag a card the board calls orphaned, about the card and naming the ferret that left it', () => {
    // Arrange
    const board = boardOf(orphanView({ title: 'Ship the thing' }));

    // Act
    const [anomaly, ...rest] = detectOrphanedCards(
      board,
      [{ ...worker, config: { ...worker.config, teammate: 'ada' } }],
      NOW,
    );

    // Assert
    should(rest).be.empty();
    should(anomaly).eql({
      kind: 'orphaned_card',
      sessionId: 'worker',
      fleetKey: 'card:F1',
      task: { id: 'F1' },
      teammate: 'ada',
      status: 'stopped',
      detail: '&F1 “Ship the thing” is in Implement, but its ferret :ada is stopped and nothing under it is alive',
      since: '2026-07-31T11:00:00.000Z',
      idleMinutes: 60,
      subject: 'card:F1|assignee:worker',
    });
  });

  it('should read only the board’s own verdict: a card in any other state is not orphaned', () => {
    // Arrange
    const board = boardOf(
      ...(['active', 'idle', 'stale', 'waiting'] as const).map((activity, index) =>
        cardView({ id: `F${index + 2}`, assignee: 'worker' }, { activity }),
      ),
    );

    // Act + Assert
    should(detectOrphanedCards(board, [worker], NOW)).be.empty();
  });

  it('should say a ferret gone from this machine is gone, and stand it in as stopped', () => {
    // Arrange
    const board = boardOf(orphanView({ assignee: null, owner: 'vanished' }));

    // Act
    const [anomaly] = detectOrphanedCards(board, [], NOW);

    // Assert
    should(anomaly?.sessionId).equal('vanished');
    should(anomaly?.status).equal('stopped');
    should(anomaly?.detail).endWith('its ferret vanished is no longer on this machine and nothing under it is alive');
    should(anomaly).not.have.property('teammate');
  });

  it('should carry the label, and date a never-touched card from its creation', () => {
    // Arrange
    const labelled = { ...worker, config: { ...worker.config, label: 'nightly' } };
    const view = cardView({ assignee: 'worker' }, { activity: 'orphaned', lastTouchedAt: null });

    // Act
    const [anomaly] = detectOrphanedCards(boardOf(view), [labelled], NOW);

    // Assert
    should(anomaly?.label).equal('nightly');
    should(anomaly?.since).equal(view.createdAt);
  });

  it('should leave idle minutes out when the last touch is in the future or unreadable', () => {
    // Arrange
    const ahead = orphanView({}, '2026-08-01T00:00:00.000Z');
    const unreadable = orphanView({ id: 'F2' }, 'not a time');

    // Act
    const anomalies = detectOrphanedCards(boardOf(ahead, unreadable), [worker], NOW);

    // Assert
    should(anomalies).have.length(2);
    for (const anomaly of anomalies) should(anomaly).not.have.property('idleMinutes');
  });

  it('should never flag a card a warden, or anything a warden spawned, was holding', () => {
    // Arrange
    const warden = session({ id: 'worker', status: 'completed', label: WARDEN_LABEL });
    const child = {
      ...session({ id: 'child', status: 'stopped' }),
      config: { ...worker.config, id: 'child', wardenLineage: true },
    };
    const board = boardOf(orphanView(), orphanView({ id: 'F2', assignee: 'child' }));

    // Act + Assert
    should(detectOrphanedCards(board, [warden, child], NOW)).be.empty();
  });

  it('should key each card apart, so two cards one ferret left are two flags in the fingerprint', () => {
    // Arrange
    const board = boardOf(orphanView(), orphanView({ id: 'F2' }));

    // Act
    const anomalies = detectOrphanedCards(board, [worker], NOW);

    // Assert
    should(anomalies.map(anomaly => anomaly.fleetKey)).eql([orphanFleetKey('F1'), orphanFleetKey('F2')]);
    should(fingerprintAnomalies(anomalies)).equal('orphaned_card:card:F1|orphaned_card:card:F2');
  });
});

describe('planOrphanEscalations', () => {
  const plan = (overrides: Partial<OrphanPlanInput> & { readonly board: OrphanPlanInput['board'] }) => {
    const fleet = overrides.fleet ?? [worker, lead];
    const orphans = overrides.orphans ?? detectOrphanedCards(overrides.board, fleet, NOW);
    return planOrphanEscalations({ memory: {}, enabled: true, clientName: 'fy', ...overrides, fleet, orphans });
  };
  const told = (via: 'owner' | 'notice', to: string, assignee = 'worker'): OrphanMemory => ({
    F1: { assignee, via, to, at: '2026-07-31T11:30:00.000Z' },
  });

  it('should queue a message to the card’s owner ferret while it is alive', () => {
    // Act
    const result = plan({ board: boardOf(orphanView({ title: 'Ship the thing' })) });

    // Assert
    should(result.resolve).be.empty();
    should(result.tell).have.length(1);
    const tell = result.tell[0];
    if (tell?.kind !== 'message') throw new Error('expected a message');
    should(tell).containDeep({ taskId: 'F1', assignee: 'worker', sessionId: 'lead' });
    const text = tell.message;
    should(text).startWith('Your card &F1 “Ship the thing” has nobody on it. It is in Implement');
    should(text).not.containEql('[ferretry]');
    should(text).not.containEql('This notice is from Ferretry');
    should(text).containEql('its ferret worker is stopped and nothing under it is alive');
    should(text).containEql('`fy resume worker`');
    should(text).containEql('`fy task assign F1 <ferret>`');
    should(text).containEql('`fy task drop F1 --reason "<why>"`');
  });

  it('should notify the owner instead, tied to the card, when the owner ferret is finished too', () => {
    // Arrange
    const fleet = [worker, session({ id: 'lead', status: 'completed' })];

    // Act
    const result = plan({ board: boardOf(orphanView({ title: 'Ship the thing' })), fleet, machine: 'mac' });

    // Assert
    const tell = result.tell[0];
    if (tell?.kind !== 'notice') throw new Error('expected a notice');
    should(tell.sessionId).equal('lead');
    should(tell.notice).containDeep({
      sourceRef: orphanNoticeSourceRef('F1'),
      task: { id: 'F1' },
      title: '&F1 has nobody on it',
      subject: '&F1 “Ship the thing” is in Implement, and no ferret is working it.',
      waitingSince: '2026-07-31T11:00:00.000Z',
    });
    should(tell.notice.why).equal(
      'Its ferret worker is stopped and nothing under it is alive. Its owner ferret lead is completed as well.',
    );
    should(tell.notice.premise).containEql('“Ship the thing” on mac, in Implement');
    should(tell.notice.howToResolve).containEql('`fy task assign F1 <ferret>`');
  });

  it('should notify the owner when the card’s ferret owns it itself', () => {
    // Arrange
    const board = boardOf(orphanView({ owner: 'worker', assignee: null }));

    // Act
    const tell = plan({ board }).tell[0];

    // Assert
    if (tell?.kind !== 'notice') throw new Error('expected a notice');
    should(tell.sessionId).equal('worker');
    should(tell.notice.why).endWith('Its ferret owns it too, so no other ferret answers for it.');
  });

  it('should hold the notice on the finished ferret’s board when the owner is gone from this machine', () => {
    // Act
    const tell = plan({ board: boardOf(orphanView()), fleet: [worker] }).tell[0];

    // Assert
    should(tell).containDeep({ kind: 'notice', sessionId: 'worker' });
  });

  it('should report a card nobody on this machine can be told about, and remember nothing', () => {
    // Act
    const result = plan({ board: boardOf(orphanView()), fleet: [] });

    // Assert
    should(result.tell).be.empty();
    should(result.unreported).eql(['F1']);
    should(result.memory).eql({});
  });

  it('should fit a long title into the notice’s limits', () => {
    // Arrange
    const fleet = [worker];
    const title = 'A very long card title '.repeat(10).trim();

    // Act
    const tell = plan({ board: boardOf(orphanView({ title })), fleet }).tell[0];

    // Assert
    if (tell?.kind !== 'notice') throw new Error('expected a notice');
    should(tell.notice.subject.length).be.belowOrEqual(120);
    should(tell.notice.subject).endWith('…');
  });

  it('should not tell anybody twice in one episode', () => {
    // Act
    const owner = plan({ board: boardOf(orphanView()), memory: told('owner', 'lead') });
    const notice = plan({ board: boardOf(orphanView()), fleet: [worker], memory: told('notice', 'worker') });

    // Assert
    should(owner.tell).be.empty();
    should(owner.memory).eql(told('owner', 'lead'));
    should(notice.tell).be.empty();
    should(notice.memory).eql(told('notice', 'worker'));
  });

  it('should move on to the owner once the owner ferret it messaged has finished as well', () => {
    // Arrange
    const fleet = [worker, session({ id: 'lead', status: 'stopped' })];

    // Act
    const result = plan({ board: boardOf(orphanView()), fleet, memory: told('owner', 'lead') });

    // Assert
    should(result.tell).containDeep([{ kind: 'notice', sessionId: 'lead' }]);
    should(result.memory).eql({});
  });

  it('should treat a card another ferret left as a new episode, clearing the old notice', () => {
    // Arrange
    const memory = told('notice', 'lead', 'earlier');

    // Act
    const result = plan({ board: boardOf(orphanView()), memory });

    // Assert
    should(result.resolve).eql([
      {
        taskId: 'F1',
        sessionId: 'lead',
        sourceRef: 'warden-orphan:F1',
        note: 'Cleared by the Warden: the card changed hands since.',
      },
    ]);
    should(result.tell).containDeep([{ kind: 'message', sessionId: 'lead', assignee: 'worker' }]);
  });

  it('should forget a card that recovered, and clear its notice when it had one', () => {
    // Arrange
    const memory: OrphanMemory = {
      F1: { assignee: 'worker', via: 'notice', to: 'worker', at: '2026-07-31T11:30:00.000Z' },
      F2: { assignee: 'worker', via: 'owner', to: 'lead', at: '2026-07-31T11:30:00.000Z' },
    };

    // Act
    const result = plan({ board: boardOf(cardView({ assignee: 'worker' }, { activity: 'active' })), memory });

    // Assert
    should(result.memory).eql({});
    should(result.tell).be.empty();
    should(result.resolve).eql([
      {
        taskId: 'F1',
        sessionId: 'worker',
        sourceRef: 'warden-orphan:F1',
        note: 'Cleared by the Warden: a ferret is on the card again, or it left its lane.',
      },
    ]);
  });

  it('should tell nobody while the Warden is off, but keep what it told and still clear what recovered', () => {
    // Arrange
    const board = boardOf(orphanView(), orphanView({ id: 'F2' }));
    const fleet = [worker, session({ id: 'lead', status: 'stopped' })];
    const memory: OrphanMemory = {
      F1: { assignee: 'worker', via: 'owner', to: 'lead', at: '2026-07-31T11:30:00.000Z' },
      F3: { assignee: 'worker', via: 'notice', to: 'worker', at: '2026-07-31T11:30:00.000Z' },
    };

    // Act
    const result = plan({ board, fleet, memory, enabled: false });

    // Assert
    should(result.tell).be.empty();
    should(result.memory).eql({ F1: memory.F1 });
    should(result.resolve.map(resolution => resolution.taskId)).eql(['F3']);
  });

  it('should skip an anomaly whose card is not on the board it was read from', () => {
    // Arrange
    const stray: WardenAnomaly = {
      kind: 'orphaned_card',
      sessionId: 'worker',
      status: 'stopped',
      detail: 'gone',
      task: { id: 'F9' },
    };
    const { task: _task, ...unnamed } = stray;

    // Act
    const result = plan({ board: boardOf(), orphans: [stray, unnamed] });

    // Assert
    should(result.tell).be.empty();
    should(result.unreported).be.empty();
  });

  it('should date a notice from the card’s creation when the anomaly carries no anchor', () => {
    // Arrange
    const view = orphanView();
    const [anomaly] = detectOrphanedCards(boardOf(view), [worker], NOW);
    const { since: _since, ...unanchored } = anomaly as WardenAnomaly;

    // Act
    const tell = plan({ board: boardOf(view), fleet: [worker], orphans: [unanchored] }).tell[0];

    // Assert
    if (tell?.kind !== 'notice') throw new Error('expected a notice');
    should(tell.notice.waitingSince).equal(view.createdAt);
  });
});
