import { describe, it } from 'bun:test';
import {
  type BoardTask,
  type BoardTaskCreateRequestInput,
  BoardTaskCreateRequestSchema,
  UNFILED_PROJECT_ID,
} from '@ferretry/protocol';
import should from 'should';
import { BoardError, BoardService, BoardUnavailableError } from '../../../src/lib/board/index.ts';
import {
  card,
  FakeFocus,
  FakeLanes,
  lanes,
  MemoryBoardStore,
  NOW,
  PROJECT,
  type ServiceWorld,
  world,
} from './support.ts';

const create = (input: Partial<BoardTaskCreateRequestInput> = {}) =>
  BoardTaskCreateRequestSchema.parse({
    kind: 'feature',
    title: 'Board store',
    ask: { text: 'build it', source: 'session:lead' },
    ...input,
  });

const serviceWith = (cards: readonly BoardTask[], overrides: Partial<ServiceWorld> = {}) => {
  const ports = world({ store: new MemoryBoardStore(cards), ...overrides });
  return { ports, service: new BoardService(ports) };
};

const stored = (ports: ServiceWorld, id: string): BoardTask => ports.store.cards.get(id) as BoardTask;

describe('reserving a card id', () => {
  it('should take the next id of the kind from the counter, never reused', async () => {
    // Arrange
    const { service } = serviceWith([card({ id: 'F7' })]);

    // Act
    const first = await service.reserve('feature');
    const second = await service.reserve('feature');
    const bug = await service.reserve('bug');

    // Assert
    should([first, second, bug]).deepEqual(['F8', 'F9', 'B1']);
  });

  it('should refuse before the daemon identity is open', async () => {
    // Arrange
    const { service } = serviceWith([], { machineId: () => undefined });

    // Act / Assert
    await should(service.reserve('feature')).be.rejectedWith(BoardUnavailableError);
  });
});

describe("a start's card", () => {
  it('should write the card under the reserved id, owned as told, and focus the session that works it', async () => {
    // Arrange
    const { ports, service } = serviceWith([card({ id: 'F1', owner: 'lead', laneId: 'implement' })]);
    const id = await service.reserve('feature');

    // Act
    const made = await service.spawn(id, create({ parent: { id: 'F1' }, assignee: 'child', workflow: 'quick' }), {
      owner: 'lead',
      by: 'lead',
      focus: 'child',
      projectId: PROJECT,
    });

    // Assert
    should(made).match({ id: 'F2', owner: 'lead', assignee: 'child', parent: { id: 'F1' }, laneId: 'todo' });
    should(stored(ports, 'F2').history).deepEqual([
      { seq: 1, at: NOW, actor: { kind: 'daemon', sessionId: 'lead' }, type: 'created', laneId: 'todo' },
    ]);
    should(made.createdBy).deepEqual({ kind: 'daemon', sessionId: 'lead' });
    should(ports.focus.focused.get('child')).deepEqual({ id: 'F2' });
    should(ports.focus.focused.has('lead')).be.false();
    should(ports.changes.events).deepEqual([{ sessionId: 'lead', event: { projectId: PROJECT, taskIds: ['F2'] } }]);
  });

  it('should refuse a parent that is not a card here, and a board with no lanes', async () => {
    // Arrange
    const { service } = serviceWith([]);
    const spawn = { owner: 'lead', by: 'lead', focus: 'lead', projectId: PROJECT };

    // Act / Assert
    await should(service.spawn('F1', create({ parent: { id: 'F99' } }), spawn)).be.rejectedWith(BoardError);
    await should(
      service.spawn('F1', create(), { ...spawn, projectId: '33333333-3333-4333-8333-333333333333' }),
    ).be.rejectedWith({ code: 'no-lane-set' });
  });

  it('should keep the card and say so when its session cannot be focused', async () => {
    // Arrange
    const { ports, service } = serviceWith([], { focus: new FakeFocus(new Set(), true) });

    // Act
    await service.spawn('F1', create(), { owner: 'lead', by: 'lead', focus: 'lead', projectId: PROJECT });

    // Assert
    should(ports.store.cards.has('F1')).be.true();
    should(ports.warnings).deepEqual(['could not focus lead on &F1']);
  });
});

