import { describe, it } from 'bun:test';
import type { CardActor, Card, CardEvent, CardView } from '../../../contract/index.ts';
import should from 'should';
import {
  BoardSweep,
  type BoardSweepPorts,
  EMPTY_SWEEP_MEMORY,
  formatIdle,
  nudgeMessage,
  nudgeRecipient,
  planSweep,
  type FerretRoster,
  type SweepBoard,
  type SweepMemory,
  type SweepMemoryStore,
} from '../../../daemon/lib/board/index.ts';
import { card, FakeSessions, lanes, liveSession, NOW, PROJECT, rosterOf } from './support.ts';

const NOW_MS = Date.parse(NOW);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ago = (ms: number): string => new Date(NOW_MS - ms).toISOString();
const EARLIER = ago(MINUTE);

const laneSets = new Map([[PROJECT, lanes(PROJECT)]]);
const ferret = (ferret: string): CardActor => ({ kind: 'ferret', ferret });

const view = (stored: Partial<Card> = {}, derived: Partial<CardView> = {}): CardView => ({
  ...card(stored),
  lastTouchedAt: null,
  touchedBy: null,
  activity: 'idle',
  rollup: {
    children: 0,
    byCategory: { backlog: 0, active: 0, review: 0, shipped: 0, verify: 0, closed: 0 },
    active: 0,
    lastTouchedAt: null,
  },
  suggestedLane: null,
  
  openAsks: [],
  blockedBy: [],
  blocks: [],
  shippedIn: null,
  ...derived,
});

const board = (...views: CardView[]): SweepBoard => ({ views, laneSets });

const created = (at = ago(HOUR)): CardEvent => ({
  seq: 1,
  at,
  actor: ferret('lead'),
  type: 'created',
  laneId: 'todo',
});

/** An event before the card numbers it. Distributed, so each event type keeps its own fields. */
type EventInput = CardEvent extends infer Event ? (Event extends unknown ? Omit<Event, 'seq'> : never) : never;

/** The child card of the lead's card F1, worked by `child`, with these events after its creation. */
const childCard = (events: readonly EventInput[], stored: Partial<Card> = {}): Card => ({
  ...card({ id: 'F2', parent: { id: 'F1' }, assignee: 'child', laneId: 'implement', ...stored }),
  history: [created(), ...events.map((event, index) => ({ ...event, seq: index + 2 }) as CardEvent)],
});

const leadCard = view({ id: 'F1', laneId: 'plan' });

const everyone = rosterOf(['lead', 'child', 'other'].map(id => liveSession(id)));

/** A memory that has seen the child card up to its creation, with nothing blocking it. */
const sawChild = (mark: Partial<SweepMemory['seen'][string]> = {}): SweepMemory => ({
  format: 1,
  sweptAt: EARLIER,
  nudged: {},
  seen: { F1: { blockedBy: [] }, F2: { blockedBy: [], ...mark } },
});

/** Every message a plan sends, as `recipient: text`. */
const sentTexts = (memory: SweepMemory, swept: SweepBoard, roster: FerretRoster = everyone) =>
  planSweep(memory, swept, roster, NOW).nudges.map(each => `${each.ferret}: ${each.message}`);

describe('the nudge words', () => {
  it('should say an idle span the way the owner reads it', () => {
    // Assert
    should([30_000, 59 * MINUTE, 3 * HOUR, 47 * HOUR, 72 * HOUR].map(formatIdle)).eql(['1m', '59m', '3h', '47h', '3d']);
  });

  it('should name the card, how long and the lane, as a plain sentence with no tag', () => {
    // Assert
    should(nudgeMessage({ id: 'F412' }, 3 * HOUR, 'Implement')).equal(
      '&F412 has had no activity for 3h in Implement. Move it, note why, block it, or drop it.',
    );
  });
});

