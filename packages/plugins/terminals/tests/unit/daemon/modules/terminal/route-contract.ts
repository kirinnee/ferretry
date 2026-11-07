/**
 * The `terminal` module's route contract: who may call each of its routes, and which of its mutating routes the
 * security log deliberately does not record from the route layer. See the README at the top of `../route-contracts.ts`.
 *
 * Opening a terminal, the terminal stream socket and typing into a session's own pane from the Console each have a rule
 * in the module's `contributes.audit`; a retitle, a close and the owner's close-finished are the only entries below.
 */
export const callers: readonly string[] = [
  'DELETE /v1/sessions/:sessionId/terminals/:terminalId operator any',
  'GET /v1/sessions/:sessionId/terminals operator any',
  'GET /v1/sessions/:sessionId/terminals/:terminalId operator any',
  'GET /v1/sessions/:sessionId/terminals/:terminalId/stream operator any',
  'GET /v1/terminals operator any',
  'PATCH /v1/sessions/:sessionId/terminals/:terminalId operator any',
  'POST /v1/sessions/:sessionId/console/input operator person',
  'POST /v1/sessions/:sessionId/terminals operator any',
  'POST /v1/terminals/close-finished operator any',
];

export const notAudited: Readonly<Record<string, string>> = {
  'PATCH /v1/sessions/:sessionId/terminals/:terminalId': 'renames a terminal; opening and attaching are audited',
  'POST /v1/terminals/close-finished':
    'audited by the terminal service: terminal.closed, a count and the stopped ferret only',
  'DELETE /v1/sessions/:sessionId/terminals/:terminalId':
    'closes a terminal, which removes access rather than adding it',
};
