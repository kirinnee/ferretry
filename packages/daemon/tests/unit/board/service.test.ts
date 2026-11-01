import { describe, it } from 'bun:test';
import {
  type AgendaItem,
  BoardQuerySchema,
  type BoardTask,
  type BoardTaskActionRequestInput,
  BoardTaskActionRequestSchema,
  type BoardTaskCreateRequestInput,
  BoardTaskCreateRequestSchema,
  type PrLink,
  UNFILED_PROJECT_ID,
} from '@ferretry/protocol';
import should from 'should';
import {
  actorOf,
  AgendaCardLinks,
  type BoardCaller,
  BoardIndex,
  BoardError,
  BoardService,
  BoardUnavailableError,
  DEPENDENCY_SECTION,
  LivenessActivityDeriver,
  neighbourhoodOf,
  OWNER_MOVE_SOURCE,
  reopenMessage,
} from '../../../src/lib/board/index.ts';
import { unfiledLaneSet } from '../../../src/lib/board-projects/index.ts';
import {
  card,
  FakeChanges,
  FakeDone,
  FakeFocus,
  FakeLanes,
  FakeReopen,
  FakeSessions,
  lanes,
  MACHINE,
  MemoryBoardStore,
  NOW,
  OTHER_PROJECT,
  PROJECT,
  type ServiceWorld,
  templateLanes,
  world,
} from './support.ts';

const owner: BoardCaller = { kind: 'owner' };
const daemon: BoardCaller = { kind: 'daemon' };
const ferret = (sessionId: string): BoardCaller => ({ kind: 'ferret', sessionId });
const lead = ferret('lead');
const child = ferret('child');
const stranger = ferret('stranger');

const create = (input: Partial<BoardTaskCreateRequestInput> = {}) =>
  BoardTaskCreateRequestSchema.parse({
    kind: 'feature',
    title: 'Board store',
    ask: { text: 'build it', source: 'owner' },
    ...input,
  });
const action = (input: BoardTaskActionRequestInput) => BoardTaskActionRequestSchema.parse(input);