describe('who a stale card nudges', () => {
  const stale = (stored: Partial<Card> = {}) => view({ assignee: 'child', ...stored }, { activity: 'stale' });

  it('should nudge a live assignee, busy or idle, and nobody while it declared a wait', () => {
    // Arrange
    const busy = rosterOf([liveSession('lead'), liveSession('child', { status: 'working' })]);

    // Assert
    should(nudgeRecipient(stale(), everyone)).equal('child');
    should(nudgeRecipient(stale(), busy)).equal('child');
    should(
      nudgeRecipient(stale(), rosterOf([liveSession('lead'), liveSession('child', { declaredWait: true })])),
    ).be.null();
  });

  it('should nudge the assignee’s nearest live lead when the assignee ended, and the owner only after that', () => {
    // Arrange
    const line = (alive: readonly string[]) =>
      rosterOf(
        [
          liveSession('boss'),
          liveSession('lead', { lead: 'boss' }),
          liveSession('child', { lead: 'lead' }),
          liveSession('grand', { lead: 'child' }),
        ].map(session => (alive.includes(session.id) ? session : { ...session, status: 'stopped' as const })),
      );
    const card = stale({ owner: 'boss', assignee: 'grand' });

    // Assert
    should(nudgeRecipient(card, line(['grand', 'child', 'lead', 'boss']))).equal('grand');
    should(nudgeRecipient(card, line(['child', 'lead', 'boss']))).equal('child');
    should(nudgeRecipient(card, line(['lead', 'boss']))).equal('lead');
    should(nudgeRecipient(card, line(['boss']))).equal('boss');
    should(nudgeRecipient(card, line([]))).be.null();
  });

  it('should reach the owner only when nobody in the assignee’s line is alive', () => {
    // Arrange
    const roster = rosterOf([liveSession('lead'), liveSession('child', { status: 'stopped' })]);

    // Assert
    should(nudgeRecipient(stale(), roster)).equal('lead');
    should(nudgeRecipient(stale(), rosterOf([liveSession('lead', { declaredWait: true })]))).be.null();
    should(nudgeRecipient(stale({ assignee: null }), rosterOf([liveSession('lead', { status: 'working' })]))).equal(
      'lead',
    );
  });

  it('should keep an interactive creator for last, and never skip past it to a dead line', () => {
    // Arrange
    const owner = liveSession('lizzette', { interactive: true });
    const card = stale({ owner: 'lizzette', assignee: 'child' });

    // Assert
    should(nudgeRecipient(card, rosterOf([owner, liveSession('child', { lead: 'lizzette' })]))).equal('child');
    should(
      nudgeRecipient(
        card,
        rosterOf([owner, liveSession('child', { lead: 'sub-lead', status: 'stopped' }), liveSession('sub-lead')]),
      ),
    ).equal('sub-lead');
    should(
      nudgeRecipient(card, rosterOf([owner, liveSession('child', { lead: 'lizzette', status: 'stopped' })])),
    ).equal('lizzette');
    should(nudgeRecipient(card, rosterOf([liveSession('child', { lead: 'lizzette', status: 'stopped' })]))).be.null();
  });

  it('should nudge nobody when the assignee is unreadable', () => {
    // Assert
    should(nudgeRecipient(stale(), rosterOf([liveSession('lead')], ['child']))).be.null();
  });
});

describe('the sweep plan: nudges', () => {
  const staleCard = (stored: Partial<Card> = {}, derived: Partial<CardView> = {}) =>
    view(
      { laneId: 'implement', createdAt: ago(5 * HOUR), ...stored },
      { activity: 'stale', lastTouchedAt: ago(3 * HOUR), ...derived },
    );

  it('should nudge a stale card once per its lane threshold, and remember when', () => {
    // Arrange
    const memory = { ...EMPTY_SWEEP_MEMORY, nudged: { F1: ago(HOUR), F2: ago(3 * HOUR) } };
    const swept = board(
      staleCard({ id: 'F1' }),
      staleCard({ id: 'F2' }),
      staleCard({ id: 'F3' }, { lastTouchedAt: null }),
    );

    // Act
    const plan = planSweep(memory, swept, everyone, NOW);

    // Assert
    should(plan.nudges).eql([
      { kind: 'stale', cardId: 'F2', ferret: 'lead', message: nudgeMessage({ id: 'F2' }, 3 * HOUR, 'Implement') },
      { kind: 'stale', cardId: 'F3', ferret: 'lead', message: nudgeMessage({ id: 'F3' }, 5 * HOUR, 'Implement') },
    ]);
    should(plan.memory.nudged).eql({ F1: ago(HOUR), F2: ago(3 * HOUR) });
    should(plan.memory.sweptAt).equal(NOW);
  });

  it('should nudge nobody for a card that is not stale, has no threshold, or has nobody to tell', () => {
    // Arrange
    const swept = board(
      staleCard({ id: 'F1' }, { activity: 'idle' }),
      staleCard({ id: 'F2' }, { activity: 'active' }),
      staleCard({ id: 'F3', laneId: 'tested' }),
      staleCard({ id: 'F4', laneId: 'nowhere' }),
      staleCard({ id: 'F5', assignee: 'child' }),
    );

    // Act
    const plan = planSweep(EMPTY_SWEEP_MEMORY, swept, rosterOf([liveSession('child', { declaredWait: true })]), NOW);

    // Assert
    should(plan.nudges).eql([]);
  });

  it('should forget closed, dropped and vanished cards, and keep what it saw of the open ones', () => {
    // Arrange
    const memory: SweepMemory = {
      format: 1,
      sweptAt: EARLIER,
      nudged: { F1: EARLIER, F2: EARLIER, F3: EARLIER, F9: EARLIER },
      seen: {},
    };
    const swept = board(
      view(
        { id: 'F1', laneId: 'implement' },
        { blockedBy: [{ id: 'F7' }] },
      ),
      view({ id: 'F2', laneId: 'closed' }),
      view({ id: 'F3', dropped: { reason: 'superseded', at: EARLIER } }),
    );

    // Act
    const plan = planSweep(memory, swept, everyone, NOW);

    // Assert
    should(plan.memory.nudged).eql({ F1: EARLIER });
    should(plan.memory.seen).eql({ F1: { blockedBy: ['/F7'] } });
  });
});

