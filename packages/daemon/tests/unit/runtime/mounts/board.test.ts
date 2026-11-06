import { describe, it } from 'bun:test';
import type {
  BoardQuery,
  BoardSkipRequest,
  BoardTask,
  BoardTaskActionRequest,
  BoardTaskCreateRequest,
} from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher, ApiError, ApiRouter } from '../../../../src/lib/api/index.ts';
import { type BoardCaller, BoardError, BoardService, BoardUnavailableError } from '../../../../src/lib/board/index.ts';
import { DEFAULT_CAPABILITY_GRANTS } from '../../../../src/lib/grants/index.ts';
import {
  BOARD_ERROR_STATUS,
  type BoardSubsystem,
  boardCaller,
  boardRoutes,
  reraiseBoardError,
} from '../../../../src/lib/runtime/mounts/board.ts';
import { jsonBody, request } from '../../api/support.ts';
import {
  card,
  FakeLanes,
  FakeParents,
  lanes,
  MemoryBoardStore,
  PROJECT,
  type ServiceWorld,
  world,
} from '../../board/support.ts';
import { DIRECTORY as SUB_FERRETS } from '../../sub-ferret/support.ts';
import { agentIn, boardSubsystem, CREDENTIALS, FERRET_SESSION, fromFerret, grantSubsystem, human } from './support.ts';

const phone = { deviceId: 'fy_device_id_phone', appSession: 'app-one' } as const;

async function dispatcher(board: BoardSubsystem, fleet = DEFAULT_CAPABILITY_GRANTS.fleet): Promise<ApiDispatcher> {
  const grants = grantSubsystem({ grants: { ...DEFAULT_CAPABILITY_GRANTS, fleet } });
  await grants.refresh();
  return new ApiDispatcher(new ApiRouter(boardRoutes(board)), CREDENTIALS, grants, undefined, {
    held: device => device.deviceId === phone.deviceId,
  });
}

/** A board that records what each route handed it. */
const recording = (overrides: Partial<ServiceWorld> = {}) => {
  const calls: {
    readonly route: string;
    readonly value: unknown;
    readonly caller?: BoardCaller;
    readonly actor?: string | undefined;
  }[] = [];
  const base = boardSubsystem();
  const service = new BoardService(world({ store: new MemoryBoardStore([card()]), ...overrides }));
  const board: BoardSubsystem = {
    board: async (query: BoardQuery) => {
      calls.push({ route: 'board', value: query });
      return await base.board(query);
    },
    ids: async () => {
      calls.push({ route: 'ids', value: null });
      return await service.ids();
    },
    mergeGate: async pr => {
      calls.push({ route: 'merge-gate', value: pr });
      return await service.mergeGate(pr);
    },
    task: async id => {
      calls.push({ route: 'task', value: id });
      return await service.task(id);
    },
    create: async (value: BoardTaskCreateRequest, caller) => {
      calls.push({ route: 'create', value, caller });
      return await service.create(value, caller);
    },
    act: async (id, value: BoardTaskActionRequest, caller) => {
      calls.push({ route: 'act', value: { id, ...value }, caller });
      return await service.act(id, value, caller);
    },
    skip: async (value: BoardSkipRequest, caller) => {
      calls.push({ route: 'skip', value, caller });
      return await service.skip(value, caller);
    },
    start: async (id, caller, key) => {
      calls.push({ route: 'start', value: id, caller, ...(key === undefined ? {} : { key }) });
      if (caller.kind !== 'owner') throw new BoardError('forbidden', 'only the owner may start a ferret on a card');
      return { task: id, sessionId: 'worker', started: true };
    },
  };
  return { calls, board };
};

