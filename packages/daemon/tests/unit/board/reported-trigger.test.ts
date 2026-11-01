import { describe, it } from 'bun:test';
import {
  type BoardTask,
  type BoardTaskActionRequestInput,
  BoardTaskActionRequestSchema,
  type Lane,
  type LaneSet,
  LaneSetSchema,
} from '@ferretry/protocol';
import should from 'should';
import { type BoardCaller, BoardError, BoardService, gateOnTheWay } from '../../../src/lib/board/index.ts';
import { DIRECTORY } from '../sub-ferret/support.ts';
import { card, FakeLanes, MemoryBoardStore, PROJECT, type ServiceWorld, templateLanes, world } from './support.ts';

const owner: BoardCaller = { kind: 'owner' };
const ferret = (sessionId: string): BoardCaller => ({ kind: 'ferret', sessionId });
const lead = ferret('lead');
const child = ferret('child');
const grandchild = ferret('grandchild');
const stranger = ferret('stranger');

const lane = (id: string, category: Lane['category'], extra: Partial<Lane> = {}): Lane => ({
  id,
  name: id,
  category,
  ...extra,
});

/**
 * A labelling project's workflow: prepare the PRs, the owner's "send for review?" gate, wait for the
 * reviewer's approval, merge and deploy, then the owner confirms it is deployed.
 */
const LABELLING: LaneSet = LaneSetSchema.parse({
  projectId: PROJECT,
  version: 2,
  confirmedBy: 'owner',
  proposedBy: 'lead',
  lanes: [
    lane('todo', 'backlog'),
    lane('prepare', 'active', { enterOn: ['work.started', 'pr.opened'] }),
    lane('send', 'review', {
      stage: {
        kind: 'gate',
        options: [
          { id: 'send', label: 'Send for review', outcome: { kind: 'next' } },
          { id: 'redo', label: 'Not yet', outcome: { kind: 'reopen-with-agenda' } },
        ],
      },
    }),
    lane('waiting', 'review', { enterOn: ['pr.review_approved'] }),
    lane('deployed', 'shipped', { enterOn: ['pr.merged', 'deploy.done'] }),
    lane('confirm', 'verify', { ownerGate: true }),
    lane('closed', 'closed', { ownerGate: true }),
  ],
  variants: {},
});

/** The same flow, where design-first work does not stop at Send for review. */
const SKIPS_SEND: LaneSet = LaneSetSchema.parse({
  ...LABELLING,
  variants: { 'design-first': LABELLING.lanes.map(entry => entry.id).filter(id => id !== 'send') },
});

/** Ferretry's own lanes, where a deploy also counts as merged: Plan/Design is a gate before them. */
const PLANNED: LaneSet = (() => {
  const set = templateLanes(PROJECT);
  return LaneSetSchema.parse({
    ...set,
    lanes: set.lanes.map(entry =>
      entry.id === 'merged' ? { ...entry, enterOn: ['pr.merged', 'deploy.done'], stage: undefined } : entry,
    ),
  });
})();

/** The same flow, where a deploy enters the owner's Confirm deployed? gate directly. */
const CONFIRMS_DEPLOY: LaneSet = LaneSetSchema.parse({
  ...LABELLING,
  lanes: LABELLING.lanes.map(entry => {
    if (entry.id === 'deployed') return lane('deployed', 'shipped', { enterOn: ['pr.merged'] });
    return entry.id === 'confirm' ? { ...entry, enterOn: ['deploy.done'] } : entry;
  }),
});

/** A set with no verify lane: work, then live, then a deploy closes it (its closed lane has no gate). */
const DEPLOY_CLOSES: LaneSet = LaneSetSchema.parse({
  projectId: PROJECT,
  version: 1,
  confirmedBy: 'owner',
  proposedBy: 'lead',
  lanes: [
    lane('todo', 'backlog'),
    lane('doing', 'active', { enterOn: ['work.started'] }),
    lane('live', 'shipped', { enterOn: ['pr.merged'] }),
    lane('done', 'closed', { enterOn: ['deploy.done'] }),
  ],
  variants: {},
});

/** The same flow with a ferret's own Check in place of the owner's Send for review? gate. */
const CHECKED: LaneSet = LaneSetSchema.parse({
  ...LABELLING,
  lanes: LABELLING.lanes.map(entry => (entry.id === 'send' ? lane('check', 'review') : entry)),
});

