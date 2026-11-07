/**
 * The browser's half of signing in to a remote MCP server (docs/mcp-oauth.md), with the daemon as the
 * OAuth client.
 *
 * NOTHING HERE HOLDS A TOKEN. One value comes out that a person acts on — the provider's authorization
 * link — and exactly one goes in that matters: the address the provider sent the browser back to, which
 * carries an authorization code the daemon redeems with a verifier only it holds. That address travels
 * in a request BODY, is answered with nothing that repeats it, and the caller is expected to drop it
 * before the promise settles. The shared contract has no field that could carry a token either way.
 *
 * EVERY WIRE SHAPE IS THE SHARED ONE, from `@ferretry/protocol`, so a value the daemon would refuse fails
 * here, at the call, rather than as a 400 a person reads as a broken sheet.
 *
 * Every call takes a connection-bound client: a fleet belongs to a MACHINE and this browser can be paired
 * to several, so nothing is cached at module scope.
 */

import {
  MCP_OAUTH_PATH,
  type McpOAuthCompletion,
  McpOAuthCompletionSchema,
  McpOAuthCompleteRequestSchema,
  type McpOAuthConnectionList,
  McpOAuthConnectionListSchema,
  type McpOAuthFlow,
  type McpOAuthFlowCancelled,
  McpOAuthFlowCancelledSchema,
  McpOAuthFlowSchema,
  type McpOAuthSignedOut,
  McpOAuthSignedOutSchema,
  type McpOAuthStartRequest,
  McpOAuthStartRequestSchema,
} from '@ferretry/protocol';
import type { FleetClient } from './fleet-client.ts';

const componentPath = (component: string): string => `${MCP_OAUTH_PATH}/${encodeURIComponent(component)}`;
const flowPath = (flowId: string): string => `${MCP_OAUTH_PATH}/flows/${encodeURIComponent(flowId)}`;

/** Where every `auth: oauth` server on this machine stands. */
export const readMcpSignIns = async (client: FleetClient): Promise<McpOAuthConnectionList> =>
  await client.request(MCP_OAUTH_PATH, McpOAuthConnectionListSchema);

/**
 * Starts signing one MCP component in. `redirectUri` is this PWA's own callback page; leaving it out asks
 * the daemon for the paste way, where the provider sends the browser to a loopback page that fails to load.
 */
export const startMcpSignIn = async (
  client: FleetClient,
  component: string,
  request: McpOAuthStartRequest,
): Promise<McpOAuthFlow> =>
  await client.request(componentPath(component), McpOAuthFlowSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(McpOAuthStartRequestSchema.parse(request)),
  });

/**
 * Hands the daemon the address the provider sent the browser back to.
 *
 * WRITE-ONLY AND SINGLE-USE. It holds an authorization code, so it goes in a body — a query string reaches
 * every proxy's access log — and a refusal comes back as a sentence about the KIND of thing sent, never
 * quoting it.
 */
export const finishMcpSignIn = async (
  client: FleetClient,
  flowId: string,
  callback: string,
): Promise<McpOAuthCompletion> =>
  await client.request(flowPath(flowId), McpOAuthCompletionSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(McpOAuthCompleteRequestSchema.parse({ callback })),
  });

/** Ends one sign-in that has not finished. `cancelled: false` means there was nothing left to end. */
export const cancelMcpSignIn = async (client: FleetClient, flowId: string): Promise<McpOAuthFlowCancelled> =>
  await client.request(flowPath(flowId), McpOAuthFlowCancelledSchema, { method: 'DELETE' });

/** Deletes one component's stored tokens, asking the provider to revoke them when it can. */
export const signOutMcp = async (client: FleetClient, component: string): Promise<McpOAuthSignedOut> =>
  await client.request(componentPath(component), McpOAuthSignedOutSchema, { method: 'DELETE' });