describe('the board mount', () => {
  it('should record a skip for the ferret in the pane that asked, never one named in the body', async () => {
    // Arrange
    const { calls, board } = recording();

    // Act
    const response = await (await dispatcher(board)).dispatch(
      request({
        method: 'POST',
        path: '/v1/board/skip',
        headers: agentIn('lead'),
        body: JSON.stringify({ reason: 'the owner said not to track this' }),
      }),
    );
    const named = await (await dispatcher(board)).dispatch(
      request({
        method: 'POST',
        path: '/v1/board/skip',
        headers: agentIn('lead'),
        body: JSON.stringify({ reason: 'x', sessionId: 'child' }),
      }),
    );

    // Assert
    should(response.status).equal(200);
    should(response.headers.get('cache-control')).equal('no-store');
    should(calls[0]).match({ route: 'skip', value: { reason: 'the owner said not to track this' } });
    should(calls[0]?.caller).eql({ kind: 'ferret', sessionId: 'lead' });
    should(jsonBody(response)).match({ sessionId: 'lead', skip: { reason: 'the owner said not to track this' } });
    should(named.status).equal(400);
  });

  it('should refuse a skip from the owner, which has no session of its own to record it on', async () => {
    // Act
    const response = await (await dispatcher(recording().board)).dispatch(
      request({ method: 'POST', path: '/v1/board/skip', headers: human, body: JSON.stringify({ reason: 'chat' }) }),
    );

    // Assert
    should(response.status).equal(400);
    should(jsonBody(response).code).equal('invalid');
  });

  it('should read the board query from the query string, defaulting to open cards', async () => {
    // Arrange
    const { calls, board } = recording();

    // Act
    const response = await (await dispatcher(board)).dispatch(
      request({
        path: '/v1/board',
        headers: human,
        query: [
          ['project', PROJECT],
          ['kind', 'feature'],
          ['limit', '20'],
          ['ferret', ''],
        ],
      }),
    );

    // Assert
    should(response.status).equal(200);
    should(response.headers.get('cache-control')).equal('no-store');
    should(calls[0]?.value).eql({ project: PROJECT, kind: 'feature', limit: 20, state: 'open' });
    should(jsonBody(response)).match({ cards: [], quarantined: [] });
  });

  it.each([
    { name: 'a limit that is not a number', query: [['limit', 'ten']] as [string, string][] },
    { name: 'an unknown state', query: [['state', 'archived']] as [string, string][] },
  ])('should refuse $name', async ({ query }) => {
    // Act
    const response = await (await dispatcher(boardSubsystem())).dispatch(
      request({ path: '/v1/board', headers: human, query }),
    );

    // Assert
    should(response.status).equal(400);
    should(jsonBody(response).code).equal('invalid');
  });

  it('should serve one card by any spelling of its id', async () => {
    // Arrange
    const { calls, board } = recording();

    // Act
    const response = await (await dispatcher(board)).dispatch(
      request({ path: '/v1/board/tasks/%26f1', headers: human }),
    );

    // Assert
    should(response.status).equal(200);
    should(calls[0]?.value).equal('F1');
    should(jsonBody(response)).match({ task: { id: 'F1' } });
  });

  it.each(['%E0%A4%A', 'F0'])('should refuse the card id %s', async id => {
    // Act
    const response = await (await dispatcher(boardSubsystem())).dispatch(
      request({ path: `/v1/board/tasks/${id}`, headers: human }),
    );

    // Assert
    should(response.status).equal(400);
  });

  it('should create a card for the ferret in the pane that asked', async () => {
    // Arrange
    const { calls, board } = recording();

    // Act
    const response = await (await dispatcher(board)).dispatch(
      request({
        method: 'POST',
        path: '/v1/board/tasks',
        headers: agentIn('lead'),
        body: JSON.stringify({ kind: 'feature', title: 'Board store', ask: { text: 'build it', source: 'owner' } }),
      }),
    );

    // Assert
    should(response.status).equal(200);
    should(calls[0]?.caller).eql({ kind: 'ferret', sessionId: 'lead' });
    should(jsonBody(response)).match({ task: { id: 'F2', owner: 'lead' } });
  });

  it('should act on a card as the owner from the human CLI and answer a refusal with its status', async () => {
    // Arrange
    const { calls, board } = recording();
    const live = await dispatcher(board);

    // Act
    const moved = await live.dispatch(
      request({
        method: 'POST',
        path: '/v1/board/tasks/F1',
        headers: human,
        body: JSON.stringify({ action: 'move', to: 'plan' }),
      }),
    );
    const refused = await live.dispatch(
      request({
        method: 'POST',
        path: '/v1/board/tasks/F1',
        headers: agentIn('stranger'),
        body: JSON.stringify({ action: 'note', text: 'hi' }),
      }),
    );

    // Assert
    should(moved.status).equal(200);
    should(calls[0]?.caller).eql({ kind: 'owner', via: 'admin-token' });
    should(refused.status).equal(403);
    should(jsonBody(refused)).match({ code: 'forbidden', allowed: ['owner-human', 'owner', 'ancestor', 'assignee'] });
  });

  it('should let a sub-ferret that is the assignee hand its card down over the wire, and refuse anywhere else', async () => {
    // Arrange — the production guard (sub-ferrets may not reassign) and the lineage, both wired.
    const service = new BoardService(
      world({
        store: new MemoryBoardStore([card({ assignee: 'child' })]),
        parents: new FakeParents({ child: 'lead', grandchild: 'child', sibling: 'lead' }),
        subFerrets: SUB_FERRETS,
      }),
    );
    const { board } = recording();
    const live = await dispatcher({ ...board, act: async (id, value, caller) => await service.act(id, value, caller) });
    const assign = (session: string, assignee: string | null) =>
      live.dispatch(
        request({
          method: 'POST',
          path: '/v1/board/tasks/F1',
          headers: agentIn(session),
          body: JSON.stringify({ action: 'assign', assignee }),
        }),
      );

    // Act
    const sibling = await assign('child', 'sibling');
    const upward = await assign('child', 'lead');
    const stranger = await assign('stranger', 'grandchild');
    const handedDown = await assign('child', 'grandchild');

    // Assert
    should([sibling.status, upward.status, stranger.status]).eql([403, 403, 403]);
    should(String(jsonBody(sibling).error)).startWith(
      "You are a sub-ferret, so you can't reassign a card outside your own subtree",
    );
    should(handedDown.status).equal(200);
    should(jsonBody(handedDown)).match({ task: { assignee: 'grandchild', owner: 'lead' } });
  });

  it('should move a card as a ferret on its own credential, and as the admin token without one', async () => {
    // Arrange — the same move twice: from a ferret's pane with its OWN session credential (no session header at
    // all), and on the admin token with no session (the owner at the machine, or a ferret that left it out).
    const { calls, board } = recording();
    const live = await dispatcher(board);
    const move = (headers: Readonly<Record<string, string>>) =>
      request({
        method: 'POST',
        path: '/v1/board/tasks/F1',
        headers,
        loopback: true,
        body: JSON.stringify({ action: 'move', to: 'plan' }),
      });

    // Act
    const own = await live.dispatch(fromFerret(move(human)));
    const token = await live.dispatch(move(human));

    // Assert — never the owner: the ferret is itself (so the board's own rule refuses it someone else's card),
    // and the token keeps the owner's authority while it is recorded as the token.
    should([own.status, jsonBody(own).code, token.status]).deepEqual([403, 'forbidden', 200]);
    should(calls.map(call => call.caller)).eql([
      { kind: 'ferret', sessionId: FERRET_SESSION },
      { kind: 'owner', via: 'admin-token' },
    ]);
  });

  it('should move a card on an external trigger its ferret reports, as the daemon, and say who reported it', async () => {
    // Arrange: a board whose Merged lane a deploy also enters, where the card's work does not stop at the
    // Plan/Design gate (a report never passes one for a ferret).
    const deployed = lanes(PROJECT);
    const laneSet = {
      ...deployed,
      lanes: deployed.lanes.map(lane =>
        lane.id === 'merged' ? { ...lane, enterOn: [...(lane.enterOn ?? []), 'deploy.done' as const] } : lane,
      ),
      variants: { 'design-first': deployed.lanes.map(lane => lane.id).filter(id => id !== 'plan') },
    };
    const { calls, board } = recording({ lanes: new FakeLanes(new Map([[PROJECT, laneSet]])) });
    const live = await dispatcher(board);
    const trigger = (headers: Readonly<Record<string, string>>, body: unknown) =>
      request({ method: 'POST', path: '/v1/board/tasks/F1', headers, body: JSON.stringify(body) });

    // Act
    const observed = await live.dispatch(trigger(agentIn('lead'), { action: 'trigger', event: 'pr.merged' }));
    const stranger = await live.dispatch(trigger(agentIn('stranger'), { action: 'trigger', event: 'deploy.done' }));
    const moved = await live.dispatch(
      trigger(agentIn('lead'), { action: 'trigger', event: 'deploy.done', reason: 'deployed to production' }),
    );

    // Assert
    should(observed.status).equal(400);
    should(stranger.status).equal(403);
    should(jsonBody(stranger)).match({ code: 'forbidden', allowed: ['owner-human', 'owner', 'ancestor', 'assignee'] });
    should(moved.status).equal(200);
    should(calls.filter(call => call.route === 'act').map(call => call.value)).eql([
      { id: 'F1', action: 'trigger', event: 'deploy.done' },
      { id: 'F1', action: 'trigger', event: 'deploy.done', reason: 'deployed to production' },
    ]);
    should(jsonBody(moved).task).match({ laneId: 'merged' });
    should((jsonBody(moved).task as BoardTask).history.at(-1)).match({
      type: 'moved',
      auto: true,
      trigger: 'deploy.done',
      actor: { kind: 'daemon' },
      reportedBy: { kind: 'ferret', sessionId: 'lead' },
    });
  });

  it('should answer a report the board has no lane for as invalid', async () => {
    // Act
    const response = await (await dispatcher(recording().board)).dispatch(
      request({
        method: 'POST',
        path: '/v1/board/tasks/F1',
        headers: human,
        body: JSON.stringify({ action: 'trigger', event: 'deploy.done' }),
      }),
    );

    // Assert
    should(response.status).equal(400);
    should(jsonBody(response).code).equal('invalid');
  });

  it('should refuse a malformed action before it reaches the board', async () => {
    // Arrange
    const { calls, board } = recording();

    // Act
    const response = await (await dispatcher(board)).dispatch(
      request({
        method: 'POST',
        path: '/v1/board/tasks/F1',
        headers: human,
        body: JSON.stringify({ action: 'teleport' }),
      }),
    );

    // Assert
    should(response.status).equal(400);
    should(calls).eql([]);
  });

  it('should start a new ferret on the card for the owner at the machine, and say which one', async () => {
    // Arrange
    const { calls, board } = recording();

    // Act
    const response = await (await dispatcher(board)).dispatch(
      request({ method: 'POST', path: '/v1/board/tasks/%26F1/start', headers: human }),
    );

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response)).eql({ task: 'F1', sessionId: 'worker', started: true });
    should(calls).eql([{ route: 'start', value: 'F1', caller: { kind: 'owner', via: 'admin-token' } }]);
  });

  it("should hand the click's request id to the start as its key, and none when the id is blank", async () => {
    // Arrange
    const { calls, board } = recording();
    const live = await dispatcher(board);

    // Act
    await live.dispatch(
      request({
        method: 'POST',
        path: '/v1/board/tasks/F1/start',
        headers: { ...human, 'x-fy-request-id': ' click-7 ' },
      }),
    );
    await live.dispatch(
      request({ method: 'POST', path: '/v1/board/tasks/F1/start', headers: { ...human, 'x-fy-request-id': '  ' } }),
    );

    // Assert
    should(calls.map(call => (call as { key?: string }).key)).eql(['click-7', undefined]);
  });

  it('should start a ferret on the card for a paired device the fleet grant lets in, as the owner', async () => {
    // Arrange
    const { calls, board } = recording();

    // Act
    const response = await (await dispatcher(board)).dispatch(
      request({ method: 'POST', path: '/v1/board/tasks/F1/start', device: phone }),
    );

    // Assert
    should(response.status).equal(200);
    should(calls[0]?.caller).eql({ kind: 'owner' });
  });

  it('should refuse a ferret’s own credential, and a remote device when the fleet grant is off', async () => {
    // Arrange
    const { calls, board } = recording();

    // Act
    const ferret = await (await dispatcher(board)).dispatch(
      request({ method: 'POST', path: '/v1/board/tasks/F1/start', headers: agentIn('lead') }),
    );
    const remote = await (await dispatcher(board, { use: false, configure: false })).dispatch(
      request({ method: 'POST', path: '/v1/board/tasks/F1/start', device: phone }),
    );

    // Assert
    should(ferret.status).equal(403);
    should(remote.status).equal(403);
    should(calls).eql([]);
  });

  it('should answer a card that is not there, and an unusable id, in the board’s own terms', async () => {
    // Arrange
    const { board } = recording();
    const live = await dispatcher({ ...board, start: boardSubsystem().start });

    // Act
    const missing = await live.dispatch(request({ method: 'POST', path: '/v1/board/tasks/F9/start', headers: human }));
    const garbled = await live.dispatch(
      request({ method: 'POST', path: '/v1/board/tasks/not-a-card/start', headers: human }),
    );

    // Assert
    should(missing.status).equal(404);
    should(garbled.status).equal(400);
  });

  it('should take a paired device the fleet grant lets in as the owner', async () => {
    // Arrange
    const { calls, board } = recording();

    // Act
    const response = await (await dispatcher(board)).dispatch(
      request({
        method: 'POST',
        path: '/v1/board/tasks/F1',
        device: phone,
        body: JSON.stringify({ action: 'note', text: 'from the phone' }),
      }),
    );

    // Assert
    should(response.status).equal(200);
    should(calls[0]?.caller).eql({ kind: 'owner' });
  });

  it('should keep the board from a remote device when the fleet grant is off', async () => {
    // Arrange
    const { calls, board } = recording();

    // Act
    const response = await (await dispatcher(board, { use: false, configure: false })).dispatch(
      request({ path: '/v1/board', device: phone }),
    );

    // Assert
    should(response.status).equal(403);
    should(calls).eql([]);
  });

  it('should list every card id on the machine, and only the ids', async () => {
    // Arrange
    const { calls, board } = recording();

    // Act
    const response = await (await dispatcher(board)).dispatch(request({ path: '/v1/board/ids', headers: human }));

    // Assert
    should(response.status).equal(200);
    should(response.headers.get('cache-control')).equal('no-store');
    should(calls.map(call => call.route)).eql(['ids']);
    should(jsonBody(response)).eql({ ids: ['F1'] });
  });

  it('should keep the id list from a remote device when the fleet grant is off', async () => {
    // Arrange
    const { calls, board } = recording();

    // Act
    const response = await (await dispatcher(board, { use: false, configure: false })).dispatch(
      request({ path: '/v1/board/ids', device: phone }),
    );

    // Assert
    should(response.status).equal(403);
    should(calls).eql([]);
  });
});