describe('the sweep plan: no news', () => {
  it("should send nobody a child card's moves, blocks, unblocks, reopens, drops, dones or asks", () => {
    // Arrange
    const moved = (from: string, to: string, extra: Partial<Extract<EventInput, { type: 'moved' }>> = {}) =>
      ({
        at: EARLIER,
        actor: ferret('child'),
        type: 'moved',
        from,
        to,
        backward: false,
        reason: null,
        ...extra,
      }) as const;
    const child = view(
      childCard(
        [
          moved('todo', 'implement'),
          { at: EARLIER, actor: ferret('child'), type: 'blocked', reason: 'vendor' },
          { at: EARLIER, actor: ferret('child'), type: 'unblocked', reason: null },
          {
            at: EARLIER,
            actor: { kind: 'owner' },
            type: 'reopened',
            from: 'review',
            to: 'implement',
            reason: 'not good',
            ask: { text: 'again', source: 'owner' },
          },
          moved('implement', 'review', { auto: true, trigger: 'signal.done', reason: 'done: shipped it' }),
          moved('review', 'merged', { auto: true, trigger: 'pr.merged' }),
        ],
        { laneId: 'review' },
      ),
      { blockedBy: [{ id: 'F9' }] },
    );
    const dropped = view(
      childCard([{ at: EARLIER, actor: ferret('child'), type: 'dropped', reason: 'superseded' }], {
        id: 'F3',
        dropped: { reason: 'superseded', at: EARLIER },
      }),
    );
    const fresh = view(childCard([moved('todo', 'implement')], { id: 'F4', createdAt: NOW }));

    // Act
    const plan = planSweep(
      { ...sawChild(), seen: { ...sawChild().seen, F3: { blockedBy: [] } } },
      board(leadCard, child, dropped, fresh),
      everyone,
      NOW,
    );

    // Assert
    should(plan.nudges).eql([]);
    should(plan.memory.seen).eql({ F1: { blockedBy: [] }, F2: { blockedBy: ['/F9'] }, F4: { blockedBy: [] } });
  });
});

describe('the sweep plan: a go-ahead once the last blocker ships', () => {
  const blockedChild = () =>
    view(
      childCard([], {
        dependsOn: [
          { task: { id: 'F9' }, until: 'shipped' },
          { task: { id: 'F8' }, until: 'released' },
          { task: { id: 'F7', machineId: 'mac' }, until: 'shipped' },
          { task: { id: 'F6' }, until: 'shipped', override: { by: 'owner', reason: 'fine', at: EARLIER } },
          { task: { id: 'F5' }, until: 'shipped' },
          { task: { id: 'F4' }, until: 'shipped' },
          { task: { id: 'F3' }, until: 'shipped' },
        ],
      }),
    );
  const blockers = [
    view({ id: 'F9', laneId: 'merged' }),
    view({ id: 'F8', laneId: 'released' }, { shippedIn: { version: '4.110.0', tag: 'v4.110.0', at: EARLIER } }),
    view({ id: 'F4', laneId: 'implement' }),
    view({ id: 'F3', projectId: '33333333-3333-4333-8333-333333333333' }),
  ];
  const wasBlocked = sawChild({ blockedBy: ['/F9', '/F8', 'mac/F7', '/F6', '/F5', '/F4', '/F3'] });

  it("should tell only the dependent card's assignee it can go ahead, naming what shipped", () => {
    // Act
    const plan = planSweep(wasBlocked, board(leadCard, blockedChild(), ...blockers), everyone, NOW);

    // Assert
    should(plan.nudges).eql([
      { kind: 'unblocked', cardId: 'F2', ferret: 'child', message: '&F2 can go ahead: &F9 merged, &F8 released.' },
    ]);
  });

  it('should tell nobody when the blockers left without shipping, the assignee is gone, or nothing changed', () => {
    // Arrange
    const unshipped = view(childCard([], { dependsOn: [] }));
    const stillBlocked = view(childCard([]), { blockedBy: [{ id: 'F9' }] });
    const swept = board(leadCard, blockedChild(), ...blockers);

    // Assert
    should(sentTexts(sawChild({ blockedBy: ['/F9'] }), board(leadCard, unshipped))).eql([]);
    should(sentTexts(wasBlocked, swept, rosterOf([liveSession('lead')]))).eql([]);
    should(sentTexts(sawChild({ blockedBy: ['/F9'] }), board(leadCard, stillBlocked))).eql([]);
    should(sentTexts(EMPTY_SWEEP_MEMORY, swept)).eql([]);
  });
});

