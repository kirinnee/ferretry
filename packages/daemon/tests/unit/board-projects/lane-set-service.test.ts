import { describe, it } from 'bun:test';
import {
  type BoardProjectId,
  LANE_TEMPLATES,
  type LaneLayoutValue,
  type LaneSet,
  type LaneSetActionRequest,
  UNFILED_PROJECT_ID,
} from '@ferretry/protocol';
import should from 'should';
import {
  type CardRelocator,
  type LaneActor,
  type LaneProposalAgenda,
  type LaneProposalCard,
  type LaneSetMutation,
  LaneSetService,
  type LaneSetStore,
  mergeReleaseLanes,
  RELEASE_MERGE_REASON,
  type RelocationAuthority,
  UNFILED_PROJECT_NAME,
} from '../../../src/lib/board-projects/index.ts';
import { lanes, oldQuickLanes, templateLanes } from '../board/support.ts';
import { DOCS_ID, FERRETRY_ID, project } from './support.ts';

const OWNER: LaneActor = { kind: 'owner' };
const FERRET: LaneActor = { kind: 'ferret', name: 'koen', sessionId: 'ms8-abcd1234' };

class MemoryStore implements LaneSetStore {
  readonly sets = new Map<string, LaneSet>();
  async read(projectId: BoardProjectId): Promise<LaneSet | null> {
    return this.sets.get(projectId) ?? null;
  }
  async transact<T>(projectId: BoardProjectId, decide: (current: LaneSet | null) => LaneSetMutation<T>): Promise<T> {
    const decision = decide(this.sets.get(projectId) ?? null);
    if (decision.next !== undefined) this.sets.set(projectId, decision.next);
    return decision.result;
  }
}

class Agenda implements LaneProposalAgenda {
  readonly raised: Array<readonly [string, string, LaneProposalCard]> = [];
  failure?: Error;
  async raise(sessionId: string, reference: string, card: LaneProposalCard): Promise<void> {
    if (this.failure !== undefined) throw this.failure;
    this.raised.push([sessionId, reference, card]);
  }
}

class Relocator implements CardRelocator {
  readonly moves: Array<readonly [string, Readonly<Record<string, string>>]> = [];
  readonly reasons: Array<string | undefined> = [];
  readonly authorities: RelocationAuthority[] = [];
  async relocate(
    projectId: BoardProjectId,
    moves: Readonly<Record<string, string>>,
    by: RelocationAuthority,
    reason?: string,
  ): Promise<void> {
    this.moves.push([projectId, moves]);
    this.authorities.push(by);
    this.reasons.push(reason);
  }
}

function world() {
  const store = new MemoryStore();
  const agenda = new Agenda();
  const relocator = new Relocator();
  const service = new LaneSetService(
    store,
    { projects: async () => [project(FERRETRY_ID, '/work/ferretry'), project(DOCS_ID, '/work/docs')] },
    { projectOf: async sessionId => (sessionId === 'ms8-abcd1234' ? FERRETRY_ID : UNFILED_PROJECT_ID) },
    agenda,
    relocator,
  );
  return { store, agenda, relocator, service };
}

const propose = (): LaneSetActionRequest => ({ action: 'propose', template: 'quick', renames: {} });

const withoutDoing = (): LaneLayoutValue => ({
  lanes: LANE_TEMPLATES.quick.lanes.filter(lane => lane.id !== 'doing'),
  variants: Object.fromEntries(
    Object.entries(LANE_TEMPLATES.quick.variants).map(([workflow, ids]) => [
      workflow,
      (ids ?? []).filter(id => id !== 'doing'),
    ]),
  ),
});

describe('LaneSetService reads', () => {
  it('should ask the session directory for a session board', async () => {
    const { service } = world();

    should(await service.projectOf('ms8-abcd1234')).equal(FERRETRY_ID);
  });

  it('should list Unfiled first with the quick lanes, then every registered project with its lanes or null', async () => {
    const { service } = world();

    const boards = await service.projects();

    should(boards.map(board => [board.id, board.name, board.path, board.laneSet?.version ?? null])).deepEqual([
      [UNFILED_PROJECT_ID, UNFILED_PROJECT_NAME, null, 1],
      [FERRETRY_ID, 'ferretry', '/work/ferretry', null],
      [DOCS_ID, 'docs', '/work/docs', null],
    ]);
  });

  it('should answer hasLaneSet and project for stored, default and absent lanes', async () => {
    const { service } = world();

    should(await service.hasLaneSet(UNFILED_PROJECT_ID)).be.true();
    should(await service.hasLaneSet(FERRETRY_ID)).be.false();
    await service.apply(FERRETRY_ID, propose(), OWNER);
    should(await service.hasLaneSet(FERRETRY_ID)).be.true();
    should((await service.project(FERRETRY_ID))?.laneSet?.version).equal(1);
    should(await service.project('44444444-4444-4444-8444-444444444444')).be.undefined();
  });
});

