/**
 * The `session-handover` module's route contract: who may call its routes, and which of its mutating routes the security
 * log deliberately does not record from the route layer. See the README at the top of `../route-contracts.ts`.
 *
 * The module's three routes are the begin, the receipt read and the cancel. Neither POST is audited from the route layer
 * (the module contributes no audit rule): the session journal records a handover.
 */
export const callers: readonly string[] = [
  'GET /v1/sessions/:sessionId/handover authenticated any',
  'POST /v1/sessions/:sessionId/handover operator any',
  'POST /v1/sessions/:sessionId/handover/cancel operator any',
];

export const notAudited: Readonly<Record<string, string>> = {
  'POST /v1/sessions/:sessionId/handover': 'drives an existing session; its journal records it',
  'POST /v1/sessions/:sessionId/handover/cancel': 'drives an existing session; its journal records it',
};
