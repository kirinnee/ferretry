import type { ApiRoute } from '../../api/route.ts';
import type { AuditedRouteRule } from '../../audit/routes.ts';
import type { ModuleContribution } from '../modules.ts';
import { type McpInventorySubsystem, mcpInventoryRoutes } from './mcp-inventory.ts';
import { type McpOAuthSubsystem, mcpOAuthRoutes } from './mcp-oauth.ts';
import { type SessionMcpSubsystem, sessionMcpRoutes } from './session-mcp.ts';

/**
 * The security log's rules for the three MCP surfaces. Signing in to (and out of) a remote server records the
 * component NAME and the flow id, never an address or a token (docs/mcp-oauth.md). Adding a server for one ferret
 * (`./session-mcp.ts`) records the session and the server's NAME, never its command, address or environment: both
 * change what agents launch with, the project file for everyone on the repository and the login for every ferret on
 * it, so both are recorded as fleet configuration, told apart by `scope`. The inventory reads and the previews write
 * nothing, so they have no rule.
 */
const MCP_AUDIT_RULES: readonly AuditedRouteRule[] = [
  // MCP sign-in (docs/mcp-oauth.md): the component NAME and the flow id, never an address or a token.
  {
    method: 'POST',
    path: '/v1/fleet/mcp-auth/:component',
    event: 'fleet.configured',
    subject: 'component',
    detail: { action: 'mcp-sign-in' },
  },
  {
    method: 'POST',
    path: '/v1/fleet/mcp-auth/flows/:flowId',
    event: 'fleet.configured',
    subject: 'flowId',
    responseNames: 'component',
    detail: { action: 'mcp-sign-in-finish' },
  },
  {
    method: 'DELETE',
    path: '/v1/fleet/mcp-auth/flows/:flowId',
    event: 'fleet.configured',
    subject: 'flowId',
    detail: { action: 'mcp-sign-in-cancel' },
  },
  {
    method: 'DELETE',
    path: '/v1/fleet/mcp-auth/:component',
    event: 'fleet.configured',
    subject: 'component',
    detail: { action: 'mcp-sign-out' },
  },
  // Adding an MCP server for one ferret (`mounts/session-mcp.ts`): the session and the server's NAME, never
  // its command, address or environment. Both change what agents launch with, the project file for
  // everyone on the repository and the login for every ferret on it, so both are recorded as fleet
  // configuration, told apart by `scope`.
  {
    method: 'POST',
    path: '/v1/sessions/:sessionId/mcp/project',
    event: 'fleet.configured',
    subject: 'sessionId',
    responseNames: 'name',
    detail: { action: 'mcp-add', scope: 'project' },
  },
  {
    method: 'POST',
    path: '/v1/sessions/:sessionId/mcp/login',
    event: 'fleet.configured',
    subject: 'sessionId',
    responseNames: 'name',
    detail: { action: 'mcp-add', scope: 'login' },
  },
];

/** The three subsystems the MCP module serves. */
export interface McpSubsystems {
  readonly oauth: McpOAuthSubsystem;
  readonly inventory: McpInventorySubsystem;
  readonly sessionMcp: SessionMcpSubsystem;
}

/** The routes of the three MCP surfaces, in the order they sat in the legacy table. */
function mcpRoutes(subsystems: McpSubsystems): readonly ApiRoute[] {
  return [
    ...mcpOAuthRoutes(subsystems.oauth),
    // `/v1/mcp` and `/v1/mcp/check` are fixed literals no other route uses; the per-session list ends in
    // `mcp/servers`, a literal pair the session MCP routes below do not use, so none can shadow another.
    ...mcpInventoryRoutes(subsystems.inventory),
    // Every path ends in literals under `mcp`, which no other route uses, and the subsystem registers its
    // deeper `preview` paths before the shallower ones itself, so none can shadow or be shadowed.
    ...sessionMcpRoutes(subsystems.sessionMcp),
  ];
}

/**
 * What the mcp module adds to the daemon: the sign-in routes, the inventory routes and the session MCP routes, and the
 * six audit rules for the ones that write. It claims no protocol feature.
 */
export function mcpContribution(subsystems: McpSubsystems): ModuleContribution {
  return { routes: mcpRoutes(subsystems), audit: { routes: MCP_AUDIT_RULES } };
}
