/**
 * The routes a browser signs in to a remote MCP server through (`docs/mcp-oauth.md`).
 *
 * ## `fleet.configure` for every act, `fleet.use` for the read
 *
 * Starting and finishing a sign-in binds this fleet to an account at a provider — every agent that uses
 * the server then acts as whoever signed in. That is the account-substitution risk the harness sign-in
 * carries, so it takes the same gate: `fleet`/`configure`, which a caller off this host passes only
 * behind the passkey unlock, and a relayed caller is off this host by the carrier rule. Signing out and
 * cancelling are configure too: they change what every runtime can reach.
 *
 * The status read is `fleet.use`: it says THAT a component is signed in and until when, never with what.
 *
 * ## The callback address travels in a body
 *
 * It carries an authorization code, so it is POSTed rather than put in a path or a query a proxy would
 * log, and the audit rule for the route reads only the flow id from the path and the component NAME
 * from the answer.
 *
 * ## `noStore` on all five
 *
 * A flow's authorization URL is a sign-in somebody is in the middle of; a cached status is a lie about
 * an expiry.
 */
import {
  McpOAuthCompleteRequestSchema,
  McpOAuthCompletionSchema,
  McpOAuthConnectionListSchema,
  McpOAuthFlowCancelledSchema,
  McpOAuthFlowSchema,
  McpOAuthSignedOutSchema,
  McpOAuthStartRequestSchema,
} from '@ferretry/protocol';
import type { z } from 'zod';
import { parseBody, parseOptionalBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { decodeParameter } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { McpOAuthRefusal, type McpOAuthService } from '../../mcp-oauth/service.ts';

export type McpOAuthSubsystem = Pick<McpOAuthService, 'connections' | 'start' | 'complete' | 'cancel' | 'signOut'>;

/** `404` for a component or flow that is not there; `409` for every other refusal. */
function refusal(error: McpOAuthRefusal): ApiError {
  const missing = error.code === 'mcp_auth_unknown_component' || error.code === 'mcp_auth_unknown_flow';
  return new ApiError(missing ? 404 : 409, error.message, error.code);
}

async function respondWith<Schema extends z.ZodType>(schema: Schema, work: () => Promise<unknown>) {
  try {
    return jsonResponse(schema.parse(await work()));
  } catch (error) {
    if (error instanceof McpOAuthRefusal) throw refusal(error);
    throw error;
  }
}

function parameter(context: RouteContext, name: string, what: string): string {
  const value = decodeParameter(context.params.get(name) ?? '') ?? '';
  if (value === '') throw new ApiError(400, `the ${what} in the path is not usable`, 'bad_request');
  return value;
}

const CONFIGURE = { capability: 'fleet', axis: 'configure' } as const;

export function mcpOAuthRoutes(subsystem: McpOAuthSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/fleet/mcp-auth',
      neverCompress: true,
      minimum: 'operator',
      capability: { capability: 'fleet', axis: 'use' },
      noStore: true,
      handle: async () =>
        await respondWith(McpOAuthConnectionListSchema, async () => ({ connections: await subsystem.connections() })),
    },
    {
      method: 'POST',
      path: '/v1/fleet/mcp-auth/:component',
      minimum: 'operator',
      capability: CONFIGURE,
      noStore: true,
      handle: async context =>
        await respondWith(McpOAuthFlowSchema, async () =>
          subsystem.start(
            parameter(context, 'component', 'server name'),
            await parseOptionalBody(context.request, McpOAuthStartRequestSchema),
          ),
        ),
    },
    {
      method: 'DELETE',
      path: '/v1/fleet/mcp-auth/:component',
      minimum: 'operator',
      capability: CONFIGURE,
      noStore: true,
      handle: async context =>
        await respondWith(McpOAuthSignedOutSchema, () =>
          subsystem.signOut(parameter(context, 'component', 'server name')),
        ),
    },
    {
      method: 'POST',
      path: '/v1/fleet/mcp-auth/flows/:flowId',
      minimum: 'operator',
      capability: CONFIGURE,
      noStore: true,
      handle: async context =>
        await respondWith(McpOAuthCompletionSchema, async () =>
          subsystem.complete(
            parameter(context, 'flowId', 'sign-in id'),
            await parseBody(context.request, McpOAuthCompleteRequestSchema),
          ),
        ),
    },
    {
      method: 'DELETE',
      path: '/v1/fleet/mcp-auth/flows/:flowId',
      minimum: 'operator',
      capability: CONFIGURE,
      noStore: true,
      handle: async context =>
        await respondWith(McpOAuthFlowCancelledSchema, async () =>
          subsystem.cancel(parameter(context, 'flowId', 'sign-in id')),
        ),
    },
  ];
}