/** The same flow, where the deploy itself would close the card. */
const CLOSES_ON_DEPLOY: LaneSet = LaneSetSchema.parse({
  ...LABELLING,
  lanes: LABELLING.lanes.map(entry => {
    if (entry.id === 'deployed') return lane('deployed', 'shipped', { enterOn: ['pr.merged'] });
    return entry.id === 'closed' ? { ...entry, enterOn: ['deploy.done'] } : entry;
  }),
});

const action = (input: BoardTaskActionRequestInput) => BoardTaskActionRequestSchema.parse(input);
const report = (event: 'deploy.done' | 'pr.review_approved', reason?: string) =>
  action({ action: 'trigger', event, ...(reason === undefined ? {} : { reason }) });

const serviceWith = (cards: readonly BoardTask[], laneSet = LABELLING, overrides: Partial<ServiceWorld> = {}) => {
  const ports = world({
    store: new MemoryBoardStore(cards),
    lanes: new FakeLanes(new Map([[PROJECT, laneSet]])),
    ...overrides,
  });
  return { ports, service: new BoardService(ports) };
};

const stored = (ports: ServiceWorld, id = 'F1'): BoardTask => ports.store.cards.get(id) as BoardTask;
const lastEvent = (ports: ServiceWorld, id = 'F1') => stored(ports, id).history.at(-1);

async function refusal(work: Promise<unknown>): Promise<BoardError> {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  should(error).be.instanceOf(BoardError);
  return error as BoardError;
}

