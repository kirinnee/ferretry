/**
 * The `session-move` module's route contract: who may call its routes, and which of its mutating routes the security
 * log deliberately does not record from the route layer. See the README at the top of `../route-contracts.ts`.
 *
 * The module's four routes are the relaunch-settings read, the conversion preview, the move and the ask-to-stop-jobs.
 * The ask-to-stop-jobs is audited (its rule is the module's `contributes.audit`: it prompts the agent as a send does). The
 * preview is a read with a body, and the move is recorded by the session's own journal.
 */
export const callers: readonly string[] = [
  'GET /v1/ferrets/:ferretId/relaunch-settings operator any',
  'POST /v1/ferrets/:ferretId/conversion-preview operator any',
  'POST /v1/ferrets/:ferretId/move operator any',
  'POST /v1/ferrets/:ferretId/move/ask-to-stop-jobs operator any',
];

export const notAudited: Readonly<Record<string, string>> = {
  'POST /v1/ferrets/:ferretId/conversion-preview':
    'a read with a body: previews a cross-harness conversion and writes nothing; the move it precedes is audited',
  'POST /v1/ferrets/:ferretId/move': 'drives an existing session; its journal records it',
};
