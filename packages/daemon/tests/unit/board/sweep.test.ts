import { describe, it } from 'bun:test';
import type { BoardActor, BoardTask, BoardTaskEvent, BoardTaskView, PrLink } from '@ferretry/protocol';
import should from 'should';
import {
  BoardSweep,
  type BoardSweepPorts,
  EMPTY_SWEEP_MEMORY,
  formatIdle,
  leadOf,
  mergeQuietItems,
  nudgeMessage,
  nudgeRecipient,
  type PendingContextQueue,
  planSweep,
  type QuietItem,
  type SessionRoster,
  type SweepBoard,
  type SweepMemory,
  type SweepMemoryStore,
} from '../../../src/lib/board/index.ts';
import { card, FakeSessions, lanes, liveSession, MACHINE, NOW, PROJECT, rosterOf } from './support.ts';

const NOW_MS = Date.parse(NOW);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ago = (ms: number): string => new Date(NOW_MS - ms).toISOString();
const EARLIER = ago(MINUTE);

const laneSets = new Map([[PROJECT, lanes(PROJECT)]]);
const ferret = (sessionId: string): BoardActor => ({ kind: 'ferret', sessionId });

const view = (stored: Partial<BoardTask> = {}, derived: Partial<BoardTaskView> = {}): BoardTaskView => ({
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
  waitingOnOwner: [],
  openAsks: [],
  blockedBy: [],
  blocks: [],
  shippedIn: null,
  ...derived,
});

const board = (...views: BoardTaskView[]): SweepBoard => ({ views, laneSets });

const created = (at = ago(HOUR)): BoardTaskEvent => ({
  seq: 1,
  at,
  actor: ferret('lead'),
  type: 'created',
  laneId: 'todo',
});

/** An event before the card numbers it. Distributed, so each event type keeps its own fields. */
type EventInput = BoardTaskEvent extends infer Event ? (Event extends unknown ? Omit<Event, 'seq'> : never) : never;

/** The child card of the lead's card F1, worked by `child`, with these events after its creation. */
const childCard = (events: readonly EventInput[], stored: Partial<BoardTask> = {}): BoardTask => ({
  ...card({ id: 'F2', parent: { id: 'F1' }, assignee: 'child', laneId: 'implement', ...stored }),
  history: [created(), ...events.map((event, index) => ({ ...event, seq: index + 2 }) as BoardTaskEvent)],
});

const leadCard = view({ id: 'F1', laneId: 'plan' });

const everyone = rosterOf(['lead', 'child', 'other'].map(id => liveSession(id)));

/** A memory that has seen the child card up to its creation, with nothing blocking it. */
const sawChild = (mark: Partial<SweepMemory['seen'][string]> = {}): SweepMemory => ({
  v: 1,
  sweptAt: EARLIER,
  nudged: {},
  seen: { F1: { seq: 1, blockedBy: [], waiting: [] }, F2: { seq: 1, blockedBy: [], waiting: [], ...mark } },
});

const pr = (): PrLink => ({
  url: 'https://github.com/kirinnee/ferretry/pull/930',
  number: 930,
  repo: 'kirinnee/ferretry',
  state: 'open',
  draft: false,
  checks: 'pending',
  mergedAt: null,
  mergeSha: null,
  releasedIn: null,
  polledAt: NOW,
});

const quietTexts = (memory: SweepMemory, swept: SweepBoard, roster: SessionRoster = everyone) =>
  planSweep(memory, swept, roster, NOW).quiet.map(each => `${each.sessionId}: ${each.item.text} [${each.item.key}]`);

describe('the nudge words', () => {
  it('should say an idle span the way the owner reads it', () => {
    // Assert
    should([30_000, 59 * MINUTE, 3 * HOUR, 47 * HOUR, 72 * HOUR].map(formatIdle)).eql(['1m', '59m', '3h', '47h', '3d']);
  });

  it('should name the card, how long and the lane', () => {
    // Assert
    should(nudgeMessage({ id: 'F412' }, 3 * HOUR, 'Implement')).equal(
      '[board] &F412 untouched 3h in Implement — move it, note why, block it, or drop it',
    );
  });
});

