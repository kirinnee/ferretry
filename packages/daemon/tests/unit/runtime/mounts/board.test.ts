import { describe, it } from 'bun:test';
import type { BoardQuery, BoardTaskActionRequest, BoardTaskCreateRequest } from '@ferretry/protocol';
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
import { card, MemoryBoardStore, PROJECT, world } from '../../board/support.ts';
import { agentIn, boardSubsystem, CREDENTIALS, grantSubsystem, human } from './support.ts';

const phone = { deviceId: 'fy_device_id_phone', appSession: 'app-one' } as const;

async function dispatcher(board: BoardSubsystem, fleet = DEFAULT_CAPABILITY_GRANTS.fleet): Promise<ApiDispatcher> {
  const grants = grantSubsystem({ grants: { ...DEFAULT_CAPABILITY_GRANTS, fleet } });
  await grants.refresh();
  return new ApiDispatcher(new ApiRouter(boardRoutes(board)), CREDENTIALS, grants, undefined, {
    held: device => device.deviceId === phone.deviceId,
  });
}

/** A board that records what each route handed it. */
const recording = () => {
  const calls: { readonly route: string; readonly value: unknown; readonly caller?: BoardCaller }[] = [];
  const base = boardSubsystem();
  const service = new BoardService(world({ store: new MemoryBoardStore([card()]) }));
  const board: BoardSubsystem = {
    board: async (query: BoardQuery) => {
      calls.push({ route: 'board', value: query });
      return await base.board(query);
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
  };
  return { calls, board };
};

describe('the board mount', () => {
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
    should(calls[0]?.caller).eql({ kind: 'owner' });
    should(refused.status).equal(403);
    should(jsonBody(refused)).match({ code: 'forbidden', allowed: ['owner-human', 'owner', 'ancestor', 'assignee'] });
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
    { actor: 'admin-cli', expected: { kind: 'owner' } },
    { actor: 'admin-ui', expected: { kind: 'owner' } },
    { actor: 'device:fy_device_id_phone', expected: { kind: 'owner' } },
  ])('should read $actor as $expected.kind', ({ actor, expected }) => {
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
