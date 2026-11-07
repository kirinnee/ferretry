import { ApiError, jsonResponse, type RouteHandler } from '@ferretry/kernel/contract';
import { callerIsAgent, parseActor } from '@ferretry/core-gate/contract';
import {
  type BoardProject,
  type BoardProjectId,
  BoardProjectIdSchema,
  type BoardProjectsResponse,
  type BoardSwitch,
  BoardSwitchRequestSchema,
  BOARD_SWITCH_OWNER_ONLY,
  type LaneSetActionRequest,
  LaneSetActionRequestSchema,
  type LaneSetChangeResponse,
} from '../../contract/index.ts';
import { describeLaneSetFailure, type LaneActor, type LaneSetFailure } from '../lib/lanes/index.ts';
import { answer, parseBody, pathParameter, reraiseBoardError } from './http.ts';

/** The board's projects and their lanes, as the routes need them. */
export interface BoardProjectsSubsystem {
  projects(): Promise<readonly BoardProject[]>;
  project(projectId: BoardProjectId): Promise<BoardProject | undefined>;
  projectOf(ferret: string): Promise<BoardProjectId>;
  apply(
    projectId: BoardProjectId,
    request: LaneSetActionRequest,
    actor: LaneActor,
  ): Promise<
    | { readonly ok: true; readonly value: LaneSetChangeResponse }
    | { readonly ok: false; readonly error: LaneSetFailure }
  >;
}

/** Whether each board is used (`docs/board.md` § The board is opt-in): read by anybody, switched by the owner. */
export interface BoardSwitchSubsystem {
  read(projectId: BoardProjectId): Promise<BoardSwitch>;
  set(projectId: BoardProjectId, on: boolean): Promise<BoardSwitch>;
}

/** The ferrets, as the lane routes need them: a name for the record and who started whom. */
export interface LaneRouteFerrets {
  nameOf(ferret: string): Promise<string>;
  /** The refusal a helper reads for an edit of the lanes, or `null` when it is a lead. */
  helperRefusal(ferret: string): Promise<string | null>;
}

const FAILURE_STATUS: Readonly<Record<LaneSetFailure['code'], number>> = {
  'not-found': 404,
  'unknown-lane': 400,
  'relocation-missing': 400,
  'owner-gate': 403,
  'version-conflict': 409,
  'already-confirmed': 409,
  'no-lane-set': 409,
  'owner-only': 403,
  'proposal-waiting': 409,
};

type Call = Parameters<RouteHandler>[0];

/**
 * The ferret behind an AGENT caller, or `undefined` for a person. Who is an agent is the one class predicate's answer
 * (`callerIsAgent`); an agent with no ferret to name (a bare warden) is refused, never taken for the owner.
 */
const ferretOf = (call: Call): string | undefined => {
  if (!callerIsAgent(call.credential, call.actor)) return undefined;
  if (call.credential?.tokenClass === 'ferret') return call.credential.ferret;
  const { kind, id } = parseActor(call.actor ?? '');
  if (kind !== 'ferret' || id === undefined || id.trim() === '')
    throw new ApiError(403, 'an agent acts on the board only from its own ferret', 'forbidden');
  return id;
};

const laneActor = async (call: Call, ferrets: LaneRouteFerrets): Promise<LaneActor> => {
  const ferret = ferretOf(call);
  // The admin token with no ferret's credential is the owner's authority, RECORDED as the token.
  if (ferret === undefined)
    return call.credential?.tokenClass === 'admin' ? { kind: 'owner', via: 'admin-token' } : { kind: 'owner' };
  return { kind: 'ferret', name: await ferrets.nameOf(ferret), ferretId: ferret } as LaneActor;
};

const projectId = (call: Call): BoardProjectId => {
  const parsed = BoardProjectIdSchema.safeParse(pathParameter(call, 'projectId', 'project id'));
  if (!parsed.success) throw new ApiError(400, 'the project id in the path is not usable', 'invalid_project_id');
  return parsed.data;
};

/**
 * The board's project list, each project's lanes and whether it uses the board. Project paths are private daemon state,
 * so these are operator-scoped like the project registry, and no-store because a lane change must show at once.
 */
export function boardProjectRoutes(
  boards: BoardProjectsSubsystem,
  switches: BoardSwitchSubsystem,
  ferrets: LaneRouteFerrets,
): {
  readonly 'GET /v1/board/projects': RouteHandler;
  readonly 'GET /v1/board/projects/:projectId/lanes': RouteHandler;
  readonly 'POST /v1/board/projects/:projectId/lanes': RouteHandler;
  readonly 'GET /v1/board/projects/:projectId/switch': RouteHandler;
  readonly 'PUT /v1/board/projects/:projectId/switch': RouteHandler;
} {
  const known = async (id: BoardProjectId): Promise<void> => {
    if ((await boards.project(id)) === undefined) throw new ApiError(404, `no board for project ${id}`, 'not-found');
  };
  return {
    'GET /v1/board/projects': async call =>
      await answer(async () => {
        const ferret = ferretOf(call);
        const current = ferret === undefined ? null : await boards.projectOf(ferret);
        const body: BoardProjectsResponse = { projects: [...(await boards.projects())], current };
        return body;
      }),
    'GET /v1/board/projects/:projectId/lanes': async call =>
      await answer(async () => {
        const id = projectId(call);
        const board = await boards.project(id);
        if (board === undefined) throw new ApiError(404, `no board for project ${id}`, 'not-found');
        return board;
      }),
    'POST /v1/board/projects/:projectId/lanes': async call => {
      const id = projectId(call);
      const request = await parseBody(call, LaneSetActionRequestSchema);
      const caller = ferretOf(call);
      if (caller !== undefined) {
        const refusal = await ferrets.helperRefusal(caller);
        if (refusal !== null) throw new ApiError(403, refusal, 'helper');
      }
      return await answer(async () => {
        const result = await boards.apply(id, request, await laneActor(call, ferrets));
        if (result.ok) return result.value;
        throw new ApiError(FAILURE_STATUS[result.error.code], describeLaneSetFailure(result.error), result.error.code);
      });
    },
    'GET /v1/board/projects/:projectId/switch': async call =>
      await answer(async () => {
        const id = projectId(call);
        await known(id);
        return await switches.read(id);
      }),
    'PUT /v1/board/projects/:projectId/switch': async call => {
      const id = projectId(call);
      const request = await parseBody(call, BoardSwitchRequestSchema);
      if (callerIsAgent(call.credential, call.actor)) throw new ApiError(403, BOARD_SWITCH_OWNER_ONLY, 'owner-only');
      return await answer(async () => {
        await known(id);
        return await switches.set(id, request.on);
      });
    },
  };
}

export { jsonResponse, reraiseBoardError };