describe('who a stale card nudges', () => {
  const stale = (stored: Partial<BoardTask> = {}) => view({ assignee: 'child', ...stored }, { activity: 'stale' });

  it('should nudge an idle assignee, and nobody while it declared a wait', () => {
    // Assert
    should(nudgeRecipient(stale(), everyone)).equal('child');
    should(
      nudgeRecipient(stale(), rosterOf([liveSession('lead'), liveSession('child', { declaredWait: true })])),
    ).be.null();
  });

  it('should nudge the owner instead when the assignee is busy on another card or gone', () => {
    // Arrange
    const busy = rosterOf([liveSession('lead'), liveSession('child', { status: 'thinking' })]);
    const gone = rosterOf([liveSession('lead')]);

    // Assert
    should(nudgeRecipient(stale(), busy)).equal('lead');
    should(nudgeRecipient(stale(), gone)).equal('lead');
  });

  it('should nudge nobody when the owner is the busy assignee, is gone, waits, or the assignee is unreadable', () => {
    // Assert
    should(
      nudgeRecipient(stale({ assignee: null }), rosterOf([liveSession('lead', { status: 'thinking' })])),
    ).be.null();
    should(nudgeRecipient(stale(), rosterOf([liveSession('child', { status: 'thinking' })]))).be.null();
    should(
      nudgeRecipient(
        stale(),
        rosterOf([liveSession('lead', { status: 'stopped' }), liveSession('child', { status: 'thinking' })]),
      ),
    ).be.null();
    should(
      nudgeRecipient(
        stale(),
        rosterOf([liveSession('lead', { declaredWait: true }), liveSession('child', { turnState: 'working' })]),
      ),
    ).be.null();
    should(nudgeRecipient(stale(), rosterOf([liveSession('lead')], ['child']))).be.null();
  });
});

describe('the sweep plan: nudges', () => {
  const staleCard = (stored: Partial<BoardTask> = {}, derived: Partial<BoardTaskView> = {}) =>
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
      { taskId: 'F2', sessionId: 'lead', message: nudgeMessage({ id: 'F2' }, 3 * HOUR, 'Implement') },
      { taskId: 'F3', sessionId: 'lead', message: nudgeMessage({ id: 'F3' }, 5 * HOUR, 'Implement') },
    ]);
    should(plan.memory.nudged).eql({ F1: ago(HOUR), F2: ago(3 * HOUR) });
    should(plan.memory.sweptAt).equal(NOW);
  });

  it('should nudge nobody for a card that is not stale, has no threshold, or has nobody to tell', () => {
    // Arrange
    const swept = board(
      staleCard({ id: 'F1' }, { activity: 'idle' }),
      staleCard({ id: 'F2' }, { activity: 'waiting' }),
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
      v: 1,
      sweptAt: EARLIER,
      nudged: { F1: EARLIER, F2: EARLIER, F3: EARLIER, F9: EARLIER },
      seen: {},
    };
    const swept = board(
      view(
        { id: 'F1', laneId: 'implement' },
        { blockedBy: [{ id: 'F7' }], waitingOnOwner: [{ sessionId: 'lead', id: 'A3' }] },
      ),
      view({ id: 'F2', laneId: 'closed' }),
      view({ id: 'F3', dropped: { reason: 'superseded', at: EARLIER } }),
    );

    // Act
    const plan = planSweep(memory, swept, everyone, NOW);

    // Assert
    should(plan.memory.nudged).eql({ F1: EARLIER });
    should(plan.memory.seen).eql({ F1: { seq: 1, blockedBy: ['/F7'], waiting: ['lead/A3'] } });
  });
});

