/**
 * The `agentTools` module's route contract: who may call each of its routes, and which of its mutating routes the
 * security log deliberately does not record from the route layer. See the README at the top of `../route-contracts.ts`.
 *
 * It has no rule in its `contributes.audit`: the agent-tools service writes the security log itself, and the pin
 * routes record the owner's own preference or a bookmark.
 */
export const callers: readonly string[] = [
  'GET /v1/sessions/:sessionId/pins operator any',
  'GET /v1/sessions/:sessionId/surfaces/browser/control operator any',
  'GET /v1/sessions/:sessionId/surfaces/terminals/control operator any',
  'POST /v1/agent/tools none any',
  'POST /v1/sessions/:sessionId/pin operator person',
  'POST /v1/sessions/:sessionId/pins operator any',
  'POST /v1/sessions/:sessionId/surfaces/browser/control operator person',
  'POST /v1/sessions/:sessionId/surfaces/browser/tools operator person',
  'POST /v1/sessions/:sessionId/surfaces/terminals/control operator person',
  'POST /v1/sessions/:sessionId/surfaces/terminals/tools operator person',
  'POST /v1/sessions/:sessionId/unpin operator person',
];

export const notAudited: Readonly<Record<string, string>> = {
  'POST /v1/sessions/:sessionId/pins': 'a bookmark in a transcript',
  'POST /v1/sessions/:sessionId/pin': "the owner's own sidebar preference; it widens nobody's access",
  'POST /v1/sessions/:sessionId/unpin': "the owner's own sidebar preference; it widens nobody's access",
  // The agent tools are audited MORE finely than this table can: a route rule may read a path parameter
  // and response names, never the body, and what matters here — which tool, on which named surface,
  // how much was typed — is in the body. `AgentToolService` writes one `agent.tool` record per call and
  // one `surface.control` record per takeover or hand back itself, refusals included.
  'POST /v1/agent/tools': 'audited per call by the agent-tools service: tool, surface name and lengths',
  'POST /v1/sessions/:sessionId/surfaces/terminals/tools':
    'audited per call by the agent-tools service: tool, surface name and lengths',
  'POST /v1/sessions/:sessionId/surfaces/browser/tools':
    'audited per call by the agent-tools service: tool, surface name and lengths',
  'POST /v1/sessions/:sessionId/surfaces/terminals/control':
    'audited per takeover and hand back by the agent-tools service',
  'POST /v1/sessions/:sessionId/surfaces/browser/control':
    'audited per takeover and hand back by the agent-tools service',
};
