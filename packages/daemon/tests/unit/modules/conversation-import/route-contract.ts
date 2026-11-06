/**
 * The `conversation-import` module's route contract: who may call each of its routes, and which of its mutating routes
 * the security log deliberately does not record. See the README at the top of `../route-contracts.ts`.
 *
 * The adoption creates sessions that can launch an agent, so it has a rule in the module's `contributes.audit`; the
 * listing, the preview and both history reads write nothing, so nothing is exempt below.
 */
export const callers: readonly string[] = [
  'GET /v1/imports/conversations operator any',
  'GET /v1/imports/conversations/:harness/:conversationId/preview operator any',
  'GET /v1/imports/history operator any',
  'GET /v1/imports/history/:importId operator any',
  'POST /v1/imports/conversations/adopt operator person',
];

export const notAudited: Readonly<Record<string, string>> = {};
