import { describe, it } from 'bun:test';
import should from 'should';
import { AgendaActionRequestSchema, AgendaItemSchema, agendaBadgeCount } from '../../src/lib/agenda.ts';
import { agendaStage, agendaStageOfKind } from '../../src/lib/agenda-stage.ts';
import { agendaState } from '../../src/lib/agenda-state.ts';

const T1 = '2026-11-03T09:00:00.000Z';
const T2 = '2026-11-03T10:00:00.000Z';
const T3 = '2026-11-03T11:00:00.000Z';
const T4 = '2026-11-03T12:00:00.000Z';

describe('agendaState', () => {
  it('should read a closed item and a notice as done, whatever else they carry', () => {
    // Assert
    should(agendaState({ resolvedAt: T1, parked: { reason: 'replied', at: T1 } })).deepEqual({ state: 'done' });
    should(agendaState({ notice: true })).deepEqual({ state: 'done' });
  });

  it('should read a snooze as snoozed, even over a rest', () => {
    // Assert
    should(
      agendaState({
        parked: { reason: 'snoozed', at: T1, until: T2 },
        resting: { sub: 'working', at: T1 },
      }),
    ).deepEqual({ state: 'snoozed' });
  });

  it('should read a replied park as resting: its own sub-state, else waiting on the ferret since the reply', () => {
    // Assert — an item parked before Resting existed names no sub-state
    should(agendaState({ parked: { reason: 'replied', at: T1 } })).deepEqual({
      state: 'resting',
      sub: 'waiting-on-ferret',
      since: T1,
    });
    should(agendaState({ parked: { reason: 'replied', at: T1 }, resting: { sub: 'working', at: T2 } })).deepEqual({
      state: 'resting',
      sub: 'working',
      since: T2,
    });
  });

  it('should read a request for more information as resting on the ferret, since the request', () => {
    // Assert
    should(agendaState({ waitingOn: 'ferret', askedAt: T2 })).deepEqual({
      state: 'resting',
      sub: 'waiting-on-ferret',
      since: T2,
    });
  });

  it('should read everything else as needing the owner, a rest detail with nothing parked included', () => {
    // Assert
    should(agendaState({})).deepEqual({ state: 'needs-you' });
    should(agendaState({ resting: { sub: 'working', at: T1 } })).deepEqual({ state: 'needs-you' });
  });
});

describe('agendaStage', () => {
  it('should read a stage from the kind when none is named, and done once closed', () => {
    // Assert
    should(agendaStageOfKind('info')).equal('explainer');
    should(agendaStageOfKind('permission')).equal('plan');
    should(agendaStageOfKind('review')).equal('plan');
    should(agendaStageOfKind('task')).equal('test');
    should(agendaStageOfKind('choice')).equal('question');
    should(agendaStage({ kind: 'info' })).equal('explainer');
    should(agendaStage({ ask: { kind: 'permission' } })).equal('plan');
    should(agendaStage({ stage: 'tracker', kind: 'info' })).equal('tracker');
    should(agendaStage({ stage: 'tracker', resolvedAt: T1 })).equal('done');
  });
});

describe('the agenda channel on the wire', () => {
  const BASE = {
    id: 'A1',
    source: 'agent-raised',
    sourceRef: null,
    subject: 'Which region?',
    why: 'The deploy needs one.',
    waitingSince: T1,
    howToResolve: 'Pick one.',
    raisedBy: 'agent',
    raisedBySession: 's1',
    raisedByName: null,
  };

  it('should read an item with its stage, rest, owner answer and where-we-are', () => {
    // Act
    const parsed = AgendaItemSchema.safeParse({
      ...BASE,
      ask: { kind: 'open-question' },
      stage: 'question',
      stages: [
        { stage: 'explainer', at: T1 },
        { stage: 'question', at: T2 },
      ],
      parked: { reason: 'replied', at: T3 },
      resting: { sub: 'waiting-on-ferret', at: T3, nudgedAt: T4, nudges: 1 },
      ownerAnswer: { at: T3, response: { kind: 'open-question', answer: 'EU' }, request: 1 },
      whereWeAre: 'The plan is written.',
      detail: 'From zero: a region is where the servers live.',
    });

    // Assert
    should(parsed.success).be.true();
  });

  it('should take a long report whole, and refuse an item past the transport bound', () => {
    // Arrange
    const report = 'x'.repeat(150_000);

    // Act
    const long = AgendaItemSchema.safeParse({ ...BASE, kind: 'info', body: report, whereWeAre: report });
    const tooBig = AgendaItemSchema.safeParse({
      ...BASE,
      kind: 'info',
      body: report,
      whereWeAre: report,
      detail: report,
      questionAnswer: report,
      context: 'y'.repeat(60_000),
      premise: 'z'.repeat(16_000),
      stillOpen: 'w'.repeat(16_000),
      steps: Array.from({ length: 20 }, () => 's'.repeat(16_000)),
    });

    // Assert
    should(long.success).be.true();
    should(tooBig.success).be.false();
    should(tooBig.error?.issues[0]?.message).match(/at most 1000000 characters as JSON/u);
  });

  it('should take a rest with a why, and an edit or add that names a stage, where we are and the detail', () => {
    // Assert
    should(AgendaActionRequestSchema.safeParse({ action: 'rest', id: 'A1', why: 'rebasing' }).success).be.true();
    should(AgendaActionRequestSchema.safeParse({ action: 'rest', id: 'A1' }).success).be.false();
    should(
      AgendaActionRequestSchema.safeParse({
        action: 'edit',
        id: 'A1',
        stage: 'plan',
        whereWeAre: 'The plan is written.',
        detail: 'From zero.',
      }).success,
    ).be.true();
    should(AgendaActionRequestSchema.safeParse({ action: 'edit', id: 'A1', stage: 'review' }).success).be.false();
  });
});

describe('agendaBadgeCount', () => {
  it('should count only what needs the owner: never resting, snoozed, done or a notice', () => {
    // Arrange
    const items = [
      {},
      { parked: { reason: 'replied', at: T1 } },
      { parked: { reason: 'snoozed', at: T1, until: T4 } },
      { notice: true as const },
      { waitingOn: 'ferret' as const, askedAt: T3 },
      {},
    ];

    // Assert
    should(agendaBadgeCount({ items })).equal(2);
  });
});