describe('LaneSetService.apply', () => {
  it('should refuse a project it does not list', async () => {
    const { service } = world();
    const missing = '44444444-4444-4444-8444-444444444444';

    should(await service.apply(missing, propose(), OWNER)).deepEqual({
      ok: false,
      error: { code: 'not-found', projectId: missing },
    });
  });

  it('should store a ferret proposal and raise one agenda choice on its own board', async () => {
    const { service, agenda, store } = world();

    const actual = await service.apply(FERRETRY_ID, propose(), FERRET);

    should(actual.ok && actual.value.agenda).equal('raised');
    should(store.sets.get(FERRETRY_ID)?.confirmedBy).be.null();
    should(agenda.raised.map(([session, reference]) => [session, reference])).deepEqual([
      ['ms8-abcd1234', `lanes:${FERRETRY_ID}:1`],
    ]);
    should(agenda.raised[0]?.[2].subject).containEql('Lanes for ferretry');
  });

  it('should keep the set live and say so when the agenda cannot be raised', async () => {
    const { service, agenda, store } = world();
    agenda.failure = new Error('agenda down');

    const actual = await service.apply(FERRETRY_ID, propose(), FERRET);

    should(actual.ok && actual.value.agenda).equal('failed');
    should(store.sets.has(FERRETRY_ID)).be.true();
  });

  it('should not ask the owner about the owner own proposal', async () => {
    const { service, agenda } = world();

    const actual = await service.apply(FERRETRY_ID, propose(), OWNER);

    should(actual.ok && actual.value.agenda).equal('not-needed');
    should(agenda.raised).deepEqual([]);
  });

  it('should refuse a proposal over a confirmed set and store nothing new', async () => {
    const { service, store } = world();

    const actual = await service.apply(UNFILED_PROJECT_ID, propose(), FERRET);

    should(actual).deepEqual({ ok: false, error: { code: 'already-confirmed', version: 1 } });
    should(store.sets.size).equal(0);
  });

  it('should edit against the default Unfiled set, relocating removed lanes', async () => {
    const { service, relocator } = world();

    const actual = await service.apply(
      UNFILED_PROJECT_ID,
      { action: 'edit', version: 1, layout: withoutDoing(), relocate: { doing: 'todo', ignored: undefined } },
      OWNER,
    );

    should(actual.ok && actual.value).containDeep({
      agenda: 'not-needed',
      laneSet: { version: 2, confirmedBy: 'owner' },
    });
    should(relocator.moves).deepEqual([[UNFILED_PROJECT_ID, { doing: 'todo' }]]);
    should(relocator.authorities).deepEqual([{ kind: 'owner' }]);
  });

  it('should move the cards of an owner edit on the admin token as the token', async () => {
    const { service, relocator } = world();

    await service.apply(
      UNFILED_PROJECT_ID,
      { action: 'edit', version: 1, layout: withoutDoing(), relocate: { doing: 'todo' } },
      { kind: 'owner', via: 'admin-token' },
    );

    should(relocator.authorities).deepEqual([{ kind: 'owner', via: 'admin-token' }]);
  });

  it('should not call the relocator when an edit removes nothing', async () => {
    const { service, relocator } = world();

    await service.apply(
      UNFILED_PROJECT_ID,
      { action: 'edit', version: 1, layout: LANE_TEMPLATES.quick, relocate: {} },
      OWNER,
    );

    should(relocator.moves).deepEqual([]);
  });

  it('should raise a choice for a ferret edit, which waits for the owner while the lanes stay', async () => {
    const { service, agenda, store } = world();

    const actual = await service.apply(
      UNFILED_PROJECT_ID,
      { action: 'edit', version: 1, layout: LANE_TEMPLATES.quick, relocate: {} },
      FERRET,
    );

    should(actual.ok && actual.value.agenda).equal('raised');
    should(agenda.raised.map(([, reference]) => reference)).deepEqual([`lanes:${UNFILED_PROJECT_ID}:2`]);
    should(store.sets.get(UNFILED_PROJECT_ID)).containDeep({
      version: 1,
      confirmedBy: 'owner',
      pending: { version: 2 },
    });
  });

  it('should store a ferret’s edit of lanes the project has as a proposal: no lane changes and no card moves', async () => {
    // Arrange: Released · to test removed and its cards sent to Closed (exploit b).
    const { service, agenda, store, relocator } = world();
    const live: LaneSet = { ...templateLanes(FERRETRY_ID), version: 3 };
    store.sets.set(FERRETRY_ID, live);
    const layout: LaneLayoutValue = {
      lanes: live.lanes.filter(lane => lane.id !== 'released'),
      variants: Object.fromEntries(
        Object.entries(live.variants).map(([workflow, ids]) => [workflow, (ids ?? []).filter(id => id !== 'released')]),
      ),
    };

    // Act
    const actual = await service.apply(
      FERRETRY_ID,
      { action: 'edit', version: 3, layout, relocate: { released: 'closed' } },
      FERRET,
    );

    // Assert
    should(actual.ok && actual.value.agenda).equal('raised');
    should(relocator.moves).deepEqual([]);
    const { pending, ...stored } = store.sets.get(FERRETRY_ID) ?? live;
    should(stored).deepEqual(live);
    should(pending).containDeep({ version: 4, baseVersion: 3, proposedBy: 'koen', relocate: { released: 'closed' } });
    should(agenda.raised.map(([session, reference]) => [session, reference])).deepEqual([
      ['ms8-abcd1234', `lanes:${FERRETRY_ID}:4`],
    ]);
    should(agenda.raised[0]?.[2].why).containEql('move its cards to Closed');
    should(agenda.raised[0]?.[2].why).containEql('keeps its lanes until you accept');
  });

  it('should refuse a confirm by a ferret and accept one by the owner', async () => {
    const { service, store } = world();
    await service.apply(FERRETRY_ID, propose(), FERRET);

    should(await service.apply(FERRETRY_ID, { action: 'confirm', version: 1 }, FERRET)).deepEqual({
      ok: false,
      error: { code: 'owner-only' },
    });
    const actual = await service.apply(FERRETRY_ID, { action: 'confirm', version: 1 }, OWNER);

    should(actual.ok && actual.value.agenda).equal('not-needed');
    should(store.sets.get(FERRETRY_ID)?.confirmedBy).equal('owner');
  });
});

