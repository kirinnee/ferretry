import { describe, expect, it } from 'bun:test';
import { formatTaskRef } from '@ferretry/protocol';
import {
  chatCardLabel,
  chatCards,
  chatChip,
  chatDrawn,
  chatChipSentence,
  chatSiblings,
  descendantSessionIds,
} from '../../src/lib/board-chat.ts';
import { sessionView } from '../support/sessions.ts';
import { NO_BOARD_FILTERS } from '../../src/lib/board-model.ts';
import { boardModelOf, card, laptop, originCard, workstation } from './board-support.ts';

const SELF = 's1';
const KID = 'c1';
const GRANDKID = 'g1';

const who = (extra: Partial<Parameters<typeof chatCards>[1]> = {}): Parameters<typeof chatCards>[1] => ({
  daemonId: laptop.daemonId,
  sessionId: SELF,
  focus: { id: 'F18' },
  relatives: new Set([KID, GRANDKID]),
  agents: false,
  ...extra,
});

const ids = (rows: readonly { readonly card: { readonly task: { readonly id: string } } }[]) =>
  rows.map(row => row.card.task.id);

const board = () =>
  boardModelOf([
    card('F18', { owner: SELF, laneId: 'plan', title: 'Board system' }),
    card('F20', { owner: SELF, laneId: 'review' }),
    card('F21', { owner: 'someone', assignee: SELF, laneId: 'todo' }),
    card('F30', { owner: KID, laneId: 'implement' }),
    card('F31', { owner: 'nobody', laneId: 'implement', parent: { id: 'F30' } }),
    card('F32', { owner: GRANDKID, laneId: 'todo' }),
    card('F99', { owner: 'other', laneId: 'implement' }),
  ]);

describe('descendantSessionIds', () => {
  it('walks the parent links to any depth and leaves out the session itself and its cousins', () => {
    const sessions = [
      sessionView(SELF),
      sessionView(KID, { config: { parent: SELF } }),
      sessionView(GRANDKID, { config: { parent: KID } }),
      sessionView('cousin', { config: { parent: 'elsewhere' } }),
    ];
    expect([...descendantSessionIds(sessions, SELF)].sort()).toEqual([KID, GRANDKID]);
    expect(descendantSessionIds(sessions, 'cousin').size).toBe(0);
  });
});

describe('chatCards', () => {
  it('puts the focus card first, then owned cards by lane order, then the sub-ferrets’ cards', async () => {
    const cards = chatCards(await board(), who());
    expect(cards.focus?.task.id).toBe('F18');
    expect(cards.owned.map(group => [group.laneName, ids(group.cards.map(c => ({ card: c })))])).toEqual([
      ['Todo', ['F21']],
      ['Review/CI', ['F20']],
    ]);
    expect(ids(cards.children)).toEqual(['F30', 'F31', 'F32']);
  });

  it('draws a sub-ferret card under its parent when the parent is among them', async () => {
    const cards = chatCards(await board(), who());
    expect(cards.children.map(row => [row.card.task.id, row.depth])).toEqual([
      ['F30', 0],
      ['F31', 1],
      ['F32', 0],
    ]);
  });

  it('counts every card once, and never another ferret’s', async () => {
    const cards = chatCards(await board(), who());
    expect(cards.total).toBe(6);
    const drawn = [
      cards.focus?.task.id,
      ...cards.owned.flatMap(g => g.cards.map(c => c.task.id)),
      ...ids(cards.children),
    ];
    expect(drawn).not.toContain('F99');
    expect(new Set(drawn).size).toBe(drawn.length);
  });

  it('shows owned cards without a focus when the session has none', async () => {
    const cards = chatCards(await board(), who({ focus: null }));
    expect(cards.focus).toBeNull();
    expect(cards.owned.flatMap(group => group.cards.map(c => c.task.id)).sort()).toEqual(['F18', 'F20', 'F21']);
  });

  it('shows no focus when the focus names a card the board does not hold, and still lists what it owns', async () => {
    const cards = chatCards(await board(), who({ focus: { id: 'F404' } }));
    expect(cards.focus).toBeNull();
    expect(cards.owned.flatMap(group => group.cards.map(c => c.task.id)).sort()).toEqual(['F18', 'F20', 'F21']);
    expect(cards.total).toBe(6);
  });

  it('is empty for a ferret that owns nothing and has no sub-ferrets', async () => {
    const cards = chatCards(await board(), who({ sessionId: 'nobody-here', focus: null, relatives: new Set() }));
    expect(cards.total).toBe(0);
    expect(cards.owned).toEqual([]);
    expect(cards.children).toEqual([]);
  });

  it('ignores a card of the same id held on another machine', async () => {
    const cards = chatCards(await board(), who({ daemonId: workstation.daemonId }));
    expect(cards.total).toBe(0);
  });
});

