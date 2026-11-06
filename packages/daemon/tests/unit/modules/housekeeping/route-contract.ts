/**
 * The `housekeeping` module's route contract: who may call each of its routes, and which of its mutating routes the
 * security log deliberately does not record. See the README at the top of `../route-contracts.ts`.
 *
 * The speed-up Test spends a provider key, so it has a rule in the module's `contributes.audit`; the scratch sweep
 * reaches nobody and the tidy plan is a read, so they are the only entries below.
 */
export const callers: readonly string[] = [
  'GET /v1/gc operator any',
  'GET /v1/speedups operator any',
  'POST /v1/gc operator any',
  'POST /v1/speedups/:provider/test operator any',
  'POST /v1/tidy/plan operator any',
];

export const notAudited: Readonly<Record<string, string>> = {
  'POST /v1/gc': 'scratch cleanup of state the daemon owns; reaches nobody',
  'POST /v1/tidy/plan':
    'a read: a POST only so a plan is never cached by a proxy; it decides what one ferret could tidy and changes nothing',
};
