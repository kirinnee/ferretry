/**
 * The `worktrees` module's route contract: who may call each of its routes, and which of its mutating routes the
 * security log deliberately does not record. See the README at the top of `../route-contracts.ts`.
 *
 * Removing a checkout has a rule in the module's `contributes.audit`; creating one does not.
 */
export const callers: readonly string[] = [
  'GET /v1/worktrees operator any',
  'GET /v1/worktrees/removal operator any',
  'POST /v1/worktrees operator any',
  'POST /v1/worktrees/remove operator any',
];

export const notAudited: Readonly<Record<string, string>> = {
  'POST /v1/worktrees':
    'creates a worktree inside a registered project; removal is the destructive half and is audited',
};
