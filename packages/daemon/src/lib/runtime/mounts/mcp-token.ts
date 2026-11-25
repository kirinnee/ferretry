/**
 * A running ferret asking for the current token behind one of its own MCP sign-in variables:
 * `POST /v1/sessions/:sessionId/mcp/token` (docs/mcp-oauth.md › A ferret that outlives its token). The domain is
 * `mcp-inventory/ferret-token.ts`; the wire is `@ferretry/protocol` mcp-oauth.
 *
 * ONLY THE FERRET ITSELF. The route is governed as `secrets.use` — it hands out a credential — but that is a gate
 * on a device, and no device may ask for a ferret's token: the handler requires the CALLER to hold the SESSION credential of the ferret
 * the path names — not the admin token with an `x-ferretry-session-id` header, which any holder of that token can write. A person, a warden and another ferret all get a 403, so the one thing this adds to
 * what a ferret could already read from its own environment is the same token, renewed.
 *
 * `noStore`: every answer is a bearer token. The security log records the session and the variable NAME
 * (`mcp.ts`), never the token.
 */
import { McpTokenRequestSchema } from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import type { CapabilityDemand } from '../../api/capability.ts';
import { ApiError } from '../../api/error.ts';
import { decodeParameter } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import type { FerretMcpTokens } from '../../mcp-inventory/ferret-token.ts';
import { McpInventoryRefusal } from '../../mcp-inventory/service.ts';

export interface McpTokenSubsystem {
  readonly tokens: Pick<FerretMcpTokens, 'headers'>;
}

const SECRETS_USE: CapabilityDemand = { capability: 'secrets', axis: 'use' };

function sessionId(context: RouteContext): string {
  const decoded = decodeParameter(context.params.get('sessionId') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the session id in the path is not usable', 'invalid_session_id');
  return decoded;
}

export function mcpTokenRoutes(subsystem: McpTokenSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/mcp/token',
      minimum: 'operator',
      caller: 'any',
      capability: SECRETS_USE,
      noStore: true,
      handle: async context => {
        const id = sessionId(context);
        if (context.credential?.tokenClass !== 'session' || context.credential.sessionId !== id)
          throw new ApiError(
            403,
            'only the ferret itself may ask for its MCP sign-in token; a person or another ferret signs in through Ferretry instead',
            'not_this_ferret',
          );
        const request = await parseBody(context.request, McpTokenRequestSchema);
        try {
          return jsonResponse(await subsystem.tokens.headers(id, request.variable));
        } catch (error) {
          if (error instanceof McpInventoryRefusal) throw new ApiError(error.status, error.message, error.code);
          throw error;
        }
      },
    },
  ];
}
