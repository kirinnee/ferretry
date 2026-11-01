import {
  type BoardProject,
  type BoardProjectId,
  BoardProjectIdSchema,
  type BoardProjectsResponse,
  type BoardResult,
  type BoardSwitch,
  BoardSwitchRequestSchema,
  type LaneSetActionRequest,
  LaneSetActionRequestSchema,
  type LaneSetChangeResponse,
} from '@ferretry/protocol';
import type { ApiActor } from '../../api/actor.ts';
import { parseActor } from '../../api/actor.ts';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { type ApiResponse, decodeParameter } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { BoardSwitchUnavailableError, LaneSetUnavailableError } from '../../board-projects/errors.ts';
import { describeLaneSetFailure, type LaneActor, type LaneSetFailure } from '../../board-projects/index.ts';
import { sessionSubFerretDirectory, subFerretRefusal } from '../../sub-ferret/index.ts';
import type { SessionDirectorySubsystem } from './sessions.ts';

/** The board's projects and their lanes, as the routes need them. */
export interface BoardProjectsSubsystem {
  projects(): Promise<readonly BoardProject[]>;
  project(projectId: BoardProjectId): Promise<BoardProject | undefined>;
  projectOf(sessionId: string): Promise<BoardProjectId>;
  apply(
    projectId: BoardProjectId,
    request: LaneSetActionRequest,
    actor: LaneActor,
  ): Promise<BoardResult<LaneSetChangeResponse, LaneSetFailure>>;
}

/** Whether each board is used (`docs/board.md` § The board is opt-in): read by anybody, switched by the owner. */
export interface BoardSwitchSubsystem {
  read(projectId: BoardProjectId): Promise<BoardSwitch>;
  set(projectId: BoardProjectId, on: boolean): Promise<BoardSwitch>;
}

const FAILURE_STATUS: Readonly<Record<LaneSetFailure['code'], number>> = {
  'not-found': 404,
  'unknown-lane': 400,
  'relocation-missing': 400,
  'version-conflict': 409,
  'already-confirmed': 409,
  'no-lane-set': 409,
  'owner-only': 403,
};

/** The session id behind a ferret's actor (`peer:` or `warden:`), or `undefined` for the owner. */
function ferretSession(actor: ApiActor | undefined): string | undefined {
  const { kind, id } = parseActor(actor ?? '');
  return (kind === 'peer' || kind === 'warden') && id !== undefined && id !== '' ? id : undefined;
}

async function laneActor(actor: ApiActor | undefined, sessions: SessionDirectorySubsystem): Promise<LaneActor> {
  const sessionId = ferretSession(actor);
  if (sessionId === undefined) return { kind: 'owner' };
  const view = await sessions.get(sessionId);
  const name = view?.config.label ?? view?.config.teammate ?? sessionId;
  return { kind: 'ferret', name, sessionId };
}

function projectId(context: RouteContext): BoardProjectId {
  const parsed = BoardProjectIdSchema.safeParse(decodeParameter(context.params.get('projectId') ?? ''));
  if (!parsed.success) throw new ApiError(400, 'the project id in the path is not usable', 'invalid_project_id');
  return parsed.data;
}

async function list(boards: BoardProjectsSubsystem, context: RouteContext): Promise<ApiResponse> {
  const session = ferretSession(context.actor);
  const current = session === undefined ? null : await boards.projectOf(session);
  const body: BoardProjectsResponse = { projects: [...(await boards.projects())], current };
  return jsonResponse(body);
}

async function read(boards: BoardProjectsSubsystem, context: RouteContext): Promise<ApiResponse> {
  const id = projectId(context);
  const board = await boards.project(id);
  if (board === undefined) throw new ApiError(404, `no board for project ${id}`, 'not-found');
  return jsonResponse(board);
}

async function change(
  boards: BoardProjectsSubsystem,
  sessions: SessionDirectorySubsystem,
  context: RouteContext,
): Promise<ApiResponse> {
  const id = projectId(context);
  const request = await parseBody(context.request, LaneSetActionRequestSchema);
  const { kind, id: caller } = parseActor(context.actor ?? '');
  if (kind === 'peer' && caller !== undefined && caller !== '') {
    const refusal = await subFerretRefusal(sessionSubFerretDirectory(sessions), caller, 'edit the board lanes');
    if (refusal !== null) throw new ApiError(403, refusal, 'sub-ferret');
  }
  const result = await boards.apply(id, request, await laneActor(context.actor, sessions));
  if (result.ok) return jsonResponse(result.value);
  throw new ApiError(FAILURE_STATUS[result.error.code], describeLaneSetFailure(result.error), result.error.code);
}

async function readSwitch(
  boards: BoardProjectsSubsystem,
  switches: BoardSwitchSubsystem,
  context: RouteContext,
): Promise<ApiResponse> {
  const id = projectId(context);
  if ((await boards.project(id)) === undefined) throw new ApiError(404, `no board for project ${id}`, 'not-found');
  return jsonResponse(await switches.read(id));
}

/** The words a ferret is refused with: the owner decides whether a project uses the board. */
export const BOARD_SWITCH_OWNER_ONLY =
  'Only the owner switches a board on or off. Ask them first, as one agenda yes/no: "Track this on the board?"';

async function setSwitch(
  boards: BoardProjectsSubsystem,
  switches: BoardSwitchSubsystem,
  context: RouteContext,
): Promise<ApiResponse> {
  const id = projectId(context);
  const request = await parseBody(context.request, BoardSwitchRequestSchema);
  if (ferretSession(context.actor) !== undefined) throw new ApiError(403, BOARD_SWITCH_OWNER_ONLY, 'owner-only');
  if ((await boards.project(id)) === undefined) throw new ApiError(404, `no board for project ${id}`, 'not-found');
  return jsonResponse(await switches.set(id, request.on));
}

/** A damaged lane document is state this daemon holds and will not serve: 503, never the caller's fault. */
async function guarded(work: () => Promise<ApiResponse>): Promise<ApiResponse> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof LaneSetUnavailableError || error instanceof BoardSwitchUnavailableError)
      throw new ApiError(503, error.message, error.code);
    throw error;
  }
}

/**
 * The board's project list, each project's lanes and whether it uses the board. Project paths are private daemon state, so these
 * are admin-scoped like the project catalog, and no-store because a lane change must show at once.
 */
export function boardProjectRoutes(
  boards: BoardProjectsSubsystem,
  sessions: SessionDirectorySubsystem,
  switches: BoardSwitchSubsystem,
): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/board/projects',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async context => await guarded(() => list(boards, context)),
    },
    {
      method: 'GET',
      path: '/v1/board/projects/:projectId/lanes',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async context => await guarded(() => read(boards, context)),
    },
    {
      method: 'POST',
      path: '/v1/board/projects/:projectId/lanes',
      minimum: 'operator',
      caller: 'any',
      capability: { capability: 'fleet', axis: 'configure' },
      noStore: true,
      handle: async context => await guarded(() => change(boards, sessions, context)),
    },
    {
      method: 'GET',
      path: '/v1/board/projects/:projectId/switch',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async context => await guarded(() => readSwitch(boards, switches, context)),
    },
    {
      method: 'PUT',
      path: '/v1/board/projects/:projectId/switch',
      minimum: 'operator',
      caller: 'any',
      capability: { capability: 'fleet', axis: 'configure' },
      noStore: true,
      handle: async context => await guarded(() => setSwitch(boards, switches, context)),
    },
  ];
}
