/**
 * The dials behind Context › MCP and Skills, and the Components page's MCP status: every MCP server and
 * skill a ferret sees, from every scope, checking one server, and reading one SKILL.md
 * (docs/mcp-scopes.md; the skills half is `GET /v1/sessions/:id/skills/inventory`).
 *
 * Every wire shape is the shared one from `@ferretry/protocol`, parsed on the way in, so a body this page
 * cannot read fails at the call rather than as a blank row. Signing in is not here: it is the sign-in
 * routes in `../fleet/mcp-auth-api.ts`, which take a server's `signIn.subject` — a component's name, or
 * a project server's `<name>..<project key>`.
 */

import {
  type IFyApiClient,
  MCP_CHECK_PATH,
  MCP_INVENTORY_PATH,
  McpCheckRequestSchema,
  type McpCheckResult,
  McpCheckResultSchema,
  type McpInventory,
  McpInventorySchema,
  type SessionSkillsInventory,
  SessionSkillsInventorySchema,
  type SkillFile,
  SkillFileSchema,
} from '@ferretry/protocol';

/** The one client capability these dials use. Bound to one machine by the caller. */
export type ToolsClient = Pick<IFyApiClient, 'request'>;

const signalled = (signal: AbortSignal | undefined): RequestInit => (signal === undefined ? {} : { signal });

/** Every MCP server one ferret sees. */
export const readSessionMcpServers = async (
  client: ToolsClient,
  sessionId: string,
  signal?: AbortSignal,
): Promise<McpInventory> =>
  await client.request(
    `/v1/sessions/${encodeURIComponent(sessionId)}/mcp/servers`,
    McpInventorySchema,
    signalled(signal),
  );

/** Every MCP server on the machine, once each, with every runtime that sees it. */
export const readMachineMcpServers = async (client: ToolsClient, signal?: AbortSignal): Promise<McpInventory> =>
  await client.request(MCP_INVENTORY_PATH, McpInventorySchema, signalled(signal));

/**
 * Connects to one server from a listing and lists its tools. With `sessionId`, as that ferret reaches it.
 * A server that does not connect is an ANSWER (`outcome`), not a thrown error: only a refused or broken
 * request throws.
 */
export const checkMcpServer = async (client: ToolsClient, id: string, sessionId?: string): Promise<McpCheckResult> =>
  await client.request(MCP_CHECK_PATH, McpCheckResultSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(McpCheckRequestSchema.parse({ id, ...(sessionId === undefined ? {} : { sessionId }) })),
  });

/** Every skill one ferret sees, with where each comes from and which one wins a name. */
export const readSessionSkillsInventory = async (
  client: ToolsClient,
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionSkillsInventory> =>
  await client.request(
    `/v1/sessions/${encodeURIComponent(sessionId)}/skills/inventory`,
    SessionSkillsInventorySchema,
    signalled(signal),
  );

/** One listed skill's SKILL.md, read for Open. The daemon serves only a path its inventory lists. */
export const readSkillFile = async (
  client: ToolsClient,
  path: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<SkillFile> =>
  await client.request(
    `/v1/skills/file?path=${encodeURIComponent(path)}&sessionId=${encodeURIComponent(sessionId)}`,
    SkillFileSchema,
    signalled(signal),
  );
