import { describe, it } from 'bun:test';
import type { BoardTask, PrLink } from '@ferretry/protocol';
import should from 'should';
import {
  BoardIndex,
  blockedBy,
  cardCategory,
  deriveView,
  type DerivationInputs,
  dependencyCycle,
  gatherDerivation,
  HistoryActivityDeriver,
  rollupOf,
  shippedIn,
  suggestedLaneOf,
  UNOBSERVED,
} from '../../../src/lib/board/index.ts';
import { card, lanes, MACHINE, NO_ASKS, NOW, OTHER_PROJECT, PROJECT } from './support.ts';

const laneSets = new Map([
  [PROJECT, lanes(PROJECT)],
  [OTHER_PROJECT, lanes(OTHER_PROJECT, 'pr')],
]);

const pr = (overrides: Partial<PrLink> = {}): PrLink => ({
  url: 'https://github.com/kirinnee/ferretry/pull/930',
  number: 930,
  repo: 'kirinnee/ferretry',
  state: 'merged',
  draft: false,
  checks: 'passing',
  mergedAt: NOW,
  mergeSha: 'a'.repeat(40),
  releasedIn: null,
  polledAt: NOW,
  ...overrides,
});

const inputs = (cards: readonly BoardTask[], overrides: Partial<DerivationInputs> = {}): DerivationInputs => ({
  index: new BoardIndex(cards, MACHINE),
  laneSets,
  activity: new Map(),
  asks: new Map(),
  ...overrides,
});

describe('the board index', () => {
  it('should resolve local refs and refuse another machine', () => {
    // Arrange
    const index = new BoardIndex([card({ id: 'F1' })], MACHINE);

    // Assert
    should(index.get({ id: 'F1' })?.id).equal('F1');
    should(index.get({ id: 'F1', machineId: MACHINE })?.id).equal('F1');
    should(index.get({ id: 'F1', machineId: 'mac' })).be.undefined();
    should(index.children('F9')).eql([]);
    should(index.dependents('F9')).eql([]);
  });

  it('should index children and dependents on this machine only', () => {
    // Arrange
    const parent = card({ id: 'F1' });
    const child = card({ id: 'F2', parent: { id: 'F1' }, dependsOn: [{ task: { id: 'F1' }, until: 'shipped' }] });
    const remote = card({
      id: 'F3',
      parent: { id: 'F1', machineId: 'mac' },
      dependsOn: [{ task: { id: 'F1', machineId: 'mac' }, until: 'shipped' }],
    });
    const sibling = card({ id: 'F4', parent: { id: 'F1' } });

    // Act
    const index = new BoardIndex([parent, child, remote, sibling], MACHINE);

    // Assert
    should(index.children('F1').map(entry => entry.id)).eql(['F2', 'F4']);
    should(index.dependents('F1').map(entry => entry.id)).eql(['F2']);
  });
});

describe('a card category', () => {
  it('should read the lane category, or nothing without known lanes', () => {
    // Assert
    should(cardCategory(card({ laneId: 'review' }), laneSets)).equal('review');
    should(cardCategory(card({ projectId: 'unfiled' }), laneSets)).be.undefined();
    should(cardCategory(card({ laneId: 'gone' }), laneSets)).be.undefined();
  });
});

describe('shipped in', () => {
  it('should be the earliest release over the merged PRs', () => {
    // Arrange
    const later = pr({
      url: 'https://github.com/kirinnee/ferretry/pull/931',
      number: 931,
      releasedIn: { version: '4.111.0', tag: 'v4.111.0', at: '2026-11-02T00:00:00.000Z' },
    });
    const earlier = pr({ releasedIn: { version: '4.110.0', tag: 'v4.110.0', at: '2026-11-01T00:00:00.000Z' } });
    const unreleased = pr({ url: 'https://github.com/kirinnee/ferretry/pull/932', number: 932 });

    // Act
    const found = shippedIn(
      card({ links: { prs: [later, unreleased, earlier], branch: null, commits: [], docs: [] } }),
    );

    // Assert
    should(found?.version).equal('4.110.0');
    should(shippedIn(card())).be.null();
  });
});

