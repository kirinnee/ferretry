import { describe, expect, it } from 'bun:test';
import { formatTaskRef } from '../../../contract/index.ts';
import {
  chatTaskLabel,
  chatTasks,
  chatChip,
  chatDrawn,
  chatSiblings,
  descendantSessionIds,
} from '../../../app/lib/board-chat.ts';
import { NO_BOARD_FILTERS } from '../../../app/lib/board-model.ts';
import { boardModelOf, boardTask, laptop, originTask, workstation } from './board-support.ts';

const SELF = 's1';
const KID = 'c1';
const GRANDKID = 'g1';

const who = (extra: Partial<Parameters<typeof chatTasks>[1]> = {}): Parameters<typeof chatTasks>[1] => ({
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
    boardTask('F18', { owner: SELF, laneId: 'plan', title: 'Board system' }),
    boardTask('F20', { owner: SELF, laneId: 'review' }),
    boardTask('F21', { owner: 'someone', assignee: SELF, laneId: 'todo' }),
    boardTask('F30', { owner: KID, laneId: 'implement' }),
    boardTask('F31', { owner: 'nobody', laneId: 'implement', parent: { id: 'F30' } }),
    boardTask('F32', { owner: GRANDKID, laneId: 'todo' }),
    boardTask('F99', { owner: 'other', laneId: 'implement' }),
  ]);

describe('descendantSessionIds', () => {
  it('walks the parent links to any depth and leaves out the session itself and its cousins', () => {
    const sessions = [
      { id: SELF },
      { id: KID, parent: SELF },
      { id: GRANDKID, parent: KID },
      { id: 'cousin', parent: 'elsewhere' },
    ];
    expect([...descendantSessionIds(sessions, SELF)].sort()).toEqual([KID, GRANDKID]);
    expect(descendantSessionIds(sessions, 'cousin').size).toBe(0);
  });
});

describe('chatCards', () => {
  it('puts the focus card first, then owned cards by lane order, then the sub-ferrets’ cards', async () => {
    const tasks = chatTasks(await board(), who());
    expect(tasks.focus?.task.id).toBe('F18');
    expect(tasks.owned.map(group => [group.laneName, ids(group.cards.map(c => ({ card: c })))])).toEqual([
      ['Todo', ['F21']],
      ['Review/CI', ['F20']],
    ]);
    expect(ids(tasks.children)).toEqual(['F30', 'F31', 'F32']);
  });

  it('draws a sub-ferret card under its parent when the parent is among them', async () => {
    const tasks = chatTasks(await board(), who());
    expect(tasks.children.map(row => [row.card.task.id, row.depth])).toEqual([
      ['F30', 0],
      ['F31', 1],
      ['F32', 0],
    ]);
  });

  it('counts every card once, and never another ferret’s', async () => {
    const tasks = chatTasks(await board(), who());
    expect(tasks.total).toBe(6);
    const drawn = [
      tasks.focus?.task.id,
      ...tasks.owned.flatMap(g => g.cards.map(c => c.task.id)),
      ...ids(tasks.children),
    ];
    expect(drawn).not.toContain('F99');
    expect(new Set(drawn).size).toBe(drawn.length);
  });

  it('shows owned cards without a focus when the session has none', async () => {
    const tasks = chatTasks(await board(), who({ focus: null }));
    expect(tasks.focus).toBeNull();
    expect(tasks.owned.flatMap(group => group.cards.map(c => c.task.id)).sort()).toEqual(['F18', 'F20', 'F21']);
  });

  it('shows no focus when the focus names a card the board does not hold, and still lists what it owns', async () => {
    const tasks = chatTasks(await board(), who({ focus: { id: 'F404' } }));
    expect(tasks.focus).toBeNull();
    expect(tasks.owned.flatMap(group => group.cards.map(c => c.task.id)).sort()).toEqual(['F18', 'F20', 'F21']);
    expect(tasks.total).toBe(6);
  });

  it('is empty for a ferret that owns nothing and has no sub-ferrets', async () => {
    const tasks = chatTasks(await board(), who({ sessionId: 'nobody-here', focus: null, relatives: new Set() }));
    expect(tasks.total).toBe(0);
    expect(tasks.owned).toEqual([]);
    expect(tasks.children).toEqual([]);
  });

  it('ignores a card of the same id held on another machine', async () => {
    const tasks = chatTasks(await board(), who({ daemonId: workstation.daemonId }));
    expect(tasks.total).toBe(0);
  });
});