describe('GET /v1/board/merge-gate', () => {
  it("should answer the PR's merge unit from the board, never cached", async () => {
    // Arrange
    const { calls, board } = recording();
    const url = 'https://github.com/kirinnee/ferretry/pull/42';

    // Act
    const response = await (await dispatcher(board)).dispatch(
      request({ path: '/v1/board/merge-gate', query: [['pr', url]], headers: human }),
    );

    // Assert
    should(response.status).equal(200);
    should(response.headers.get('cache-control')).equal('no-store');
    should(calls).eql([{ route: 'merge-gate', value: url }]);
    should(jsonBody(response)).eql({ pr: url, unit: [], waits: [], unreadable: [] });
  });

  it('should refuse a request that names no PR, or something that is not one', async () => {
    // Arrange
    const { board } = recording();
    const api = await dispatcher(board);

    // Act
    const none = await api.dispatch(request({ path: '/v1/board/merge-gate', headers: human }));
    const wrong = await api.dispatch(request({ path: '/v1/board/merge-gate', query: [['pr', 'F12']], headers: human }));

    // Assert
    should(none.status).equal(400);
    should(wrong.status).equal(400);
  });

  it('should keep the gate from a remote device when the fleet grant is off', async () => {
    // Arrange
    const { calls, board } = recording();

    // Act
    const response = await (await dispatcher(board, { use: false, configure: false })).dispatch(
      request({ path: '/v1/board/merge-gate', query: [['pr', 'x']], device: phone }),
    );

    // Assert
    should(response.status).equal(403);
    should(calls).eql([]);
  });
});

