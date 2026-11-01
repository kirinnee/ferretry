import { type ApiActor, isHumanAdminActor, parseActor } from './actor.ts';
import type { AuthenticatedCredential } from './authentication.ts';
import type { RouteContext } from './route.ts';

/**
 * Whether a caller is an AGENT — a ferret or a warden — rather than a person. The ONE answer to that
 * question: the boundary refuses an agent on a `caller: 'person'` route with it, and every handler that
 * refuses an agent PART of an `any` route asks it too, so the two can never disagree.
 *
 * KEYED ON THE CREDENTIAL CLASS FIRST:
 *
 * - `session` — a ferret's own credential. Always an agent, whatever any header says.
 * - `warden` — a supervising pane's token. Always an agent.
 * - `device` — a paired device. Always a person.
 * - `admin` — the host's admin token. A person UNLESS the request names a ferret's session in
 *   `x-ferretry-session-id` (the actor is then `peer:` or `warden:`). That half is the honest-client
 *   fallback for a ferret that has no credential of its own — a pane started before the issuer, or an
 *   older `fy` — and it is exactly as strong as it ever was: a caller that holds the admin token and
 *   leaves the header out IS the owner at the machine to this daemon (docs/agent-tools.md § "The ferret
 *   session credential").
 *
 * No caller (a public route) is not an agent: such a route reads whatever credential it takes itself.
 */
export function callerIsAgent(credential: AuthenticatedCredential | undefined, actor: ApiActor | undefined): boolean {
  if (credential === undefined) return false;
  switch (credential.tokenClass) {
    case 'session':
    case 'warden':
      return true;
    case 'device':
      return false;
    case 'admin':
      return !isHumanAdminActor(actor);
  }
}

/** {@link callerIsAgent} of a handler's own context. */
export const isAgentCaller = (context: RouteContext): boolean => callerIsAgent(context.credential, context.actor);

/**
 * The session an AGENT caller is acting as: its own credential's, or — for the honest-client admin token with a
 * session header — the `peer:` it named. `undefined` for a person, and for a warden, which acts as no ferret.
 */
export function agentSessionOf(context: RouteContext): string | undefined {
  if (context.credential?.tokenClass === 'session') return context.credential.sessionId;
  if (!isAgentCaller(context)) return undefined;
  const actor = parseActor(context.actor ?? '');
  return actor.kind === 'peer' && actor.id !== '' ? actor.id : undefined;
}

/** The code a person-only act refuses an agent with, at the boundary and in a handler alike. */
export const OWNER_ONLY_CODE = 'owner_only';