describe('blocked by', () => {
  const blocker = (overrides: Partial<BoardTask>) => card({ id: 'F2', ...overrides });
  const dependent = (until: 'shipped' | 'released' = 'shipped', extra: Partial<BoardTask> = {}) =>
    card({ id: 'F1', dependsOn: [{ task: { id: 'F2' }, until }], ...extra });

  it.each([
    {
      name: 'a blocker still in implement',
      blocker: blocker({ laneId: 'implement' }),
      until: 'shipped' as const,
      blocks: true,
    },
    { name: 'a merged blocker', blocker: blocker({ laneId: 'merged' }), until: 'shipped' as const, blocks: false },
    {
      name: 'a merged blocker awaited until released',
      blocker: blocker({ laneId: 'merged' }),
      until: 'released' as const,
      blocks: true,
    },
    {
      name: 'a blocker in the Released lane',
      blocker: blocker({ laneId: 'released' }),
      until: 'released' as const,
      blocks: false,
    },
    {
      name: 'a merged blocker with a released PR',
      blocker: blocker({
        laneId: 'merged',
        links: {
          prs: [pr({ releasedIn: { version: '4.110.0', tag: 'v4.110.0', at: NOW } })],
          branch: null,
          commits: [],
          docs: [],
        },
      }),
      until: 'released' as const,
      blocks: false,
    },
    { name: 'a closed blocker', blocker: blocker({ laneId: 'closed' }), until: 'released' as const, blocks: false },
    {
      name: 'a dropped blocker',
      blocker: blocker({ laneId: 'merged', dropped: { reason: 'superseded', at: NOW } }),
      until: 'shipped' as const,
      blocks: true,
    },
    {
      name: 'a blocker on a board without lanes',
      blocker: blocker({ projectId: 'unfiled', laneId: 'merged' }),
      until: 'shipped' as const,
      blocks: true,
    },
    {
      name: 'a blocker in a lane its board lost',
      blocker: blocker({ laneId: 'gone' }),
      until: 'released' as const,
      blocks: true,
    },
    {
      name: 'a blocker on a board with no lanes awaited until released',
      blocker: blocker({ projectId: 'unfiled', laneId: 'merged' }),
      until: 'released' as const,
      blocks: true,
    },
  ])('should decide $name', ({ blocker: found, until, blocks }) => {
    // Arrange
    const waiting = dependent(until);

    // Act
    const refs = blockedBy(waiting, new BoardIndex([waiting, found], MACHINE), laneSets);

    // Assert
    should(refs.length > 0).equal(blocks);
  });

  it('should still count a blocker this machine cannot read', () => {
    // Arrange
    const waiting = card({
      id: 'F1',
      dependsOn: [
        { task: { id: 'F9' }, until: 'shipped' },
        { task: { id: 'F2', machineId: 'mac' }, until: 'shipped' },
      ],
    });

    // Act
    const refs = blockedBy(waiting, new BoardIndex([waiting], MACHINE), laneSets);

    // Assert
    should(refs).eql([{ id: 'F9' }, { id: 'F2', machineId: 'mac' }]);
  });

  it('should not count an overridden dependency', () => {
    // Arrange
    const waiting = card({
      id: 'F1',
      dependsOn: [{ task: { id: 'F9' }, until: 'shipped', override: { by: 'owner', reason: 'ship it', at: NOW } }],
    });

    // Act
    const refs = blockedBy(waiting, new BoardIndex([waiting], MACHINE), laneSets);

    // Assert
    should(refs).eql([]);
  });
});

