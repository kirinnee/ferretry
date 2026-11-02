import { agentSessionOf } from './agent-caller.ts';
import { ApiError } from './error.ts';
import type { RouteContext } from './route.ts';

/** The code a ferret's start naming some other session as the parent is refused with. */
const PARENT_MISMATCH_CODE = 'parent_mismatch';

/**
 * WHO A NEW SESSION'S PARENT IS, for any caller that names a ferret's session: that ferret, always
 * (docs/pack-mode.md § Parent and child). The one rule every route that starts a session on a ferret's
 * behalf applies — `POST /v1/sessions` and `POST /v1/pack/new` — so the two can never disagree.
 *
 * - A `parent` naming another session is refused `403 parent_mismatch`: that session would gain lineage
 *   over the child, its sub-ferret limits would be the ones charged, and the Inbox would name the child's
 *   items by that session's root.
 * - An absent `parent` is filled in from the caller's session, so a ferret can never start a parent-less,
 *   top-level session.
 *
 * The caller's session is its own credential's, or — for the honest-client admin token — the one named in
 * `x-ferretry-session-id` (`agentSessionOf`). The owner (the admin token with no session header, a paired
 * device) names no session and is unchanged: it may start a session for any parent or none.
 */
export function lineageOf<T extends { readonly parent?: string | undefined }>(context: RouteContext, request: T): T {
  const sessionId = agentSessionOf(context);
  if (sessionId === undefined) return request;
  if (request.parent !== undefined && request.parent !== sessionId)
    throw new ApiError(
      403,
      'a ferret starts sessions only as its own children; leave the parent out, the daemon reads it from your credential',
      PARENT_MISMATCH_CODE,
    );
  return { ...request, parent: sessionId };
}