describe('the board caller', () => {
  it.each([
    { actor: 'peer:lead', expected: { kind: 'ferret', sessionId: 'lead' } },
    { actor: 'admin-cli', expected: { kind: 'owner', via: 'admin-token' } },
    { actor: 'admin-ui', expected: { kind: 'owner', via: 'admin-token' } },
    { actor: 'device:fy_device_id_phone', expected: { kind: 'owner' } },
  ])('should read $actor as $expected.kind ($expected.via)', ({ actor, expected }) => {
    // Assert
    should(boardCaller(actor)).eql(expected);
  });

  it.each(['peer:', 'device', 'device:', 'warden:w1', 'cron:nightly', undefined])(
    'should refuse the actor %s',
    actor => {
      // Assert
      should(() => boardCaller(actor)).throw(ApiError, { status: 403 });
    },
  );
});

describe('a board refusal on the wire', () => {
  it('should map every board code to a status', () => {
    // Assert
    should(Object.values(BOARD_ERROR_STATUS).every(status => status >= 400 && status < 500)).be.true();
  });

  it('should answer a refusal without allowed standings plainly', () => {
    // Assert
    should(() => reraiseBoardError(new BoardError('cycle', 'a cycle'))).throw(ApiError, {
      status: 409,
      code: 'cycle',
      extra: undefined,
    });
  });

  it('should answer an unavailable board 503 with the fixed message', () => {
    // Assert
    should(() => reraiseBoardError(new BoardUnavailableError('/home/x is damaged'))).throw(ApiError, {
      status: 503,
      code: 'unavailable',
      message: 'the board cannot be written right now',
    });
  });

  it('should let anything else propagate as the defect it is', () => {
    // Arrange
    const defect = new TypeError('boom');

    // Assert
    should(() => reraiseBoardError(defect)).throw(defect);
  });
});