describe('the dependency cycle check', () => {
  it('should name the cycle an edge two hops away would close', () => {
    // Arrange
    const cards = [
      card({ id: 'F1' }),
      card({ id: 'F2', dependsOn: [{ task: { id: 'F3' }, until: 'shipped' }] }),
      card({ id: 'F3', dependsOn: [{ task: { id: 'F1' }, until: 'shipped' }] }),
    ];

    // Act
    const cycle = dependencyCycle(new BoardIndex(cards, MACHINE), 'F1', { id: 'F2' });

    // Assert
    should(cycle).equal('&F1 → &F2 → &F3 → &F1');
  });

  it('should pass an acyclic graph with shared ancestors and remote edges', () => {
    // Arrange
    const cards = [
      card({ id: 'F1' }),
      card({
        id: 'F2',
        dependsOn: [
          { task: { id: 'F4' }, until: 'shipped' },
          { task: { id: 'F3' }, until: 'shipped' },
        ],
      }),
      card({
        id: 'F3',
        dependsOn: [
          { task: { id: 'F4' }, until: 'shipped' },
          { task: { id: 'F1', machineId: 'mac' }, until: 'shipped' },
        ],
      }),
      card({ id: 'F4' }),
    ];

    // Act
    const cycle = dependencyCycle(new BoardIndex(cards, MACHINE), 'F1', { id: 'F2' });

    // Assert
    should(cycle).be.null();
    should(dependencyCycle(new BoardIndex(cards, MACHINE), 'F1', { id: 'F2', machineId: 'mac' })).be.null();
  });
});

