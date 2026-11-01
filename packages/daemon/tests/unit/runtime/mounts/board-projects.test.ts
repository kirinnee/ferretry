import { describe, it } from 'bun:test';
import {
  type BoardProject,
  type BoardProjectId,
  BoardProjectsResponseSchema,
  type BoardSwitch,
  BoardSwitchSchema,
  boardErr,
  boardOk,
  LANE_TEMPLATES,
  type LaneSet,
  type LaneSetActionRequest,
  type LaneSetChangeResponse,
  UNFILED_PROJECT_ID,
} from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher, ApiRouter } from '../../../../src/lib/api/index.ts';
import { BoardSwitchUnavailableError, LaneSetUnavailableError } from '../../../../src/lib/board-projects/errors.ts';
import type { LaneActor, LaneSetFailure } from '../../../../src/lib/board-projects/index.ts';
import {
  BOARD_SWITCH_OWNER_ONLY,
  type BoardProjectsSubsystem,
  type BoardSwitchSubsystem,
  boardProjectRoutes,
} from '../../../../src/lib/runtime/mounts/board-projects.ts';
import { jsonBody, request } from '../../api/support.ts';
import { handleDirectly } from './second-line.ts';
import {
  agentIn,
  CREDENTIALS,
  FERRET_SESSION,
  fromFerret,
  grantSubsystem,
  human,
  sessionDirectory,
  sessionView,
} from './support.ts';

const FERRETRY_ID = '11111111-1111-4111-8111-111111111111';

const QUICK_LANES: LaneSet = {
  projectId: UNFILED_PROJECT_ID,
  version: 1,
  confirmedBy: 'owner',
  proposedBy: 'ferretry',
  ...LANE_TEMPLATES.quick,
};
const UNFILED: BoardProject = { id: UNFILED_PROJECT_ID, name: 'Unfiled', path: null, laneSet: QUICK_LANES };
const FERRETRY: BoardProject = { id: FERRETRY_ID, name: 'Ferretry', path: '/work/ferretry', laneSet: null };
const CHANGE: LaneSetChangeResponse = { laneSet: QUICK_LANES, agenda: 'raised' };

interface Calls {
  readonly applied: Array<{ projectId: BoardProjectId; request: LaneSetActionRequest; actor: LaneActor }>;
}

function boards(overrides: Partial<BoardProjectsSubsystem> = {}): BoardProjectsSubsystem & Calls {
  const applied: Calls['applied'] = [];
  return {
    applied,
    projects: async () => [UNFILED, FERRETRY],
    project: async id => [UNFILED, FERRETRY].find(board => board.id === id),
    projectOf: async () => FERRETRY_ID,
    apply: async (projectId, body, actor) => {
      applied.push({ projectId, request: body, actor });
      return boardOk(CHANGE);
    },
    ...overrides,
  };
}

/** A switch that remembers what it was set to; every board starts off. */
function switches(): BoardSwitchSubsystem & { readonly set_: Array<[BoardProjectId, boolean]> } {
  const state = new Map<BoardProjectId, BoardSwitch>();
  const set_: Array<[BoardProjectId, boolean]> = [];
  return {
    set_,
    read: async projectId => state.get(projectId) ?? { projectId, on: false, setBy: 'default', setAt: null },
    set: async (projectId, on) => {
      set_.push([projectId, on]);
      const value: BoardSwitch = { projectId, on, setBy: 'owner', setAt: '2026-11-01T12:00:00.000Z' };
      state.set(projectId, value);
      return value;
    },
  };
}

async function dispatcher(
  subsystem: BoardProjectsSubsystem,
  switch_: BoardSwitchSubsystem = switches(),
): Promise<ApiDispatcher> {
  const grants = grantSubsystem();
  await grants.refresh();
  const sessions = sessionDirectory([
    sessionView('ms8-abcd1234', { label: 'Koen', teammate: 'koen' }),
    sessionView('ms8-plain001', {}),
    sessionView('ms8-sub00001', { parent: 'ms8-abcd1234' }),
  ]);
  return new ApiDispatcher(new ApiRouter(boardProjectRoutes(subsystem, sessions, switch_)), CREDENTIALS, grants);
}

