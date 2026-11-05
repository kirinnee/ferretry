import { describe, it } from 'bun:test';
import should from 'should';
import { AgendaActionRequestSchema, AgendaItemSchema, agendaBadgeCount } from '../../src/lib/agenda.ts';
import { type AgendaQueueSource, needsYouQueue, restingQueue } from '../../src/lib/agenda-queue.ts';
import { agendaStage, agendaStageOfKind } from '../../src/lib/agenda-stage.ts';
import { agendaState } from '../../src/lib/agenda-state.ts';

const T1 = '2026-11-03T09:00:00.000Z';
const T2 = '2026-11-03T10:00:00.000Z';
const T3 = '2026-11-03T11:00:00.000Z';
const T4 = '2026-11-03T12:00:00.000Z';

/** A queue item: an id and when it began needing the owner, and whatever else the case says. */
const item = (id: string, waitingSince: string, rest: Record<string, unknown> = {}): AgendaQueueSource =>
  ({ id, waitingSince, ...rest }) as AgendaQueueSource;

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

describe('needsYouQueue', () => {
  it('should list each item at most once, blockers first, then by when each started needing the owner', () => {
    // Arrange
    const items = [
      item('A1', T3),
      item('A2', T1),
      item('A3', T4, { blockingNow: true }),
      item('A2', T1),
      item('A4', T2, { blockingNow: true }),
    ];

    // Act
    const queue = needsYouQueue(items);

    // Assert
    should(queue.map(each => each.id)).deepEqual(['A4', 'A3', 'A2', 'A1']);
  });

  it('should order two items that started needing the owner together by their key, whatever order they arrive in', () => {
    // Arrange
    const items = [item('A9', T1), item('A2', T1), item('A5', T1, { blockingNow: true }), item('A1', T1)];

    // Act
    const queue = needsYouQueue(items);

    // Assert
    should(queue.map(each => each.id)).deepEqual(['A5', 'A1', 'A2', 'A9']);
  });

  it('should leave out what waits on nobody: resting, snoozed, done and notices', () => {
    // Arrange
    const items = [
      item('A1', T1),
      item('A2', T1, { parked: { reason: 'replied', at: T2 } }),
      item('A3', T1, { parked: { reason: 'snoozed', at: T2, until: T4 } }),
      item('A4', T1, { notice: true }),
      item('A5', T1, { waitingOn: 'ferret', askedAt: T2 }),
    ];

    // Assert
    should(needsYouQueue(items).map(each => each.id)).deepEqual(['A1']);
    should(agendaBadgeCount({ items })).equal(1);
  });

  it('should key items across boards by the key it is given, so two boards’ A1 are two entries', () => {
    // Arrange
    const items = [
      { ...item('A1', T2), sessionId: 's1' },
      { ...item('A1', T1), sessionId: 's2' },
      { ...item('A1', T2), sessionId: 's1' },
    ];

    // Act
    const queue = needsYouQueue(items, each => `${each.sessionId}/${each.id}`);

    // Assert
    should(queue.map(each => each.sessionId)).deepEqual(['s2', 's1']);
  });
});

describe('restingQueue', () => {
  it('should list the items waiting on their ferret first, then the ones being worked on, then the snoozed by wake', () => {
    // Arrange
    const items = [
      item('A1', T1, { parked: { reason: 'snoozed', at: T1, until: T4 } }),
      item('A2', T1, { parked: { reason: 'replied', at: T1 }, resting: { sub: 'working', at: T1, why: 'rebasing' } }),
      item('A3', T1, { parked: { reason: 'replied', at: T3 } }),
      item('A4', T1, { parked: { reason: 'snoozed', at: T1, until: T2 } }),
      item('A5', T1, { waitingOn: 'ferret', askedAt: T2 }),
      item('A6', T1),
    ];

    // Act
    const resting = restingQueue(items);

    // Assert
    should(resting.map(each => each.id)).deepEqual(['A5', 'A3', 'A2', 'A4', 'A1']);
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
      askVersion: 2,
    });

    // Assert
    should(parsed.success).be.true();
  });

  it('should take a long report whole, and refuse an item whose own content is past its bound', () => {
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
    should(tooBig.error?.issues[0]?.message).match(/at most 560000 characters as JSON/u);
  });

  it('should take a rest, an answer naming its ask version, and an edit that replaces the ask or clears the answer', () => {
    // Assert
    should(AgendaActionRequestSchema.safeParse({ action: 'rest', id: 'A1', why: 'rebasing' }).success).be.true();
    should(AgendaActionRequestSchema.safeParse({ action: 'rest', id: 'A1' }).success).be.false();
    should(
      AgendaActionRequestSchema.safeParse({
        action: 'resolve',
        id: 'A1',
        askVersion: 2,
        response: { kind: 'open-question', answer: 'EU' },
      }).success,
    ).be.true();
    should(
      AgendaActionRequestSchema.safeParse({
        action: 'edit',
        id: 'A1',
        stage: 'plan',
        kind: 'yesno',
        ask: { kind: 'multiple-choice', options: [{ label: 'Yes' }, { label: 'No' }] },
        clear: ['questionAnswer'],
      }).success,
    ).be.true();
    should(
      AgendaActionRequestSchema.safeParse({ action: 'edit', id: 'A1', questionAnswer: 'x', clear: ['questionAnswer'] })
        .success,
    ).be.false();
  });
});
