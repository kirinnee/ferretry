/**
 * Adding an MCP server for one ferret: `/v1/sessions/:sessionId/mcp`. The domain is
 * `session-mcp/service.ts`; the wire is `@ferretry/protocol` session-mcp.
 *
 * ONE ROUTE PER SCOPE, because a route declares exactly one capability and the two scopes are governed
 * by different ones:
 *
 * - the PROJECT file is a write into the person's repository, so reading it is `filesystem.use` and
 *   writing it is `filesystem.configure` — the step-up a governed caller needs comes with that axis;
 * - the LOGIN is the fleet, so its preview is `fleet.use` and its add is `fleet.configure`, applied
 *   through the same reviewed-change path `fleet-catalog.ts` serves, under the caller's governance.
 *
 * The deeper `preview` paths are registered before the scope paths and those before the bare `mcp`
 * read, so no pattern can shadow another. `noStore` on all five: every answer is a statement about a
 * file or a profile as it is right now.
 */
import {
  type SessionMcpAdded,
  type SessionMcpAddRequest,
  SessionMcpAddRequestSchema,
  type SessionMcpListing,
  type SessionMcpPreview,
  type SessionMcpPreviewRequest,
  SessionMcpPreviewRequestSchema,
} from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import type { CallerGovernance } from '../../api/capability.ts';
import { isAgentCaller } from '../../api/agent-caller.ts';
import { ApiError } from '../../api/error.ts';
import { type ApiResponse, decodeParameter } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { FleetCatalogRefusal, type FreshStepUpContext } from '../../fleet/catalog-service.ts';
import { SessionMcpRefusal, SessionMcpService, type SessionMcpServiceDeps } from '../../session-mcp/service.ts';

/** The five acts, from the parsed request to the answer the caller sees. */
export interface SessionMcpSubsystem {
  list(sessionId: string): Promise<SessionMcpListing>;
  previewProject(sessionId: string, request: SessionMcpPreviewRequest): Promise<SessionMcpPreview>;
  addProject(sessionId: string, request: SessionMcpAddRequest): Promise<SessionMcpAdded>;
  previewLogin(sessionId: string, request: SessionMcpPreviewRequest): Promise<SessionMcpPreview>;
  addLogin(
    sessionId: string,
    request: SessionMcpPreviewRequest,
    governance: CallerGovernance | undefined,
    freshStepUp: FreshStepUpContext,
  ): Promise<SessionMcpAdded>;
}

const FILESYSTEM_USE = { capability: 'filesystem', axis: 'use' } as const;
const FILESYSTEM_CONFIGURE = { capability: 'filesystem', axis: 'configure' } as const;
const FLEET_USE = { capability: 'fleet', axis: 'use' } as const;
const FLEET_CONFIGURE = { capability: 'fleet', axis: 'configure' } as const;

function sessionId(context: RouteContext): string {
  const decoded = decodeParameter(context.params.get('sessionId') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the session id in the path is not usable', 'invalid_session_id');
  return decoded;
}

/** Restates a refusal in the HTTP vocabulary: the domain's own, or the fleet's as `fleet-catalog.ts` answers it. */
function refuse(error: unknown): never {
  if (error instanceof SessionMcpRefusal) throw new ApiError(error.status, error.message, error.code);
  if (error instanceof FleetCatalogRefusal)
    throw new ApiError(error.code === 'fleet_change_unknown' ? 404 : 409, error.message, error.code);
  throw error;
}

async function answer(work: () => Promise<unknown>): Promise<ApiResponse> {
  return jsonResponse(await work().catch(refuse));
}

/** This subsystem's route table. */
export function sessionMcpRoutes(subsystem: SessionMcpSubsystem): readonly ApiRoute[] {
  return [
    {
      // A read with a body: it reads the file and writes nothing, so it is `use`.
      method: 'POST',
      path: '/v1/sessions/:sessionId/mcp/project/preview',
      minimum: 'operator',
      caller: 'any',
      capability: FILESYSTEM_USE,
      noStore: true,
      handle: async context => {
        const id = sessionId(context);
        const request = await parseBody(context.request, SessionMcpPreviewRequestSchema);
        return await answer(() => subsystem.previewProject(id, request));
      },
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/mcp/login/preview',
      minimum: 'operator',
      caller: 'any',
      capability: FLEET_USE,
      noStore: true,
      handle: async context => {
        const id = sessionId(context);
        const request = await parseBody(context.request, SessionMcpPreviewRequestSchema);
        return await answer(() => subsystem.previewLogin(id, request));
      },
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/mcp/project',
      minimum: 'operator',
      caller: 'any',
      capability: FILESYSTEM_CONFIGURE,
      noStore: true,
      handle: async context => {
        const id = sessionId(context);
        const request = await parseBody(context.request, SessionMcpAddRequestSchema);
        return await answer(() => subsystem.addProject(id, request));
      },
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/mcp/login',
      minimum: 'operator',
      caller: 'person',
      capability: FLEET_CONFIGURE,
      noStore: true,
      handle: async context => {
        const id = sessionId(context);
        const request = await parseBody(context.request, SessionMcpPreviewRequestSchema);
        return await answer(() =>
          subsystem.addLogin(id, request, context.governance, {
            presentation: context.presentation,
            spend: () => context.spendFreshStepUp?.(),
            agent: isAgentCaller(context),
          }),
        );
      },
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/mcp',
      minimum: 'operator',
      caller: 'any',
      capability: FILESYSTEM_USE,
      noStore: true,
      handle: async context => {
        const id = sessionId(context);
        return await answer(() => subsystem.list(id));
      },
    },
  ];
}

/** Builds the subsystem the composition root mounts. */
export function createSessionMcpSubsystem(deps: SessionMcpServiceDeps): SessionMcpSubsystem {
  return new SessionMcpService(deps);
}
