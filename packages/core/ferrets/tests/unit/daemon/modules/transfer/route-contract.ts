/**
 * The `transfer` module's route contract: who may call each of its routes, and which of its mutating routes the
 * security log deliberately does not record from the route layer. See the README at the top of `../route-contracts.ts`.
 *
 * The module's routes are the four attachment routes. None has an audit rule: the upload, the unlock and the lock are
 * the only mutating entries, and each is explained below.
 */
export const callers: readonly string[] = [
  'DELETE /v1/sessions/:sessionId/attachments/:attachmentId/unlock operator any',
  'GET /v1/sessions/:sessionId/attachments/:attachmentId operator any',
  'POST /v1/sessions/:sessionId/attachments operator any',
  'POST /v1/sessions/:sessionId/attachments/:attachmentId/unlock operator any',
];

export const notAudited: Readonly<Record<string, string>> = {
  'POST /v1/sessions/:sessionId/attachments': 'a file handed to an agent; the transcript is that history',
  'POST /v1/sessions/:sessionId/attachments/:attachmentId/unlock': 'opens an attachment to its own session only',
  'DELETE /v1/sessions/:sessionId/attachments/:attachmentId/unlock': 'closes an attachment again',
};