describe('a reported trigger', () => {
  it('should move the card as the daemon would, and record who reported it', async () => {
    // Arrange
    const { ports, service } = serviceWith([card({ laneId: 'waiting', owner: 'lead', assignee: 'child' })]);

    // Act
    const response = await service.act('F1', report('deploy.done', 'deployed to production'), child);

    // Assert
    should(response.task.laneId).equal('deployed');
    should(lastEvent(ports)).match({
      type: 'moved',
      from: 'waiting',
      to: 'deployed',
      backward: false,
      auto: true,
      trigger: 'deploy.done',
      reason: 'deployed to production',
      actor: { kind: 'daemon' },
      reportedBy: { kind: 'ferret', sessionId: 'child' },
    });
    should(lastEvent(ports)).not.have.property('reportedVia');
  });

  it('should take the report of the owner, the owner ferret and its leads', async () => {
    for (const caller of [owner, lead, ferret('grandparent')]) {
      // Arrange
      const { ports, service } = serviceWith([card({ laneId: 'prepare', owner: 'lead' })], SKIPS_SEND, {});
      const lineage = caller === lead ? undefined : { lead: 'grandparent' };
      const withLineage =
        lineage === undefined
          ? service
          : new BoardService({ ...ports, parents: { parentOf: async id => lineage[id as 'lead'] } });

      // Act
      await withLineage.act('F1', report('pr.review_approved'), caller);

      // Assert
      should(stored(ports).laneId).equal('waiting');
      should(lastEvent(ports)).match({ auto: true, trigger: 'pr.review_approved', reportedBy: { kind: caller.kind } });
    }
  });

  it('should record how the owner reported it when it came on the admin token', async () => {
    // Arrange
    const { ports, service } = serviceWith([card({ laneId: 'waiting' })]);

    // Act
    await service.act('F1', report('deploy.done'), { kind: 'owner', via: 'admin-token' });

    // Assert
    should(lastEvent(ports)).match({
      actor: { kind: 'daemon' },
      reportedBy: { kind: 'owner' },
      reportedVia: 'admin-token',
    });
    should(lastEvent(ports)).not.have.property('actorVia');
  });

  it('should refuse a ferret with no standing on the card', async () => {
    // Arrange
    const { ports, service } = serviceWith([card({ laneId: 'waiting', owner: 'lead' })]);

    // Act
    const error = await refusal(service.act('F1', report('deploy.done'), stranger));

    // Assert
    should(error.code).equal('forbidden');
    should(error.message).equal(
      "only the owner, its owner ferret, the owner ferret's leads, its assignee may report an event on &F1 (owner ferret lead)",
    );
    should(ports.store.writes).eql([]);
  });

  it('should move a card forward past lanes its variant walks, and never back', async () => {
    // Arrange
    const ahead = serviceWith([card({ laneId: 'prepare' })], SKIPS_SEND);
    const past = serviceWith([card({ laneId: 'confirm' })]);
    const there = serviceWith([card({ laneId: 'deployed' })]);

    // Act
    await ahead.service.act('F1', report('deploy.done'), lead);
    const back = await past.service.act('F1', report('deploy.done'), lead);
    const same = await there.service.act('F1', report('deploy.done'), lead);

    // Assert
    should(stored(ahead.ports).laneId).equal('deployed');
    should(back.task.laneId).equal('confirm');
    should(same.task.laneId).equal('deployed');
    should(past.ports.store.writes).eql([]);
    should(there.ports.store.writes).eql([]);
  });

  it('should not move a blocked card on for a ferret: a dependency holds a report as it holds a move', async () => {
    for (const caller of [lead, child]) {
      // Arrange
      const { ports, service } = serviceWith(
        [
          card({
            laneId: 'waiting',
            owner: 'lead',
            assignee: 'child',
            dependsOn: [{ task: { id: 'F2' }, until: 'shipped' }],
          }),
          card({ id: 'F2' }),
        ],
        LABELLING,
        { subFerrets: DIRECTORY },
      );

      // Act
      const error = await refusal(service.act('F1', report('deploy.done'), caller));

      // Assert
      should(error.code).equal('blocked-by');
      should(error.message).equal(
        '&F1 is blocked by &F2: a report does not move it on to deployed until they ship (only the owner may override a dependency)',
      );
      should(ports.store.writes).eql([]);
    }
  });

  it('should move a blocked card within its category, and on for the owner, saying what blocked it', async () => {
    // Arrange: Check and Waiting are both review lanes, so a move between them is sideways.
    const blocked = { owner: 'lead', dependsOn: [{ task: { id: 'F2' }, until: 'shipped' as const }] };
    const sideways = serviceWith([card({ ...blocked, laneId: 'check' }), card({ id: 'F2' })], CHECKED);
    const owned = serviceWith([card({ ...blocked, laneId: 'waiting' }), card({ id: 'F2' })]);

    // Act
    await sideways.service.act('F1', report('pr.review_approved'), lead);
    await owned.service.act('F1', report('deploy.done'), owner);

    // Assert
    should(lastEvent(sideways.ports)).match({ to: 'waiting', reason: 'pr.review_approved while blocked by &F2' });
    should(lastEvent(owned.ports)).match({ to: 'deployed', reason: 'deploy.done while blocked by &F2' });
  });

  it('should leave a gate the owner has not answered to the owner', async () => {
    // Arrange
    const { ports, service } = serviceWith([card({ laneId: 'send', owner: 'lead' })]);

    // Act
    const error = await refusal(service.act('F1', report('pr.review_approved'), lead));

    // Assert
    should(error.code).equal('owner-gate');
    should(error.message).equal(
      "&F1 waits in send for the owner; a report does not pass that gate, the owner's answer does",
    );
    should(ports.store.writes).eql([]);
  });

  it('should leave to the owner a gate the card’s variant walks between its lane and the target', async () => {
    // Arrange: Prepare → [Send for review?] → Waiting, on the reviewer's approval.
    const { ports, service } = serviceWith([card({ laneId: 'prepare', owner: 'lead' })]);

    // Act
    const error = await refusal(service.act('F1', report('pr.review_approved'), lead));

    // Assert
    should(error.code).equal('owner-gate');
    should(error.message).equal(
      "&F1 would pass send, which waits for the owner; a report does not pass that gate, the owner's answer does",
    );
    should(ports.store.writes).eql([]);
  });

  it('should leave Plan/Design to the owner for work that plans first, and not for work that skips it', async () => {
    // Arrange
    const planned = serviceWith([card({ laneId: 'todo', workflow: 'design-first' })], PLANNED);
    const quick = serviceWith([card({ laneId: 'todo', workflow: 'quick' })], PLANNED);

    // Act
    const error = await refusal(planned.service.act('F1', report('deploy.done'), lead));
    await quick.service.act('F1', report('deploy.done'), lead);

    // Assert
    should(error.message).startWith('&F1 would pass Plan/Design, which waits for the owner;');
    should(stored(quick.ports).laneId).equal('merged');
  });

  it('should let a report take a card INTO a gate: entering one is not passing it', async () => {
    // Arrange
    const { ports, service } = serviceWith([card({ laneId: 'waiting' })], CONFIRMS_DEPLOY);

    // Act
    await service.act('F1', report('deploy.done'), lead);

    // Assert
    should(stored(ports).laneId).equal('confirm');
  });

  it('should let the owner’s own report pass a gate on the way', async () => {
    // Arrange
    const { ports, service } = serviceWith([card({ laneId: 'prepare' })]);

    // Act
    await service.act('F1', report('deploy.done'), owner);

    // Assert
    should(stored(ports).laneId).equal('deployed');
    should(lastEvent(ports)).match({ from: 'prepare', to: 'deployed', reportedBy: { kind: 'owner' } });
  });

  it('should let the owner’s own report pass the gate', async () => {
    // Arrange
    const { ports, service } = serviceWith([card({ laneId: 'send' })]);

    // Act
    await service.act('F1', report('pr.review_approved'), owner);

    // Assert
    should(stored(ports).laneId).equal('waiting');
  });

  it('should never close a card in an owner-gated closed lane, whoever reports', async () => {
    for (const caller of [owner, lead]) {
      // Arrange
      const { ports, service } = serviceWith([card({ laneId: 'deployed' })], CLOSES_ON_DEPLOY);

      // Act
      const error = await refusal(service.act('F1', report('deploy.done'), caller));

      // Assert
      should(error.code).equal('owner-gate');
      should(error.message).equal("deploy.done would close &F1 in closed, which only the owner's own move enters");
      should(ports.store.writes).eql([]);
    }
  });

  it('should leave closing to the owner even where the closed lane has no gate', async () => {
    // Arrange: a set with no verify lane, whose ungated closed lane a deploy enters (a fact may close it).
    for (const caller of [lead, child]) {
      const { ports, service } = serviceWith(
        [card({ laneId: 'live', owner: 'lead', assignee: 'child' })],
        DEPLOY_CLOSES,
        {
          subFerrets: DIRECTORY,
        },
      );

      // Act
      const error = await refusal(service.act('F1', report('deploy.done'), caller));

      // Assert
      should(error.code).equal('owner-gate');
      should(error.message).equal('deploy.done would close &F1 in done, and only the owner closes a card on a report');
      should(ports.store.writes).eql([]);
    }
  });

  it('should let the owner close on a report where the closed lane has no gate', async () => {
    // Arrange
    const { ports, service } = serviceWith([card({ laneId: 'live' })], DEPLOY_CLOSES);

    // Act
    await service.act('F1', report('deploy.done'), owner);

    // Assert
    should(stored(ports).laneId).equal('done');
    should(lastEvent(ports)).match({ auto: true, trigger: 'deploy.done', reportedBy: { kind: 'owner' } });
  });

  it('should say so when the board has no lane for the event', async () => {
    // Arrange: the default Ferretry board enters no lane on a deploy.
    const { service } = serviceWith([card({ laneId: 'implement' })], LABELLING, { lanes: new FakeLanes() });

    // Act
    const error = await refusal(service.act('F1', report('deploy.done'), lead));

    // Assert
    should(error.code).equal('invalid');
    should(error.message).startWith(
      'no lane of this board enters on deploy.done for design-first work, so it does not move &F1;',
    );
  });

  it('should refuse a dropped card', async () => {
    // Arrange
    const { service } = serviceWith([
      card({ laneId: 'waiting', dropped: { reason: 'no', at: '2026-10-01T00:00:00.000Z' } }),
    ]);

    // Act
    const error = await refusal(service.act('F1', report('deploy.done'), lead));

    // Assert
    should(error.code).equal('invalid');
    should(error.message).equal('&F1 is dropped; reopen it before you report an event on it');
  });
});

