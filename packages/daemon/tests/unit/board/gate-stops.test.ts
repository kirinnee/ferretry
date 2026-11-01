import { describe, it } from 'bun:test';
import { type BoardTask, BoardTaskActionRequestSchema, type LaneSet, type PrLink } from '@ferretry/protocol';
import should from 'should';
import {
  type BoardCaller,
  BoardError,
  BoardService,
  type BoardStanding,
  type CardAudience,
  gatesBetween,
  mayPassGate,
} from '../../../src/lib/board/index.ts';
import { card, FakeFocus, FakeLanes, lanes, MemoryBoardStore, NOW, OTHER_PROJECT, PROJECT, world } from './support.ts';

/**
 * A GATE IS PASSED ONLY BY THE OWNER (docs/board.md § Gates ask the owner): their answer to its item, or their own
 * move — and, on an internal card, its owner ferret's or a lead's. A ferret's move, a daemon trigger, PR facts,
 * `fy signal done` and a refile may bring a card INTO a gate; none takes it out of one or past one.
 */

/** The classic lanes with Review/CI made a gate too: Todo, Plan*, Implement, Review/CI*, Merged, Released, To test*, Closed. */
const withMiddleGate = (base: LaneSet = lanes(PROJECT)): LaneSet => ({
  ...base,
  lanes: base.lanes.map(lane => (lane.id === 'review' ? { ...lane, ownerGate: true } : lane)),
});

/** The classic lanes with To test NOT owner-gated: a verify lane is still a gate (Done / Not good), by its stage. */
const verifyWithoutOwnerGate = (): LaneSet => {
  const base = lanes(PROJECT);
  return {
    ...base,
    lanes: base.lanes.map(lane => {
      if (lane.id !== 'tested') return lane;
      const { ownerGate: _ownerGate, ...rest } = lane;
      return rest;
    }),
  };
};

const CALLERS: Readonly<Record<Exclude<BoardStanding, 'daemon'>, BoardCaller>> = {
  'owner-human': { kind: 'owner' },
  owner: { kind: 'ferret', sessionId: 'child' },
  ancestor: { kind: 'ferret', sessionId: 'lead' },
  assignee: { kind: 'ferret', sessionId: 'grandchild' },
  reader: { kind: 'ferret', sessionId: 'stranger' },
};

const cardFor = (audience: CardAudience, laneId: string, overrides: Partial<BoardTask> = {}): BoardTask =>
  card({
    laneId,
    owner: 'child',
    assignee: 'grandchild',
    createdBy: { kind: 'ferret', sessionId: 'child' },
    ask:
      audience === 'external' ? { text: 'build it', source: 'owner' } : { text: 'build it', source: 'session:child' },
    history: [{ seq: 1, at: NOW, actor: { kind: 'ferret', sessionId: 'child' }, type: 'created', laneId }],
    ...overrides,
  });

const serviceOver = (cards: readonly BoardTask[], laneSet: LaneSet = lanes(PROJECT)) => {
  const store = new MemoryBoardStore(cards);
  const focus = new FakeFocus();
  const service = new BoardService(
    world({
      store,
      focus,
      lanes: new FakeLanes(
        new Map([
          [PROJECT, laneSet],
          [OTHER_PROJECT, laneSet.projectId === OTHER_PROJECT ? laneSet : { ...laneSet, projectId: OTHER_PROJECT }],
        ]),
      ),
      runningVersion: () => '4.110.0',
    }),
  );
  return { store, focus, service, stored: (id = 'F1') => store.cards.get(id) as BoardTask };
};

const move = (to: string, reason?: string) =>
  BoardTaskActionRequestSchema.parse({ action: 'move', to, ...(reason === undefined ? {} : { reason }) });

const attempt = async (work: Promise<unknown>): Promise<BoardError | undefined> =>
  await work.then(
    () => undefined,
    (error: unknown) => {
      if (error instanceof BoardError) return error;
      throw error;
    },
  );

