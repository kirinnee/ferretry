/**
 * Every MCP server a ferret sees, and checking one (docs/mcp-scopes.md). The domain is
 * `mcp-inventory/`; the wire is `@ferretry/protocol` mcp-inventory.
 *
 * - `GET /v1/mcp` lists the machine: `fleet`/`use`, the same as the component catalogue it extends.
 * - `GET /v1/sessions/:sessionId/mcp/servers` lists one ferret: `filesystem`/`use`, the same as the
 *   project listing beside it, because it reads that ferret's project folder.
 * - `POST /v1/mcp/check` can START A COMMAND (a stdio server), so it is governed as running one:
 *   `terminal`/`use`. A caller who may open a terminal here may run that command anyway; one who may
 *   not, may not have Ferretry run it for them.
 *
 * Sign-in stays where it is (`/v1/fleet/mcp-auth/:component`, docs/mcp-oauth.md): a project server
 * signs in under its subject. `noStore` on all three: every answer is a statement about now.
 */
import { McpCheckRequestSchema } from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { type ApiResponse, decodeParameter } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import type { McpCheckService } from '../../mcp-inventory/check.ts';
import { McpInventoryRefusal, type McpInventoryService } from '../../mcp-inventory/service.ts';

export interface McpInventorySubsystem {
  readonly inventory: Pick<McpInventoryService, 'machine' | 'session'>;
  readonly check: Pick<McpCheckService, 'check'>;
}

function sessionId(context: RouteContext): string {
  const decoded = decodeParameter(context.params.get('sessionId') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the session id in the path is not usable', 'invalid_session_id');
  return decoded;
}

async function answer(work: () => Promise<unknown>): Promise<ApiResponse> {
  try {
    return jsonResponse(await work());
  } catch (error) {
    if (error instanceof McpInventoryRefusal) throw new ApiError(error.status, error.message, error.code);
    throw error;
  }
}

export function mcpInventoryRoutes(subsystem: McpInventorySubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/mcp',
      minimum: 'operator',
      caller: 'any',
      capability: { capability: 'fleet', axis: 'use' },
      noStore: true,
      handle: async () => await answer(() => subsystem.inventory.machine()),
    },
    {
      method: 'POST',
      path: '/v1/mcp/check',
      minimum: 'operator',
      caller: 'any',
      capability: { capability: 'terminal', axis: 'use' },
      noStore: true,
      handle: async context => {
        const request = await parseBody(context.request, McpCheckRequestSchema);
        return await answer(() => subsystem.check.check(request.id, request.sessionId));
      },
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/mcp/servers',
      minimum: 'operator',
      caller: 'any',
      capability: { capability: 'filesystem', axis: 'use' },
      noStore: true,
      handle: async context => {
        const id = sessionId(context);
        return await answer(() => subsystem.inventory.session(id));
      },
    },
  ];
}
