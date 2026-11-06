/**
 * The `inputRequests` module's route contract: who may call each of its routes, and which of its mutating routes the
 * security log deliberately does not record from the route layer. See the README at the top of `../route-contracts.ts`.
 *
 * It has no rule in its `contributes.audit`: the two services write the security log themselves, with names and flags
 * only, so the entries below say which service does.
 */
export const callers: readonly string[] = [
  'GET /v1/input-requests operator person',
  'GET /v1/phone-approvals operator person',
  'GET /v1/sessions/:sessionId/input-requests operator person',
  'GET /v1/sessions/:sessionId/input-requests/:requestId/shot operator person',
  'GET /v1/sessions/:sessionId/phone-approvals/:approvalId operator person',
  'POST /v1/sessions/:sessionId/input-requests/:requestId/cancel operator person',
  'POST /v1/sessions/:sessionId/input-requests/:requestId/deliver operator person',
  'POST /v1/sessions/:sessionId/phone-approvals/:approvalId/refuse operator person',
];

export const notAudited: Readonly<Record<string, string>> = {
  'GET /v1/input-requests': 'a read; carries no value',
  'GET /v1/sessions/:sessionId/input-requests': 'a read; carries no value',
  'POST /v1/sessions/:sessionId/input-requests/:requestId/deliver':
    'audited by the input-request service: input.delivered or input.refused, names and flags only, never the value',
  'POST /v1/sessions/:sessionId/input-requests/:requestId/cancel':
    'audited by the input-request service: input.cancelled, names and flags only',
  'POST /v1/sessions/:sessionId/phone-approvals/:approvalId/refuse':
    'audited by the phone-approval service: phone-approval.refused, the account, the site and the ferret, never the number',
};
