import { describe, it } from 'bun:test';
import type { Card, CardView, LaneSet, PrLink, ReleasedIn } from '../../../contract/index.ts';
import should from 'should';
import {
  applyPrUpdate,
  BoardIndex,
  BoardService,
  BoardSweep,
  type CardContext,
  closedLaneOf,
  EMPTY_SWEEP_MEMORY,
  gateOf,
  HELPER_ENDED_GRACE_MS,
  helperCloseReason,
  planSweep,
  type PrUpdate,
  reconcileFacts,
  shippedCloseReason,
  stageGateLanes,
  SUB_CARD_HELPER_REASON,
  SUB_CARD_SHIPPED_REASON,
  type SweepBoard,
} from '../../../daemon/lib/board/index.ts';
import {
  card,
  FakeFocus,
  FakeSessions,
  lanes,
  liveSession,
  MemoryBoardStore,
  NOW,
  PROJECT,
  rosterOf,
  templateLanes,
  world,
} from './support.ts';

const URL = 'https://github.com/kirinnee/ferretry/pull/940';
const SHA = 'a'.repeat(40);
const RELEASE: ReleasedIn = { version: '4.110.0', tag: 'v4.110.0', at: '2026-10-30T09:30:00Z' };

const pr = (overrides: Partial<PrLink> = {}): PrLink => ({
  url: URL,
  number: 940,
  repo: 'kirinnee/ferretry',
  state: 'open',
  draft: false,
  checks: 'none',
  mergedAt: null,
  mergeSha: null,
  releasedIn: null,
  polledAt: '2026-10-30T09:00:00Z',
  ...overrides,
});
const mergedPr = (releasedIn: ReleasedIn | null = null): PrLink =>
  pr({ state: 'merged', mergedAt: '2026-10-30T09:00:00Z', mergeSha: SHA, releasedIn });

const PARENT = { id: 'F1' };
const sub = (laneId: string, prs: readonly PrLink[] = [], overrides: Partial<Card> = {}): Card =>
  card({
    id: 'F2',
    parent: PARENT,
    owner: 'lead',
    assignee: 'child',
    laneId,
    workflow: 'quick',
    links: { prs: [...prs], branch: null, commits: [], docs: [] },
    ...overrides,
  });

const context = (subject: Card, laneSet: LaneSet = templateLanes(), overrides: Partial<CardContext> = {}) => ({
  now: NOW,
  actor: { kind: 'daemon' as const },
  standing: 'daemon' as const,
  laneSet,
  index: new BoardIndex([subject], 'machine-1'),
  laneSets: new Map([[PROJECT, laneSet]]),
  ...overrides,
});

const lastMove = (subject: Card | null) => subject?.history.at(-1);

describe('a sub-card whose PRs shipped', () => {
  it('should close instead of waiting in Released · to test, with the reason in its history', () => {
    // Arrange
    const subject = sub('implement', [mergedPr(RELEASE)]);
    const update: PrUpdate = { link: [], observed: [], releases: [], runningVersion: null };

    // Act
    const outcome = applyPrUpdate(subject, update, context(subject));

    // Assert
    should(outcome.task?.laneId).equal('closed');
    should(lastMove(outcome.task)).match({
      type: 'moved',
      from: 'released',
      to: 'closed',
      reason: SUB_CARD_SHIPPED_REASON,
      auto: true,
      actor: { kind: 'daemon' },
    });
  });

  it('should leave a top-level card in Released · to test for the owner to try', () => {
    // Arrange
    const subject = sub('implement', [mergedPr(RELEASE)], { parent: null });

    // Act
    const caught = reconcileFacts(subject, context(subject));

    // Assert
    should(caught?.laneId).equal('released');
  });

  it('should close a quick sub-card on merge, where a top-level one would go to To test', () => {
    // Arrange
    const quick = lanes(PROJECT, 'quick');
    const subject = sub('doing', [mergedPr()]);

    // Act
    const caught = reconcileFacts(subject, context(subject, quick));

    // Assert
    should(caught?.laneId).equal('closed');
    should(lastMove(caught)).match({ reason: SUB_CARD_SHIPPED_REASON });
  });

  it('should stay open while one of its PRs is still open', () => {
    // Arrange
    const subject = sub('released', [mergedPr(RELEASE), pr({ number: 941, url: `${URL}1` })]);

    // Act / Assert
    should(shippedCloseReason(subject, templateLanes())).be.null();
    should(reconcileFacts(subject, context(subject))?.laneId).not.equal('closed');
  });

  it('should close from a verify lane only, and never a top-level, dropped or closed card', () => {
    // Arrange
    const set = templateLanes();
    const shipped = [mergedPr(RELEASE)];
    const dropped = sub('released', shipped, {
      dropped: { at: NOW, by: { kind: 'owner' }, reason: 'no' } as Card['dropped'],
    });

    // Act / Assert
    should(shippedCloseReason(sub('released', shipped), set)).equal(SUB_CARD_SHIPPED_REASON);
    should(shippedCloseReason(sub('implement', shipped), set)).be.null();
    should(shippedCloseReason(sub('released', shipped, { parent: null }), set)).be.null();
    should(shippedCloseReason(dropped, set)).be.null();
    should(shippedCloseReason(sub('closed', shipped), set)).be.null();
    should(shippedCloseReason(sub('released', []), set)).be.null();
  });
});