// ---------------------------------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------------------------------

class MemoryStore implements SweepMemoryStore {
  written: SweepMemory[] = [];

  constructor(public current: SweepMemory = EMPTY_SWEEP_MEMORY) {}

  async read(): Promise<SweepMemory> {
    return this.current;
  }

  async write(memory: SweepMemory): Promise<void> {
    this.written.push(memory);
    this.current = memory;
  }
}

const tickWorld = (swept: SweepBoard, memory: SweepMemory, failing: ReadonlySet<string> = new Set()) => {
  const sent: { ferret: string; message: string }[] = [];
  const warnings: string[] = [];
  const store = new MemoryStore(memory);
  const ports: BoardSweepPorts = {
    board: { sweepBoard: async () => swept, closeEndedHelper: async () => false, returnToLead: async () => false },
    sessions: new FakeSessions(everyone),
    guard: new FakeSessions(everyone),
    memory: store,
    nudges: {
      send: async (ferret, message) => {
        if (failing.has(ferret)) throw new Error('composer busy');
        sent.push({ ferret, message });
      },
    },
    clock: { now: () => NOW },
    diagnostics: { warn: message => warnings.push(message) },
  };
  return { sweep: new BoardSweep(ports), sent, warnings, store };
};

describe('the board sweep tick', () => {
  const stale = (id: string, assignee: string) =>
    view({ id, assignee, laneId: 'implement' }, { activity: 'stale', lastTouchedAt: ago(3 * HOUR) });
  const unblocked = () =>
    view(childCard([], { dependsOn: [{ task: { id: 'F9' }, until: 'shipped' }] }), { blockedBy: [] });

  it('should send each nudge as it is, the go-ahead too, and remember the stale nudge', async () => {
    // Arrange
    const child = view(
      childCard([{ at: EARLIER, actor: ferret('child'), type: 'blocked', reason: 'vendor' }], {
        dependsOn: [{ task: { id: 'F9' }, until: 'shipped' }],
      }),
    );
    const { sweep, sent, store } = tickWorld(
      board(leadCard, child, view({ id: 'F9', laneId: 'merged' }), stale('F5', 'lead')),
      sawChild({ blockedBy: ['/F9'] }),
    );

    // Act
    const report = await sweep.tick();

    // Assert
    should(report).eql({ nudged: ['F5'], unblocked: ['F2'], closed: [], returned: [] });
    should(sent).eql([
      { ferret: 'child', message: '&F2 can go ahead: &F9 merged.' },
      { ferret: 'lead', message: nudgeMessage({ id: 'F5' }, 3 * HOUR, 'Implement') },
    ]);
    should(store.current.nudged).eql({ F5: NOW });
    should(store.current.seen.F2).eql({ blockedBy: [] });
    should(store.current.sweptAt).equal(NOW);
  });

  it('should report what it could not send and carry on, so an unsent nudge or go-ahead is tried again', async () => {
    // Arrange
    const world = tickWorld(
      board(leadCard, unblocked(), view({ id: 'F9', laneId: 'merged' }), stale('F5', 'other'), stale('F6', 'lead')),
      sawChild({ blockedBy: ['/F9'] }),
      new Set(['other', 'child']),
    );

    // Act
    const report = await world.sweep.tick();

    // Assert
    should(report).eql({ nudged: ['F6'], unblocked: [], closed: [], returned: [] });
    should(world.warnings).eql([
      'could not nudge child about &F2: composer busy',
      'could not nudge other about &F5: composer busy',
    ]);
    should(world.store.current.nudged).eql({ F6: NOW });
    should(world.store.current.seen.F2).eql({ blockedBy: ['/F9'] });
  });

  it('should do nothing in a tick that overlaps a running one', async () => {
    // Arrange
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const world = tickWorld(board(), EMPTY_SWEEP_MEMORY);
    const read = world.store.read.bind(world.store);
    world.store.read = async () => {
      await gate;
      return await read();
    };

    // Act
    const first = world.sweep.tick();
    const second = await world.sweep.tick();
    release();
    await first;
    const third = await world.sweep.tick();

    // Assert
    should(second).eql({ nudged: [], unblocked: [], closed: [], returned: [] });
    should(third).eql({ nudged: [], unblocked: [], closed: [], returned: [] });
    should(world.store.written).have.length(2);
  });
});