describe('the derived view', () => {
  it('should sum the live children by category and count the active ones', () => {
    // Arrange
    const parent = card({ id: 'F1', laneId: 'implement' });
    const cards = [
      parent,
      card({ id: 'F2', parent: { id: 'F1' }, laneId: 'review' }),
      card({ id: 'F3', parent: { id: 'F1' }, laneId: 'merged' }),
      card({ id: 'F4', parent: { id: 'F1' }, laneId: 'merged', dropped: { reason: 'no', at: NOW } }),
      card({ id: 'F5', parent: { id: 'F1' }, projectId: 'unfiled' }),
      card({ id: 'F6', parent: { id: 'F3' }, laneId: 'todo' }),
    ];
    const activity = new Map([
      ['F2', { lastTouchedAt: '2026-10-30T11:00:00.000Z', touchedBy: 'child', activity: 'active' as const }],
      ['F6', { lastTouchedAt: '2026-10-30T12:00:00.000Z', touchedBy: 'grandchild', activity: 'idle' as const }],
    ]);

    // Act
    const rollup = rollupOf(parent, inputs(cards, { activity }));

    // Assert
    should(rollup).eql({
      children: 2,
      byCategory: { backlog: 0, active: 0, review: 1, shipped: 1, verify: 0, closed: 0 },
      active: 1,
      lastTouchedAt: '2026-10-30T12:00:00.000Z',
    });
  });

  it('should walk a parent loop once', () => {
    // Arrange
    const first = card({ id: 'F1', parent: { id: 'F2' } });
    const second = card({ id: 'F2', parent: { id: 'F1' } });

    // Act
    const rollup = rollupOf(first, inputs([first, second]));

    // Assert
    should(rollup.children).equal(1);
    should(rollup.lastTouchedAt).be.null();
  });

  it.each([
    { name: 'children all merged', children: ['merged', 'released'], parentLane: 'implement', expected: 'merged' },
    { name: 'children all closed', children: ['closed'], parentLane: 'implement', expected: 'tested' },
    { name: 'a child behind the parent', children: ['todo', 'merged'], parentLane: 'implement', expected: null },
    { name: 'children level with the parent', children: ['implement'], parentLane: 'plan', expected: null },
  ])('should suggest a lane for $name', ({ children, parentLane, expected }) => {
    // Arrange
    const parent = card({ id: 'F1', laneId: parentLane });
    const cards = [
      parent,
      ...children.map((laneId, index) => card({ id: `F${index + 2}`, laneId, parent: { id: 'F1' } })),
    ];

    // Act
    const suggested = suggestedLaneOf(parent, inputs(cards));

    // Assert
    should(suggested).equal(expected);
  });

  it('should skip a category the parent variant does not walk', () => {
    // Arrange: a pr board has no verify lane, and its last lane is closed.
    const parent = card({ id: 'F1', projectId: OTHER_PROJECT, laneId: 'implement' });
    const child = card({ id: 'F2', projectId: OTHER_PROJECT, laneId: 'merged', parent: { id: 'F1' } });

    // Act
    const suggested = suggestedLaneOf(parent, inputs([parent, child]));

    // Assert: shipped and verify are missing there, so the furthest it may suggest is review.
    should(suggested).equal('review');
  });

  it.each([
    { name: 'no children', cards: () => [card({ id: 'F1', laneId: 'implement' })] },
    {
      name: 'a parent without lanes',
      cards: () => [
        card({ id: 'F1', projectId: 'unfiled' }),
        card({ id: 'F2', parent: { id: 'F1' }, laneId: 'merged' }),
      ],
    },
    {
      name: 'a parent in a lane its board lost',
      cards: () => [card({ id: 'F1', laneId: 'gone' }), card({ id: 'F2', parent: { id: 'F1' }, laneId: 'merged' })],
    },
    {
      name: 'a dropped parent',
      cards: () => [
        card({ id: 'F1', dropped: { reason: 'no', at: NOW } }),
        card({ id: 'F2', parent: { id: 'F1' }, laneId: 'merged' }),
      ],
    },
    {
      name: 'a child without lanes',
      cards: () => [card({ id: 'F1' }), card({ id: 'F2', parent: { id: 'F1' }, projectId: 'unfiled' })],
    },
  ])('should suggest nothing for $name', ({ cards }) => {
    // Arrange
    const all = cards();

    // Act
    const suggested = suggestedLaneOf(all[0] as BoardTask, inputs(all));

    // Assert
    should(suggested).be.null();
  });

  it('should put the derived fields beside the stored card', () => {
    // Arrange
    const blocker = card({ id: 'F2', laneId: 'implement' });
    const waiting = card({ id: 'F1', dependsOn: [{ task: { id: 'F2' }, until: 'shipped' }] });
    const droppedDependent = card({
      id: 'F3',
      dependsOn: [{ task: { id: 'F2' }, until: 'shipped' }],
      dropped: { reason: 'no', at: NOW },
    });
    const ask = { sessionId: 'lead', id: 'A4' };
    const asks = new Map([['F1', { open: [ask], blocking: [ask] }]]);
    const all = [waiting, blocker, droppedDependent];

    // Act
    const view = deriveView(waiting, inputs(all, { asks }));
    const blockerView = deriveView(blocker, inputs(all));

    // Assert
    should(view.blockedBy).eql([{ id: 'F2' }]);
    should(view.waitingOnOwner).eql([ask]);
    should(view.openAsks).eql([ask]);
    should(view.activity).equal(UNOBSERVED.activity);
    should(view.shippedIn).be.null();
    should(blockerView.blocks).eql([{ id: 'F1' }]);
    should(blockerView.openAsks).eql([]);
  });

  it('should ask both derivation ports once for the whole board', async () => {
    // Arrange
    const cards = [card({ id: 'F1', blocked: { on: 'external', reason: 'vendor', since: NOW } }), card({ id: 'F2' })];

    // Act
    const gathered = await gatherDerivation(cards, new BoardIndex(cards, MACHINE), laneSets, {
      activity: new HistoryActivityDeriver(),
      agenda: NO_ASKS,
    });

    // Assert
    should(gathered.activity.get('F1')?.activity).equal('waiting');
    should(gathered.activity.get('F2')).eql({ lastTouchedAt: NOW, touchedBy: 'lead', activity: 'idle' });
    should(gathered.asks.size).equal(0);
  });
});