describe('gatesBetween', () => {
  it('lists the gates a card’s variant walks between its lane and a target, never the target itself', () => {
    const laneSet = withMiddleGate();
    const lane = (id: string) => laneSet.lanes.find(each => each.id === id) as LaneSet['lanes'][number];
    should(
      gatesBetween(laneSet, { laneId: 'todo', workflow: 'design-first' }, lane('merged')).map(each => each.id),
    ).eql(['plan', 'review']);
    should(gatesBetween(laneSet, { laneId: 'todo', workflow: 'quick' }, lane('merged')).map(each => each.id)).eql([
      'review',
    ]);
    should(gatesBetween(laneSet, { laneId: 'implement', workflow: 'design-first' }, lane('review'))).be.empty();
    should(gatesBetween(laneSet, { laneId: 'merged', workflow: 'design-first' }, lane('implement'))).be.empty();
  });
});

describe('a ferret’s move never jumps a gate', () => {
  const JUMPS = [
    { name: 'over a middle gate', laneSet: withMiddleGate(), from: 'implement', to: 'merged', gate: 'Review/CI' },
    { name: 'over Plan on design-first', laneSet: lanes(PROJECT), from: 'todo', to: 'implement', gate: 'Plan/Design' },
    {
      name: 'out of a verify lane with no owner gate',
      laneSet: verifyWithoutOwnerGate(),
      from: 'tested',
      to: 'closed',
      gate: 'To test',
    },
  ] as const;

  for (const jump of JUMPS) {
    for (const audience of ['external', 'internal'] as const) {
      for (const [standing, caller] of Object.entries(CALLERS) as [Exclude<BoardStanding, 'daemon'>, BoardCaller][]) {
        const expected = standing !== 'reader' && mayPassGate(standing, audience);
        it(`${expected ? 'lets' : 'refuses'} ${standing} on an ${audience} card ${jump.name}`, async () => {
          // Arrange
          const world = serviceOver([cardFor(audience, jump.from)], jump.laneSet);

          // Act
          const error = await attempt(world.service.act('F1', move(jump.to), caller));

          // Assert
          if (expected) {
            should(error).be.undefined();
            should(world.stored().laneId).equal(jump.to);
            return;
          }
          should(error?.code).equalOneOf('owner-gate', 'forbidden');
          should(world.stored().laneId).equal(jump.from);
        });
      }
    }
  }

  it('names the gate it would pass', async () => {
    // Arrange
    const world = serviceOver([cardFor('external', 'implement')], withMiddleGate());

    // Act
    const error = await attempt(world.service.act('F1', move('merged'), CALLERS.assignee));

    // Assert
    should(error?.code).equal('owner-gate');
    should(error?.message).startWith('only the owner moves &F1 past Review/CI');
  });

  it('lets a ferret move a card INTO a gate, and back out of one with a reason', async () => {
    // Arrange
    const world = serviceOver([cardFor('external', 'implement')], withMiddleGate());

    // Act
    await world.service.act('F1', move('review'), CALLERS.assignee);
    await world.service.act('F1', move('implement', 'one more fix'), CALLERS.assignee);

    // Assert
    should(world.stored().laneId).equal('implement');
  });
});