describe('the gate on the way', () => {
  const target = (id: string) => LABELLING.lanes.find(entry => entry.id === id) as Lane;
  const on = (laneId: string, to: string, laneSet = LABELLING) =>
    gateOnTheWay(laneSet, { laneId, workflow: 'design-first' }, target(to))?.id;

  it('should name the card’s own gate first, then the first gate its variant walks before the target', () => {
    should(on('send', 'deployed')).equal('send');
    should(on('prepare', 'deployed')).equal('send');
    should(on('todo', 'closed')).equal('send');
  });

  it('should pass none when the target is the next gate, an earlier lane, or the gate is skipped', () => {
    should(on('prepare', 'send')).be.undefined();
    should(on('waiting', 'confirm')).be.undefined();
    should(on('deployed', 'prepare')).be.undefined();
    should(on('prepare', 'deployed', SKIPS_SEND)).be.undefined();
  });

  it('should read every lane as walked when the variant names a lane the set lacks', () => {
    // Arrange
    const broken = { ...SKIPS_SEND, variants: { 'design-first': ['todo', 'gone'] } } as LaneSet;

    // Act + Assert
    should(on('prepare', 'deployed', broken)).equal('send');
  });

  it('should refuse a card in a lane the set lacks', () => {
    should(() => on('gone', 'deployed')).throw(BoardError);
  });
});