describe('LaneSetService.acceptProposal', () => {
  /** A ferret's waiting proposal on Ferretry's live lanes: Released · to test removed, its cards to Merged. */
  const waiting = async () => {
    const parts = world();
    const live: LaneSet = { ...templateLanes(FERRETRY_ID), version: 3 };
    parts.store.sets.set(FERRETRY_ID, live);
    const layout: LaneLayoutValue = {
      lanes: live.lanes.filter(lane => lane.id !== 'released'),
      variants: Object.fromEntries(
        Object.entries(live.variants).map(([workflow, ids]) => [workflow, (ids ?? []).filter(id => id !== 'released')]),
      ),
    };
    await parts.service.apply(
      FERRETRY_ID,
      { action: 'edit', version: 3, layout, relocate: { released: 'merged' } },
      FERRET,
    );
    return { ...parts, live, layout };
  };

  it('should make the waiting proposal live and only then move its cards, as the owner', async () => {
    const { service, store, relocator } = await waiting();

    should(await service.acceptProposal(FERRETRY_ID, 4)).be.true();

    should(store.sets.get(FERRETRY_ID)).containDeep({ version: 4, confirmedBy: 'owner', proposedBy: 'koen' });
    should(store.sets.get(FERRETRY_ID)?.pending).be.undefined();
    should(store.sets.get(FERRETRY_ID)?.lanes.some(lane => lane.id === 'released')).be.false();
    should(relocator.moves).deepEqual([[FERRETRY_ID, { released: 'merged' }]]);
    should(relocator.authorities).deepEqual([{ kind: 'owner' }]);
  });

  it('should take the owner’s confirm from the lane editor the same way', async () => {
    const { service, store, relocator } = await waiting();

    const actual = await service.apply(FERRETRY_ID, { action: 'confirm', version: 4 }, OWNER);

    should(actual.ok && actual.value).containDeep({
      agenda: 'not-needed',
      laneSet: { version: 4, confirmedBy: 'owner' },
    });
    should(store.sets.get(FERRETRY_ID)?.pending).be.undefined();
    should(relocator.authorities).deepEqual([{ kind: 'owner' }]);
  });

  it('should accept nothing for the card of a proposal a newer one replaced, or one the owner’s edit dropped', async () => {
    // Arrange
    const { service, store, relocator, live, layout } = await waiting();
    await service.apply(
      FERRETRY_ID,
      { action: 'edit', version: 3, layout, relocate: { released: 'implement' } },
      FERRET,
    );

    // Act + Assert: the first card (4) names nothing now; the second (5) is waiting.
    should(await service.acceptProposal(FERRETRY_ID, 4)).be.false();
    should(store.sets.get(FERRETRY_ID)?.pending?.version).equal(5);
    await service.apply(FERRETRY_ID, { action: 'edit', version: 3, layout: live, relocate: {} }, OWNER);
    should(await service.acceptProposal(FERRETRY_ID, 5)).be.false();
    should(store.sets.get(FERRETRY_ID)).containDeep({ version: 6, confirmedBy: 'owner' });
    should(store.sets.get(FERRETRY_ID)?.lanes.some(lane => lane.id === 'released')).be.true();
    should(relocator.moves).deepEqual([]);
  });

  it('should confirm the proposed version', async () => {
    const { service, store } = world();
    await service.apply(FERRETRY_ID, propose(), FERRET);

    should(await service.acceptProposal(FERRETRY_ID, 1)).be.true();
    should(store.sets.get(FERRETRY_ID)?.confirmedBy).equal('owner');
  });

  it('should confirm nothing for a version that has moved on or a project with no lanes', async () => {
    const { service, store } = world();
    await service.apply(FERRETRY_ID, propose(), FERRET);

    should(await service.acceptProposal(FERRETRY_ID, 9)).be.false();
    should(await service.acceptProposal(DOCS_ID, 1)).be.false();
    should(store.sets.get(FERRETRY_ID)?.confirmedBy).be.null();
  });
});