describe('the sweep plan: quiet events', () => {
  it('should take a board it has never seen as a baseline and say nothing', () => {
    // Arrange
    const child = view(childCard([{ at: EARLIER, actor: ferret('child'), type: 'note', text: 'hi' }]));

    // Assert
    should(quietTexts(EMPTY_SWEEP_MEMORY, board(leadCard, child))).eql([]);
  });

  it("should tell the lead of a child card's moves, blocks, unblocks, reopens and drops since it last looked", () => {
    // Arrange
    const child = childCard(
      [
        {
          at: EARLIER,
          actor: ferret('child'),
          type: 'moved',
          from: 'todo',
          to: 'implement',
          backward: false,
          reason: null,
        },
        { at: EARLIER, actor: ferret('child'), type: 'note', text: 'progress' },
        { at: EARLIER, actor: ferret('child'), type: 'blocked', reason: 'waiting on\nthe vendor' },
        { at: EARLIER, actor: ferret('child'), type: 'unblocked', reason: null },
        {
          at: EARLIER,
          actor: { kind: 'owner' },
          type: 'reopened',
          from: 'review',
          to: 'implement',
          reason: 'x'.repeat(100),
          ask: { text: 'again', source: 'owner' },
        },
        {
          at: EARLIER,
          actor: ferret('lead'),
          type: 'moved',
          from: 'implement',
          to: 'review',
          backward: false,
          reason: null,
        },
      ],
      { laneId: 'review' },
    );

    // Act
    const texts = quietTexts(sawChild(), board(leadCard, view(child)));

    // Assert
    should(texts).eql([
      'lead: &F2 → Implement [F2:lane]',
      'lead: &F2 blocked: waiting on the vendor [F2:block]',
      'lead: &F2 unblocked [F2:block]',
      `lead: &F2 reopened → Implement: ${'x'.repeat(79)}… [F2:lane]`,
    ]);
  });

  it('should name the PR when a PR trigger moved the card, and announce a drop before forgetting the card', () => {
    // Arrange
    const moved = childCard(
      [
        {
          at: EARLIER,
          actor: { kind: 'daemon' },
          type: 'moved',
          from: 'implement',
          to: 'review',
          backward: false,
          reason: null,
          auto: true,
          trigger: 'pr.opened',
        },
      ],
      { laneId: 'review', links: { prs: [pr()], branch: null, commits: [], docs: [] } },
    );
    const dropped = {
      ...childCard([{ at: EARLIER, actor: ferret('child'), type: 'dropped', reason: 'superseded by &F9' }], {
        id: 'F3',
        dropped: { reason: 'superseded by &F9', at: EARLIER },
      }),
    };
    const memory = { ...sawChild(), seen: { ...sawChild().seen, F3: { seq: 1, blockedBy: [], waiting: [] } } };

    // Act
    const plan = planSweep(memory, board(leadCard, view(moved), view(dropped)), everyone, NOW);

    // Assert
    should(plan.quiet.map(each => each.item.text)).eql(['&F2 → Review/CI (PR #930)', '&F3 dropped: superseded by &F9']);
    should(Object.keys(plan.memory.seen)).eql(['F1', 'F2']);
  });

  it("should leave a done move to the done's own quiet line", () => {
    // Arrange
    const done = childCard(
      [
        {
          at: EARLIER,
          actor: { kind: 'daemon' },
          type: 'moved',
          from: 'implement',
          to: 'review',
          backward: false,
          reason: 'shipped the sweep',
          auto: true,
          trigger: 'signal.done',
        },
      ],
      { laneId: 'review' },
    );

    // Act
    const plan = planSweep(sawChild(), board(leadCard, view(done)), everyone, NOW);

    // Assert
    should(plan.quiet).eql([]);
    should(plan.memory.seen['F2']?.seq).equal(2);
  });

  it('should read a card created since the last tick from its first event, and skip a closed one never seen', () => {
    // Arrange
    const fresh = childCard(
      [
        {
          at: NOW,
          actor: ferret('child'),
          type: 'moved',
          from: 'todo',
          to: 'implement',
          backward: false,
          reason: null,
          auto: undefined,
        },
      ],
      { createdAt: NOW },
    );
    const closed = view(childCard([], { id: 'F3', laneId: 'closed', createdAt: NOW }));
    const memory = { ...sawChild(), seen: { F1: { seq: 1, blockedBy: [], waiting: [] } } };

    // Assert
    should(quietTexts(memory, board(leadCard, view(fresh), closed))).eql(['lead: &F2 → Implement [F2:lane]']);
  });

  it('should tell the lead when a child starts waiting on a card or the owner', () => {
    // Arrange
    const child = view(childCard([]), {
      blockedBy: [{ id: 'F9' }, { id: 'F8', machineId: 'mac' }],
      waitingOnOwner: [
        { sessionId: 'child', id: 'A9' },
        { sessionId: 'child', id: 'A3' },
      ],
    });

    // Act
    const texts = quietTexts(sawChild({ waiting: ['child/A3'] }), board(leadCard, child));

    // Assert
    should(texts).eql(['lead: &F2 waiting on &F9, &F8 [F2:deps]', 'lead: &F2 waiting on owner (!A9) [F2:asks]']);
  });

  it('should tell the assignee and the lead once the last blocker ships, naming it', () => {
    // Arrange
    const child = view(
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
    const memory = sawChild({ blockedBy: ['/F9', '/F8', 'mac/F7', '/F6', '/F5', '/F4', '/F3'] });

    // Act
    const texts = quietTexts(memory, board(leadCard, child, ...blockers));

    // Assert
    should(texts).eql([
      'lead: &F2 unblocked: &F9 merged, &F8 released [F2:deps]',
      'child: &F2 unblocked: &F9 merged, &F8 released [F2:unblocked]',
    ]);
  });

  it('should tell only the lead when the blockers left without shipping', () => {
    // Arrange
    const child = view(childCard([], { dependsOn: [] }));

    // Assert
    should(quietTexts(sawChild({ blockedBy: ['/F9'] }), board(leadCard, child))).eql(['lead: &F2 unblocked [F2:deps]']);
  });

  it('should tell nobody about a top-level card, and nobody the roster does not hold', () => {
    // Arrange
    const top = view(
      childCard([{ at: EARLIER, actor: ferret('child'), type: 'blocked', reason: 'vendor' }], { parent: null }),
    );
    const child = view(childCard([{ at: EARLIER, actor: ferret('child'), type: 'blocked', reason: 'vendor' }]));

    // Assert
    should(quietTexts(sawChild(), board(leadCard, top))).eql([]);
    should(quietTexts(sawChild(), board(leadCard, child), rosterOf([liveSession('child')]))).eql([]);
  });
});

describe('the lead of a card', () => {
  it("should be the parent's ferret, the card's owner when the parent is elsewhere, and never the card's own ferret", () => {
    // Arrange
    const byId = new Map([
      ['F1', view({ id: 'F1', assignee: 'boss' })],
      ['F5', view({ id: 'F5', assignee: 'child' })],
    ]);

    // Assert
    should(leadOf(view({ id: 'F2', parent: { id: 'F1' }, assignee: 'child' }), byId)).equal('boss');
    should(leadOf(view({ id: 'F2', parent: { id: 'F1', machineId: MACHINE }, assignee: 'child' }), byId)).equal('boss');
    should(leadOf(view({ id: 'F2', parent: { id: 'F1', machineId: 'mac' }, assignee: 'child' }), byId)).equal('lead');
    should(leadOf(view({ id: 'F2', parent: { id: 'F404' }, assignee: 'child' }), byId)).equal('lead');
    should(leadOf(view({ id: 'F2', parent: { id: 'F5' }, assignee: 'child' }), byId)).be.null();
    should(leadOf(view({ id: 'F2', parent: null, assignee: 'child' }), byId)).be.null();
  });
});

// ---------------------------------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------------------------------

class MemoryContext implements PendingContextQueue {
  readonly held = new Map<string, readonly QuietItem[]>();
  failAppendFor: string | undefined;

  async append(sessionId: string, items: readonly QuietItem[]): Promise<void> {
    if (sessionId === this.failAppendFor) throw new Error('disk full');
    this.held.set(sessionId, mergeQuietItems(this.held.get(sessionId) ?? [], items));
  }

  async take(sessionId: string): Promise<readonly QuietItem[]> {
    const items = this.held.get(sessionId) ?? [];
    this.held.delete(sessionId);
    return items;
  }

  async restore(sessionId: string, items: readonly QuietItem[]): Promise<void> {
    this.held.set(sessionId, mergeQuietItems(items, this.held.get(sessionId) ?? []));
  }
}

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
  const sent: { sessionId: string; message: string }[] = [];
  const warnings: string[] = [];
  const context = new MemoryContext();
  const store = new MemoryStore(memory);
  const ports: BoardSweepPorts = {
    board: { sweepBoard: async () => swept },
    sessions: new FakeSessions(everyone),
    memory: store,
    quiet: context,
    context,
    nudges: {
      send: async (sessionId, message) => {
        if (failing.has(sessionId)) throw new Error('composer busy');
        sent.push({ sessionId, message });
      },
    },
    clock: { now: () => NOW },
    diagnostics: { warn: message => warnings.push(message) },
  };
  return { sweep: new BoardSweep(ports), sent, warnings, context, store };
};