describe('a sub-ferret reporting a trigger', () => {
  it('should report on the card it is doing, as it links its PR', async () => {
    // Arrange
    const { ports, service } = serviceWith([card({ laneId: 'waiting', owner: 'lead', assignee: 'child' })], LABELLING, {
      subFerrets: DIRECTORY,
    });

    // Act
    await service.act('F1', report('deploy.done'), child);

    // Assert
    should(stored(ports).laneId).equal('deployed');
    should(lastEvent(ports)).match({ reportedBy: { kind: 'ferret', sessionId: 'child' } });
  });

  it('should be refused on a card it owns but is not doing, and told whom to tell', async () => {
    // Arrange: child owns F1, which another ferret is doing.
    const { ports, service } = serviceWith(
      [card({ laneId: 'waiting', owner: 'child', assignee: 'stranger' })],
      LABELLING,
      {
        subFerrets: DIRECTORY,
      },
    );

    // Act
    const error = await refusal(service.act('F1', report('deploy.done'), child));

    // Assert
    should(error.code).equal('forbidden');
    should(error.message).equal(
      'Sub-ferrets don\'t report events on a card they are not doing; tell your lead: fy send lizzette "…"',
    );
    should(ports.store.writes).eql([]);
  });

  it('should leave a lead free to report on any card its standing reaches', async () => {
    // Arrange
    const { ports, service } = serviceWith([card({ laneId: 'waiting', owner: 'lead', assignee: 'child' })], LABELLING, {
      subFerrets: DIRECTORY,
    });

    // Act
    await service.act('F1', report('deploy.done'), lead);

    // Assert
    should(stored(ports).laneId).equal('deployed');
  });

  it('should be refused on a card it has no standing on', async () => {
    // Arrange
    const { service } = serviceWith([card({ laneId: 'waiting', owner: 'lead', assignee: 'child' })], LABELLING, {
      subFerrets: DIRECTORY,
    });

    // Act
    const error = await refusal(service.act('F1', report('deploy.done'), grandchild));

    // Assert
    should(error.code).equal('forbidden');
  });
});

describe('a move and a report agree on the owner’s gates', () => {
  /** A hand-made set whose verify lane is not owner-gated, with a lane after it a ferret could reach. */
  const UNGATED_VERIFY: LaneSet = LaneSetSchema.parse({
    projectId: PROJECT,
    version: 1,
    confirmedBy: 'owner',
    proposedBy: 'lead',
    lanes: [
      lane('todo', 'backlog'),
      lane('doing', 'active', { enterOn: ['work.started'] }),
      lane('check', 'verify', { enterOn: ['pr.merged'] }),
      lane('live', 'shipped', { enterOn: ['deploy.done'] }),
      lane('closed', 'closed', { ownerGate: true }),
    ],
    variants: {},
  });

  it('should keep a ferret’s move and its report out of a verify lane alike, and let the owner move it', async () => {
    // Arrange
    const moving = serviceWith([card({ laneId: 'check', owner: 'lead' })], UNGATED_VERIFY);
    const reporting = serviceWith([card({ laneId: 'check', owner: 'lead' })], UNGATED_VERIFY);
    const owning = serviceWith([card({ laneId: 'check', owner: 'lead' })], UNGATED_VERIFY);

    // Act
    const moved = await refusal(moving.service.act('F1', action({ action: 'move', to: 'live' }), lead));
    const reported = await refusal(reporting.service.act('F1', report('deploy.done'), lead));
    await owning.service.act('F1', action({ action: 'move', to: 'live' }), owner);

    // Assert
    should([moved.code, reported.code]).eql(['owner-gate', 'owner-gate']);
    should(stored(owning.ports).laneId).equal('live');
  });
});
