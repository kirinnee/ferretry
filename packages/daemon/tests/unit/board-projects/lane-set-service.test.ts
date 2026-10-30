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
  UNFILED_PROJECT_NAME,
} from '../../../src/lib/board-projects/index.ts';
import { lanes, templateLanes } from '../board/support.ts';
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
  async relocate(projectId: BoardProjectId, moves: Readonly<Record<string, string>>, reason?: string): Promise<void> {
    this.moves.push([projectId, moves]);
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

  it('should raise a choice for a ferret edit, which leaves the set unconfirmed', async () => {
    const { service, agenda } = world();

    const actual = await service.apply(
      UNFILED_PROJECT_ID,
      { action: 'edit', version: 1, layout: LANE_TEMPLATES.quick, relocate: {} },
      FERRET,
    );

    should(actual.ok && actual.value.agenda).equal('raised');
    should(agenda.raised.length).equal(1);
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
