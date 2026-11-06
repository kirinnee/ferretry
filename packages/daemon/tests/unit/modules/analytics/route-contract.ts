/**
 * The `analytics` module's route contract: who may call each of its routes, and which of its mutating routes the
 * security log deliberately does not record. See the README at the top of `../route-contracts.ts`.
 *
 * It has no audit rule, so each of its mutating routes is in `notAudited`.
 */
export const callers: readonly string[] = [
  'GET /v1/analytics operator any',
  'GET /v1/analytics/pricing operator any',
  'PATCH /v1/analytics/pricing operator any',
  'POST /v1/analytics/pricing/sync/apply operator any',
  'POST /v1/analytics/pricing/sync/preview operator any',
];

export const notAudited: Readonly<Record<string, string>> = {
  'PATCH /v1/analytics/pricing': 'the cost table for usage reports; reaches nobody',
  'POST /v1/analytics/pricing/sync/preview': 'a read with a body: previews a price sync',
  'POST /v1/analytics/pricing/sync/apply': 'the cost table for usage reports; reaches nobody',
};