describe('LaneSetService merges Released and To test at boot', () => {
  it('should merge each stored set that has both, move the cards before and after, and say why', async () => {
    // Arrange
    const { store, relocator, service } = world();
    store.sets.set(FERRETRY_ID, { ...lanes(FERRETRY_ID), version: 3 });
    store.sets.set(DOCS_ID, templateLanes(DOCS_ID));

    // Act
    const outcomes = await service.mergeReleaseLanes();

    // Assert
    should(outcomes).deepEqual([{ projectId: FERRETRY_ID, merged: true, version: 4 }]);
    should(relocator.moves).deepEqual([
      [FERRETRY_ID, { tested: 'released' }],
      [FERRETRY_ID, { tested: 'released' }],
    ]);
    should(relocator.reasons).deepEqual([RELEASE_MERGE_REASON, RELEASE_MERGE_REASON]);
    should(RELEASE_MERGE_REASON).equal('Released and To test are one lane now: Released · to test');
    should(store.sets.get(FERRETRY_ID)?.lanes.some(lane => lane.id === 'tested')).be.false();
    should(store.sets.get(FERRETRY_ID)?.confirmedBy).equal('owner');
    should(relocator.authorities).deepEqual([{ kind: 'daemon' }, { kind: 'daemon' }]);
    should(store.sets.get(DOCS_ID)?.version).equal(1);
  });

  it('should do nothing the second time', async () => {
    // Arrange
    const { store, relocator, service } = world();
    store.sets.set(FERRETRY_ID, lanes(FERRETRY_ID));
    await service.mergeReleaseLanes();

    // Act
    const again = await service.mergeReleaseLanes();

    // Assert
    should(again).deepEqual([]);
    should(relocator.moves).have.length(2);
  });

  it('should store nothing and move no card again when the set was merged in between', async () => {
    // Arrange
    const { store, relocator, service } = world();
    store.sets.set(FERRETRY_ID, lanes(FERRETRY_ID));
    const merged = mergeReleaseLanes(lanes(FERRETRY_ID))?.next;
    const transact = store.transact.bind(store);
    store.transact = async (projectId, decide) => {
      if (merged !== undefined) store.sets.set(projectId, merged);
      return await transact(projectId, decide);
    };

    // Act
    const outcomes = await service.mergeReleaseLanes();

    // Assert
    should(outcomes).deepEqual([]);
    should(relocator.moves).have.length(1);
  });

  it('should report a project it could not merge and go on with the rest', async () => {
    // Arrange
    const { store, service } = world();
    store.sets.set(DOCS_ID, lanes(DOCS_ID));
    const read = store.read.bind(store);
    store.read = async projectId => {
      if (projectId === FERRETRY_ID) throw new Error('damaged lane set');
      return await read(projectId);
    };

    // Act
    const outcomes = await service.mergeReleaseLanes();

    // Assert
    should(outcomes).deepEqual([
      { projectId: FERRETRY_ID, merged: false, problem: 'damaged lane set' },
      { projectId: DOCS_ID, merged: true, version: 2 },
    ]);
  });

  it('should report a failure that is not an Error in its own words', async () => {
    // Arrange
    const { store, service } = world();
    store.read = async () => Promise.reject('disk gone');

    // Act + Assert
    should((await service.mergeReleaseLanes())[0]).deepEqual({
      projectId: UNFILED_PROJECT_ID,
      merged: false,
      problem: 'disk gone',
    });
  });
});

