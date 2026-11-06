/**
 * The `renders` module's route contract: who may call each of its routes, and which of its mutating routes the
 * security log deliberately does not record. See the README at the top of `../route-contracts.ts`.
 */
export const callers: readonly string[] = [
  'GET /v1/renders/:id operator any',
  'GET /v1/renders/:id/meta operator any',
  'POST /v1/renders operator any',
];

export const notAudited: Readonly<Record<string, string>> = {
  'POST /v1/renders':
    'saves a picture a ferret made into the daemon’s state home, validated and size-capped; it changes nobody’s access, and a ferret or the owner at the machine is the only caller',
};
