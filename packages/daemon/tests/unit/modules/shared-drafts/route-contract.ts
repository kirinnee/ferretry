/**
 * The `shared-drafts` module's route contract: who may call each of its routes, and which of its mutating routes the
 * security log deliberately does not record. See the README at the top of `../route-contracts.ts`.
 *
 * The module has no audit rule: a draft is the owner's own unsent words, so both the edit and the live stream are
 * listed in `notAudited`. The stream is a socket route; the surface tests tell the two tables apart by what is mounted.
 */
export const callers: readonly string[] = [
  'GET /v1/sessions/:sessionId/shared-draft operator person',
  'GET /v1/sessions/:sessionId/shared-draft/stream operator person',
  'POST /v1/sessions/:sessionId/shared-draft operator person',
];

export const notAudited: Readonly<Record<string, string>> = {
  'POST /v1/sessions/:sessionId/shared-draft':
    "the owner's own unsent words, typed at keystroke rate; it widens nobody's access, and logging it would copy the draft into a log",
  'GET /v1/sessions/:sessionId/shared-draft/stream':
    "the owner's own unsent words at keystroke rate, to the owner's own devices; logging it would copy the draft into a log",
};
