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
  LANE_CARD_WITHDRAWN,
  type RelocationAuthority,
  UNFILED_PROJECT_NAME,
} from '../../../src/lib/board-projects/index.ts';
import { templateLanes } from '../board/support.ts';
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
  readonly withdrawn: Array<readonly [string, string, string]> = [];
  failure?: Error;
  async raise(sessionId: string, reference: string, card: LaneProposalCard): Promise<void> {
    if (this.failure !== undefined) throw this.failure;
    this.raised.push([sessionId, reference, card]);
  }
  async withdraw(sessionId: string, reference: string, note: string): Promise<void> {
    if (this.failure !== undefined) throw this.failure;
    this.withdrawn.push([sessionId, reference, note]);
  }
}

class Relocator implements CardRelocator {
  readonly moves: Array<readonly [string, Readonly<Record<string, string>>]> = [];
  readonly authorities: RelocationAuthority[] = [];
  async relocate(
    projectId: BoardProjectId,
    moves: Readonly<Record<string, string>>,
    by: RelocationAuthority,
  ): Promise<void> {
    this.moves.push([projectId, moves]);
    this.authorities.push(by);
  }
}

/** `lead` started `ms8-abcd1234` (koen); `ms8-other001` is nobody's. */
const PARENTS: Readonly<Record<string, string>> = { 'ms8-abcd1234': 'lead' };

function world(parents: boolean = true) {
  const store = new MemoryStore();
  const agenda = new Agenda();
  const relocator = new Relocator();
  const service = new LaneSetService(
    store,
    { projects: async () => [project(FERRETRY_ID, '/work/ferretry'), project(DOCS_ID, '/work/docs')] },
    { projectOf: async sessionId => (sessionId === 'ms8-abcd1234' ? FERRETRY_ID : UNFILED_PROJECT_ID) },
    agenda,
    relocator,
    parents ? { parentOf: async sessionId => PARENTS[sessionId] } : undefined,
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
    should(agenda.raised[0]?.[2].why).containEql(
      'removes Released, which waits for the owner, and sends its cards into the closed lane, which closes them',
    );
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

/**
 * A waiting proposal belongs to the ferret that made it (review L2), and its card goes when it does (review L1):
 * replaced, accepted in the editor, or dropped by a change to the lanes.
 */
describe('LaneSetService and a waiting proposal’s card', () => {
  const OTHER: LaneActor = { kind: 'ferret', name: 'ivy', sessionId: 'ms8-other001' };
  const LEAD: LaneActor = { kind: 'ferret', name: 'lead', sessionId: 'lead' };
  const live = (): LaneSet => ({ ...templateLanes(FERRETRY_ID), version: 3 });
  const rename = (name: string): LaneSetActionRequest => ({
    action: 'edit',
    version: 3,
    layout: {
      lanes: live().lanes.map(lane => (lane.id === 'todo' ? { ...lane, name } : lane)),
      variants: live().variants,
    },
    relocate: {},
  });
  const waiting = async (parents = true) => {
    const parts = world(parents);
    parts.store.sets.set(FERRETRY_ID, live());
    await parts.service.apply(FERRETRY_ID, rename('Backlog'), FERRET);
    return parts;
  };
  const reference = (version: number) => `lanes:${FERRETRY_ID}:${String(version)}`;

  it('should refuse another ferret’s replacement of a waiting proposal, naming whose it is', async () => {
    const { service, store, agenda } = await waiting();

    const actual = await service.apply(FERRETRY_ID, rename('Inbox'), OTHER);

    should(actual).deepEqual({ ok: false, error: { code: 'proposal-waiting', version: 4, proposedBy: 'koen' } });
    should(store.sets.get(FERRETRY_ID)?.pending).containDeep({ version: 4, proposerSession: 'ms8-abcd1234' });
    should(agenda.withdrawn).deepEqual([]);
  });

  it('should let the proposer, or a lead above it, replace it, and withdraw the replaced card', async () => {
    // Arrange
    const { service, store, agenda } = await waiting();

    // Act
    const own = await service.apply(FERRETRY_ID, rename('Inbox'), FERRET);
    const lead = await service.apply(FERRETRY_ID, rename('Queue'), LEAD);

    // Assert
    should(own.ok && lead.ok).be.true();
    should(store.sets.get(FERRETRY_ID)?.pending).containDeep({ version: 6, proposerSession: 'lead' });
    should(agenda.withdrawn).deepEqual([
      ['ms8-abcd1234', reference(4), LANE_CARD_WITHDRAWN.replaced],
      ['ms8-abcd1234', reference(5), LANE_CARD_WITHDRAWN.replaced],
    ]);
  });

  it('should not let a lead replace it when nobody says who started whom', async () => {
    const { service } = await waiting(false);

    should(await service.apply(FERRETRY_ID, rename('Queue'), LEAD)).match({
      ok: false,
      error: { code: 'proposal-waiting' },
    });
  });

  it('should withdraw the card when the owner accepts the proposal in the lane editor', async () => {
    const { service, agenda } = await waiting();

    await service.apply(FERRETRY_ID, { action: 'confirm', version: 4 }, OWNER);

    should(agenda.withdrawn).deepEqual([['ms8-abcd1234', reference(4), LANE_CARD_WITHDRAWN.accepted]]);
  });

  it('should withdraw the card when the owner’s own edit drops the proposal', async () => {
    const { service, agenda } = await waiting();

    await service.apply(FERRETRY_ID, rename('Mine'), OWNER);

    should(agenda.withdrawn).deepEqual([['ms8-abcd1234', reference(4), LANE_CARD_WITHDRAWN.dropped]]);
  });

  it('should still take the owner’s edit when the card cannot be withdrawn', async () => {
    // Arrange
    const { service, agenda, store } = await waiting();
    agenda.failure = new Error('agenda down');

    // Act
    const actual = await service.apply(FERRETRY_ID, rename('Mine'), OWNER);

    // Assert
    should(actual.ok).be.true();
    should(store.sets.get(FERRETRY_ID)).containDeep({ version: 5, confirmedBy: 'owner' });
    should(store.sets.get(FERRETRY_ID)?.pending).be.undefined();
  });

  it('should leave the card alone when the owner confirms the live set instead', async () => {
    const { service, agenda } = await waiting();

    await service.apply(FERRETRY_ID, { action: 'confirm', version: 3 }, OWNER);

    should(agenda.withdrawn).deepEqual([]);
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
