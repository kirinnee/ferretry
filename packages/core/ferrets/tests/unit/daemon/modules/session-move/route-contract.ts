/**
 * The `session-migrate` module's route contract: who may call its routes, and which of its mutating routes the security
 * log deliberately does not record from the route layer. See the README at the top of `../route-contracts.ts`.
 *
 * The module's four routes are the relaunch-settings read, the conversion preview, the migrate and the ask-to-stop-jobs.
 * The ask-to-stop-jobs is audited (its rule is the module's `contributes.audit`: it prompts the agent as a send does). The
 * preview is a read with a body, and the migrate is recorded by the session's own journal.
 */
export const callers: readonly string[] = [
  'GET /v1/sessions/:sessionId/relaunch-settings operator any',
  'POST /v1/sessions/:sessionId/conversion-preview operator any',
  'POST /v1/sessions/:sessionId/migrate operator any',
  'POST /v1/sessions/:sessionId/migrate/ask-to-stop-jobs operator any',
];

export const notAudited: Readonly<Record<string, string>> = {
  'POST /v1/sessions/:sessionId/conversion-preview':
    'a read with a body: previews a cross-harness conversion and writes nothing; the migrate it precedes is audited',
  'POST /v1/sessions/:sessionId/migrate': 'drives an existing session; its journal records it',
};