const post = (projectId: string, body: unknown, headers: Readonly<Record<string, string>> = human) =>
  request({
    method: 'POST',
    path: `/v1/board/projects/${projectId}/lanes`,
    headers,
    loopback: true,
    body: JSON.stringify(body),
  });

const PROPOSE = { action: 'propose', template: 'quick' };

describe('the board switch', () => {
  const put = (projectId: string, body: unknown, headers: Readonly<Record<string, string>> = human) =>
    request({
      method: 'PUT',
      path: `/v1/board/projects/${projectId}/switch`,
      headers,
      loopback: true,
      body: JSON.stringify(body),
    });
  const get = (projectId: string, headers: Readonly<Record<string, string>> = human) =>
    request({ path: `/v1/board/projects/${projectId}/switch`, headers, loopback: true });

  it("should read a board's switch, off until the owner throws it", async () => {
    const state = switches();
    const surface = await dispatcher(boards(), state);

    const before = await surface.dispatch(get(FERRETRY_ID));
    const thrown = await surface.dispatch(put(FERRETRY_ID, { on: true }));
    const after = await surface.dispatch(get(FERRETRY_ID, agentIn('ms8-abcd1234')));

    should(before.status).equal(200);
    should(before.headers.get('cache-control')).equal('no-store');
    should(BoardSwitchSchema.parse(jsonBody(before))).deepEqual({
      projectId: FERRETRY_ID,
      on: false,
      setBy: 'default',
      setAt: null,
    });
    should(thrown.status).equal(200);
    should(BoardSwitchSchema.parse(jsonBody(after))).match({ on: true, setBy: 'owner' });
    should(state.set_).deepEqual([[FERRETRY_ID, true]]);
  });

  it('should refuse a ferret, however it asks: the owner decides', async () => {
    const state = switches();
    const response = await (
      await dispatcher(boards(), state)
    ).dispatch(put(FERRETRY_ID, { on: true }, agentIn('ms8-abcd1234')));
    const own = await (await dispatcher(boards(), state)).dispatch(fromFerret(put(FERRETRY_ID, { on: true })));

    // The boundary refuses both: the switch is `caller: 'person'`.
    should([response.status, jsonBody(response).code]).deepEqual([403, 'owner_only']);
    should([own.status, jsonBody(own).code]).deepEqual([403, 'owner_only']);
    should(state.set_).deepEqual([]);
  });

  it('should still refuse a ferret in the handler if the boundary ever let one through', async () => {
    const state = switches();
    const sessions = sessionDirectory([]);

    const answer = await handleDirectly(
      boardProjectRoutes(boards(), sessions, state),
      'PUT',
      `/v1/board/projects/${FERRETRY_ID}/switch`,
      undefined,
      { on: true },
    );

    should([answer.status, answer.code, answer.message]).deepEqual([403, 'owner-only', BOARD_SWITCH_OWNER_ONLY]);
    should(state.set_).deepEqual([]);
  });

  it('should answer 404 for a board it does not list, and 400 for a body that is not a switch', async () => {
    const surface = await dispatcher(boards());
    const other = '44444444-4444-4444-8444-444444444444';

    const read = await surface.dispatch(get(other));
    const set = await surface.dispatch(put(other, { on: false }));
    const bad = await surface.dispatch(put(FERRETRY_ID, { on: 'yes' }));

    should([read.status, set.status, bad.status]).deepEqual([404, 404, 400]);
  });

  it('should answer 503 when the switch document is damaged', async () => {
    const damaged: BoardSwitchSubsystem = {
      read: async () => {
        throw new BoardSwitchUnavailableError('/state/board/switch.json: not JSON');
      },
      set: async () => {
        throw new Error('unreachable');
      },
    };
    const response = await (await dispatcher(boards(), damaged)).dispatch(get(FERRETRY_ID));

    should(response.status).equal(503);
    should(JSON.stringify(jsonBody(response))).not.containEql('/state');
  });
});

