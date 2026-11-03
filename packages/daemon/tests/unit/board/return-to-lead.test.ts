import { describe, it } from 'bun:test';
import type { BoardTask, BoardTaskView } from '@ferretry/protocol';
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
  type SessionRoster,
  type SweepBoard,
  SUB_CARD_HELPER_REASON,
} from '../../../src/lib/board/index.ts';
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
import type { SessionLiveness } from '../../../src/lib/board/index.ts';

const old = new Date(Date.parse(NOW) - HELPER_ENDED_GRACE_MS - 1000).toISOString();
const laneSets = new Map([[PROJECT, lanes(PROJECT)]]);

const idle = (stored: BoardTask, derived: Partial<BoardTaskView> = {}): BoardTaskView => ({
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
  waitingOnOwner: [],
  openAsks: [],
  blockedBy: [],
  blocks: [],
  shippedIn: null,
  ...derived,
});
const board = (...views: BoardTaskView[]): SweepBoard => ({ views, laneSets });

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
const helperWithPr = (overrides: Partial<BoardTask> = {}): BoardTask =>
  card({
    id: 'F2',
    parent: { id: 'F1' },
    owner: 'lead',
    assignee: 'child',
    laneId: 'review',
    links,
    ...overrides,
  });

const session = (id: string, lead?: string, overrides: Partial<SessionLiveness> = {}) =>
  liveSession(id, { ...(lead === undefined ? {} : { lead }), ...overrides });

/** `lead` > `child` > `grandchild`, with the grandchild ended in the given way. */
const rosterWithEnded = (ended: 'completed' | 'stopped' | 'unheld', extra: readonly SessionLiveness[] = []) => {
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
    should(nearestLiveLead(rosterWithEnded('completed'), 'grandchild')).equal('child');
  });

  it('should skip an ended lead and walk up to the lead above it', () => {
    // Arrange
    const roster = rosterOf([
      session('lead'),
      session('child', 'lead', { status: 'stopped' }),
      session('grandchild', 'child', { status: 'completed' }),
    ]);

    // Act / Assert
    should(nearestLiveLead(roster, 'grandchild')).equal('lead');
  });

  it('should be nobody when every ancestor has ended, there is none, or the chain loops', () => {
    // Arrange
    const ended = rosterOf([
      session('lead', undefined, { status: 'stopped' }),
      session('child', 'lead', { status: 'completed' }),
    ]);
    const loop = rosterOf([session('a', 'b', { status: 'stopped' }), session('b', 'a', { status: 'stopped' })]);

    // Act / Assert
    should(nearestLiveLead(ended, 'child')).be.null();
    should(nearestLiveLead(ended, 'lead')).be.null();
    should(nearestLiveLead(loop, 'a')).be.null();
  });
});

describe('the sweep returning an ended ferret’s card', () => {
  it.each(['completed', 'stopped', 'unheld'] as const)(
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
      session('grandchild', 'child', { status: 'completed' }),
    ]);

    // Act
    const plan = planSweep(EMPTY_SWEEP_MEMORY, board(idle(helperWithPr({ assignee: 'grandchild' }))), roster, NOW);

    // Assert
    should(plan.returns).eql([{ id: 'F2', lead: 'lead', from: 'grandchild' }]);
  });

  it('should return a top-level card a sub-ferret held', () => {
    // Arrange
    const held = idle(helperWithPr({ parent: null, assignee: null, owner: 'grandchild' }));

    // Act
    const plan = planSweep(EMPTY_SWEEP_MEMORY, board(held), rosterWithEnded('completed'), NOW);

    // Assert
    should(plan.returns).eql([{ id: 'F2', lead: 'child', from: 'grandchild' }]);
  });

  it('should still close a PR-free helper instead of returning it', () => {
    // Arrange
    const helper = idle(
      helperWithPr({ assignee: 'grandchild', links: { prs: [], branch: null, commits: [], docs: [] } }),
    );

    // Act
    const plan = planSweep(EMPTY_SWEEP_MEMORY, board(helper), rosterWithEnded('completed'), NOW);

    // Assert
    should(plan.closes).eql(['F2']);
    should(plan.returns).be.empty();
  });

  it('should return nothing when no ancestor is alive, so the card is an orphan', () => {
    // Arrange
    const roster = rosterOf([
      session('lead', undefined, { status: 'stopped' }),
      session('grandchild', 'lead', { status: 'completed' }),
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
      rosterWithEnded('completed'),
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
    should(planSweep(EMPTY_SWEEP_MEMORY, board(fresh), rosterWithEnded('completed'), NOW).returns).be.empty();
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
        returnToLead: async (id, lead, from) => await service.returnToLead(id, lead, from),
      },
      sessions: new FakeSessions(rosterWithEnded('completed')),
      memory: { read: async () => EMPTY_SWEEP_MEMORY, write: async () => undefined },
      nudges: { send: async () => undefined },
      clock: { now: () => NOW },
      diagnostics: { warn: () => undefined },
    });

    // Act
    const report = await sweep.tick();

    // Assert
    const after = ported.store.cards.get('F2') as BoardTask;
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
      sessions: new FakeSessions(rosterWithEnded('completed')),
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
  const serviceFor = (stored: BoardTask) => {
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
    const moved = await service.returnToLead('F2', 'child', 'grandchild');

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

describe('an orphaned card', () => {
  const derive = (stored: BoardTask, roster: SessionRoster) =>
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
      session('grandchild', 'lead', { status: 'completed' }),
    ]);

    // Act / Assert
    should(derive(stored, nobody)).equal('orphaned');
    should(derive(stored, rosterWithEnded('completed'))).not.equal('orphaned');
  });
});

describe('the history reason of a closing helper', () => {
  it('should be untouched by the return rule', () => {
    // Act / Assert
    should(SUB_CARD_HELPER_REASON).equal('helper finished');
  });
});