describe('LaneSetService gives quick sets their To test lane at boot', () => {
  it('should add To test to each stored quick set from before it, move no card, and ask nothing', async () => {
    // Arrange
    const { store, agenda, relocator, service } = world();
    store.sets.set(UNFILED_PROJECT_ID, { ...oldQuickLanes(UNFILED_PROJECT_ID), version: 2 });
    store.sets.set(DOCS_ID, oldQuickLanes(DOCS_ID));
    store.sets.set(FERRETRY_ID, templateLanes(FERRETRY_ID));

    // Act
    const outcomes = await service.addQuickToTestLanes();

    // Assert
    should(outcomes).deepEqual([
      { projectId: UNFILED_PROJECT_ID, added: true, version: 3 },
      { projectId: DOCS_ID, added: true, version: 2 },
    ]);
    should(store.sets.get(UNFILED_PROJECT_ID)?.lanes.map(lane => lane.id)).deepEqual([
      'todo',
      'doing',
      'to-test',
      'closed',
    ]);
    should(store.sets.get(UNFILED_PROJECT_ID)?.confirmedBy).equal('owner');
    should(store.sets.get(FERRETRY_ID)?.version).equal(1);
    should(relocator.moves).be.empty();
    should(agenda.raised).be.empty();
  });

  it('should do nothing the second time, nor for an Unfiled board that keeps the built-in lanes', async () => {
    // Arrange
    const { store, service } = world();
    store.sets.set(DOCS_ID, oldQuickLanes(DOCS_ID));
    await service.addQuickToTestLanes();

    // Act
    const again = await service.addQuickToTestLanes();

    // Assert
    should(again).deepEqual([]);
    should(store.sets.has(UNFILED_PROJECT_ID)).be.false();
    should((await service.laneSet(UNFILED_PROJECT_ID))?.lanes.map(lane => lane.id)).containEql('to-test');
  });

  it('should report a project it could not update and go on with the rest', async () => {
    // Arrange
    const { store, service } = world();
    store.sets.set(DOCS_ID, oldQuickLanes(DOCS_ID));
    const transact = store.transact.bind(store);
    store.transact = async (projectId, decide) => {
      if (projectId === FERRETRY_ID) throw new Error('damaged lane set');
      if (projectId === UNFILED_PROJECT_ID) return Promise.reject('disk gone');
      return await transact(projectId, decide);
    };

    // Act
    const outcomes = await service.addQuickToTestLanes();

    // Assert
    should(outcomes).deepEqual([
      { projectId: UNFILED_PROJECT_ID, added: false, problem: 'disk gone' },
      { projectId: FERRETRY_ID, added: false, problem: 'damaged lane set' },
      { projectId: DOCS_ID, added: true, version: 2 },
    ]);
  });
});

