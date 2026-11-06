/**
 * The `voice` module's route contract: who may call each of its routes, and which of its mutating routes the
 * security log deliberately does not record. See the README at the top of `../route-contracts.ts`.
 */
export const callers: readonly string[] = ['POST /v1/stt/enhance operator any'];

export const notAudited: Readonly<Record<string, string>> = {
  'POST /v1/stt/enhance': 'a read with a body: tidies dictated text',
};