describe('chatCards lanes (the Kanban)', () => {
  const lanesOf = (cards: ReturnType<typeof chatCards>) =>
    cards.lanes.map(lane => [lane.name, lane.category, lane.cards.map(c => c.task.id).sort()]);

  it('has one column per lane that holds a drawn card, in lane order, each card once', async () => {
    const cards = chatCards(await board(), who());
    expect(lanesOf(cards)).toEqual([
      ['Todo', 'backlog', ['F21', 'F32']],
      ['Plan/Design', 'active', ['F18']],
      ['Implement', 'active', ['F30', 'F31']],
      ['Review/CI', 'review', ['F20']],
    ]);
    expect(cards.lanes.reduce((sum, lane) => sum + lane.cards.length, 0)).toBe(cards.total);
  });

  it('never carries an empty lane or another ferret’s card', async () => {
    const cards = chatCards(await board(), who());
    expect(cards.lanes.every(lane => lane.cards.length > 0)).toBe(true);
    expect(cards.lanes.flatMap(lane => lane.cards.map(c => c.task.id))).not.toContain('F99');
  });

  it('keeps a card the project has no lanes for in an Unplaced column', async () => {
    const model = await boardModelOf([card('F40', { owner: SELF, laneId: 'gone-lane' })]);
    const cards = chatCards(model, who({ focus: null }));
    expect(lanesOf(cards)).toEqual([['Unplaced', null, ['F40']]]);
  });

  it('is empty when the ferret has nothing', async () => {
    const cards = chatCards(await board(), who({ sessionId: 'nobody-here', focus: null, relatives: new Set() }));
    expect(cards.lanes).toEqual([]);
  });
});

describe('chatDrawn and chatSiblings', () => {
  it('lists the focus, then the owned cards, then the sub-ferrets’ cards, once each', async () => {
    const cards = chatCards(await board(), who());
    expect(chatDrawn(cards).map(c => c.task.id)).toEqual(['F18', 'F21', 'F20', 'F30', 'F31', 'F32']);
  });

  it('gives the drawer each drawn card with its lane’s name', async () => {
    const cards = chatCards(await board(), who());
    const siblings = chatSiblings(cards);
    expect(siblings.map(s => [s.task.id, s.laneName])).toEqual([
      ['F18', 'Plan/Design'],
      ['F21', 'Todo'],
      ['F20', 'Review/CI'],
      ['F30', 'Implement'],
      ['F31', 'Implement'],
      ['F32', 'Todo'],
    ]);
  });
});

describe('chatChip', () => {
  const focus = { id: 'F18' };

  it('says no card when the session has no focus card', () => {
    const chip = chatChip(undefined, null, undefined, 'ready');
    expect(chip).toEqual({ kind: 'none' });
    expect(chatChipSentence(chip)).toBe('No card');
  });

  it('names the card, its lane and how it is doing', async () => {
    const model = await boardModelOf([card('F18', { owner: SELF, laneId: 'plan', title: 'Board system' })]);
    const cards = chatCards(model, who());
    const found = cards.focus;
    const chip = chatChip(focus, found, found === null ? undefined : cards.places.get(found.key), 'ready');
    expect(chip).toMatchObject({
      kind: 'card',
      ref: formatTaskRef(focus),
      title: 'Board system',
      lane: 'Plan/Design',
      activity: 'active',
      tone: 'ok',
    });
    if (chip.kind !== 'card') throw new Error('expected a card chip');
    expect(chatChipSentence(chip)).toBe('&F18, Board system, Plan/Design, active');
    expect(chatCardLabel(chip)).toBe('&F18 (Plan/Design)');
  });

  it.each([
    ['idle', 'quiet'],
    ['stale', 'warn'],
    ['orphaned', 'err'],
    ['waiting', 'pend'],
  ] as const)('tones a %s card %s', async (activity, tone) => {
    const model = await boardModelOf([card('F18', { owner: SELF, activity })]);
    const cards = chatCards(model, who());
    const chip = chatChip(focus, cards.focus, undefined, 'ready');
    expect(chip).toMatchObject({ kind: 'card', activity, tone });
  });

  it('says a waiting card is waiting on you when the owner is who it waits for', async () => {
    const model = await boardModelOf([
      card('F18', {
        owner: SELF,
        activity: 'waiting',
        waitingOnOwner: [{ sessionId: SELF, id: 'A3' }],
        openAsks: [{ sessionId: SELF, id: 'A3' }],
      }),
    ]);
    const chip = chatChip(focus, chatCards(model, who()).focus, undefined, 'ready');
    expect(chip).toMatchObject({ activity: 'waiting on you', tone: 'pend' });
  });

  it('shows only the id while the board is being read, and closed once it was read without the card', () => {
    expect(chatChip(focus, null, undefined, 'loading')).toMatchObject({
      kind: 'card',
      title: null,
      lane: null,
      activity: null,
      tone: 'quiet',
    });
    const closed = chatChip(focus, null, undefined, 'ready');
    expect(closed).toMatchObject({ kind: 'card', activity: 'closed' });
    if (closed.kind !== 'card') throw new Error('expected a card chip');
    expect(chatChipSentence(closed)).toBe('&F18, closed');
    expect(chatCardLabel(closed)).toBe('&F18');
  });
});