describe('LaneSetService writes out every lane’s stage at boot', () => {
  it('should stage each stored set from before stages, move no card, and ask nothing', async () => {
    // Arrange
    const { store, agenda, relocator, service } = world();
    store.sets.set(UNFILED_PROJECT_ID, { ...oldQuickLanes(UNFILED_PROJECT_ID), version: 2 });
    store.sets.set(FERRETRY_ID, { ...lanes(FERRETRY_ID), version: 5 });
    store.sets.set(DOCS_ID, templateLanes(DOCS_ID, 'writing'));

    // Act
    const outcomes = await service.stageLanes();

    // Assert
    should(outcomes).deepEqual([
      { projectId: UNFILED_PROJECT_ID, staged: true, version: 2 },
      { projectId: FERRETRY_ID, staged: true, version: 5 },
    ]);
    should(store.sets.get(FERRETRY_ID)?.lanes.every(lane => lane.stage !== undefined)).be.true();
    should(store.sets.get(FERRETRY_ID)?.confirmedBy).equal('owner');
    should(store.sets.get(DOCS_ID)?.version).equal(1);
    should(relocator.moves).be.empty();
    should(agenda.raised).be.empty();
  });

  it('should do nothing the second time, nor for an Unfiled board that keeps the built-in lanes', async () => {
    // Arrange
    const { store, service } = world();
    store.sets.set(DOCS_ID, oldQuickLanes(DOCS_ID));
    await service.stageLanes();

    // Act
    const again = await service.stageLanes();

    // Assert
    should(again).deepEqual([]);
    should(store.sets.has(UNFILED_PROJECT_ID)).be.false();
    should((await service.laneSet(UNFILED_PROJECT_ID))?.lanes.every(lane => lane.stage !== undefined)).be.true();
  });

  it('should never write a staged set the next read would refuse', async () => {
    // Arrange: a stored set no reader accepts (a lane entered on no trigger at all), which only a fake store holds.
    const { store, service } = world();
    const broken = oldQuickLanes(DOCS_ID);
    const unreadable = {
      ...broken,
      lanes: broken.lanes.map(lane => (lane.id === 'doing' ? { ...lane, enterOn: [] } : lane)),
    } as LaneSet;
    store.sets.set(DOCS_ID, unreadable);

    // Act
    const outcomes = await service.stageLanes();

    // Assert
    should(outcomes).deepEqual([
      {
        projectId: DOCS_ID,
        staged: false,
        problem: 'staging its lanes would leave them unreadable, so they are left as they are',
      },
    ]);
    should(store.sets.get(DOCS_ID)).equal(unreadable);
  });

  it('should report a project whose set it could not read and go on with the rest', async () => {
    // Arrange
    const { store, service } = world();
    store.sets.set(DOCS_ID, oldQuickLanes(DOCS_ID));
    const transact = store.transact.bind(store);
    store.transact = async (projectId, decide) => {
      if (projectId === FERRETRY_ID) throw new Error('refusing to use a damaged lane set');
      if (projectId === UNFILED_PROJECT_ID) return Promise.reject('disk gone');
      return await transact(projectId, decide);
    };

    // Act
    const outcomes = await service.stageLanes();

    // Assert
    should(outcomes).deepEqual([
      { projectId: UNFILED_PROJECT_ID, staged: false, problem: 'disk gone' },
      { projectId: FERRETRY_ID, staged: false, problem: 'refusing to use a damaged lane set' },
      { projectId: DOCS_ID, staged: true, version: 1 },
    ]);
  });

  it('should leave a pending proposal acceptable: Accept on its card still confirms the staged set', async () => {
    // Arrange: a ferret's proposal from before stages, its agenda card waiting on the owner.
    const { store, service } = world();
    store.sets.set(DOCS_ID, { ...oldQuickLanes(DOCS_ID), version: 4, confirmedBy: null, proposedBy: 'koen' });
    await service.stageLanes();

    // Act
    const accepted = await service.acceptProposal(DOCS_ID, 4);

    // Assert
    should(accepted).be.true();
    should(store.sets.get(DOCS_ID)).match({ version: 4, confirmedBy: 'owner' });
    should(store.sets.get(DOCS_ID)?.lanes.every(lane => lane.stage !== undefined)).be.true();
  });
});
