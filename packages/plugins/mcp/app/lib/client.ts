/**
 * MCP's wire, through the one generated client this half is given (§9.6): every call is `client.call(routeKey, init)` and
 * every answer is parsed with the contract's own schema, so a body this half cannot read fails at the call rather than as
 * a blank row. No code here holds a base URL, a token or a fetch.
 *
 * NOTHING HERE HOLDS A TOKEN (docs/mcp-oauth.md). One value comes out that a person acts on — the provider's authorization
 * link — and exactly one goes in that matters: the address the provider sent the browser back to, which carries an
 * authorization code the daemon redeems with a verifier only it holds. It travels in a request BODY, is answered with
 * nothing that repeats it, and the caller drops it before the promise settles. The contract has no field that could carry
 * a token either way.
 */
import type { PluginClient } from '@ferretry/kernel/manifest';
import {
  McpCheckRequestSchema,
  type McpCheckResult,
  McpCheckResultSchema,
  type McpInventory,
  McpInventorySchema,
  type McpOAuthCompletion,
  McpOAuthCompleteRequestSchema,
  McpOAuthCompletionSchema,
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
} from '../../contract/index.ts';

/** The slice of the per-daemon client this half uses; a test hands a scripted one. */
export type McpClient = Pick<PluginClient, 'call'>;

const FERRET_SERVERS_ROUTE = 'GET /v1/ferrets/:ferretId/mcp/servers' as const;
const MACHINE_SERVERS_ROUTE = 'GET /v1/mcp' as const;
const CHECK_ROUTE = 'POST /v1/mcp/check' as const;
const SIGN_INS_ROUTE = 'GET /v1/mcp/auth' as const;
const START_ROUTE = 'POST /v1/mcp/auth/:component' as const;
const SIGN_OUT_ROUTE = 'DELETE /v1/mcp/auth/:component' as const;
const FINISH_ROUTE = 'POST /v1/mcp/auth/flows/:flowId' as const;
const CANCEL_ROUTE = 'DELETE /v1/mcp/auth/flows/:flowId' as const;

/** Every MCP server one ferret sees, from every scope. */
export const readFerretMcpServers = async (client: McpClient, ferretId: string): Promise<McpInventory> =>
  McpInventorySchema.parse(await client.call(FERRET_SERVERS_ROUTE, { params: { ferretId } }));

/** Every MCP server on the machine, once each, with every runtime that sees it. */
export const readMachineMcpServers = async (client: McpClient): Promise<McpInventory> =>
  McpInventorySchema.parse(await client.call(MACHINE_SERVERS_ROUTE));

/**
 * Connects to one server from a listing and lists its tools. With `ferretId`, as that ferret reaches it. A server that
 * does not connect is an ANSWER (`outcome`), not a thrown error: only a refused or broken request throws.
 */
export const checkMcpServer = async (client: McpClient, id: string, ferretId?: string): Promise<McpCheckResult> =>
  McpCheckResultSchema.parse(
    await client.call(CHECK_ROUTE, {
      // The contract keeps today's field name; it holds a ferret id.
      body: McpCheckRequestSchema.parse({ id, ...(ferretId === undefined ? {} : { sessionId: ferretId }) }),
    }),
  );

/** Where every `auth: oauth` server on this machine stands. */
export const readMcpSignIns = async (client: McpClient): Promise<McpOAuthConnectionList> =>
  McpOAuthConnectionListSchema.parse(await client.call(SIGN_INS_ROUTE));

/**
 * Starts signing one MCP server in. `redirectUri` is this app's own callback page; leaving it out asks the daemon for the
 * paste way, where the provider sends the browser to a loopback page that fails to load.
 */
export const startMcpSignIn = async (
  client: McpClient,
  component: string,
  request: McpOAuthStartRequest,
): Promise<McpOAuthFlow> =>
  McpOAuthFlowSchema.parse(
    await client.call(START_ROUTE, { params: { component }, body: McpOAuthStartRequestSchema.parse(request) }),
  );

/**
 * Hands the daemon the address the provider sent the browser back to. WRITE-ONLY AND SINGLE-USE: it holds an
 * authorization code, so it goes in a body, and a refusal comes back as a sentence about the KIND of thing sent.
 */
export const finishMcpSignIn = async (
  client: McpClient,
  flowId: string,
  callback: string,
): Promise<McpOAuthCompletion> =>
  McpOAuthCompletionSchema.parse(
    await client.call(FINISH_ROUTE, { params: { flowId }, body: McpOAuthCompleteRequestSchema.parse({ callback }) }),
  );

/** Ends one sign-in that has not finished. `cancelled: false` means there was nothing left to end. */
export const cancelMcpSignIn = async (client: McpClient, flowId: string): Promise<McpOAuthFlowCancelled> =>
  McpOAuthFlowCancelledSchema.parse(await client.call(CANCEL_ROUTE, { params: { flowId } }));

/** Deletes one server's stored tokens, asking the provider to revoke them when it can. */
export const signOutMcp = async (client: McpClient, component: string): Promise<McpOAuthSignedOut> =>
  McpOAuthSignedOutSchema.parse(await client.call(SIGN_OUT_ROUTE, { params: { component } }));