describe('a sub-card whose ferret finishes with no PR', () => {
  it('should close as a finished helper when it signals done', async () => {
    // Arrange
    const focus = new FakeFocus();
    focus.focused.set('child', { id: 'F2' });
    const ports = world({ store: new MemoryBoardStore([sub('implement')]), focus });
    const service = new BoardService(ports);

    // Act
    const done = await service.signalDone('child', 'reviewed: no findings');

    // Assert
    const stored = ports.store.cards.get('F2') as Card;
    should(done?.moved?.id).equal('closed');
    should(stored.laneId).equal('closed');
    should(stored.history.at(-1)).match({ type: 'moved', to: 'closed', reason: SUB_CARD_HELPER_REASON, auto: true });
    should(stored.history.at(-2)).match({ type: 'note', text: 'done: reviewed: no findings' });
    should(ports.store.writes).have.length(1);
  });

  it('should wait in review on done while its PR is open, not close', async () => {
    // Arrange
    const focus = new FakeFocus();
    focus.focused.set('child', { id: 'F2' });
    const ports = world({ store: new MemoryBoardStore([sub('implement', [pr()])]), focus });
    const service = new BoardService(ports);

    // Act
    const done = await service.signalDone('child', 'PR up');

    // Assert
    should(done?.moved?.id).equal('review');
    should((ports.store.cards.get('F2') as Card).laneId).equal('review');
  });

  it('should leave a sub-card whose PR merged where it is on done', async () => {
    // Arrange
    const focus = new FakeFocus();
    focus.focused.set('child', { id: 'F2' });
    const ports = world({ store: new MemoryBoardStore([sub('implement', [mergedPr()])]), focus });
    const service = new BoardService(ports);

    // Act
    const done = await service.signalDone('child', 'merged');

    // Assert
    should(done?.moved).be.null();
    should((ports.store.cards.get('F2') as Card).laneId).equal('implement');
  });

  it('should still send a top-level card with no PR to be tried', async () => {
    // Arrange
    const focus = new FakeFocus();
    focus.focused.set('child', { id: 'F2' });
    const ports = world({ store: new MemoryBoardStore([sub('implement', [], { parent: null })]), focus });
    const service = new BoardService(ports);

    // Act
    const done = await service.signalDone('child', 'built');

    // Assert
    should(done?.moved?.category).not.equal('closed');
  });

  it('should decide from the PRs alone: none open or merged is a helper, and a closed one ships nothing', () => {
    // Arrange
    const set = templateLanes();
    const abandoned = pr({ state: 'closed' });

    // Act / Assert
    should(helperCloseReason(sub('implement'), set)).equal(SUB_CARD_HELPER_REASON);
    should(helperCloseReason(sub('implement', [abandoned]), set)).equal(SUB_CARD_HELPER_REASON);
    should(helperCloseReason(sub('implement', [pr()]), set)).be.null();
    should(helperCloseReason(sub('implement', [mergedPr()]), set)).be.null();
    should(helperCloseReason(sub('implement', [], { parent: null }), set)).be.null();
    should(helperCloseReason(sub('closed'), set)).be.null();
  });
});

