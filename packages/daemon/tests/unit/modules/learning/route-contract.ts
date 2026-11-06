/**
 * The `learning` module's route contract: who may call each of its routes, and which of its mutating routes the
 * security log deliberately does not record. See the README at the top of `../route-contracts.ts`.
 *
 * `PATCH /v1/learning/config` and
 * `POST /v1/learning/proposals/:id/apply` are audited (the module's `contributes.audit`), so they have no line in
 * `notAudited`.
 */
export const callers: readonly string[] = [
  'GET /v1/learning/config operator any',
  'GET /v1/learning/proposals operator any',
  'GET /v1/learning/proposals/:id/apply-preview operator any',
  'GET /v1/learning/proposals/:id/patch operator any',
  'GET /v1/learning/scan operator any',
  'GET /v1/learning/sessions operator any',
  'GET /v1/learning/status operator any',
  'PATCH /v1/learning/config operator person',
  'PATCH /v1/sessions/:sessionId/learning operator any',
  'POST /v1/agent/lessons none any',
  'POST /v1/learning/proposals/:id operator any',
  'POST /v1/learning/proposals/:id/apply operator person',
  'POST /v1/learning/run operator any',
  'POST /v1/learning/scan operator person',
  'POST /v1/learning/scan/cancel operator any',
  'POST /v1/learning/scan/estimate operator any',
];

export const notAudited: Readonly<Record<string, string>> = {
  'POST /v1/learning/proposals/:id': 'accepts or declines a learning suggestion for a skill file; reaches nobody',
  'POST /v1/learning/run': 'starts a learning pass over transcripts the daemon already holds',
  'PATCH /v1/sessions/:sessionId/learning':
    'switches whether one ferret files lessons; changes no access, and its re-instruction is in its transcript',
  'POST /v1/learning/scan/estimate': 'a read with a body: counts what a scan would read and cost',
  'POST /v1/learning/scan': 'starts miners over transcripts the daemon already holds; reaches nobody',
  'POST /v1/learning/scan/cancel': 'stops the miners a scan started; removes work rather than adding access',
  'POST /v1/agent/lessons': 'a ferret filing a lesson into the inbox for the owner to review; reaches nobody',
};