describe('the board sweep tick', () => {
  const stale = (id: string, assignee: string) =>
    view({ id, assignee, laneId: 'implement' }, { activity: 'stale', lastTouchedAt: ago(3 * HOUR) });

  it("should queue quiet events, nudge with the recipient's pending context on top, and remember the nudge", async () => {
    // Arrange
    const child = view(
      childCard([
        {
          at: EARLIER,
          actor: ferret('child'),
          type: 'moved',
          from: 'implement',
          to: 'review',
          backward: false,
          reason: null,
        },
        { at: EARLIER, actor: ferret('child'), type: 'blocked', reason: 'vendor' },
      ]),
    );
    const { sweep, sent, context, store } = tickWorld(board(leadCard, child, stale('F5', 'lead')), sawChild());

    // Act
    const report = await sweep.tick();

    // Assert
    should(report).eql({ nudged: ['F5'], quiet: 2 });
    should(sent).eql([
      {
        sessionId: 'lead',
        message: `[board] &F2 → Review/CI · &F2 blocked: vendor\n\n${nudgeMessage({ id: 'F5' }, 3 * HOUR, 'Implement')}`,
      },
    ]);
    should(context.held.has('lead')).be.false();
    should(store.current.nudged).eql({ F5: NOW });
    should(store.current.sweptAt).equal(NOW);
  });

  it('should report what it could not do and carry on, keeping an unsent nudge unremembered', async () => {
    // Arrange
    const child = view(childCard([{ at: EARLIER, actor: ferret('child'), type: 'blocked', reason: 'vendor' }]));
    const world = tickWorld(
      board(leadCard, child, stale('F5', 'other'), stale('F6', 'child')),
      sawChild(),
      new Set(['other']),
    );
    world.context.failAppendFor = 'lead';

    // Act
    const report = await world.sweep.tick();

    // Assert
    should(report).eql({ nudged: ['F6'], quiet: 0 });
    should(world.warnings).eql([
      'could not queue board events for lead: disk full',
      'could not nudge other about &F5: composer busy',
    ]);
    should(world.store.current.nudged).eql({ F6: NOW });
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
    should(second).eql({ nudged: [], quiet: 0 });
    should(third).eql({ nudged: [], quiet: 0 });
    should(world.store.written).have.length(2);
  });
});
