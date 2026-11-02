import { describe, it } from 'bun:test';
import { type AgendaItem, AgendaItemSchema } from '@ferretry/protocol';
import should from 'should';
import { planTidy, type TidyCardFact, type TidyFacts } from '../../../src/lib/tidy/index.ts';

const NOW = '2026-10-23T10:00:00.000Z';
const ME = 'mvysqi93-47a51e26';
const OTHER = 'mvyother1-11111111';
const MACHINE = 'machine-a';

const item = (id: string, extra: Record<string, unknown> = {}): AgendaItem =>
  AgendaItemSchema.parse({
    id,
    source: 'agent-raised',
    sourceRef: null,
    subject: `Ask ${id}`,
    why: 'Because.',
    waitingSince: NOW,
    howToResolve: 'Say so.',
    raisedBy: 'agent',
    raisedBySession: ME,
    raisedByName: 'Ada',
    ...extra,
  });

const card = (id: string, extra: Partial<TidyCardFact> = {}): TidyCardFact => ({
  id: id as TidyCardFact['id'],
  title: `Card ${id}`,
  projectId: 'proj',
  owner: ME,
  assignee: null,
  askedBy: 'agent',
  finished: false,
  ...extra,
});

const facts = (extra: Partial<TidyFacts> = {}): TidyFacts => ({
  sessionId: ME,
  subFerret: false,
  machineId: MACHINE,
  cards: [],
  boardsOn: new Set(),
  liveSessions: new Set(),
  gateCards: new Set(),
  items: [],
  replying: new Set(),
  ...extra,
});

const dropped = (plan: ReturnType<typeof planTidy>) => plan.drop.map(each => each.id);
const closed = (plan: ReturnType<typeof planTidy>) => plan.close.map(each => each.id);
const kept = (plan: ReturnType<typeof planTidy>) => plan.keep.map(each => `${each.id}:${each.code}`);

describe('planTidy: cards', () => {
  it('should drop the ferret’s own open agent-asked card on a board that is off', () => {
    // Arrange
    const input = facts({ cards: [card('F1')] });

    // Act
    const plan = planTidy(input);

    // Assert
    should(dropped(plan)).deepEqual(['F1']);
    should(plan.keep).deepEqual([]);
    should(plan.sessionId).equal(ME);
  });

  it('should drop a card the ferret is assigned though another session owns it', () => {
    // Arrange
    const input = facts({ cards: [card('F1', { owner: OTHER, assignee: ME })] });

    // Act / Assert
    should(dropped(planTidy(input))).deepEqual(['F1']);
  });

  it('should leave a card some other ferret owns and does', () => {
    // Arrange
    const input = facts({ cards: [card('F1', { owner: OTHER, assignee: OTHER })] });

    // Act
    const plan = planTidy(input);

    // Assert
    should(plan.drop).deepEqual([]);
    should(plan.keep).deepEqual([]);
  });

  it('should leave a card already closed or dropped out of the plan entirely', () => {
    // Arrange
    const input = facts({ cards: [card('F1', { finished: true })] });

    // Act
    const plan = planTidy(input);

    // Assert
    should(plan.drop).deepEqual([]);
    should(plan.keep).deepEqual([]);
  });

  it('should keep a card the owner asked for', () => {
    // Arrange
    const input = facts({ cards: [card('F1', { askedBy: 'person' })] });

    // Act
    const plan = planTidy(input);

    // Assert
    should(dropped(plan)).deepEqual([]);
    should(kept(plan)).deepEqual(['F1:owner-asked']);
  });

  it('should keep a card on a board that is on', () => {
    // Arrange
    const input = facts({ cards: [card('F1')], boardsOn: new Set(['proj']) });

    // Act
    const plan = planTidy(input);

    // Assert
    should(kept(plan)).deepEqual(['F1:board-on']);
  });

  it('should keep a card another live session is assigned to, and drop it once that session is gone', () => {
    // Arrange
    const handed = card('F1', { assignee: OTHER });

    // Act
    const live = planTidy(facts({ cards: [handed], liveSessions: new Set([OTHER]) }));
    const gone = planTidy(facts({ cards: [handed] }));

    // Assert
    should(kept(live)).deepEqual(['F1:assigned-to-live-session']);
    should(dropped(gone)).deepEqual(['F1']);
  });

  it('should not count the ferret itself as another live session', () => {
    // Arrange
    const input = facts({ cards: [card('F1')], liveSessions: new Set([ME]) });

    // Act / Assert
    should(dropped(planTidy(input))).deepEqual(['F1']);
  });

  it('should keep a card waiting at a gate on the owner', () => {
    // Arrange
    const input = facts({ cards: [card('F1')], gateCards: new Set(['F1']) });

    // Act
    const plan = planTidy(input);

    // Assert
    should(kept(plan)).deepEqual(['F1:waiting-at-gate']);
  });

  it('should put no card in a sub-ferret’s plan, because the daemon refuses its drops', () => {
    // Arrange
    const input = facts({ subFerret: true, cards: [card('F1')] });

    // Act
    const plan = planTidy(input);

    // Assert
    should(plan.subFerret).be.true();
    should(plan.drop).deepEqual([]);
    should(plan.keep).deepEqual([]);
  });
});