describe('the daemon’s moves stop at a gate', () => {
  const merged = (fields: Partial<PrLink> = {}): PrLink => ({
    url: 'https://github.com/kirinnee/ferretry/pull/930',
    number: 930,
    repo: 'kirinnee/ferretry',
    state: 'merged',
    draft: false,
    checks: 'passing',
    mergedAt: '2026-10-30T09:00:00Z',
    mergeSha: 'a'.repeat(40),
    releasedIn: null,
    polledAt: NOW,
    ...fields,
  });
  const links = (prs: PrLink[]) => ({ links: { prs, branch: null, commits: [], docs: [] } });

  it('keeps a card waiting at Plan when a PR opens: a trigger does not take it out', async () => {
    // Arrange
    const world = serviceOver([cardFor('external', 'plan')]);

    // Act
    const moved = await world.service.trigger('F1', 'pr.opened');

    // Assert
    should(moved).be.null();
    should(world.stored().laneId).equal('plan');
  });

  it('stops a trigger at the first gate on the way, and says so', async () => {
    // Arrange
    const world = serviceOver([cardFor('external', 'implement')], withMiddleGate());

    // Act
    await world.service.trigger('F1', 'pr.merged');

    // Assert
    should(world.stored().laneId).equal('review');
    should(world.stored().history.at(-1)).match({
      type: 'moved',
      to: 'review',
      trigger: 'pr.merged',
      reason: 'stopped at Review/CI, which waits for the owner',
    });
  });

  it('stops a trigger at an internal card’s gate too: its lead passes it, never the daemon', async () => {
    // Arrange
    const world = serviceOver([cardFor('internal', 'implement')], withMiddleGate());

    // Act
    await world.service.trigger('F1', 'pr.merged');

    // Assert
    should(world.stored().laneId).equal('review');
  });

  it('keeps a card in a verify lane with no owner gate when PR facts would move it', async () => {
    // Arrange — an open PR beside the shipped one used to pull a card back out of To test
    const world = serviceOver(
      [
        cardFor('external', 'tested', {
          workflow: 'quick',
          ...links([
            merged({ releasedIn: { version: '4.110.0', tag: 'v4.110.0', at: NOW } }),
            merged({
              url: 'https://github.com/kirinnee/ferretry/pull/931',
              number: 931,
              state: 'open',
              mergedAt: null,
              mergeSha: null,
            }),
          ]),
        }),
      ],
      verifyWithoutOwnerGate(),
    );

    // Act
    const moved = await world.service.trigger('F1', 'pr.ready');

    // Assert
    should(moved).be.null();
    should(world.stored().laneId).equal('tested');
  });

  it('stops PR facts read at a refile at the first gate of the new board', async () => {
    // Arrange — merged and released, refiled onto a board whose Review/CI is a gate
    const world = serviceOver(
      [
        cardFor('external', 'todo', {
          workflow: 'quick',
          ...links([merged({ releasedIn: { version: '4.110.0', tag: 'v4.110.0', at: NOW } })]),
        }),
      ],
      withMiddleGate(),
    );

    // Act
    await world.service.act(
      'F1',
      BoardTaskActionRequestSchema.parse({ action: 'refile', projectId: OTHER_PROJECT }),
      CALLERS.ancestor,
    );

    // Assert
    should(world.stored()).match({ projectId: OTHER_PROJECT, laneId: 'review' });
  });

  it('holds a fy signal done out of a gate, and stops one at a gate on the way', async () => {
    // Arrange — the card in Plan, and one building with a gated Review/CI ahead
    const atPlan = serviceOver([cardFor('external', 'plan', { owner: 'lead', assignee: null })]);
    const building = serviceOver([cardFor('external', 'implement', { owner: 'lead', assignee: null })], {
      ...withMiddleGate(),
      lanes: withMiddleGate().lanes.map(lane =>
        lane.id === 'merged' ? { ...lane, enterOn: [...(lane.enterOn ?? []), 'signal.done'] } : lane,
      ),
    });
    atPlan.focus.focused.set('lead', { id: 'F1' });
    building.focus.focused.set('lead', { id: 'F1' });

    // Act
    const held = await atPlan.service.signalDone('lead', 'planned');
    const stopped = await building.service.signalDone('lead', 'built');

    // Assert
    should(held?.moved).be.null();
    should(held?.held).startWith('only the owner moves &F1 on from plan');
    should(atPlan.stored().laneId).equal('plan');
    should(stopped?.moved?.id).equal('review');
    should(building.stored().laneId).equal('review');
  });

  it('lets the owner’s own report of an external event pass the gates on its way', async () => {
    // Arrange — Merged entered on a deploy, past the gated Review/CI
    const laneSet = withMiddleGate();
    const deploying: LaneSet = {
      ...laneSet,
      lanes: laneSet.lanes.map(lane =>
        lane.id === 'merged' ? { ...lane, enterOn: ['pr.merged', 'deploy.done'] } : lane,
      ),
    };
    const owner = serviceOver([cardFor('external', 'implement')], deploying);
    const ferret = serviceOver([cardFor('external', 'implement')], deploying);
    const report = BoardTaskActionRequestSchema.parse({ action: 'trigger', event: 'deploy.done' });

    // Act
    await owner.service.act('F1', report, CALLERS['owner-human']);
    const refused = await attempt(ferret.service.act('F1', report, CALLERS.owner));

    // Assert
    should(owner.stored().laneId).equal('merged');
    should(refused?.code).equal('owner-gate');
    should(ferret.stored().laneId).equal('implement');
  });
});
