/**
 * The `update` module's route contract: who may call each of its routes, and which of its mutating routes the
 * security log deliberately does not record. See the README at the top of `../route-contracts.ts`.
 *
 * Each of its mutating routes has a rule in the module's `contributes.audit`, so it has no line in `notAudited`.
 */
export const callers: readonly string[] = [
  'GET /v1/daemon/update operator any',
  'GET /v1/harnesses/update operator any',
  'PATCH /v1/daemon/update/settings operator person',
  'POST /v1/daemon/update operator person',
  'POST /v1/harnesses/update operator person',
];

export const notAudited: Readonly<Record<string, string>> = {};
