/**
 * The `mcp` module's route contract: who may call each of its routes, and which of its mutating routes the security
 * log deliberately does not record. See the README at the top of `../route-contracts.ts`.
 *
 * The sign-in routes and the two adds (a project's `.mcp.json`, a login's profile) each have a rule in the module's
 * `contributes.audit`; the checks and the previews write nothing, so they are the only entries below.
 */
export const callers: readonly string[] = [
  'DELETE /v1/fleet/mcp-auth/:component operator person',
  'DELETE /v1/fleet/mcp-auth/flows/:flowId operator person',
  'GET /v1/fleet/mcp-auth operator any',
  'GET /v1/mcp operator any',
  'GET /v1/sessions/:sessionId/mcp operator any',
  'GET /v1/sessions/:sessionId/mcp/servers operator any',
  'POST /v1/fleet/mcp-auth/:component operator person',
  'POST /v1/fleet/mcp-auth/flows/:flowId operator person',
  'POST /v1/mcp/check operator any',
  'POST /v1/sessions/:sessionId/mcp/login operator person',
  'POST /v1/sessions/:sessionId/mcp/login/preview operator any',
  'POST /v1/sessions/:sessionId/mcp/project operator any',
  'POST /v1/sessions/:sessionId/mcp/project/preview operator any',
];

export const notAudited: Readonly<Record<string, string>> = {
  'POST /v1/mcp/check':
    'a read with a body: opens and closes one MCP session to list its tools; changes no configuration and grants nobody anything',
  'POST /v1/sessions/:sessionId/mcp/project/preview':
    'a read with a body: previews a .mcp.json change and writes nothing; the add is audited',
  'POST /v1/sessions/:sessionId/mcp/login/preview':
    'a read with a body: previews a login MCP add and writes nothing; the add is audited',
};