describe('signal done on the card', () => {
  const focused = (sessionId: string, id: string) => {
    const focus = new FakeFocus();
    focus.focused.set(sessionId, { id });
    return focus;
  };

  it('should note the message and move an active card to review in one write', async () => {
    // Arrange
    const { ports, service } = serviceWith(
      [card({ id: 'F2', owner: 'lead', assignee: 'child', laneId: 'implement', workflow: 'quick' })],
      { focus: focused('child', 'F2') },
    );

    // Act
    const done = await service.signalDone('child', 'built and tested');

    // Assert
    should(done?.moved?.id).equal('review');
    should(stored(ports, 'F2').laneId).equal('review');
    should(stored(ports, 'F2').history.slice(1)).match([
      { type: 'note', text: 'done: built and tested', actor: { kind: 'ferret', sessionId: 'child' } },
      {
        type: 'moved',
        to: 'review',
        auto: true,
        trigger: 'signal.done',
        actor: { kind: 'daemon', sessionId: 'child' },
      },
    ]);
    should(ports.store.writes).have.length(1);
    should(ports.changes.events.map(each => each.sessionId)).deepEqual(['child']);
  });

  it('should move a done Unfiled card with no PR to To test, never to Closed', async () => {
    // Arrange
    const { ports, service } = serviceWith(
      [card({ projectId: UNFILED_PROJECT_ID, laneId: 'doing', workflow: 'quick' })],
      {
        focus: focused('lead', 'F1'),
        lanes: new FakeLanes(new Map([[UNFILED_PROJECT_ID, lanes(UNFILED_PROJECT_ID, 'quick')]])),
      },
    );

    // Act
    const done = await service.signalDone('lead', 'fixed the claim form');

    // Assert
    should(done?.moved?.id).equal('to-test');
    should(stored(ports, 'F1').history.at(-1)).match({
      type: 'moved',
      from: 'doing',
      to: 'to-test',
      trigger: 'signal.done',
      reason: 'fixed the claim form',
    });
  });

  it('should only note a card that stays, and say why a gate or a blocker held it', async () => {
    // Arrange
    const todo = serviceWith([card({ laneId: 'todo' })], { focus: focused('lead', 'F1') });
    const gated = serviceWith([card({ laneId: 'plan' })], { focus: focused('lead', 'F1') });

    // Act
    const stays = await todo.service.signalDone('lead', undefined);
    const held = await gated.service.signalDone('lead', 'designed');

    // Assert
    should(stays).match({ moved: null });
    should(stays).not.have.property('held');
    should(stored(todo.ports, 'F1').history.at(-1)).match({ type: 'note', text: 'signalled done' });
    should(held).match({ moved: null, held: 'only the owner moves &F1 on from plan, so it stays there' });
    should(stored(gated.ports, 'F1').laneId).equal('plan');
  });

  it('should do nothing for a session with no focus card here', async () => {
    // Arrange
    const none = serviceWith([card()]);
    const elsewhere = new FakeFocus();
    elsewhere.focused.set('lead', { id: 'F1', machineId: 'another-machine' });
    const remote = serviceWith([card()], { focus: elsewhere });
    const vanished = serviceWith([], { focus: focused('lead', 'F1') });

    // Act / Assert
    should(await none.service.signalDone('lead', 'done')).be.null();
    should(await remote.service.signalDone('lead', 'done')).be.null();
    should(await vanished.service.signalDone('lead', 'done')).be.null();
    should(none.ports.store.writes).be.empty();
  });

  it('should refuse a ferret that may not note the card it is focused on', async () => {
    // Arrange
    const { service } = serviceWith([card({ owner: 'lead' })], { focus: focused('stranger', 'F1') });

    // Act / Assert
    await should(service.signalDone('stranger', 'done')).be.rejectedWith({ code: 'forbidden' });
  });
});