describe('public and private cards on the wire', () => {
  const visibility = (value: string) => JSON.stringify({ action: 'visibility', visibility: value });

  it('should hand the visibility filter to the board, and answer an unknown one as invalid', async () => {
    // Arrange
    const { calls, board } = recording();
    const live = await dispatcher(board);

    // Act
    const asked = await live.dispatch(
      request({ path: '/v1/board', headers: human, query: [['visibility', 'public']] }),
    );
    const bad = await live.dispatch(request({ path: '/v1/board', headers: human, query: [['visibility', 'secret']] }));

    // Assert
    should(asked.status).equal(200);
    should(calls[0]?.value).match({ visibility: 'public' });
    should(bad.status).equal(400);
    should(jsonBody(bad).code).equal('invalid');
  });

  it('should send no visibility when the query names none, so an older app keeps every card', async () => {
    const { calls, board } = recording();
    await (await dispatcher(board)).dispatch(request({ path: '/v1/board', headers: human }));
    should(calls[0]?.value).not.have.property('visibility');
  });

  it('should refuse a ferret that hides the owner’s ask, naming who may', async () => {
    // Arrange: F1 is the owner's ask, owned by `lead`
    const { board } = recording();

    // Act
    const response = await (await dispatcher(board)).dispatch(
      request({ method: 'POST', path: '/v1/board/tasks/F1', headers: agentIn('lead'), body: visibility('private') }),
    );

    // Assert
    should(response.status).equal(403);
    should(jsonBody(response)).match({ code: 'forbidden', allowed: ['owner-human'] });
  });

  it('should let the owner at the machine hide it, and a paired device the fleet grant lets in', async () => {
    const { board } = recording();
    const live = await dispatcher(board);
    const hidden = await live.dispatch(
      request({ method: 'POST', path: '/v1/board/tasks/F1', headers: human, body: visibility('private') }),
    );
    should(hidden.status).equal(200);
    should(jsonBody(hidden)).match({ task: { visibility: 'private' } });
    const shown = await live.dispatch(
      request({ method: 'POST', path: '/v1/board/tasks/F1', device: phone, body: visibility('public') }),
    );
    should(shown.status).equal(200);
    should(jsonBody(shown)).match({ task: { visibility: 'public' } });
  });

  it('should keep a remote device from changing visibility when the fleet grant is off', async () => {
    const { calls, board } = recording();
    const response = await (await dispatcher(board, { use: false, configure: false })).dispatch(
      request({ method: 'POST', path: '/v1/board/tasks/F1', device: phone, body: visibility('private') }),
    );
    should(response.status).equal(403);
    should(calls).eql([]);
  });

  it('should refuse a malformed visibility before it reaches the board', async () => {
    const { calls, board } = recording();
    const response = await (await dispatcher(board)).dispatch(
      request({ method: 'POST', path: '/v1/board/tasks/F1', headers: human, body: visibility('hidden') }),
    );
    should(response.status).equal(400);
    should(calls).eql([]);
  });
});
