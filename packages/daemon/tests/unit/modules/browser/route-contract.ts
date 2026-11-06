/**
 * The `browser` module's route contract: who may call each of its routes, and which of its mutating routes the
 * security log deliberately does not record from the route layer. See the README at the top of `../route-contracts.ts`.
 *
 * Every mutating route of the module has a rule in its `contributes.audit` (the sign-in window, a proxy test, taking
 * control of a session's browser, and the browser stream socket), so nothing needs listing in `notAudited`.
 */
export const callers: readonly string[] = [
  'GET /v1/browser/login operator person',
  'GET /v1/browser/state operator any',
  'GET /v1/sessions/:sessionId/browser operator any',
  'GET /v1/sessions/:sessionId/browser/stream operator any',
  'POST /v1/browser/login operator person',
  'POST /v1/browser/proxy/test operator person',
  'POST /v1/sessions/:sessionId/browser operator any',
];

export const notAudited: Readonly<Record<string, string>> = {};