describe('chatCards lanes (the Kanban)', () => {
  const lanesOf = (tasks: ReturnType<typeof chatTasks>) =>
    tasks.lanes.map(lane => [lane.name, lane.category, lane.cards.map(c => c.task.id).sort()]);

  it('has one column per lane that holds a drawn card, in lane order, each card once', async () => {
    const tasks = chatTasks(await board(), who());
    expect(lanesOf(tasks)).toEqual([
      ['Todo', 'backlog', ['F21', 'F32']],
      ['Plan/Design', 'active', ['F18']],
      ['Implement', 'active', ['F30', 'F31']],
      ['Review/CI', 'review', ['F20']],
    ]);
    expect(tasks.lanes.reduce((sum, lane) => sum + lane.cards.length, 0)).toBe(tasks.total);
  });

  it('never carries an empty lane or another ferret’s card', async () => {
    const tasks = chatTasks(await board(), who());
    expect(tasks.lanes.every(lane => lane.cards.length > 0)).toBe(true);
    expect(tasks.lanes.flatMap(lane => lane.cards.map(c => c.task.id))).not.toContain('F99');
  });

  it('keeps a card the project has no lanes for in an Unplaced column', async () => {
    const model = await boardModelOf([boardTask('F40', { owner: SELF, laneId: 'gone-lane' })]);
    const tasks = chatTasks(model, who({ focus: null }));
    expect(lanesOf(tasks)).toEqual([['Unplaced', null, ['F40']]]);
  });

  it('is empty when the ferret has nothing', async () => {
    const tasks = chatTasks(await board(), who({ sessionId: 'nobody-here', focus: null, relatives: new Set() }));
    expect(tasks.lanes).toEqual([]);
  });
});

describe('chatDrawn and chatSiblings', () => {
  it('lists the focus, then the owned cards, then the sub-ferrets’ cards, once each', async () => {
    const tasks = chatTasks(await board(), who());
    expect(chatDrawn(tasks).map(c => c.task.id)).toEqual(['F18', 'F21', 'F20', 'F30', 'F31', 'F32']);
  });

  it('gives the drawer each drawn card with its lane’s name', async () => {
    const tasks = chatTasks(await board(), who());
    const siblings = chatSiblings(tasks);
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
  });

  it('names the card, its lane and how it is doing', async () => {
    const model = await boardModelOf([boardTask('F18', { owner: SELF, laneId: 'plan', title: 'Board system' })]);
    const tasks = chatTasks(model, who());
    const found = tasks.focus;
    const chip = chatChip(focus, found, found === null ? undefined : tasks.places.get(found.key), 'ready');
    expect(chip).toMatchObject({
      kind: 'card',
      ref: formatTaskRef(focus),
      title: 'Board system',
      lane: 'Plan/Design',
      activity: 'active',
      tone: 'ok',
    });
    if (chip.kind !== 'card') throw new Error('expected a card chip');
    expect(chatTaskLabel(chip)).toBe('&F18 (Plan/Design)');
  });

  it.each([
    ['idle', 'quiet'],
    ['stale', 'warn'],
    ['orphaned', 'err'],
  ] as const)('tones a %s card %s', async (activity, tone) => {
    const model = await boardModelOf([boardTask('F18', { owner: SELF, activity })]);
    const tasks = chatTasks(model, who());
    const chip = chatChip(focus, tasks.focus, undefined, 'ready');
    expect(chip).toMatchObject({ kind: 'card', activity, tone });
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
    expect(chatTaskLabel(closed)).toBe('&F18');
  });
});

