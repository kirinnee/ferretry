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
import { handleDirectly } from './second-line.ts';
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
  const calls: { readonly route: string; readonly value: unknown; readonly caller?: BoardCaller }[] = [];
  const base = boardSubsystem();
  const service = new BoardService(
    world({ store: new MemoryBoardStore([card({ legacyRef: 'abc:F12' })]), ...overrides }),
  );
  const board: BoardSubsystem = {
    board: async (query: BoardQuery) => {
      calls.push({ route: 'board', value: query });
      return await base.board(query);
    },
    task: async id => {
      calls.push({ route: 'task', value: id });
      return await service.task(id);
    },
    taskByLegacyRef: async legacyRef => {
      calls.push({ route: 'legacyRef', value: legacyRef });
      return await service.taskByLegacyRef(legacyRef);
    },
    importLegacy: async options => {
      calls.push({ route: 'import', value: options });
      return await base.importLegacy(options);
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
  };
  return { calls, board };
};

describe('the board mount', () => {
  it('should record a skip for the ferret in the pane that asked, never one named in the body', async () => {
    // Arrange
    const { calls, board } = recording();

    // Act
    const response = await (
      await dispatcher(board)
    ).dispatch(
      request({
        method: 'POST',
        path: '/v1/board/skip',
        headers: agentIn('lead'),
        body: JSON.stringify({ reason: 'the owner said not to track this' }),
      }),
    );
    const named = await (
      await dispatcher(board)
    ).dispatch(
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
    const response = await (
      await dispatcher(recording().board)
    ).dispatch(
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
    const response = await (
      await dispatcher(board)
    ).dispatch(
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
    const response = await (
      await dispatcher(boardSubsystem())
    ).dispatch(request({ path: '/v1/board', headers: human, query }));

    // Assert
    should(response.status).equal(400);
    should(jsonBody(response).code).equal('invalid');
  });

  it('should serve one card by any spelling of its id', async () => {
    // Arrange
    const { calls, board } = recording();

    // Act
    const response = await (
      await dispatcher(board)
    ).dispatch(request({ path: '/v1/board/tasks/%26f1', headers: human }));

    // Assert
    should(response.status).equal(200);
    should(calls[0]?.value).equal('F1');
    should(jsonBody(response)).match({ task: { id: 'F1' } });
  });

  it('should serve the card an old task became, by any spelling of the old reference', async () => {
    // Arrange
    const { calls, board } = recording();

    // Act
    const response = await (
      await dispatcher(board)
    ).dispatch(request({ path: '/v1/board/tasks', headers: human, query: [['legacyRef', 'abc:&f12']] }));

    // Assert
    should(response.status).equal(200);
    should(calls[0]).match({ route: 'legacyRef', value: 'abc:F12' });
    should(jsonBody(response)).match({ task: { id: 'F1', legacyRef: 'abc:F12' } });
  });

  it('should answer 404 when no card came from the old task', async () => {
    // Act
    const response = await (
      await dispatcher(recording().board)
    ).dispatch(request({ path: '/v1/board/tasks', headers: human, query: [['legacyRef', 'abc:F99']] }));

    // Assert
    should(response.status).equal(404);
  });

  it.each([undefined, '', 'F12', 'abc:', ':F12', 'a b:F12', 'abc:nope'])(
    'should refuse the legacyRef %s',
    async value => {
      // Act
      const { calls, board } = recording();
      const response = await (
        await dispatcher(board)
      ).dispatch(
        request({
          path: '/v1/board/tasks',
          headers: human,
          query: value === undefined ? [] : [['legacyRef', value]],
        }),
      );

      // Assert
      should(response.status).equal(400);
      should(jsonBody(response).code).equal('invalid');
      should(calls).eql([]);
    },
  );

  it.each([
    { body: JSON.stringify({}), dryRun: false },
    { body: JSON.stringify({ dryRun: false }), dryRun: false },
    { body: JSON.stringify({ dryRun: true }), dryRun: true },
  ])('should run the import for the owner with $body', async ({ body, dryRun }) => {
    // Arrange
    const { calls, board } = recording();

    // Act
    const response = await (
      await dispatcher(board)
    ).dispatch(request({ method: 'POST', path: '/v1/board/import', headers: human, body }));

    // Assert
    should(response.status).equal(200);
    should(calls[0]).eql({ route: 'import', value: { dryRun } });
    should(jsonBody(response)).match({ skipped: false, complete: true });
  });

  it('should refuse the import from a ferret, and a malformed body from the owner', async () => {
    // Arrange
    const { calls, board } = recording();
    const live = await dispatcher(board);

    // Act
    const ferret = await live.dispatch(
      request({ method: 'POST', path: '/v1/board/import', headers: agentIn('lead'), body: '{}' }),
    );
    const malformed = await live.dispatch(
      request({ method: 'POST', path: '/v1/board/import', headers: human, body: JSON.stringify({ dryRun: 'yes' }) }),
    );

    // Assert
    should(ferret.status).equal(403);
    should(malformed.status).equal(400);
    should(calls).eql([]);
  });

  it.each(['%E0%A4%A', 'F0'])('should refuse the card id %s', async id => {
    // Act
    const response = await (
      await dispatcher(boardSubsystem())
    ).dispatch(request({ path: `/v1/board/tasks/${id}`, headers: human }));

    // Assert
    should(response.status).equal(400);
  });

  it('should create a card for the ferret in the pane that asked', async () => {
    // Arrange
    const { calls, board } = recording();

    // Act
    const response = await (
      await dispatcher(board)
    ).dispatch(
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
    should(String(jsonBody(sibling).error)).startWith("Sub-ferrets don't reassign cards");
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
    const response = await (
      await dispatcher(recording().board)
    ).dispatch(
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
    const response = await (
      await dispatcher(board)
    ).dispatch(
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

  it('should take a paired device the fleet grant lets in as the owner', async () => {
    // Arrange
    const { calls, board } = recording();

    // Act
    const response = await (
      await dispatcher(board)
    ).dispatch(
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
    const response = await (
      await dispatcher(board, { use: false, configure: false })
    ).dispatch(request({ path: '/v1/board', device: phone }));

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

describe('the board import’s own second line', () => {
  it('should still refuse a ferret’s own credential if the boundary ever let one through', async () => {
    // Arrange
    const { board, calls } = recording();

    // Act
    const answer = await handleDirectly(boardRoutes(board), 'POST', '/v1/board/import', undefined, {});

    // Assert
    should([answer.status, answer.code]).deepEqual([403, 'forbidden']);
    should(calls).deepEqual([]);
  });
});