/** A service over a store already holding `cards`. */
const serviceWith = (cards: readonly BoardTask[], overrides: Partial<ServiceWorld> = {}) => {
  const ports = world({ store: new MemoryBoardStore(cards), ...overrides });
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

describe('creating a card', () => {
  it("should give a ferret's card a counter id, its project, the first backlog lane and its focus", async () => {
    // Arrange
    const { ports, service } = serviceWith([]);

    // Act
    const response = await service.create(create(), lead);

    // Assert
    should(response.task).match({
      id: 'F1',
      owner: 'lead',
      assignee: null,
      projectId: PROJECT,
      laneId: 'todo',
      machineId: 'machine-1',
    });
    should(response.task.createdBy).eql({ kind: 'ferret', sessionId: 'lead' });
    should(response.task.history).eql([
      { seq: 1, at: NOW, actor: { kind: 'ferret', sessionId: 'lead' }, type: 'created', laneId: 'todo' },
    ]);
    should(response.laneSet?.projectId).equal(PROJECT);
    should(ports.focus.focused.get('lead')).eql({ id: 'F1' });
    should(ports.changes.events).eql([{ sessionId: 'lead', event: { projectId: PROJECT, taskIds: ['F1'] } }]);
  });

  it('should number cards per kind across the machine', async () => {
    // Arrange
    const { service } = serviceWith([card({ id: 'F7' })]);

    // Act
    const feature = await service.create(create(), lead);
    const bug = await service.create(create({ kind: 'bug' }), child);

    // Assert
    should(feature.task.id).equal('F8');
    should(bug.task.id).equal('B1');
  });

  it("should make the owner's card owned by the ferret it names, and focus nobody", async () => {
    // Arrange
    const { ports, service } = serviceWith([]);

    // Act
    const response = await service.create(create({ assignee: 'worker', projectId: PROJECT }), owner);

    // Assert
    should(response.task).match({ owner: 'worker', assignee: 'worker', createdBy: { kind: 'owner' } });
    should(ports.focus.focused.size).equal(0);
    should(ports.changes.events[0]?.sessionId).equal('worker');
  });

  it('should refuse an owner card with no ferret to own it', async () => {
    // Act
    const error = await refusal(serviceWith([]).service.create(create(), owner));

    // Assert
    should(error.code).equal('invalid');
  });

  it('should refuse a board with no lanes, naming the proposal command', async () => {
    // Act: the owner has no session, so the card goes to Unfiled, which has no lanes here.
    const error = await refusal(serviceWith([]).service.create(create({ assignee: 'worker' }), owner));

    // Assert
    should(error.code).equal('no-lane-set');
    should(error.message).containEql('fy board lanes propose');
  });

  it('should honour a named lane, but let only the owner start a card closed', async () => {
    // Arrange
    const { service } = serviceWith([]);

    // Act
    const implement = await service.create(create({ laneId: 'implement' }), lead);
    const gated = await refusal(service.create(create({ laneId: 'closed' }), lead));
    const closed = await service.create(create({ laneId: 'closed', assignee: 'lead', projectId: PROJECT }), owner);

    // Assert
    should(implement.task.laneId).equal('implement');
    should(gated.code).equal('owner-gate');
    should(gated.allowed).eql(['owner-human']);
    should(closed.task.laneId).equal('closed');
  });

  it('should refuse an unknown lane', async () => {
    // Act
    const error = await refusal(serviceWith([]).service.create(create({ laneId: 'nowhere' }), lead));

    // Assert
    should(error.code).equal('unknown-lane');
    should(error.message).containEql('todo, plan, implement');
  });

  it('should let the assignee of a card add a child under it, and nobody unrelated', async () => {
    // Arrange
    const parent = card({ owner: 'lead', assignee: 'child' });
    const { service } = serviceWith([parent]);

    // Act
    const sub = await service.create(create({ parent: { id: 'F1' } }), child);
    const refused = await refusal(service.create(create({ parent: { id: 'F1' } }), stranger));

    // Assert
    should(sub.task.parent).eql({ id: 'F1' });
    should(refused.code).equal('forbidden');
  });

  it.each([
    { name: 'a parent on another machine', input: { parent: { id: 'F1', machineId: 'mac' } }, code: 'invalid' },
    { name: 'a missing parent', input: { parent: { id: 'F9' } }, code: 'not-found' },
    { name: 'a missing dependency', input: { dependsOn: [{ task: { id: 'F9' } }] }, code: 'not-found' },
  ])('should refuse $name', async ({ input, code }) => {
    // Act
    const error = await refusal(
      serviceWith([card()]).service.create(create(input as Partial<BoardTaskCreateRequestInput>), lead),
    );

    // Assert
    should(error.code).equal(code);
  });

  it('should record a dependency named at create', async () => {
    // Act
    const response = await serviceWith([card()]).service.create(
      create({ dependsOn: [{ task: { id: 'F1' }, until: 'released' }] }),
      lead,
    );

    // Assert
    should(response.task.dependsOn).eql([{ task: { id: 'F1' }, until: 'released' }]);
    should(response.task.blockedBy).eql([{ id: 'F1' }]);
  });

  it('should refuse to write before the machine identity is open', async () => {
    // Act
    const error = await serviceWith([], { machineId: () => undefined })
      .service.create(create(), lead)
      .catch((thrown: unknown) => thrown);

    // Assert
    should(error).be.instanceOf(BoardUnavailableError);
  });

  it('should refuse an id the counter issued twice instead of overwriting the card', async () => {
    // Arrange
    const store = new MemoryBoardStore([card({ id: 'F1' })]);
    store.allocateId = async () => 'F1';

    // Act
    const error = await serviceWith([], { store })
      .service.create(create(), lead)
      .catch((thrown: unknown) => thrown);

    // Assert
    should(error).be.instanceOf(BoardUnavailableError);
    should((error as BoardUnavailableError).detail).containEql('F1');
  });
});

describe('moving a card', () => {
  it('should move it forward with no reason needed', async () => {
    // Arrange
    const { ports, service } = serviceWith([card()]);

    // Act
    const response = await service.act('F1', action({ action: 'move', to: 'plan' }), lead);

    // Assert
    should(response.task.laneId).equal('plan');
    should(lastEvent(ports)).match({ type: 'moved', from: 'todo', to: 'plan', backward: false, reason: null });
  });

  it.each([
    { name: 'the lane it is in', to: 'todo', code: 'invalid' },
    { name: 'a lane the board lacks', to: 'nowhere', code: 'unknown-lane' },
  ])('should refuse a move to $name', async ({ to, code }) => {
    // Act
    const error = await refusal(serviceWith([card()]).service.act('F1', action({ action: 'move', to }), lead));

    // Assert
    should(error.code).equal(code);
  });

  it('should refuse a card whose lane its board lost', async () => {
    // Act
    const error = await refusal(
      serviceWith([card({ laneId: 'gone' })]).service.act('F1', action({ action: 'move', to: 'plan' }), lead),
    );

    // Assert
    should(error.code).equal('unknown-lane');
  });

  it('should need a reason to move back, and record it on a plain ferret move', async () => {
    // Arrange
    const { ports, service } = serviceWith([card({ laneId: 'review' })]);

    // Act
    const refused = await refusal(service.act('F1', action({ action: 'move', to: 'implement' }), lead));
    await service.act('F1', action({ action: 'move', to: 'implement', reason: 'CI found a bug' }), lead);

    // Assert
    should(refused.code).equal('reason-required');
    should(lastEvent(ports)).match({ type: 'moved', backward: true, reason: 'CI found a bug' });
    should(ports.reopen.notices).eql([]);
    should(stored(ports).clarifications).eql([]);
  });

  it('should keep an owner-gated lane for the owner to pass', async () => {
    // Arrange
    const { ports, service } = serviceWith([card({ laneId: 'plan' })]);

    // Act
    const refused = await refusal(service.act('F1', action({ action: 'move', to: 'implement' }), lead));
    await service.act('F1', action({ action: 'move', to: 'implement' }), owner);

    // Assert
    should(refused.code).equal('owner-gate');
    should(refused.message).containEql('fy agenda add --task F1');
    should(stored(ports).laneId).equal('implement');
    should(lastEvent(ports)?.actor).eql({ kind: 'owner' });
  });

  it('should record a move made on the admin token as the admin token, never as the owner', async () => {
    // Arrange — the host's admin token with no ferret's own credential: the owner at the machine, or a ferret
    // that ran fy without its session. It keeps the owner's authority (it may pass the owner gate) …
    const { ports, service } = serviceWith([card({ laneId: 'plan' })]);

    // Act
    await service.act('F1', action({ action: 'move', to: 'implement' }), { kind: 'owner', via: 'admin-token' });

    // Assert — … and is recorded as what the daemon actually knows, beside an actor every reader can parse.
    should(stored(ports).laneId).equal('implement');
    should(lastEvent(ports)).match({ actor: { kind: 'owner' }, actorVia: 'admin-token' });
  });

  it('should let only the owner close a card on a board that has a verify lane', async () => {
    // Arrange
    const { ports, service } = serviceWith([card({ laneId: 'tested' })]);

    // Act
    const refused = await refusal(service.act('F1', action({ action: 'move', to: 'closed' }), lead));
    await service.act('F1', action({ action: 'move', to: 'closed' }), owner);

    // Assert
    should(refused.code).equal('owner-gate');
    should(refused.message).containEql('only the owner closes a card');
    should(stored(ports).laneId).equal('closed');
  });

  it('should let a ferret close a card on a board with no verify lane', async () => {
    // Arrange
    const { ports, service } = serviceWith([card({ projectId: OTHER_PROJECT, laneId: 'review' })]);

    // Act
    await service.act('F1', action({ action: 'move', to: 'merged' }), lead);

    // Assert
    should(stored(ports).laneId).equal('merged');
  });

  it('should hold a blocked card back from a later category but let it move sideways and back', async () => {
    // Arrange
    const blocker = card({ id: 'F2', laneId: 'implement' });
    const blocked = card({ laneId: 'merged', dependsOn: [{ task: { id: 'F2' }, until: 'shipped' }] });
    const { ports, service } = serviceWith([blocked, blocker]);

    // Act
    const forward = await refusal(service.act('F1', action({ action: 'move', to: 'tested' }), lead));
    await service.act('F1', action({ action: 'move', to: 'released' }), lead);
    await service.act('F1', action({ action: 'move', to: 'review', reason: 'rework' }), lead);

    // Assert
    should(forward.code).equal('blocked-by');
    should(forward.message).containEql('&F2');
    should(stored(ports).laneId).equal('review');
  });

  it("should send a card back on the owner's move as one atomic reopen, delivered to its ferret", async () => {
    // Arrange
    const { ports, service } = serviceWith([card({ laneId: 'tested', assignee: 'child' })]);

    // Act
    const response = await service.act(
      'F1',
      action({ action: 'move', to: 'implement', reason: 'the theme button still flickers' }),
      owner,
    );

    // Assert
    should(response.task.laneId).equal('implement');
    should(lastEvent(ports)).match({
      type: 'reopened',
      from: 'tested',
      to: 'implement',
      reason: 'the theme button still flickers',
      ask: { text: 'the theme button still flickers', source: OWNER_MOVE_SOURCE },
    });
    should(stored(ports).history.filter(event => event.type === 'moved')).eql([]);
    should(stored(ports).clarifications).eql([
      { text: 'the theme button still flickers', source: OWNER_MOVE_SOURCE, at: NOW, by: { kind: 'owner' } },
    ]);
    should(ports.reopen.notices).match([
      { from: 'tested', to: 'implement', by: { kind: 'owner' }, task: { id: 'F1' } },
    ]);
    should(ports.changes.events[0]?.sessionId).equal('lead');
  });

  it("should tell the card's ferret ONCE when the owner moves it into the closed lane, and not on a reopen", async () => {
    // Arrange
    const { ports, service } = serviceWith([card({ laneId: 'tested', assignee: 'child', title: 'Ship it' })]);

    // Act
    await service.act('F1', action({ action: 'move', to: 'closed' }), owner);

    // Assert
    should(ports.done.notices).match([{ task: { id: 'F1', laneId: 'closed' } }]);
    should(ports.reopen.notices).eql([]);
  });

  it('should tell nobody when a ferret closes the card, or the owner moves it within the open lanes', async () => {
    // Arrange
    const { ports, service } = serviceWith([
      card({ id: 'F1', laneId: 'tested', assignee: 'child' }),
      card({ id: 'F2', laneId: 'review', assignee: 'child' }),
    ]);

    // Act
    await service.act('F1', action({ action: 'move', to: 'closed' }), lead).catch(() => undefined);
    await service.act('F2', action({ action: 'move', to: 'merged' }), owner);

    // Assert
    should(ports.done.notices).eql([]);
  });

  it('should refuse to move a dropped card', async () => {
    // Act
    const error = await refusal(
      serviceWith([card({ dropped: { reason: 'superseded', at: NOW } })]).service.act(
        'F1',
        action({ action: 'move', to: 'plan' }),
        lead,
      ),
    );

    // Assert
    should(error.code).equal('invalid');
    should(error.message).containEql('reopen it');
  });

  it('should refuse a ferret that is not on the card, saying who may', async () => {
    // Act
    const error = await refusal(
      serviceWith([card()]).service.act('F1', action({ action: 'move', to: 'plan' }), stranger),
    );

    // Assert
    should(error.code).equal('forbidden');
    should(error.allowed).eql(['owner-human', 'owner', 'ancestor', 'assignee']);
  });

  it("should let a lead move its sub-ferret's card through lineage", async () => {
    // Arrange: grandchild's card is owned by child, whose parent is lead.
    const { ports, service } = serviceWith([card({ owner: 'child', assignee: 'grandchild' })]);

    // Act
    await service.act('F1', action({ action: 'move', to: 'plan' }), lead);

    // Assert
    should(stored(ports).laneId).equal('plan');
  });

  it('should refuse a card on a board that lost its lanes', async () => {
    // Act
    const error = await refusal(
      serviceWith([card({ projectId: 'unfiled' })]).service.act('F1', action({ action: 'note', text: 'hi' }), lead),
    );

    // Assert
    should(error.code).equal('no-lane-set');
  });

  it('should refuse a card that does not exist', async () => {
    // Act
    const error = await refusal(serviceWith([]).service.act('F1', action({ action: 'note', text: 'hi' }), lead));

    // Assert
    should(error.code).equal('not-found');
  });
});

describe('reopening a card', () => {
  it('should send it back with the words, delivered to the assignee when someone else reopens it', async () => {
    // Arrange
    const { ports, service } = serviceWith([card({ laneId: 'merged', assignee: 'child' })]);

    // Act
    await service.act(
      'F1',
      action({
        action: 'reopen',
        to: 'implement',
        reason: 'regressed',
        ask: { text: 'it broke again', source: 'owner in chat' },
      }),
      lead,
    );

    // Assert
    should(stored(ports).laneId).equal('implement');
    should(stored(ports).clarifications[0]).match({
      text: 'it broke again',
      source: 'owner in chat',
      by: { kind: 'ferret', sessionId: 'lead' },
    });
    should(ports.reopen.notices.length).equal(1);
  });

  it('should not tell the assignee about its own reopen', async () => {
    // Arrange
    const { ports, service } = serviceWith([card({ laneId: 'merged', assignee: 'child' })]);

    // Act
    await service.act(
      'F1',
      action({ action: 'reopen', to: 'implement', reason: 'regressed', ask: { text: 'owner said', source: 'chat' } }),
      child,
    );

    // Assert
    should(ports.reopen.notices).eql([]);
  });

  it.each([
    { name: 'forward', to: 'review', message: 'move it on instead' },
    { name: 'into the closed lane', to: 'closed', message: 'a reopen opens a card' },
  ])('should refuse a reopen $name', async ({ to, message }) => {
    // Act
    const error = await refusal(
      serviceWith([card({ laneId: 'implement' })]).service.act(
        'F1',
        action({ action: 'reopen', to, reason: 'r', ask: { text: 't', source: 's' } }),
        lead,
      ),
    );

    // Assert
    should(error.code).equal('invalid');
    should(error.message).containEql(message);
  });

  it('should reopen a dropped card into any open lane', async () => {
    // Arrange
    const { ports, service } = serviceWith([card({ laneId: 'implement', dropped: { reason: 'superseded', at: NOW } })]);

    // Act
    await service.act(
      'F1',
      action({
        action: 'reopen',
        to: 'implement',
        reason: 'needed after all',
        ask: { text: 'do it', source: 'owner' },
      }),
      lead,
    );

    // Assert
    should(stored(ports).dropped).be.null();
    should(stored(ports).laneId).equal('implement');
  });
});

describe('dependencies', () => {
  it('should add one inside the board-wide dependency section', async () => {
    // Arrange
    const { ports, service } = serviceWith([card(), card({ id: 'F2' })]);

    // Act
    const response = await service.act('F1', action({ action: 'depend', task: { id: 'F2' } }), lead);

    // Assert
    should(response.task.dependsOn).eql([{ task: { id: 'F2' }, until: 'shipped' }]);
    should(response.task.blockedBy).eql([{ id: 'F2' }]);
    should(lastEvent(ports)).match({ type: 'depended', task: { id: 'F2' }, until: 'shipped' });
    should(ports.sections).eql([DEPENDENCY_SECTION]);
  });

  it("should let any ferret depend its own card on anybody's", async () => {
    // Arrange
    const { ports, service } = serviceWith([card({ owner: 'stranger' }), card({ id: 'F2', owner: 'lead' })]);

    // Act
    await service.act('F1', action({ action: 'depend', task: { id: 'F2' } }), stranger);

    // Assert
    should(stored(ports).dependsOn.length).equal(1);
  });

  it('should refuse a dependency that closes a cycle, naming it', async () => {
    // Arrange
    const { service } = serviceWith([
      card(),
      card({ id: 'F2', dependsOn: [{ task: { id: 'F1' }, until: 'shipped' }] }),
    ]);

    // Act
    const error = await refusal(service.act('F1', action({ action: 'depend', task: { id: 'F2' } }), lead));

    // Assert
    should(error.code).equal('cycle');
    should(error.message).containEql('&F1 → &F2 → &F1');
  });

  it.each([
    { name: 'itself', task: { id: 'F1' }, code: 'invalid' },
    { name: 'a card on another machine', task: { id: 'F2', machineId: 'mac' }, code: 'invalid' },
    { name: 'a missing card', task: { id: 'F9' }, code: 'not-found' },
    { name: 'a card it already depends on', task: { id: 'F2' }, code: 'invalid' },
  ])('should refuse a dependency on $name', async ({ task, code }) => {
    // Arrange
    const { service } = serviceWith([
      card({ dependsOn: [{ task: { id: 'F2' }, until: 'shipped' }] }),
      card({ id: 'F2' }),
    ]);

    // Act
    const error = await refusal(service.act('F1', action({ action: 'depend', task }), lead));

    // Assert
    should(error.code).equal(code);
  });

  it('should let only the owner override, recorded, and then let the card advance', async () => {
    // Arrange
    const { ports, service } = serviceWith([
      card({ dependsOn: [{ task: { id: 'F2' }, until: 'shipped' }] }),
      card({ id: 'F2' }),
    ]);
    const override = action({ action: 'depend', task: { id: 'F2' }, override: { reason: 'ship without it' } });

    // Act
    const refused = await refusal(service.act('F1', override, lead));
    await service.act('F1', override, owner);
    await service.act('F1', action({ action: 'move', to: 'plan' }), lead);

    // Assert
    should(refused.code).equal('forbidden');
    should(refused.allowed).eql(['owner-human']);
    should(stored(ports).dependsOn).eql([
      { task: { id: 'F2' }, until: 'shipped', override: { by: 'owner', reason: 'ship without it', at: NOW } },
    ]);
    should(stored(ports).history.find(event => event.type === 'depended')).match({ override: { by: 'owner' } });
    should(stored(ports).laneId).equal('plan');
  });

  it('should keep an override when the wait changes', async () => {
    // Arrange
    const overridden = { by: 'owner' as const, reason: 'ok', at: NOW };
    const { ports, service } = serviceWith([
      card({ dependsOn: [{ task: { id: 'F2' }, until: 'shipped', override: overridden }] }),
      card({ id: 'F2' }),
    ]);

    // Act
    await service.act('F1', action({ action: 'depend', task: { id: 'F2' }, until: 'released' }), lead);

    // Assert
    should(stored(ports).dependsOn).eql([{ task: { id: 'F2' }, until: 'released', override: overridden }]);
  });

  it('should remove one with a reason, and refuse one it does not have', async () => {
    // Arrange
    const { ports, service } = serviceWith([
      card({ dependsOn: [{ task: { id: 'F2' }, until: 'shipped' }] }),
      card({ id: 'F2' }),
    ]);

    // Act
    await service.act('F1', action({ action: 'undepend', task: { id: 'F2' }, reason: 'not needed' }), lead);
    const again = await refusal(
      service.act('F1', action({ action: 'undepend', task: { id: 'F2' }, reason: 'x' }), lead),
    );

    // Assert
    should(stored(ports).dependsOn).eql([]);
    should(lastEvent(ports)).match({ type: 'undepended', reason: 'not needed' });
    should(again.code).equal('invalid');
  });
});

describe('reading a card by the old task it came from', () => {
  it('should serve the card whose legacyRef matches, and say when none does', async () => {
    // Arrange
    const store = new MemoryBoardStore([card({ legacyRef: 'abc:F12' }), card({ id: 'F2', legacyRef: 'abc:F13' })]);
    const { service } = serviceWith([], { store });

    // Act
    const found = await service.taskByLegacyRef('abc:F13');
    const missing = await refusal(service.taskByLegacyRef('abc:F14'));

    // Assert
    should(found.task.id).equal('F2');
    should(missing.code).equal('not-found');
    should(missing.message).containEql('abc:F14');
  });
});

describe('everything else on a card', () => {
  it('should focus the calling ferret without writing the card', async () => {
    // Arrange
    const { ports, service } = serviceWith([card()]);

    // Act
    await service.act('F1', action({ action: 'focus' }), lead);

    // Assert
    should(ports.focus.focused.get('lead')).eql({ id: 'F1' });
    should(ports.store.writes).eql([]);
    should(ports.changes.events).eql([]);
  });

  it('should refuse focus for the owner and for a session that is gone', async () => {
    // Arrange
    const { service } = serviceWith([card({ assignee: 'ghost' })]);

    // Act
    const human = await refusal(service.act('F1', action({ action: 'focus' }), owner));
    const ghost = await refusal(service.act('F1', action({ action: 'focus' }), ferret('ghost')));

    // Assert
    should(human.code).equal('invalid');
    should(ghost.code).equal('not-found');
  });

  it("should record a ferret's skip on its own session, stamped now, without touching a card", async () => {
    // Arrange
    const { ports, service } = serviceWith([card()]);

    // Act
    const recorded = await service.skip({ reason: 'chit-chat, nothing to track' }, lead);

    // Assert
    should(recorded).eql({ sessionId: 'lead', skip: { reason: 'chit-chat, nothing to track', at: NOW } });
    should(ports.focus.skips.get('lead')).eql({ reason: 'chit-chat, nothing to track', at: NOW });
    should(ports.store.writes).eql([]);
    should(ports.changes.events).eql([]);
  });

  it('should clear a standing skip when the ferret takes a card', async () => {
    // Arrange
    const { ports, service } = serviceWith([card()]);
    await service.skip({ reason: 'chit-chat' }, lead);

    // Act
    await service.act('F1', action({ action: 'focus' }), lead);

    // Assert
    should(await ports.focus.skipOf('lead')).be.null();
  });

  it('should refuse a skip from the owner or the daemon, and for a session that is gone', async () => {
    // Arrange
    const { service } = serviceWith([card()]);

    // Act
    const human = await refusal(service.skip({ reason: 'x' }, owner));
    const machine = await refusal(service.skip({ reason: 'x' }, daemon));
    const ghost = await refusal(service.skip({ reason: 'x' }, ferret('ghost')));

    // Assert
    should(human.code).equal('invalid');
    should(machine.code).equal('invalid');
    should(ghost.code).equal('not-found');
  });

  it('should block and unblock on the outside world only', async () => {
    // Arrange
    const { ports, service } = serviceWith([card()]);

    // Act
    await service.act('F1', action({ action: 'block', reason: 'waiting on GitHub' }), lead);
    const blocked = stored(ports).blocked;
    const view = await service.task('F1');
    await service.act('F1', action({ action: 'unblock' }), lead);
    const again = await refusal(service.act('F1', action({ action: 'unblock', reason: 'x' }), lead));

    // Assert
    should(blocked).eql({ on: 'external', reason: 'waiting on GitHub', since: NOW });
    should(view.task.activity).equal('waiting');
    should(stored(ports).blocked).be.null();
    should(lastEvent(ports)).match({ type: 'unblocked', reason: null });
    should(again.code).equal('invalid');
  });

  it('should refuse to block a dropped card', async () => {
    // Act
    const error = await refusal(
      serviceWith([card({ dropped: { reason: 'no', at: NOW } })]).service.act(
        'F1',
        action({ action: 'block', reason: 'x' }),
        lead,
      ),
    );

    // Assert
    should(error.code).equal('invalid');
  });

  it('should let the owner side drop, not the assignee, and only once', async () => {
    // Arrange
    const { ports, service } = serviceWith([card({ assignee: 'child' })]);

    // Act
    const assignee = await refusal(service.act('F1', action({ action: 'drop', reason: 'superseded' }), child));
    await service.act('F1', action({ action: 'drop', reason: 'superseded' }), lead);
    const twice = await refusal(service.act('F1', action({ action: 'drop', reason: 'again' }), lead));

    // Assert
    should(assignee.code).equal('forbidden');
    should(stored(ports).dropped).eql({ reason: 'superseded', at: NOW });
    should(twice.code).equal('invalid');
  });

  it('should append a clarification verbatim', async () => {
    // Arrange
    const { ports, service } = serviceWith([card()]);

    // Act
    await service.act('F1', action({ action: 'clarify', text: 'also the phone', source: 'owner, chat' }), lead);

    // Assert
    should(stored(ports).clarifications).eql([
      { text: 'also the phone', source: 'owner, chat', at: NOW, by: { kind: 'ferret', sessionId: 'lead' } },
    ]);
    should(lastEvent(ports)).match({ type: 'clarified', text: 'also the phone' });
  });

  it('should link each kind once', async () => {
    // Arrange
    const { ports, service } = serviceWith([card()]);
    const url = 'https://github.com/kirinnee/ferretry/pull/930';
    const links: BoardTaskActionRequestInput[] = [
      { action: 'link', pr: url },
      { action: 'link', branch: 'feat/board-store' },
      { action: 'link', commit: 'abc123' },
      { action: 'link', doc: 'docs/board.md' },
    ];

    // Act
    for (const link of links) await service.act('F1', action(link), lead);
    const refusals = await Promise.all(
      links.map(async link => (await refusal(service.act('F1', action(link), lead))).code),
    );

    // Assert
    should(stored(ports).links).eql({
      prs: [
        {
          url,
          number: 930,
          repo: 'kirinnee/ferretry',
          state: 'unknown',
          draft: false,
          checks: 'none',
          mergedAt: null,
          mergeSha: null,
          releasedIn: null,
          polledAt: null,
        },
      ],
      branch: 'feat/board-store',
      commits: ['abc123'],
      docs: ['docs/board.md'],
    });
    should(refusals).eql(['invalid', 'invalid', 'invalid', 'invalid']);
  });

  it('should let the owner side reassign, once per change', async () => {
    // Arrange
    const { ports, service } = serviceWith([card({ assignee: 'child' })]);

    // Act
    const assignee = await refusal(service.act('F1', action({ action: 'assign', assignee: 'worker' }), child));
    await service.act('F1', action({ action: 'assign', assignee: 'worker' }), lead);
    const same = await refusal(service.act('F1', action({ action: 'assign', assignee: 'worker' }), lead));

    // Assert
    should(assignee.code).equal('forbidden');
    should(lastEvent(ports)).match({ type: 'assigned', from: 'child', to: 'worker' });
    should(same.code).equal('invalid');
  });

  it('should note', async () => {
    // Arrange
    const { ports, service } = serviceWith([card()]);

    // Act
    await service.act('F1', action({ action: 'note', text: 'surveying origin/main' }), lead);

    // Assert
    should(lastEvent(ports)).match({ type: 'note', text: 'surveying origin/main' });
  });

  it('should let the assignee fill the card, but keep the title and brief for the owner side', async () => {
    // Arrange
    const { ports, service } = serviceWith([card({ assignee: 'child' })]);

    // Act
    await service.act(
      'F1',
      action({ action: 'edit', summary: 'one file per card', premise: 'the store collides' }),
      child,
    );
    const retitle = await refusal(service.act('F1', action({ action: 'edit', title: 'Board v2' }), child));
    await service.act(
      'F1',
      action({ action: 'edit', title: 'Board v2', terms: [{ term: 'Lane', meaning: 'a column' }] }),
      lead,
    );
    const nothing = await refusal(service.act('F1', action({ action: 'edit', title: 'Board v2' }), lead));

    // Assert
    should(stored(ports)).match({ summary: 'one file per card', premise: 'the store collides', title: 'Board v2' });
    should(
      stored(ports)
        .history.filter(event => event.type === 'field-edited')
        .map(event => event.field),
    ).eql(['summary', 'premise', 'title', 'terms']);
    should(retitle.code).equal('forbidden');
    should(nothing.code).equal('invalid');
  });

  it('should keep How to test from the create, and record a rewrite as its own edit', async () => {
    // Arrange
    const { ports, service } = serviceWith([]);

    // Act
    const created = await service.create(create({ howToTest: '1. Open the Board' }), lead);
    await service.act(
      created.task.id,
      action({ action: 'edit', howToTest: '1. Open the Board\n2. Tap the card' }),
      lead,
    );

    // Assert
    should(stored(ports)).match({ howToTest: '1. Open the Board\n2. Tap the card' });
    should(lastEvent(ports)).match({ type: 'field-edited', field: 'howToTest' });
  });

  it('should let the assignee write How to test without owner standing', async () => {
    // Arrange
    const { ports, service } = serviceWith([card({ assignee: 'child' })]);

    // Act
    await service.act('F1', action({ action: 'edit', howToTest: '1. Run fy task show F1' }), child);

    // Assert
    should(stored(ports).howToTest).equal('1. Run fy task show F1');
  });

  it('should claim and release files', async () => {
    // Arrange
    const { ports, service } = serviceWith([card()]);

    // Act
    await service.act('F1', action({ action: 'file', path: 'src/lib/board/service.ts' }), lead);
    const twice = await refusal(service.act('F1', action({ action: 'file', path: 'src/lib/board/service.ts' }), lead));
    await service.act('F1', action({ action: 'file', path: 'src/lib/board/service.ts', release: true }), lead);
    const absent = await refusal(
      service.act('F1', action({ action: 'file', path: 'src/lib/board/service.ts', release: true }), lead),
    );

    // Assert
    should(stored(ports).files).eql([]);
    should(lastEvent(ports)).match({ type: 'file-released', reason: null });
    should(twice.code).equal('invalid');
    should(absent.code).equal('invalid');
  });

  it('should reorder for the owner side', async () => {
    // Arrange
    const { ports, service } = serviceWith([card()]);

    // Act
    await service.act('F1', action({ action: 'order', order: 3 }), lead);
    const same = await refusal(service.act('F1', action({ action: 'order', order: 3 }), lead));

    // Assert
    should(lastEvent(ports)).match({ type: 'ordered', from: null, to: 3 });
    should(same.code).equal('invalid');
  });

  describe('snoozing a card to test', () => {
    const LATER = '2026-10-30T14:00:00.000Z';
    const toTest = () => card({ laneId: 'tested' });

    it('should let the owner snooze a card and remember the lane it was snoozed in', async () => {
      // Arrange
      const { ports, service } = serviceWith([toTest()]);

      // Act
      const response = await service.act('F1', action({ action: 'snooze', until: LATER }), owner);

      // Assert
      should(response.task.snoozed).eql({ until: LATER, laneId: 'tested' });
      should(stored(ports).snoozed).eql({ until: LATER, laneId: 'tested' });
      should(lastEvent(ports)).match({ type: 'snoozed', until: LATER });
    });

    it('should wake a snoozed card, and refuse to wake one that is not snoozed', async () => {
      // Arrange
      const { ports, service } = serviceWith([toTest()]);
      await service.act('F1', action({ action: 'snooze', until: LATER }), owner);

      // Act
      await service.act('F1', action({ action: 'snooze', until: null }), owner);
      const again = await refusal(service.act('F1', action({ action: 'snooze', until: null }), owner));

      // Assert
      should(stored(ports).snoozed).equal(null);
      should(lastEvent(ports)).match({ type: 'snoozed', until: null });
      should(again.code).equal('invalid');
    });

    it('should refuse a time that has passed', async () => {
      // Arrange
      const { service } = serviceWith([toTest()]);

      // Act
      const error = await refusal(
        service.act('F1', action({ action: 'snooze', until: '2026-10-30T09:00:00.000Z' }), owner),
      );

      // Assert
      should(error.code).equal('invalid');
    });

    it('should leave the snooze to the owner, not a ferret', async () => {
      // Arrange
      const { service } = serviceWith([toTest()]);

      // Act
      const error = await refusal(service.act('F1', action({ action: 'snooze', until: LATER }), lead));

      // Assert
      should(error.code).equal('forbidden');
    });
  });

  describe('re-parenting a card', () => {
    const cards = () => [
      card({ id: 'F1', owner: 'lead', assignee: 'child' }),
      card({ id: 'F2', owner: 'lead' }),
      card({ id: 'F3', owner: 'stranger', assignee: 'stranger' }),
    ];

    it('should move the card under another, with the words in its history', async () => {
      // Arrange
      const { ports, service } = serviceWith(cards());

      // Act
      const response = await service.act(
        'F1',
        action({ action: 'reparent', parent: { id: 'F2' }, reason: 'it is part of the board work' }),
        lead,
      );

      // Assert
      should(response.task.parent).eql({ id: 'F2' });
      should(stored(ports).parent).eql({ id: 'F2' });
      should(lastEvent(ports)).match({
        type: 'reparented',
        from: null,
        to: { id: 'F2' },
        reason: 'it is part of the board work',
        actor: { kind: 'ferret', sessionId: 'lead' },
      });
    });

    it('should lift a card to the top level with --none, and refuse a move that changes nothing', async () => {
      // Arrange
      const { ports, service } = serviceWith([
        card({ id: 'F1', owner: 'lead', parent: { id: 'F2' } }),
        card({ id: 'F2', owner: 'lead' }),
      ]);

      // Act
      const same = await refusal(service.act('F1', action({ action: 'reparent', parent: { id: 'F2' } }), lead));
      await service.act('F1', action({ action: 'reparent', parent: null }), lead);
      const again = await refusal(service.act('F1', action({ action: 'reparent', parent: null }), lead));

      // Assert
      should(stored(ports).parent).be.null();
      should(lastEvent(ports)).match({ type: 'reparented', from: { id: 'F2' }, to: null, reason: null });
      should(again.code).equal('invalid');
      should(same.code).equal('invalid');
    });

    it('should let the human, the owner and an ancestor re-parent', async () => {
      // Arrange
      const human = serviceWith(cards());
      const ancestor = serviceWith([card({ id: 'F1', owner: 'child' }), card({ id: 'F2', owner: 'lead' })]);

      // Act
      await human.service.act('F1', action({ action: 'reparent', parent: { id: 'F2' } }), owner);
      await ancestor.service.act('F1', action({ action: 'reparent', parent: { id: 'F2' } }), lead);

      // Assert
      should(stored(human.ports).parent).eql({ id: 'F2' });
      should(stored(ancestor.ports).parent).eql({ id: 'F2' });
    });

    it("should refuse the card's worker and a stranger", async () => {
      // Arrange
      const { ports, service } = serviceWith(cards());

      // Act
      const worker = await refusal(service.act('F1', action({ action: 'reparent', parent: { id: 'F2' } }), child));
      const reader = await refusal(service.act('F1', action({ action: 'reparent', parent: { id: 'F2' } }), stranger));

      // Assert
      should(worker.code).equal('forbidden');
      should(reader.code).equal('forbidden');
      should(stored(ports).parent).be.null();
    });

    it('should refuse a ferret that cannot write the tree it would move the card onto', async () => {
      // Arrange
      const { ports, service } = serviceWith(cards());

      // Act
      const error = await refusal(service.act('F1', action({ action: 'reparent', parent: { id: 'F3' } }), lead));

      // Assert
      should(error.code).equal('forbidden');
      should(stored(ports).parent).be.null();
    });

    it('should refuse a loop, a missing parent and a card from another machine', async () => {
      // Arrange
      const { service } = serviceWith([
        card({ id: 'F1', owner: 'lead' }),
        card({ id: 'F2', owner: 'lead', parent: { id: 'F1' } }),
      ]);

      // Act
      const loop = await refusal(service.act('F1', action({ action: 'reparent', parent: { id: 'F2' } }), lead));
      const self = await refusal(service.act('F1', action({ action: 'reparent', parent: { id: 'F1' } }), lead));
      const missing = await refusal(service.act('F1', action({ action: 'reparent', parent: { id: 'F99' } }), lead));

      // Assert
      should(loop.code).equal('cycle');
      should(self.code).equal('cycle');
      should(missing.code).equal('not-found');
    });
  });

  it('should refuse a write that would leave the card invalid', async () => {
    // Arrange: a card already at the clarification bound.
    const full = card({
      clarifications: Array.from({ length: 128 }, () => ({
        text: 't',
        source: 's',
        at: NOW,
        by: { kind: 'owner' as const },
      })),
    });

    // Act
    const error = await refusal(
      serviceWith([full]).service.act('F1', action({ action: 'clarify', text: 'one more', source: 'owner' }), lead),
    );

    // Assert
    should(error.code).equal('invalid');
    should(error.message).containEql('clarifications');
  });
});

describe('handing a card to a sub-ferret', () => {
  it('should refuse a card dropped after the lead chose it', async () => {
    // Arrange
    const { service, ports } = serviceWith([card({ id: 'F1', owner: 'lead', dropped: { at: NOW, reason: 'x' } })]);

    // Act
    const error = await refusal(service.handOver('F1', 'lead', 'child'));

    // Assert
    should(error.code).equal('invalid');
    should(error.message).containEql('is dropped');
    should(ports.store.writes).be.empty();
  });

  it('should still hand the card over, with a warning, when the sub-ferret cannot be focused', async () => {
    // Arrange
    const { service, ports } = serviceWith([card({ id: 'F1', owner: 'lead' })], { focus: new FakeFocus(new Set()) });

    // Act
    const handed = await service.handOver('F1', 'lead', 'child');

    // Assert
    should(handed).match({ id: 'F1', assignee: 'child' });
    should(ports.warnings.some(warning => warning.includes('could not focus child'))).be.true();
  });
});

describe('refiling a card', () => {
  it("should land it in the same category's lane on the other board and tell both boards", async () => {
    // Arrange
    const { ports, service } = serviceWith([card({ laneId: 'implement' })]);

    // Act
    await service.act(
      'F1',
      action({ action: 'refile', projectId: OTHER_PROJECT, reason: 'it is ferretry work' }),
      lead,
    );

    // Assert
    should(stored(ports)).match({ projectId: OTHER_PROJECT, laneId: 'plan' });
    should(lastEvent(ports)).match({ type: 'refiled', fromProject: PROJECT, toProject: OTHER_PROJECT, toLane: 'plan' });
    should(ports.changes.events.map(entry => entry.event.projectId)).eql([PROJECT, OTHER_PROJECT]);
  });

  it('should fall back to the backlog when the other board lacks the category', async () => {
    // Arrange
    const { ports, service } = serviceWith([card({ laneId: 'tested' })]);

    // Act
    await service.act('F1', action({ action: 'refile', projectId: OTHER_PROJECT }), lead);

    // Assert
    should(stored(ports).laneId).equal('todo');
  });

  it('should take a named lane, and let the daemon refile too', async () => {
    // Arrange
    const { ports, service } = serviceWith([card()]);

    // Act
    await service.act('F1', action({ action: 'refile', projectId: OTHER_PROJECT, laneId: 'review' }), daemon);

    // Assert
    should(stored(ports).laneId).equal('review');
    should(lastEvent(ports)?.actor).eql({ kind: 'daemon' });
  });

  it.each([
    { name: 'onto its own board', input: { projectId: PROJECT }, code: 'invalid' },
    { name: 'onto a board with no lanes', input: { projectId: 'unfiled' as const }, code: 'no-lane-set' },
    {
      name: 'into a lane that board lacks',
      input: { projectId: OTHER_PROJECT, laneId: 'tested' },
      code: 'unknown-lane',
    },
  ])('should refuse a refile $name', async ({ input, code }) => {
    // Act
    const error = await refusal(serviceWith([card()]).service.act('F1', action({ action: 'refile', ...input }), lead));

    // Assert
    should(error.code).equal(code);
  });

  it('should keep an owner-gated closed lane on the other board for the owner', async () => {
    // Act
    const error = await refusal(
      serviceWith([card({ projectId: OTHER_PROJECT })]).service.act(
        'F1',
        action({ action: 'refile', projectId: PROJECT, laneId: 'closed' }),
        lead,
      ),
    );

    // Assert
    should(error.code).equal('owner-gate');
  });

  it.each([
    { name: 'into the closed lane of its category', laneId: undefined },
    { name: 'into the closed lane it names', laneId: 'closed' },
  ])('should carry a card that is already closed $name, past the gate', async ({ laneId }) => {
    // Arrange: Merged closes on the `pr` board, so the card is closed there already.
    const { ports, service } = serviceWith([card({ projectId: OTHER_PROJECT, laneId: 'merged' })]);

    // Act
    await service.act('F1', action({ action: 'refile', projectId: PROJECT, ...(laneId ? { laneId } : {}) }), lead);

    // Assert
    should(stored(ports)).match({ projectId: PROJECT, laneId: 'closed' });
    should(lastEvent(ports)).match({ type: 'refiled', toProject: PROJECT, toLane: 'closed' });
  });

  it("should keep a closed card closed when its workflow's lanes on the other board skip the closed lane", async () => {
    // Arrange
    const target = lanes(PROJECT);
    const variants = { ...target.variants, 'design-first': ['todo', 'plan', 'implement'] };
    const { ports, service } = serviceWith([card({ projectId: OTHER_PROJECT, laneId: 'merged' })], {
      lanes: new FakeLanes(
        new Map([
          [PROJECT, { ...target, variants }],
          [OTHER_PROJECT, lanes(OTHER_PROJECT, 'pr')],
        ]),
      ),
    });

    // Act
    await service.act('F1', action({ action: 'refile', projectId: PROJECT }), lead);

    // Assert
    should(stored(ports).laneId).equal('closed');
  });

  it('should still keep the gate for a ferret moving a card into Closed after a refile', async () => {
    // Arrange
    const { service } = serviceWith([card({ projectId: OTHER_PROJECT, laneId: 'merged' })]);
    await service.act('F1', action({ action: 'refile', projectId: PROJECT, laneId: 'released' }), lead);

    // Act
    const error = await refusal(service.act('F1', action({ action: 'move', to: 'closed' }), lead));

    // Assert
    should(error.code).equal('owner-gate');
  });
});

describe('a daemon trigger', () => {
  it('should move the card into the lane the trigger names, marked automatic', async () => {
    // Arrange
    const { ports, service } = serviceWith([card({ laneId: 'implement' })]);

    // Act
    const response = await service.trigger('F1', 'pr.opened', { sessionId: 'child', reason: 'PR #930 opened' });

    // Assert
    should(response?.task.laneId).equal('review');
    should(lastEvent(ports)).match({
      type: 'moved',
      auto: true,
      trigger: 'pr.opened',
      reason: 'PR #930 opened',
      actor: { kind: 'daemon', sessionId: 'child' },
    });
    should(ports.changes.events[0]?.sessionId).equal('child');
  });

  it('should move a blocked card anyway and say so', async () => {
    // Arrange
    const { ports, service } = serviceWith([
      card({ laneId: 'review', dependsOn: [{ task: { id: 'F2' }, until: 'shipped' }] }),
      card({ id: 'F2' }),
    ]);

    // Act
    await service.trigger('F1', 'pr.merged');

    // Assert
    should(stored(ports).laneId).equal('merged');
    should(lastEvent(ports)).match({ reason: 'pr.merged while blocked by &F2', actor: { kind: 'daemon' } });
    should(ports.changes.events[0]?.sessionId).equal('lead');
  });

  it.each([
    {
      name: 'a trigger its board has no lane for',
      stored: { projectId: OTHER_PROJECT, laneId: 'merged' },
      trigger: 'release.published' as const,
    },
    { name: 'a card already there', stored: { laneId: 'review' }, trigger: 'pr.opened' as const },
    { name: 'a card past it', stored: { laneId: 'merged' }, trigger: 'pr.opened' as const },
    {
      name: 'a dropped card',
      stored: { laneId: 'implement', dropped: { reason: 'no', at: NOW } },
      trigger: 'pr.opened' as const,
    },
  ])('should not move $name', async ({ stored: overrides, trigger }) => {
    // Arrange
    const { ports, service } = serviceWith([card(overrides)]);

    // Act
    const response = await service.trigger('F1', trigger);

    // Assert
    should(response).be.null();
    should(ports.store.writes).eql([]);
  });

  it('should refuse a card that does not exist', async () => {
    // Act
    const error = await refusal(serviceWith([]).service.trigger('F1', 'pr.opened'));

    // Assert
    should(error.code).equal('not-found');
  });

  it('should not let a ferret or the owner trigger', async () => {
    // Act
    const { ports, service } = serviceWith([card({ laneId: 'implement' })]);
    const caught = await service.act('F1', action({ action: 'move', to: 'review' }), lead).then(() => 'moved');

    // Assert: a ferret MOVES; only the daemon's trigger path marks a move automatic.
    should(caught).equal('moved');
    should(lastEvent(ports)).not.have.property('auto');
  });
});

describe('reading the board', () => {
  const board = () => [
    card({ id: 'F1', laneId: 'implement' }),
    card({ id: 'F2', laneId: 'closed' }),
    card({ id: 'F3', laneId: 'tested' }),
    card({ id: 'F4', projectId: OTHER_PROJECT }),
    card({ id: 'F5', dropped: { reason: 'no', at: NOW } }),
  ];

  it("should serve one project's open cards with its lanes, counts and the quarantined files", async () => {
    // Arrange
    const store = new MemoryBoardStore(board(), [{ id: 'F9', reason: 'the card file is not valid JSON' }]);
    const { service } = serviceWith([], { store });

    // Act
    const response = await service.board(BoardQuerySchema.parse({ project: PROJECT }));

    // Assert
    should(response.cards.map(entry => entry.id).sort()).eql(['F1', 'F3']);
    should(response.laneSet?.projectId).equal(PROJECT);
    should(response.counts).match({ closedHidden: 1, toTest: 1 });
    should(response.quarantined).eql([{ id: 'F9', reason: 'the card file is not valid JSON' }]);
    should(response.nextCursor).be.null();
  });

  it('should serve every project with no one lane set', async () => {
    // Act
    const response = await serviceWith(board()).service.board(BoardQuerySchema.parse({ state: 'all' }));

    // Assert
    should(response.projectId).be.null();
    should(response.laneSet).be.null();
    should(response.cards.length).equal(5);
  });

  it('should answer a project with no lanes with no lane set', async () => {
    // Act
    const response = await serviceWith(board()).service.board(BoardQuerySchema.parse({ project: 'unfiled' }));

    // Assert
    should(response.laneSet).be.null();
    should(response.cards).eql([]);
  });

  it('should read before the machine identity is open', async () => {
    // Act
    const response = await serviceWith(board(), { machineId: () => undefined }).service.board(
      BoardQuerySchema.parse({}),
    );

    // Assert
    should(response.cards.length).equal(3);
  });

  it('should serve one card, and say when it is missing or quarantined', async () => {
    // Arrange
    const store = new MemoryBoardStore([card({ projectId: 'unfiled' })], [{ id: 'F9', reason: 'damaged' }]);
    const { service } = serviceWith([], { store, machineId: () => undefined });

    // Act
    const found = await service.task('F1');
    const missing = await refusal(service.task('F2'));
    const damaged = await refusal(service.task('F9'));

    // Assert
    should(found.laneSet).be.null();
    should(missing.code).equal('not-found');
    should(damaged.message).containEql('quarantined');
  });

  /**
   * One card's read derived the whole board (every card's activity, every ferret's lineage) to show one card:
   * ~140 ms for a 2.8 KB answer. Its neighbourhood alone gives it the same view; the agenda is still read for
   * every ferret on the board, because an item about this card may sit in another card's ferret's agenda.
   */
  it('should derive one card from its neighbourhood alone and give it the view the whole board gives it', async () => {
    // Arrange
    const cards = [
      card({ id: 'F0' }),
      card({ id: 'F1', parent: { id: 'F0' } }),
      card({ id: 'F2', parent: { id: 'F1' }, owner: 'child' }),
      card({ id: 'F3', parent: { id: 'F1' }, dropped: { reason: 'superseded', at: NOW } }),
      card({ id: 'F4', owner: 'stranger' }),
    ];
    const ask = { sessionId: 'stranger', id: 'A1' };
    const agenda = new AgendaCardLinks(
      {
        open: async sessionId =>
          sessionId === 'stranger'
            ? ([{ id: 'A1', task: { id: 'F1' }, blockingNow: true }] as unknown as readonly AgendaItem[])
            : [],
      },
      () => MACHINE,
      { warn: () => undefined },
    );
    const derived: string[][] = [];
    const deriver = new LivenessActivityDeriver({ sessions: new FakeSessions(), clock: { now: () => NOW } });
    const activity = {
      derive: async (inputs: Parameters<typeof deriver.derive>[0]) => {
        derived.push(inputs.cards.map(each => each.id).sort());
        return await deriver.derive(inputs);
      },
    };
    const { service } = serviceWith(cards, { agenda, activity, lanes: new FakeLanes() });

    // Act
    const one = await service.task('F1');
    const whole = await service.board(BoardQuerySchema.parse({ state: 'all' }));

    // Assert
    should(derived[0]).eql(['F0', 'F1', 'F2']);
    should(one.task.waitingOnOwner).eql([ask]);
    should(one.task.activity).equal('waiting');
    should(one.task).eql(whole.cards.find(each => each.id === 'F1'));
  });

  it('should walk a loop in parent once when it gathers a neighbourhood', () => {
    // Arrange
    const looped = [card({ id: 'F1', parent: { id: 'F2' } }), card({ id: 'F2', parent: { id: 'F1' } })];

    // Act
    const around = neighbourhoodOf(looped[0] as BoardTask, new BoardIndex(looped, MACHINE));

    // Assert
    should(around.map(each => each.id).sort()).eql(['F1', 'F2']);
  });

  it('should hand the sweep every card, closed and dropped included, with every lane set, in one roster read', async () => {
    // Arrange
    const sessions = new FakeSessions();
    const activity = new LivenessActivityDeriver({ sessions, clock: { now: () => NOW } });

    // Act
    const swept = await serviceWith(board(), { activity }).service.sweepBoard();
    const unidentified = await serviceWith(board(), { machineId: () => undefined }).service.sweepBoard();

    // Assert
    should(swept.views.map(view => view.id)).eql(['F1', 'F2', 'F3', 'F4', 'F5']);
    should([...swept.laneSets.keys()].sort()).eql([PROJECT, OTHER_PROJECT].sort());
    should(swept.views[0]).match({ activity: 'idle', lastTouchedAt: NOW, touchedBy: 'lead' });
    should(sessions.reads).equal(1);
    should(unidentified.views).have.length(5);
  });
});

describe('what follows a write', () => {
  it('should report, not fail, when focus, the feed or the reopen delivery cannot be done', async () => {
    // Arrange
    const ports = world({
      store: new MemoryBoardStore([card({ laneId: 'merged', assignee: 'child' })]),
      focus: new FakeFocus(new Set(), true),
      changes: new FakeChanges('journal closed'),
      reopen: new FakeReopen(true),
      done: new FakeDone(true),
    });
    const service = new BoardService(ports);

    // Act
    await service.act('F1', action({ action: 'note', text: 'hi' }), lead);
    await service.act('F1', action({ action: 'move', to: 'implement', reason: 'not good' }), owner);
    await service.act('F1', action({ action: 'move', to: 'closed' }), owner);

    // Assert
    should(stored(ports).laneId).equal('closed');
    should(ports.warnings).eql([
      'could not focus lead on &F1: config is read-only',
      'could not publish board.changed for &F1: journal closed',
      'could not publish board.changed for &F1: journal closed',
      'could not deliver the reopen of &F1: nobody to tell',
      'could not publish board.changed for &F1: journal closed',
      'could not tell the ferret &F1 is done: nobody to tell',
    ]);
  });

  it('should take a project of its session from the lane source', async () => {
    // Arrange
    const { service } = serviceWith([], {
      lanes: new FakeLanes(new Map([[OTHER_PROJECT, lanes(OTHER_PROJECT, 'pr')]]), new Map([['lead', OTHER_PROJECT]])),
    });

    // Act
    const response = await service.create(create(), lead);

    // Assert
    should(response.task.projectId).equal(OTHER_PROJECT);
  });

  describe('for a ferret on the Unfiled board', () => {
    const unfiledLead = () =>
      new FakeLanes(
        new Map([
          [OTHER_PROJECT, lanes(OTHER_PROJECT, 'pr')],
          [UNFILED_PROJECT_ID, unfiledLaneSet()],
        ]),
        new Map([['lead', UNFILED_PROJECT_ID]]),
      );

    it('should put the card on the board of the repository it registers, proposing as the ferret', async () => {
      // Arrange
      const adopted: string[] = [];
      const { service } = serviceWith([], {
        lanes: unfiledLead(),
        adoption: {
          adopt: async (sessionId, proposer) => {
            adopted.push(`${sessionId}:${proposer ?? sessionId}`);
            return { projectId: OTHER_PROJECT, proposed: true };
          },
        },
      });

      // Act
      const response = await service.create(create(), lead);

      // Assert
      should(response.task.projectId).equal(OTHER_PROJECT);
      should(adopted).eql(['lead:lead']);
    });

    it('should keep the card Unfiled when nothing is registered, and say why when registering failed', async () => {
      // Arrange
      const quiet = serviceWith([], { lanes: unfiledLead(), adoption: { adopt: async () => null } });
      const failing = serviceWith([], {
        lanes: unfiledLead(),
        adoption: { adopt: () => Promise.reject(new Error('registry is damaged')) },
      });

      // Act
      const kept = await quiet.service.create(create(), lead);
      const fallen = await failing.service.create(create(), lead);

      // Assert
      should([kept.task.projectId, fallen.task.projectId]).eql([UNFILED_PROJECT_ID, UNFILED_PROJECT_ID]);
      should(failing.ports.warnings).containEql('could not register the repository of lead: registry is damaged');
    });

    it('should not register anything for a card that names its board, or for a ferret already on one', async () => {
      // Arrange
      const adopted: string[] = [];
      const adoption = {
        adopt: async (sessionId: string) => {
          adopted.push(sessionId);
          return null;
        },
      };
      const named = serviceWith([], { lanes: unfiledLead(), adoption });
      const filed = serviceWith([], { adoption });

      // Act
      await named.service.create(create({ projectId: OTHER_PROJECT }), lead);
      await filed.service.create(create(), lead);

      // Assert
      should(adopted).be.empty();
    });
  });
});

describe('the reopen message and actors', () => {
  it.each([
    { by: { kind: 'owner' as const }, expected: '&F412 was reopened by the owner: not good' },
    { by: { kind: 'ferret' as const, sessionId: 'lead' }, expected: '&F412 was reopened by lead: not good' },
    { by: { kind: 'daemon' as const }, expected: '&F412 was reopened by the daemon: not good' },
  ])('should say who reopened it', ({ by, expected }) => {
    // Assert
    should(reopenMessage({ id: 'F412' }, by, 'not good')).equal(expected);
  });

  it('should say the admin token for an owner actor that acted on it, never the owner', () => {
    // Assert
    should(reopenMessage({ id: 'F412' }, { kind: 'owner' }, 'not good', 'admin-token')).equal(
      '&F412 was reopened by the admin token (the owner at this machine, or a ferret without its own credential): not good',
    );
  });

  it('should record each caller as its actor', () => {
    // Assert
    should(actorOf(owner)).eql({ kind: 'owner' });
    should(actorOf(lead)).eql({ kind: 'ferret', sessionId: 'lead' });
    should(actorOf(daemon)).eql({ kind: 'daemon' });
    should(actorOf({ kind: 'daemon', sessionId: 'child' })).eql({ kind: 'daemon', sessionId: 'child' });
  });
});

describe("relocating a removed lane's cards", () => {
  it('should record the reason it is given instead, for a move that is not a removal', async () => {
    // Arrange
    const { ports, service } = serviceWith([card({ id: 'F1', laneId: 'tested' })]);

    // Act
    await service.relocate(PROJECT, { tested: 'released' }, 'Released and To test are one lane now');

    // Assert
    should(stored(ports, 'F1').laneId).equal('released');
    should(lastEvent(ports, 'F1')).match({
      type: 'moved',
      from: 'tested',
      to: 'released',
      reason: 'Released and To test are one lane now',
    });
  });

  it('should move each card of a removed lane on that board once, and say why', async () => {
    // Arrange
    const { ports, service } = serviceWith([
      card({ id: 'F1', laneId: 'plan' }),
      card({ id: 'F2', laneId: 'implement' }),
      card({ id: 'F3', laneId: 'plan', projectId: OTHER_PROJECT }),
    ]);

    // Act
    const first = await service.relocate(PROJECT, { plan: 'implement' });
    const again = await service.relocate(PROJECT, { plan: 'implement' });

    // Assert
    should(first).eql(['F1']);
    should(again).eql([]);
    should(stored(ports, 'F1').laneId).equal('implement');
    should(lastEvent(ports, 'F1')).match({
      type: 'moved',
      from: 'plan',
      to: 'implement',
      backward: false,
      reason: 'lane plan was removed from the board',
      actor: { kind: 'daemon' },
    });
    should(stored(ports, 'F3').laneId).equal('plan');
    should(ports.changes.events).eql([{ sessionId: 'lead', event: { projectId: PROJECT, taskIds: ['F1'] } }]);
  });

  it('should leave a card that moved away, or was refiled, before its turn', async () => {
    // Arrange
    const store = new MemoryBoardStore([card({ id: 'F1', laneId: 'plan' }), card({ id: 'F2', laneId: 'plan' })]);
    const write = store.write.bind(store);
    store.write = async (id, decide) => {
      const current = store.cards.get(id) as BoardTask;
      if (id === 'F1') store.cards.set(id, { ...current, laneId: 'implement' });
      if (id === 'F2') store.cards.set(id, { ...current, projectId: OTHER_PROJECT });
      return await write(id, decide);
    };

    // Act
    const moved = await serviceWith([], { store }).service.relocate(PROJECT, { plan: 'implement' });

    // Assert
    should(moved).eql([]);
    should(store.writes).eql([]);
  });

  it('should skip a card that vanished and a relocation onto its own lane', async () => {
    // Arrange
    const store = new MemoryBoardStore([card({ id: 'F1', laneId: 'plan' }), card({ id: 'F2', laneId: 'review' })]);
    const write = store.write.bind(store);
    store.write = async (id, decide) => {
      if (id === 'F1') store.cards.delete(id);
      return await write(id, decide);
    };

    // Act
    const moved = await serviceWith([], { store }).service.relocate(PROJECT, { plan: 'implement', review: 'review' });

    // Assert
    should(moved).eql([]);
  });
});

describe('lanes follow PR facts at the write', () => {
  const URL = 'https://github.com/kirinnee/ferretry/pull/930';
  const RELEASE = { version: '4.110.0', tag: 'v4.110.0', at: '2026-10-30T09:30:00Z' };
  const known = (fields: Partial<PrLink> = {}): PrLink => ({
    url: URL,
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
  const holding = (pr: PrLink, overrides: Partial<BoardTask> = {}): BoardTask =>
    card({ id: 'F2', laneId: 'implement', links: { prs: [pr], branch: null, commits: [], docs: [] }, ...overrides });
  const moves = (task: BoardTask) =>
    task.history.flatMap(event =>
      event.type === 'moved' ? [[event.to, event.trigger, event.reason, event.actor.kind, event.auto]] : [],
    );

  it('should use what another card already caches of a PR the moment it is linked', async () => {
    // Arrange
    const { ports, service } = serviceWith([card({ laneId: 'implement' }), holding(known())]);

    // Act
    await service.act('F1', action({ action: 'link', pr: URL.replace('kirinnee', 'KirinNee') }), lead);

    // Assert
    should(stored(ports).links.prs[0]).match({
      state: 'merged',
      number: 930,
      url: URL.replace('kirinnee', 'KirinNee'),
    });
    should(moves(stored(ports))).eql([['merged', 'pr.merged', 'PR #930 merged', 'daemon', true]]);
    should(stored(ports).history.map(event => event.type)).eql(['created', 'linked', 'moved']);
  });

  it.each([
    { name: 'open', pr: known({ state: 'open', mergedAt: null, mergeSha: null }), lane: 'review', trigger: 'pr.ready' },
    {
      name: 'released and running here',
      pr: known({ releasedIn: RELEASE }),
      lane: 'tested',
      trigger: 'release.running',
    },
  ])('should move a card at once on a linked PR that is $name', async ({ pr, lane, trigger }) => {
    // Arrange
    const { ports, service } = serviceWith([card({ laneId: 'plan' }), holding(pr)], {
      runningVersion: () => '4.114.0',
    });

    // Act
    await service.act('F1', action({ action: 'link', pr: URL }), lead);

    // Assert
    should(stored(ports).laneId).equal(lane);
    should(lastEvent(ports)).match({ type: 'moved', trigger, auto: true, actor: { kind: 'daemon' } });
  });

  it('should leave a card where it is when the PR linked is one nobody has polled', async () => {
    // Arrange
    const { ports, service } = serviceWith([card({ laneId: 'implement' })]);

    // Act
    await service.act('F1', action({ action: 'link', pr: URL }), lead);

    // Assert
    should(stored(ports)).match({ laneId: 'implement' });
    should(stored(ports).links.prs[0]?.state).equal('unknown');
    should(lastEvent(ports)).match({ type: 'linked' });
  });

  it('should not seed a link from a card that holds a stale unknown state, or a different PR', async () => {
    // Arrange
    const other = known({ url: 'https://github.com/kirinnee/ferretry/pull/931', number: 931 });
    const unknown = known({ state: 'unknown', checks: 'none', mergedAt: null, mergeSha: null, polledAt: null });
    const { ports, service } = serviceWith([card(), holding(other), holding(unknown, { id: 'F3' })]);

    // Act
    await service.act('F1', action({ action: 'link', pr: URL }), lead);

    // Assert
    should(stored(ports).links.prs[0]?.state).equal('unknown');
  });

  it('should take the freshest look when several cards cache the same PR', async () => {
    // Arrange
    const stale = known({ state: 'open', mergedAt: null, mergeSha: null, polledAt: '2026-10-30T08:00:00.000Z' });
    const { ports, service } = serviceWith([card(), holding(known()), holding(stale, { id: 'F3' })]);

    // Act
    await service.act('F1', action({ action: 'link', pr: URL }), lead);

    // Assert
    should(stored(ports).links.prs[0]?.state).equal('merged');
  });

  describe('a refile out of the Unfiled board', () => {
    const unfiledWorld = (task: BoardTask) =>
      serviceWith([task], {
        lanes: new FakeLanes(
          new Map([
            [UNFILED_PROJECT_ID, unfiledLaneSet()],
            [PROJECT, templateLanes(PROJECT)],
          ]),
        ),
      });
    const unfiledAt = (laneId: string, prs: readonly PrLink[]): BoardTask =>
      card({ projectId: UNFILED_PROJECT_ID, laneId, links: { prs: [...prs], branch: null, commits: [], docs: [] } });

    it('should land a card merged but not released in Merged, not in Released · to test by its To test lane', async () => {
      // Arrange
      const { ports, service } = unfiledWorld(unfiledAt('to-test', [known()]));

      // Act
      await service.act(
        'F1',
        action({ action: 'refile', projectId: PROJECT, reason: 'its PR is in Ferretry' }),
        daemon,
      );

      // Assert
      should(stored(ports)).match({ projectId: PROJECT, laneId: 'merged' });
      should(stored(ports).history.at(-2)).match({
        type: 'refiled',
        toLane: 'implement',
        reason: 'its PR is in Ferretry',
      });
      should(moves(stored(ports)).at(-1)).eql(['merged', 'pr.merged', 'PR #930 merged', 'daemon', true]);
    });

    it('should land a card whose PR shipped in a release in Released · to test, from Doing', async () => {
      // Arrange
      const { ports, service } = unfiledWorld(unfiledAt('doing', [known({ releasedIn: RELEASE })]));

      // Act
      await service.act('F1', action({ action: 'refile', projectId: PROJECT }), daemon);

      // Assert
      should(stored(ports)).match({ projectId: PROJECT, laneId: 'released' });
      should(moves(stored(ports)).at(-1)?.slice(0, 2)).eql(['released', 'release.published']);
    });

    it('should land by category when the PR facts say nothing, and take a named lane over them', async () => {
      // Arrange
      const noPr = unfiledWorld(unfiledAt('to-test', []));
      const named = unfiledWorld(unfiledAt('to-test', [known()]));

      // Act
      await noPr.service.act('F1', action({ action: 'refile', projectId: PROJECT }), daemon);
      await named.service.act('F1', action({ action: 'refile', projectId: PROJECT, laneId: 'released' }), daemon);

      // Assert
      should(stored(noPr.ports)).match({ projectId: PROJECT, laneId: 'released' });
      should(stored(named.ports)).match({ projectId: PROJECT, laneId: 'released' });
    });
  });

  it('should re-evaluate a card refiled to another board against that board lanes', async () => {
    // Arrange
    const { ports, service } = serviceWith([holding(known(), { id: 'F1' })]);

    // Act
    await service.act('F1', action({ action: 'refile', projectId: OTHER_PROJECT }), lead);

    // Assert: the `pr` template closes on merge, and a fact may enter a lane the owner does not gate.
    should(stored(ports)).match({ projectId: OTHER_PROJECT, laneId: 'merged' });
    should(moves(stored(ports))).eql([['merged', 'pr.merged', 'PR #930 merged', 'daemon', true]]);
  });

  it('should refile as before when the card has no PR facts', async () => {
    // Arrange
    const { ports, service } = serviceWith([card({ laneId: 'implement' })]);

    // Act
    await service.act('F1', action({ action: 'refile', projectId: OTHER_PROJECT }), lead);

    // Assert
    should(stored(ports)).match({ projectId: OTHER_PROJECT, laneId: 'plan' });
  });

  it('should record a PR update with the version this daemon runs', async () => {
    // Arrange
    const shipped = holding(known({ releasedIn: RELEASE }), { id: 'F1', laneId: 'released' });
    const { ports, service } = serviceWith([shipped], { runningVersion: () => '4.110.0' });

    // Act
    await service.recordPullRequests('F1', { link: [], observed: [], releases: [], runningVersion: null });

    // Assert
    should(stored(ports).laneId).equal('tested');
  });
});