describe('closing a helper whose ferret ended', () => {
  const idle = (view: Card, derived: Partial<CardView> = {}): CardView => ({
    ...view,
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
  const board = (...views: CardView[]): SweepBoard => ({ views, laneSets: new Map([[PROJECT, lanes(PROJECT)]]) });
  const gone = rosterOf([liveSession('lead')]);
  const alive = rosterOf([liveSession('lead'), liveSession('child')]);
  const old = new Date(Date.parse(NOW) - HELPER_ENDED_GRACE_MS - 1000).toISOString();

  it('should plan to close a PR-free sub-card handed to a ferret that is gone', () => {
    // Arrange
    const ended = idle(sub('implement'), { lastTouchedAt: old });

    // Act
    const plan = planSweep(EMPTY_SWEEP_MEMORY, board(ended), gone, NOW);

    // Assert
    should(plan.closes).deepEqual(['F2']);
  });

  it.each([
    { name: 'its ferret is alive', view: idle(sub('implement'), { lastTouchedAt: old }), roster: alive },
    { name: 'its ferret could not be read', view: idle(sub('implement')), roster: rosterOf([], ['child']) },
    { name: 'it has an open PR', view: idle(sub('implement', [pr()]), { lastTouchedAt: old }), roster: gone },
    {
      name: 'it is a top-level card',
      view: idle(sub('implement', [], { parent: null }), { lastTouchedAt: old }),
      roster: gone,
    },
    {
      name: 'it is the lead’s own bookkeeping',
      view: idle(sub('todo', [], { assignee: null }), { lastTouchedAt: old }),
      roster: rosterOf([]),
    },
    { name: 'the ferret only just went', view: idle(sub('implement'), { lastTouchedAt: NOW }), roster: gone },
  ])('should leave it open when $name', ({ view, roster }) => {
    // Act
    const plan = planSweep(EMPTY_SWEEP_MEMORY, board(view), roster, NOW);

    // Assert
    should(plan.closes).be.empty();
  });

  it('should close the card through the service on the tick and report it', async () => {
    // Arrange
    const ported = world({ store: new MemoryBoardStore([sub('implement')]) });
    const service = new BoardService(ported);
    const warnings: string[] = [];
    const swept = board(idle(sub('implement'), { lastTouchedAt: old }));
    const sweep = new BoardSweep({
      board: {
        sweepBoard: async () => swept,
        closeEndedHelper: async id => await service.closeEndedHelper(id),
        returnToLead: async () => false,
      },
      sessions: new FakeSessions(gone),
      guard: new FakeSessions(gone),
      memory: { read: async () => EMPTY_SWEEP_MEMORY, write: async () => undefined },
      nudges: { send: async () => undefined },
      clock: { now: () => NOW },
      diagnostics: { warn: message => warnings.push(message) },
    });

    // Act
    const report = await sweep.tick();

    // Assert
    should(report.closed).deepEqual(['F2']);
    should((ported.store.cards.get('F2') as Card).history.at(-1)).match({ reason: SUB_CARD_HELPER_REASON });
    should(warnings).be.empty();
  });

  it('should warn and carry on when a close fails', async () => {
    // Arrange
    const warnings: string[] = [];
    const swept = board(idle(sub('implement'), { lastTouchedAt: old }));
    const sweep = new BoardSweep({
      board: {
        sweepBoard: async () => swept,
        closeEndedHelper: async () => {
          throw new Error('store is read-only');
        },
        returnToLead: async () => false,
      },
      sessions: new FakeSessions(gone),
      guard: new FakeSessions(gone),
      memory: { read: async () => EMPTY_SWEEP_MEMORY, write: async () => undefined },
      nudges: { send: async () => undefined },
      clock: { now: () => NOW },
      diagnostics: { warn: message => warnings.push(message) },
    });

    // Act
    const report = await sweep.tick();

    // Assert
    should(report.closed).be.empty();
    should(warnings).deepEqual(['could not close helper &F2: store is read-only']);
  });

  it('should leave the card alone when it gained a PR since the sweep read it', async () => {
    // Arrange
    const ported = world({ store: new MemoryBoardStore([sub('implement', [pr()])]) });

    // Act
    const closed = await new BoardService(ported).closeEndedHelper('F2');

    // Assert
    should(closed).be.false();
    should(ported.store.writes).be.empty();
  });
});

describe('no gate item for a sub-card the owner would test', () => {
  it('should raise none at a verify lane for a sub-card, and still raise one for a top-level card', () => {
    // Arrange
    const set = templateLanes();
    const gate = (task: Card) => gateOf({ task, laneSet: set, audience: 'external' }, stageGateLanes);

    // Act / Assert
    should(gate(sub('released', [mergedPr(RELEASE)]))).be.undefined();
    should(gate(sub('released', [mergedPr(RELEASE)], { parent: null }))).not.be.undefined();
  });
});

describe('the lane a finished sub-card closes into', () => {
  it('should be the Done lane, else the first closed lane when Done is not a closed one', () => {
    should(closedLaneOf(lanes())?.id).equal('closed');
    const set = lanes();
    should(closedLaneOf({ ...set, doneLane: set.lanes[0]?.id ?? '' })?.id).equal('closed');
  });
});