describe('chatCards and "Internal"', () => {
  // The chat reads every card (the chip must find a sub-ferret's own focus); what it draws is chatCards'.
  const everyCard = (cards: Parameters<typeof boardModelOf>[0]) =>
    boardModelOf(cards, { ...NO_BOARD_FILTERS, agents: true });
  const mixed = () =>
    everyCard([
      originCard('F18', 'human', null, { owner: SELF, laneId: 'plan' }),
      originCard('F20', 'agent', { id: 'F18' }, { owner: SELF, laneId: 'plan', parent: { id: 'F18' } }),
      originCard('F21', 'human', null, { owner: SELF, laneId: 'plan' }),
      originCard('F30', 'agent', null, { owner: KID, laneId: 'implement' }),
      originCard('F31', 'human', null, { owner: KID, laneId: 'implement' }),
    ]);
  const drawn = (cards: ReturnType<typeof chatCards>) => chatDrawn(cards).map(c => c.task.id);

  it('draws only the owner’s own cards until agent tasks are on, and counts what it hides', async () => {
    const cards = chatCards(await mixed(), who());
    expect(drawn(cards)).toEqual(['F18', 'F21', 'F31']);
    expect(cards.total).toBe(3);
    expect(cards.hiddenAgents).toBe(2);
    expect(cards.under.size).toBe(0);
  });

  it('draws the agent cards too when they are on, each right under the human card it serves', async () => {
    const cards = chatCards(await mixed(), who({ agents: true }));
    expect(cards.total).toBe(5);
    expect(cards.hiddenAgents).toBe(0);
    expect(cards.lanes.find(lane => lane.name === 'Plan/Design')?.cards.map(c => c.task.id)).toEqual([
      'F18',
      'F20',
      'F21',
    ]);
    expect([...cards.under]).toEqual([cards.lanes[0]?.cards[1]?.key ?? '']);
    expect(drawn(cards)).toContain('F30');
  });

  it('still finds the focus card for the chip when it is an agent card that is not drawn', async () => {
    const cards = chatCards(await mixed(), who({ focus: { id: 'F20' } }));
    expect(cards.focus?.task.id).toBe('F20');
    expect(cards.shownFocus).toBeNull();
    expect(drawn(cards)).not.toContain('F20');
    expect(chatChip({ id: 'F20' }, cards.focus, undefined, 'ready')).toMatchObject({ kind: 'card', title: 'Card F20' });
  });

  it('draws a focus card that is a human card', async () => {
    const cards = chatCards(await mixed(), who());
    expect(cards.shownFocus?.task.id).toBe('F18');
  });

  it('shows every card of an older daemon, which says nothing of who asked', async () => {
    const cards = chatCards(await board(), who());
    expect(cards.total).toBe(6);
    expect(cards.hiddenAgents).toBe(0);
  });

  it('carries each column’s board and lane id so a drop can be placed', async () => {
    const cards = chatCards(await mixed(), who());
    expect(cards.lanes.every(lane => lane.laneId !== null && lane.groupKey !== '')).toBe(true);
    const model = await boardModelOf([card('F40', { owner: SELF, laneId: 'gone-lane' })]);
    expect(chatCards(model, who({ focus: null })).lanes[0]).toMatchObject({ laneId: null });
  });
});
