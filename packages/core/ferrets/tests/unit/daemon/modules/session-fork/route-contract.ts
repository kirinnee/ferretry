/**
 * The `session-fork` module's route contract: who may call its route, and which of its mutating routes the security
 * log deliberately does not record from the route layer. See the README at the top of `../route-contracts.ts`.
 *
 * The module's one route is the fork. It is audited (its rule is the module's `contributes.audit`: a fork opens a
 * brand-new session), so nothing is listed as not audited.
 */
export const callers: readonly string[] = ['POST /v1/sessions/:sessionId/fork operator person'];

export const notAudited: Readonly<Record<string, string>> = {};