describe('planTidy: agenda items', () => {
  it('should close an info item', () => {
    // Arrange
    const input = facts({ items: [item('A1')] });

    // Act
    const plan = planTidy(input);

    // Assert
    should(closed(plan)).deepEqual(['A1']);
    should(plan.close[0]?.code).equal('info');
  });

  it('should close a plain notification', () => {
    // Arrange
    const input = facts({ items: [item('A1', { notice: true })] });

    // Act / Assert
    should(closed(planTidy(input))).deepEqual(['A1']);
  });

  it.each([
    ['snoozed', { parked: { reason: 'snoozed', at: NOW, until: '2026-10-24T10:00:00.000Z' } }],
    ['replied', { parked: { reason: 'replied', at: NOW } }],
    ['in discussion', { waitingOn: 'ferret', askedAt: NOW, waitingFor: 'discussion' }],
    ['waiting on the ferret for information', { waitingOn: 'ferret', askedAt: NOW, waitingFor: 'info' }],
  ])('should close a tracking item that is %s', (_state, extra) => {
    // Arrange
    const input = facts({ items: [item('A1', { ask: { kind: 'task' }, ...extra })] });

    // Act
    const plan = planTidy(input);

    // Assert
    should(closed(plan)).deepEqual(['A1']);
  });

  it('should close a "do this" item that asks no question and offers no choice, as status only', () => {
    // Arrange
    const input = facts({ items: [item('A1', { ask: { kind: 'task' } })] });

    // Act
    const plan = planTidy(input);

    // Assert
    should(plan.close[0]?.code).equal('status-only');
  });

  it('should close an item linked to a card this run drops, as card-dropped', () => {
    // Arrange
    const linked = item('A1', { ask: { kind: 'task' }, task: { id: 'F1' } });
    const input = facts({ cards: [card('F1')], items: [linked] });

    // Act
    const plan = planTidy(input);

    // Assert
    should(dropped(plan)).deepEqual(['F1']);
    should(plan.close[0]?.code).equal('card-dropped');
  });

  it('should name a card-dropped item even when the link carries this machine', () => {
    // Arrange
    const linked = item('A1', { ask: { kind: 'task' }, task: { id: 'F1', machineId: MACHINE } });
    const input = facts({ cards: [card('F1')], items: [linked] });

    // Act / Assert
    should(planTidy(input).close[0]?.code).equal('card-dropped');
  });

  it('should not treat a link to another machine’s card of the same id as this run’s drop', () => {
    // Arrange
    const linked = item('A1', { ask: { kind: 'task' }, task: { id: 'F1', machineId: 'machine-b' } });
    const input = facts({ cards: [card('F1')], items: [linked] });

    // Act
    const plan = planTidy(input);

    // Assert
    should(plan.close[0]?.code).equal('status-only');
  });

  it('should keep an item with a question, even one linked to a dropped card', () => {
    // Arrange
    const asked = item('A1', {
      ask: { kind: 'open-question' },
      questions: [{ question: 'Which region?' }],
      task: { id: 'F1' },
    });
    const input = facts({ cards: [card('F1')], items: [asked] });

    // Act
    const plan = planTidy(input);

    // Assert
    should(closed(plan)).deepEqual([]);
    should(kept(plan)).containEql('A1:needs-owner');
    should(plan.keep.find(each => each.id === 'A1')?.why).containEql('fy agenda done A1');
  });

  it('should keep an item with options', () => {
    // Arrange
    const choice = item('A1', {
      ask: { kind: 'multiple-choice', options: [{ label: 'Yes' }, { label: 'No' }] },
    });
    const input = facts({ items: [choice] });

    // Act / Assert
    should(kept(planTidy(input))).deepEqual(['A1:needs-owner']);
  });

  it('should keep a form, a permission, a review and a held configuration change', () => {
    // Arrange
    const items = [
      item('A1', {
        ask: { kind: 'open-question' },
        kind: 'form',
        fields: [{ id: 'region', type: 'text', label: 'Region?' }],
      }),
      item('A2', { ask: { kind: 'permission' } }),
      item('A3', { ask: { kind: 'answer-review' } }),
      item('A4', {
        ask: { kind: 'permission' },
        confirms: { path: 'config/a.yaml', etag: 'e', changes: ['x'] },
      }),
    ];

    // Act
    const plan = planTidy(facts({ items }));

    // Assert
    should(closed(plan)).deepEqual([]);
    should(kept(plan)).deepEqual(['A1:needs-owner', 'A2:needs-owner', 'A3:needs-owner', 'A4:needs-owner']);
  });

  it('should keep a gate item and a daemon-raised item', () => {
    // Arrange
    const gate = {
      cardId: 'F9',
      laneId: 'to-test',
      laneName: 'To test',
      entry: 1,
      projectId: 'proj',
      options: [{ id: 'next', label: 'Good', outcome: 'next' }],
    };
    const items = [
      item('A1', {
        raisedBy: 'daemon',
        raisedBySession: null,
        raisedByName: null,
        gate,
        ask: { kind: 'multiple-choice', options: [{ label: 'Good' }, { label: 'Not good' }] },
      }),
      item('A2', { raisedBy: 'daemon', raisedBySession: null, raisedByName: null }),
    ];

    // Act
    const plan = planTidy(facts({ items }));

    // Assert
    should(closed(plan)).deepEqual([]);
    should(kept(plan)).deepEqual(['A1:gate', 'A2:gate']);
  });

  it('should keep an item the owner raised or another ferret raised', () => {
    // Arrange
    const items = [
      item('A1', { raisedBy: 'human', raisedBySession: null, raisedByName: null }),
      item('A2', { raisedBySession: OTHER }),
    ];

    // Act
    const plan = planTidy(facts({ items }));

    // Assert
    should(kept(plan)).deepEqual(['A1:not-yours', 'A2:not-yours']);
  });

  it('should keep an item the owner is answering now, or whose answer did not arrive', () => {
    // Arrange
    const undelivered = {
      at: NOW,
      reply: { kind: 'resolve', answer: 'Yes' },
      reason: 'The ferret was busy.',
    } as unknown as AgendaItem['undelivered'];
    const items = [item('A1', { ask: { kind: 'task' } }), { ...item('A2', { ask: { kind: 'task' } }), undelivered }];

    // Act
    const plan = planTidy(facts({ items, replying: new Set(['A1']) }));

    // Assert
    should(closed(plan)).deepEqual([]);
    should(kept(plan)).deepEqual(['A1:owner-replying', 'A2:owner-replying']);
  });

  it('should keep a kind-less item whose ask cannot be told apart from a question', () => {
    // Arrange
    const odd = { ...item('A1', { ask: { kind: 'task' } }), ask: undefined, kind: 'reply' } as unknown as AgendaItem;

    // Act
    const plan = planTidy(facts({ items: [odd] }));

    // Assert
    should(kept(plan)).deepEqual(['A1:needs-owner']);
  });

  it('should use the item’s title when it has one', () => {
    // Arrange
    const titled = item('A1', { title: 'PR ready', kind: 'info' });

    // Act
    const plan = planTidy(facts({ items: [titled] }));

    // Assert
    should(plan.close[0]?.subject).equal('PR ready');
  });

  it('should plan nothing for a ferret with nothing', () => {
    // Arrange
    const input = facts();

    // Act
    const plan = planTidy(input);

    // Assert
    should(plan).deepEqual({ v: 1, sessionId: ME, subFerret: false, drop: [], close: [], keep: [] });
  });

  it('should still close a sub-ferret’s own tracking items', () => {
    // Arrange
    const input = facts({ subFerret: true, items: [item('A1', { ask: { kind: 'task' } })] });

    // Act
    const plan = planTidy(input);

    // Assert
    should(closed(plan)).deepEqual(['A1']);
  });
});
