import { ApiError } from './error.ts';
import type { RouteContext } from './route.ts';

/** The code a ferret's start naming some other session as the parent is refused with. */
const PARENT_MISMATCH_CODE = 'parent_mismatch';

/**
 * WHO A NEW SESSION'S PARENT IS, for a caller on a ferret's OWN session credential: that ferret, always
 * (docs/pack-mode.md § Parent and child). The one rule every route that starts a session on a ferret's
 * behalf applies — `POST /v1/sessions` and `POST /v1/pack/new` — so the two can never disagree.
 *
 * - A `parent` naming another session is refused `403 parent_mismatch`: that session would gain lineage
 *   over the child, and its sub-ferret limits would be the ones charged.
 * - An absent `parent` is filled in from the credential, so a ferret can never start a parent-less,
 *   top-level session: every session it starts is its child, counted against its limits and its depth.
 *
 * Any other caller is unchanged. The owner (the admin token at the machine, a paired device) may start a
 * session for any parent or none, and the admin token naming a ferret in `x-ferretry-session-id` stays the
 * honest-client fallback it always was: the parent it names is the body's, exactly as before.
 */
export function lineageOf<T extends { readonly parent?: string | undefined }>(context: RouteContext, request: T): T {
  const credential = context.credential;
  if (credential?.tokenClass !== 'session') return request;
  if (request.parent !== undefined && request.parent !== credential.sessionId)
    throw new ApiError(
      403,
      'a ferret starts sessions only as its own children; leave the parent out, the daemon reads it from your credential',
      PARENT_MISMATCH_CODE,
    );
  return { ...request, parent: credential.sessionId };
}
