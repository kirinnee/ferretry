/**
 * The `names` module's route contract: who may call each of its routes, and which of its mutating routes the security
 * log deliberately does not record. See the README at the top of `../route-contracts.ts`.
 *
 * The module's one route is a read of which callsigns are free, so it has no audit rule and nothing in `notAudited`.
 */
export const callers: readonly string[] = ['GET /v1/names operator any'];

export const notAudited: Readonly<Record<string, string>> = {};