describe('chatCards and "Internal"', () => {
  // The chat reads every task (the chip must find a sub-ferret's own focus); what it draws is chatTasks'.
  const everyTask = (tasks: Parameters<typeof boardModelOf>[0]) =>
    boardModelOf(tasks, { ...NO_BOARD_FILTERS, agents: true });
  const mixed = () =>
    everyTask([
      originTask('F18', 'human', null, { owner: SELF, laneId: 'plan' }),
      originTask('F20', 'agent', { id: 'F18' }, { owner: SELF, laneId: 'plan', parent: { id: 'F18' } }),
      originTask('F21', 'human', null, { owner: SELF, laneId: 'plan' }),
      originTask('F30', 'agent', null, { owner: KID, laneId: 'implement' }),
      originTask('F31', 'human', null, { owner: KID, laneId: 'implement' }),
    ]);
  const drawn = (tasks: ReturnType<typeof chatTasks>) => chatDrawn(tasks).map(c => c.task.id);

  it('draws only the owner’s own cards until agent tasks are on, and counts what it hides', async () => {
    const tasks = chatTasks(await mixed(), who());
    expect(drawn(tasks)).toEqual(['F18', 'F21', 'F31']);
    expect(tasks.total).toBe(3);
    expect(tasks.hiddenAgents).toBe(2);
    expect(tasks.under.size).toBe(0);
  });

  it('draws the agent cards too when they are on, each right under the human card it serves', async () => {
    const tasks = chatTasks(await mixed(), who({ agents: true }));
    expect(tasks.total).toBe(5);
    expect(tasks.hiddenAgents).toBe(0);
    expect(tasks.lanes.find(lane => lane.name === 'Plan/Design')?.cards.map(c => c.task.id)).toEqual([
      'F18',
      'F20',
      'F21',
    ]);
    expect([...tasks.under]).toEqual([tasks.lanes[0]?.cards[1]?.key ?? '']);
    expect(drawn(tasks)).toContain('F30');
  });

  it('still finds the focus card for the chip when it is an agent card that is not drawn', async () => {
    const tasks = chatTasks(await mixed(), who({ focus: { id: 'F20' } }));
    expect(tasks.focus?.task.id).toBe('F20');
    expect(tasks.shownFocus).toBeNull();
    expect(drawn(tasks)).not.toContain('F20');
    expect(chatChip({ id: 'F20' }, tasks.focus, undefined, 'ready')).toMatchObject({ kind: 'card', title: 'Card F20' });
  });

  it('draws a focus card that is a human card', async () => {
    const tasks = chatTasks(await mixed(), who());
    expect(tasks.shownFocus?.task.id).toBe('F18');
  });

  it('draws a top-level ferret’s cards the owner asked for in its chat, though no owner message proves the ask', async () => {
    // Shaped like the owner's report: a top-level lead's tasks are `origin: human` (only the owner talks in its
    // chat), but the daemon stored `askedBy: agent` where the ask's words did not match an owner message.
    const filed = (id: string, laneId: string, extra: Record<string, unknown> = {}) =>
      boardTask(id, { owner: SELF, laneId, origin: 'human', askedBy: 'agent', ...extra });
    const model = await everyTask([
      filed('F137', 'todo', { askedBy: 'person' }),
      filed('F246', 'todo', { askedBy: 'person', parent: { id: 'F240' } }),
      filed('I7', 'todo', { kind: 'infra' }),
      filed('F240', 'implement'),
      filed('F568', 'implement'),
      filed('F559', 'implement', { askedBy: 'person' }),
      filed('F304', 'merged'),
      filed('F283', 'released'),
      filed('F291', 'released', { askedBy: 'person' }),
      originTask('F144', 'agent', null, { owner: SELF, laneId: 'released' }),
    ]);
    const tasks = chatTasks(model, who({ focus: null }));
    expect(drawn(tasks).sort()).toEqual(['F137', 'F240', 'F246', 'F283', 'F291', 'F304', 'F559', 'F568', 'I7']);
    expect(tasks.total).toBe(9);
    expect(tasks.hiddenAgents).toBe(1);
    expect(tasks.lanes.map(lane => [lane.name, lane.cards.map(c => c.task.id).sort()])).toEqual([
      ['Todo', ['F137', 'F246', 'I7']],
      ['Implement', ['F240', 'F559', 'F568']],
      ['Merged', ['F304']],
      ['Released', ['F283', 'F291']],
    ]);
  });

  it('hides a sub-card the owner’s lead made for itself (origin human, askedBy agent) like the Board does, and keeps its top-level sibling', async () => {
    const both = (id: string, extra: Record<string, unknown> = {}) =>
      boardTask(id, { owner: SELF, laneId: 'todo', origin: 'human', askedBy: 'agent', ...extra });
    const model = await everyTask([both('F1'), both('F2', { parent: { id: 'F1' } }), both('F3')]);
    const off = chatTasks(model, who({ focus: null }));
    expect(drawn(off).sort()).toEqual(['F1', 'F3']);
    expect(off.total).toBe(2);
    expect(off.hiddenAgents).toBe(1);
    const on = chatTasks(model, who({ focus: null, agents: true }));
    expect(drawn(on).sort()).toEqual(['F1', 'F2', 'F3']);
    expect(on.hiddenAgents).toBe(0);
  });

  it('shows every card of an older daemon, which says nothing of who asked', async () => {
    const tasks = chatTasks(await board(), who());
    expect(tasks.total).toBe(6);
    expect(tasks.hiddenAgents).toBe(0);
  });

  it('carries each column’s board and lane id so a drop can be placed', async () => {
    const tasks = chatTasks(await mixed(), who());
    expect(tasks.lanes.every(lane => lane.laneId !== null && lane.groupKey !== '')).toBe(true);
    const model = await boardModelOf([boardTask('F40', { owner: SELF, laneId: 'gone-lane' })]);
    expect(chatTasks(model, who({ focus: null })).lanes[0]).toMatchObject({ laneId: null });
  });
});
