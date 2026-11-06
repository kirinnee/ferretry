/**
 * The `workSearch` module's route contract: who may call each of its routes, and which of its mutating routes the
 * security log deliberately does not record. See the README at the top of `../route-contracts.ts`.
 */
export const callers: readonly string[] = ['GET /v1/search operator any', 'POST /v1/search/related operator any'];

export const notAudited: Readonly<Record<string, string>> = {
  'POST /v1/search/related':
    'a read: a POST only because a title and an ask do not fit a URL; it weighs them against the board and changes nothing',
};
