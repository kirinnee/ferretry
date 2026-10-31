import { isHumanAdminActor } from './actor.ts';
import type { RouteContext } from './route.ts';

/**
 * An agent: a caller that identified itself (`peer:`, a warden) rather than a person or the host.
 * A paired device and the human's own shell (`admin-cli`, `admin-ui`) are not agents.
 *
 * The actor is derived server-side from the credential and the session header; a request body never
 * participates. This is an operational boundary for honest clients, not a cryptographic per-session
 * capability (see `isHumanAdminActor`).
 */
export const isAgentCaller = (context: RouteContext): boolean =>
  context.credential !== undefined && context.credential.tokenClass !== 'device' && !isHumanAdminActor(context.actor);
