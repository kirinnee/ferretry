import { describe, it } from 'bun:test';
import type { Card, CardView } from '../../../contract/index.ts';
import should from 'should';
import {
  BoardService,
  BoardSweep,
  deriveActivities,
  BoardIndex,
  EMPTY_SWEEP_MEMORY,
  HELPER_ENDED_GRACE_MS,
  nearestLiveLead,
  planSweep,
  returnCard,
  type FerretRoster,
  type SweepBoard,
  SUB_CARD_HELPER_REASON,
} from '../../../daemon/lib/board/index.ts';
import {
  card,
  FakeSessions,
  lanes,
  liveSession,
  MACHINE,
  MemoryBoardStore,
  NOW,
  PROJECT,
  rosterOf,
  world,
} from './support.ts';
import type { FerretLiveness } from '../../../daemon/lib/board/index.ts';

const old = new Date(Date.parse(NOW) - HELPER_ENDED_GRACE_MS - 1000).toISOString();
const laneSets = new Map([[PROJECT, lanes(PROJECT)]]);

const idle = (stored: Card, derived: Partial<CardView> = {}): CardView => ({
  ...stored,
  lastTouchedAt: old,
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

const openPr = {
  url: 'https://github.com/kirinnee/ferretry/pull/950',
  number: 950,
  repo: 'kirinnee/ferretry',
  state: 'open' as const,
  draft: false,
  checks: 'none' as const,
  mergedAt: null,
  mergeSha: null,
  releasedIn: null,
  polledAt: NOW,
};
const links = { prs: [openPr], branch: null, commits: [], docs: [] };

/** A card `lead` handed to `child` as a sub-card with a PR open, so it neither closes nor ships. */
const helperWithPr = (overrides: Partial<Card> = {}): Card =>
  card({
    id: 'F2',
    parent: { id: 'F1' },
    owner: 'lead',
    assignee: 'child',
    laneId: 'review',
    links,
    ...overrides,
  });

const session = (id: string, lead?: string, overrides: Partial<FerretLiveness> = {}) =>
  liveSession(id, { ...(lead === undefined ? {} : { lead }), ...overrides });

/** `lead` > `child` > `grandchild`, with the grandchild ended in the given way. */
const rosterWithEnded = (ended: 'stopped' | 'unheld', extra: readonly FerretLiveness[] = []) => {
  const gone = session('grandchild', 'child', ended === 'unheld' ? {} : { status: ended });
  const sessions = [session('lead'), session('child', 'lead'), ...extra, ...(ended === 'unheld' ? [] : [gone])];
  const roster = rosterOf(sessions);
  return ended === 'unheld'
    ? { ...roster, sessions: new Map([...roster.sessions, ['grandchild', gone]]), held: new Set(roster.held) }
    : roster;
};

describe('the live lead above an ended ferret', () => {
  it('should be its lead when that lead is alive', () => {
    // Act / Assert
    should(nearestLiveLead(rosterWithEnded('stopped'), 'grandchild')).equal('child');
  });

  it('should skip an ended lead and walk up to the lead above it', () => {
    // Arrange
    const roster = rosterOf([
      session('lead'),
      session('child', 'lead', { status: 'stopped' }),
      session('grandchild', 'child', { status: 'stopped' }),
    ]);

    // Act / Assert
    should(nearestLiveLead(roster, 'grandchild')).equal('lead');
  });

  it('should be nobody when every ancestor has ended, there is none, or the chain loops', () => {
    // Arrange
    const ended = rosterOf([
      session('lead', undefined, { status: 'stopped' }),
      session('child', 'lead', { status: 'stopped' }),
    ]);
    const loop = rosterOf([session('a', 'b', { status: 'stopped' }), session('b', 'a', { status: 'stopped' })]);

    // Act / Assert
    should(nearestLiveLead(ended, 'child')).be.null();
    should(nearestLiveLead(ended, 'lead')).be.null();
    should(nearestLiveLead(loop, 'a')).be.null();
  });

  it('should stop walking past the lineage depth cap', () => {
    // Arrange — a chain of ended ferrets longer than the cap, with a live lead beyond it
    const chain = Array.from({ length: 70 }, (_, depth) =>
      session(`s${depth}`, depth === 69 ? 'live' : `s${depth + 1}`, { status: 'stopped' }),
    );
    const roster = rosterOf([session('live'), ...chain]);

    // Act / Assert
    should(nearestLiveLead(roster, 's0')).be.null();
  });
});

describe('the sweep returning an ended ferret’s card', () => {
  it.each(['stopped', 'unheld'] as const)(
    'should plan to return a card whose ferret ended as %s, to its live lead',
    ended => {
      // Arrange
      const view = idle(helperWithPr({ assignee: 'grandchild', owner: 'child' }));

      // Act
      const plan = planSweep(EMPTY_SWEEP_MEMORY, board(view), rosterWithEnded(ended), NOW);

      // Assert
      should(plan.returns).eql([{ id: 'F2', lead: 'child', from: 'grandchild' }]);
      should(plan.closes).be.empty();
    },
  );

  it('should walk past an ended parent to the grandparent', () => {
    // Arrange
    const roster = rosterOf([
      session('lead'),
      session('child', 'lead', { status: 'stopped' }),
      session('grandchild', 'child', { status: 'stopped' }),
    ]);

    // Act
    const plan = planSweep(EMPTY_SWEEP_MEMORY, board(idle(helperWithPr({ assignee: 'grandchild' }))), roster, NOW);

    // Assert
    should(plan.returns).eql([{ id: 'F2', lead: 'lead', from: 'grandchild' }]);
  });

  it('should return a top-level card a helper held', () => {
    // Arrange
    const held = idle(helperWithPr({ parent: null, assignee: null, owner: 'grandchild' }));

    // Act
    const plan = planSweep(EMPTY_SWEEP_MEMORY, board(held), rosterWithEnded('stopped'), NOW);

    // Assert
    should(plan.returns).eql([{ id: 'F2', lead: 'child', from: 'grandchild' }]);
  });

  it('should still close a PR-free helper instead of returning it', () => {
    // Arrange
    const helper = idle(
      helperWithPr({ assignee: 'grandchild', links: { prs: [], branch: null, commits: [], docs: [] } }),
    );

    // Act
    const plan = planSweep(EMPTY_SWEEP_MEMORY, board(helper), rosterWithEnded('stopped'), NOW);

    // Assert
    should(plan.closes).eql(['F2']);
    should(plan.returns).be.empty();
  });

  it('should return nothing when no ancestor is alive, so the card is an orphan', () => {
    // Arrange
    const roster = rosterOf([
      session('lead', undefined, { status: 'stopped' }),
      session('grandchild', 'lead', { status: 'stopped' }),
    ]);
    const view = idle(helperWithPr({ assignee: 'grandchild' }));

    // Act
    const plan = planSweep(EMPTY_SWEEP_MEMORY, board(view), roster, NOW);

    // Assert
    should(plan.returns).be.empty();
  });

  it.each([
    ['closed', { laneId: 'closed' }],
    ['shipped', { laneId: 'merged' }],
    ['to test', { laneId: 'tested' }],
    ['backlog', { laneId: 'todo' }],
    ['dropped', { dropped: { reason: 'no', at: NOW } }],
  ] as const)('should leave a %s card alone', (_name, overrides) => {
    // Act
    const plan = planSweep(
      EMPTY_SWEEP_MEMORY,
      board(idle(helperWithPr({ assignee: 'grandchild', ...overrides }))),
      rosterWithEnded('stopped'),
      NOW,
    );

    // Assert
    should(plan.returns).be.empty();
  });

  it('should wait out the grace, and leave a card whose ferret is still alive', () => {
    // Arrange
    const fresh = idle(helperWithPr({ assignee: 'grandchild' }), { lastTouchedAt: NOW });
    const alive = idle(helperWithPr({ assignee: 'grandchild' }));
    const living = rosterOf([session('lead'), session('child', 'lead'), session('grandchild', 'child')]);

    // Act / Assert
    should(planSweep(EMPTY_SWEEP_MEMORY, board(fresh), rosterWithEnded('stopped'), NOW).returns).be.empty();
    should(planSweep(EMPTY_SWEEP_MEMORY, board(alive), living, NOW).returns).be.empty();
  });

  it('should return through the service on the tick, journal-ready, and report it', async () => {
    // Arrange
    const stored = helperWithPr({ assignee: 'grandchild' });
    const ported = world({ store: new MemoryBoardStore([stored]) });
    const service = new BoardService(ported);
    const swept = board(idle(stored));
    const sweep = new BoardSweep({
      board: {
        sweepBoard: async () => swept,
        closeEndedHelper: async id => await service.closeEndedHelper(id),
        returnToLead: async (id, plan, settle) => await service.returnToLead(id, plan, settle),
      },
      sessions: new FakeSessions(rosterWithEnded('stopped')),
      guard: new FakeSessions(rosterWithEnded('stopped')),
      memory: { read: async () => EMPTY_SWEEP_MEMORY, write: async () => undefined },
      nudges: { send: async () => undefined },
      clock: { now: () => NOW },
      diagnostics: { warn: () => undefined },
    });

    // Act
    const report = await sweep.tick();

    // Assert
    const after = ported.store.cards.get('F2') as Card;
    should(report.returned).eql(['F2']);
    should(after.assignee).equal('child');
    should(after.laneId).equal('review');
    should(after.history.at(-1)).match({
      type: 'assigned',
      from: 'grandchild',
      to: 'child',
      returnedFrom: 'grandchild',
      actor: { kind: 'daemon' },
    });
  });

  it('should warn and carry on when a return fails', async () => {
    // Arrange
    const warnings: string[] = [];
    const sweep = new BoardSweep({
      board: {
        sweepBoard: async () => board(idle(helperWithPr({ assignee: 'grandchild' }))),
        closeEndedHelper: async () => false,
        returnToLead: async () => {
          throw new Error('store is read-only');
        },
      },
      sessions: new FakeSessions(rosterWithEnded('stopped')),
      guard: new FakeSessions(rosterWithEnded('stopped')),
      memory: { read: async () => EMPTY_SWEEP_MEMORY, write: async () => undefined },
      nudges: { send: async () => undefined },
      clock: { now: () => NOW },
      diagnostics: { warn: message => warnings.push(message) },
    });

    // Act
    const report = await sweep.tick();

    // Assert
    should(report.returned).be.empty();
    should(warnings).eql(['could not return &F2 to child: store is read-only']);
  });
});

describe('returning one card through the service', () => {
  const serviceFor = (stored: Card) => {
    const ported = world({ store: new MemoryBoardStore([stored]) });
    return { ported, service: new BoardService(ported) };
  };

  it.each([
    ['closed', { laneId: 'closed' }],
    ['shipped', { laneId: 'merged' }],
    ['dropped', { dropped: { reason: 'no', at: NOW } }],
    ['reassigned since the sweep', { assignee: 'worker' }],
  ] as const)('should leave a card that is %s by the time it is written', async (_name, overrides) => {
    // Arrange
    const { ported, service } = serviceFor(helperWithPr({ assignee: 'grandchild', ...overrides }));
    const before = ported.store.cards.get('F2');

    // Act
    const roster = rosterWithEnded('stopped');
    const moved = await service.returnToLead(
      'F2',
      { lead: 'child', from: 'grandchild' },
      async work => await work(roster),
    );

    // Assert
    should(moved).be.false();
    should(ported.store.cards.get('F2')).equal(before);
  });

  it('should write the history line with the ferret that finished and no other change', () => {
    // Arrange
    const stored = helperWithPr({ assignee: 'grandchild' });

    // Act
    const returned = returnCard(stored, 'child', 'grandchild', { now: NOW });

    // Assert
    should(returned.assignee).equal('child');
    should({ ...returned, assignee: stored.assignee, history: stored.history }).eql(stored);
    should(returned.history.at(-1)).eql({
      seq: stored.history.length + 1,
      at: NOW,
      actor: { kind: 'daemon' },
      type: 'assigned',
      from: 'grandchild',
      to: 'child',
      returnedFrom: 'grandchild',
    });
  });
});

/** A tick whose roster changes after the plan is made: the card's write must judge the roster as it is then. */
const tickWithRosterChange = async (options: {
  readonly stored: readonly Card[];
  readonly planned: readonly CardView[];
  readonly before: FerretRoster;
  readonly after: FerretRoster;
}) => {
  const ported = world({ store: new MemoryBoardStore(options.stored) });
  const service = new BoardService(ported);
  const sessions = new FakeSessions(options.before);
  const sweep = new BoardSweep({
    board: {
      sweepBoard: async () => board(...options.planned),
      // Planning is over once the helper closes run: the roster moves on before the returns execute.
      closeEndedHelper: async () => {
        sessions.current = options.after;
        return false;
      },
      returnToLead: async (id, plan, settle) => await service.returnToLead(id, plan, settle),
    },
    sessions,
    guard: sessions,
    memory: { read: async () => EMPTY_SWEEP_MEMORY, write: async () => undefined },
    nudges: { send: async () => undefined },
    clock: { now: () => NOW },
    diagnostics: { warn: () => undefined },
  });
  const report = await sweep.tick();
  return { report, ported };
};

const prFree = { prs: [], branch: null, commits: [], docs: [] };
/** A second ended helper, with no PR, so the tick runs a helper close (and the roster changes) before the returns. */
const trigger = () => idle(helperWithPr({ id: 'F9', assignee: 'grandchild', links: prFree }));

describe('a return judged again when it is written', () => {
  const planned = () => [trigger(), idle(helperWithPr({ assignee: 'grandchild' }))];

  it('should not hand the card to a lead that ended after the plan', async () => {
    // Arrange
    const stored = [helperWithPr({ assignee: 'grandchild' }), helperWithPr({ id: 'F9', assignee: 'grandchild' })];
    const after = rosterOf([
      session('lead'),
      session('child', 'lead', { status: 'stopped' }),
      session('grandchild', 'child', { status: 'stopped' }),
    ]);

    // Act
    const { report, ported } = await tickWithRosterChange({
      stored,
      planned: planned(),
      before: rosterWithEnded('stopped'),
      after,
    });

    // Assert
    should(report.returned).be.empty();
    should(ported.store.cards.get('F2')?.assignee).equal('grandchild');
  });

  it('should not take a card from a worker that came back after the plan', async () => {
    // Arrange
    const stored = [helperWithPr({ assignee: 'grandchild' }), helperWithPr({ id: 'F9', assignee: 'grandchild' })];
    const resumed = rosterOf([session('lead'), session('child', 'lead'), session('grandchild', 'child')]);

    // Act
    const { report, ported } = await tickWithRosterChange({
      stored,
      planned: planned(),
      before: rosterWithEnded('stopped'),
      after: resumed,
    });

    // Assert
    should(report.returned).be.empty();
    should(ported.store.cards.get('F2')?.assignee).equal('grandchild');
  });

  it('should still return the card when nothing changed since the plan', async () => {
    // Arrange
    const stored = [helperWithPr({ assignee: 'grandchild' }), helperWithPr({ id: 'F9', assignee: 'grandchild' })];

    // Act
    const { report, ported } = await tickWithRosterChange({
      stored,
      planned: planned(),
      before: rosterWithEnded('stopped'),
      after: rosterWithEnded('stopped'),
    });

    // Assert
    should(report.returned).eql(['F2']);
    should(ported.store.cards.get('F2')?.assignee).equal('child');
  });

  it('should leave a helper whose PR closed after the plan for the helper close, not return it to its owner', async () => {
    // Arrange — planned with its PR open (so it is a return), stored with the PR closed unmerged
    const closedPr = { ...openPr, state: 'closed' as const };
    const stored = [
      helperWithPr({ assignee: 'grandchild', owner: 'child', links: { ...links, prs: [closedPr] } }),
      helperWithPr({ id: 'F9', assignee: 'grandchild', links: prFree }),
    ];
    const roster = rosterWithEnded('stopped');

    // Act
    const { report, ported } = await tickWithRosterChange({
      stored,
      planned: [trigger(), idle(helperWithPr({ assignee: 'grandchild', owner: 'child' }))],
      before: roster,
      after: roster,
    });

    // Assert
    const after = ported.store.cards.get('F2') as Card;
    should(report.returned).be.empty();
    should(after.assignee).equal('grandchild');
    should(planSweep(EMPTY_SWEEP_MEMORY, board(idle(after)), roster, NOW).closes).eql(['F2']);
  });
});

describe('a lead’s own bookkeeping sub-card whose ferret ended', () => {
  it.each([
    ['assigned to nobody', { owner: 'grandchild', assignee: null }],
    ['assigned to its owner', { owner: 'grandchild', assignee: 'grandchild' }],
  ] as const)('should not be returned, %s', (_name, overrides) => {
    // Arrange
    const view = idle(helperWithPr(overrides));

    // Act
    const plan = planSweep(EMPTY_SWEEP_MEMORY, board(view), rosterWithEnded('stopped'), NOW);

    // Assert
    should(plan.returns).be.empty();
    should(plan.closes).be.empty();
  });

  it('should be returned while a top-level card of the same shape is', () => {
    // Arrange
    const topLevel = idle(helperWithPr({ owner: 'grandchild', assignee: null, parent: null }));

    // Act
    const plan = planSweep(EMPTY_SWEEP_MEMORY, board(topLevel), rosterWithEnded('stopped'), NOW);

    // Assert
    should(plan.returns).eql([{ id: 'F2', lead: 'child', from: 'grandchild' }]);
  });
});

describe('an orphaned card', () => {
  const derive = (stored: Card, roster: FerretRoster) =>
    deriveActivities(
      { cards: [stored], index: new BoardIndex([stored], MACHINE), laneSets, asks: new Map() },
      roster,
      Date.parse(NOW),
    ).get('F2')?.activity;

  it('should be orphaned only when no ancestor of its ended ferret is alive', () => {
    // Arrange
    const stored = helperWithPr({ assignee: 'grandchild', createdAt: old });
    const nobody = rosterOf([
      session('lead', undefined, { status: 'stopped' }),
      session('grandchild', 'lead', { status: 'stopped' }),
    ]);

    // Act / Assert
    should(derive(stored, nobody)).equal('orphaned');
    should(derive(stored, rosterWithEnded('stopped'))).not.equal('orphaned');
  });
});

describe('the history reason of a closing helper', () => {
  it('should be untouched by the return rule', () => {
    // Act / Assert
    should(SUB_CARD_HELPER_REASON).equal('helper finished');
  });
});