describe('the board projects mount', () => {
  it('should list the boards without naming a current one for the owner', async () => {
    const response = await (
      await dispatcher(boards())
    ).dispatch(request({ path: '/v1/board/projects', headers: human, loopback: true }));

    should(response.status).equal(200);
    should(response.headers.get('cache-control')).equal('no-store');
    should(BoardProjectsResponseSchema.parse(jsonBody(response))).deepEqual({
      projects: [UNFILED, FERRETRY],
      current: null,
    });
  });

  it("should name the calling session's board as current", async () => {
    const response = await (
      await dispatcher(boards())
    ).dispatch(request({ path: '/v1/board/projects', headers: agentIn('ms8-abcd1234'), loopback: true }));

    should(BoardProjectsResponseSchema.parse(jsonBody(response)).current).equal(FERRETRY_ID);
  });

  it('should read one board and answer 404 for one it does not list', async () => {
    const surface = await dispatcher(boards());

    const found = await surface.dispatch(
      request({ path: `/v1/board/projects/${FERRETRY_ID}/lanes`, headers: human, loopback: true }),
    );
    const missing = await surface.dispatch(
      request({
        path: '/v1/board/projects/44444444-4444-4444-8444-444444444444/lanes',
        headers: human,
        loopback: true,
      }),
    );

    should(found.status).equal(200);
    should(jsonBody(found)).deepEqual(FERRETRY);
    should(missing.status).equal(404);
    should(jsonBody(missing)).containEql({ code: 'not-found' });
  });

  it('should refuse a project id that is not one', async () => {
    const response = await (
      await dispatcher(boards())
    ).dispatch(request({ path: '/v1/board/projects/not-an-id/lanes', headers: human, loopback: true }));

    should(response.status).equal(400);
    should(jsonBody(response)).containEql({ code: 'invalid_project_id' });
  });

  it('should apply an owner change as the owner', async () => {
    const subsystem = boards();

    const response = await (await dispatcher(subsystem)).dispatch(post(FERRETRY_ID, PROPOSE));

    should(response.status).equal(200);
    should(jsonBody(response)).deepEqual(CHANGE);
    // The admin token with no ferret's credential: the owner's authority, recorded as the token.
    should(subsystem.applied).deepEqual([
      { projectId: FERRETRY_ID, request: { ...PROPOSE, renames: {} }, actor: { kind: 'owner', via: 'admin-token' } },
    ]);
  });

  it('should apply a paired device’s change as the owner, plainly', async () => {
    const subsystem = boards();

    const answer = await handleDirectly(
      boardProjectRoutes(subsystem, sessionDirectory([]), switches()),
      'POST',
      `/v1/board/projects/${FERRETRY_ID}/lanes`,
      { credential: { kind: 'authenticated', tokenClass: 'device', deviceId: 'device-1' }, actor: 'device:device-1' },
      PROPOSE,
    );

    should(answer.status).equal(200);
    should(subsystem.applied.map(applied => applied.actor)).deepEqual([{ kind: 'owner' }]);
  });

  it('should take a ferret’s own credential as that ferret, and refuse an agent with no session to name', async () => {
    const subsystem = boards();
    const sessions = sessionDirectory([]);

    const own = await (await dispatcher(subsystem)).dispatch(fromFerret(post(FERRETRY_ID, PROPOSE)));
    const bare = await handleDirectly(
      boardProjectRoutes(subsystem, sessions, switches()),
      'POST',
      `/v1/board/projects/${FERRETRY_ID}/lanes`,
      { credential: { kind: 'authenticated', tokenClass: 'warden' }, actor: 'warden' },
      PROPOSE,
    );

    should(own.status).equal(200);
    should(subsystem.applied.map(applied => applied.actor)).deepEqual([
      { kind: 'ferret', name: FERRET_SESSION, sessionId: FERRET_SESSION },
    ]);
    should([bare.status, bare.code]).deepEqual([403, 'forbidden']);
  });

  it('should apply a ferret change as that ferret, named by its label, its teammate name or its id', async () => {
    const subsystem = boards();
    const surface = await dispatcher(subsystem);

    await surface.dispatch(post(FERRETRY_ID, PROPOSE, agentIn('ms8-abcd1234')));
    await surface.dispatch(post(FERRETRY_ID, PROPOSE, agentIn('ms8-plain001')));
    await surface.dispatch(post(FERRETRY_ID, PROPOSE, agentIn('ms8-unknown1')));

    should(subsystem.applied.map(call => call.actor)).deepEqual([
      { kind: 'ferret', name: 'Koen', sessionId: 'ms8-abcd1234' },
      { kind: 'ferret', name: 'ms8-plain001', sessionId: 'ms8-plain001' },
      { kind: 'ferret', name: 'ms8-unknown1', sessionId: 'ms8-unknown1' },
    ]);
  });

  it('should refuse a sub-ferret a lane change and name its lead, but let the lead change them', async () => {
    const subsystem = boards();
    const surface = await dispatcher(subsystem);

    const refused = await surface.dispatch(post(FERRETRY_ID, PROPOSE, agentIn('ms8-sub00001')));
    const allowed = await surface.dispatch(post(FERRETRY_ID, PROPOSE, agentIn('ms8-abcd1234')));

    should(refused.status).equal(403);
    should(JSON.stringify(jsonBody(refused))).containEql(
      "Sub-ferrets don't edit the board lanes; tell your lead: fy send koen",
    );
    should(allowed.status).equal(200);
    should(subsystem.applied.map(call => call.actor)).deepEqual([
      { kind: 'ferret', name: 'Koen', sessionId: 'ms8-abcd1234' },
    ]);
  });

  it('should restate every refusal with its own status and words', async () => {
    const failures: ReadonlyArray<readonly [LaneSetFailure, number]> = [
      [{ code: 'not-found', projectId: 'x' }, 404],
      [{ code: 'unknown-lane', laneId: 'l' }, 400],
      [{ code: 'relocation-missing', laneIds: ['a'] }, 400],
      [{ code: 'version-conflict', current: 2 }, 409],
      [{ code: 'already-confirmed', version: 2 }, 409],
      [{ code: 'no-lane-set' }, 409],
      [{ code: 'owner-only' }, 403],
    ];
    for (const [failure, status] of failures) {
      const surface = await dispatcher(boards({ apply: async () => boardErr(failure) }));

      const response = await surface.dispatch(post(FERRETRY_ID, PROPOSE));

      should(response.status).equal(status);
      should(jsonBody(response)).containEql({ code: failure.code });
    }
  });

  it('should refuse a body that is not a lane action', async () => {
    const response = await (await dispatcher(boards())).dispatch(post(FERRETRY_ID, { action: 'burn' }));

    should(response.status).equal(400);
  });

  it('should answer 503 with the fixed message for a damaged lane document, on every route', async () => {
    const damaged = () => {
      throw new LaneSetUnavailableError('/state/board/lanes/x.json: not JSON');
    };
    const surface = await dispatcher(boards({ projects: damaged, project: damaged, apply: damaged }));

    const responses = [
      await surface.dispatch(request({ path: '/v1/board/projects', headers: human, loopback: true })),
      await surface.dispatch(
        request({ path: `/v1/board/projects/${FERRETRY_ID}/lanes`, headers: human, loopback: true }),
      ),
      await surface.dispatch(post(FERRETRY_ID, PROPOSE)),
    ];

    for (const response of responses) {
      should(response.status).equal(503);
      should(JSON.stringify(jsonBody(response))).not.containEql('/state/board');
    }
  });

  it('should let any other failure surface as the daemon error it is', async () => {
    const surface = await dispatcher(
      boards({
        projects: async () => {
          throw new Error('boom');
        },
      }),
    );

    const response = await surface.dispatch(request({ path: '/v1/board/projects', headers: human, loopback: true }));

    should(response.status).equal(500);
  });
});
