import { type AgentAddressCandidate, ambiguousAgentAddressMessage, resolveAgentAddress } from '@ferretry/protocol';
import { ApiError } from '../../api/error.ts';
import { decodeParameter, type RouteParameters } from '../../api/http.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import type { SocketRoute } from '../../api/socket.ts';

/**
 * AN AGENT'S NAME IS AN ADDRESS, ON EVERY ROUTE THAT TAKES A SESSION.
 *
 * Agents are named (`aniya`, `torrey`) so people and other agents can address them without copying a
 * session id. The command line documented `fy send <id|callsign>`, the reference standard told agents
 * to write `:aniya` — and the send route took ids only, so an agent asked to message `:aniya` was told
 * "no session aniya" and fell back to looking the id up by hand. Every other per-session route had the
 * same gap, each behind its own `tryParseSessionId`.
 *
 * So the answer is given ONCE, here, for the whole table: before any per-session handler runs, a
 * `:sessionId` that is not a session on this machine is read as a name and replaced with the session
 * it addresses, by the protocol's rule (`resolveAgentAddress`) — case-insensitive, the live holder
 * preferred. Handlers, the audit log and the agent-control switches all see the canonical id, so none
 * of them has to know names exist.
 *
 * WHAT IT NEVER DOES.
 *
 * - It never guesses. A name two sessions hold on the same footing is refused `409` with every
 *   candidate, so the sender chooses by id; a message delivered to the wrong agent is worse than one
 *   that asks.
 * - It never invents a refusal of its own for a name nobody holds: the parameter is left as it came,
 *   and the route answers exactly what it answers for an unknown id today.
 * - It never reads the fleet for an id. The exact-id check is the index; the documents are read only
 *   when the path does not name a session at all.
 *
 * It runs AFTER authorization, so it changes which session a permitted request acts on and never
 * whether it is permitted. A warden's remedy is decided over the path as sent, which for a name is a
 * target it was not assigned — a warden addresses sessions by id, and that path fails closed.
 */

/** The fleet as name resolution needs it. */
export interface SessionAddressBook {
  /** Whether this exact id is a session on this machine. Cheap: the index, not the documents. */
  has(id: string): boolean;
  /** Every session a name could address. Read only when the path names no session id. */
  candidates(): Promise<readonly AgentAddressCandidate[]>;
}

const SESSION_PARAMETER = 'sessionId';

/** The route's parameters with a name in `:sessionId` replaced by the session it addresses. */
export async function addressedParameters(book: SessionAddressBook, params: RouteParameters): Promise<RouteParameters> {
  const raw = params.get(SESSION_PARAMETER);
  if (raw === undefined) return params;
  const reference = decodeParameter(raw);
  if (reference === undefined || reference === '' || book.has(reference)) return params;
  const resolution = resolveAgentAddress(reference, await book.candidates());
  if (resolution.kind === 'ambiguous')
    throw new ApiError(
      409,
      ambiguousAgentAddressMessage(resolution.name, resolution.candidates),
      'ambiguous_agent_name',
    );
  if (resolution.kind === 'unknown') return params;
  return new Map([...params, [SESSION_PARAMETER, encodeURIComponent(resolution.id)]]);
}

const addressed = async (book: SessionAddressBook, context: RouteContext): Promise<RouteContext> => {
  const params = await addressedParameters(book, context.params);
  return params === context.params ? context : { ...context, params };
};

const takesSession = (route: { readonly path: string }): boolean => route.path.includes(`:${SESSION_PARAMETER}`);

/** The request/response table, with every per-session route addressable by name. */
export function sessionAddressedRoutes(book: SessionAddressBook, routes: readonly ApiRoute[]): readonly ApiRoute[] {
  return routes.map(route =>
    takesSession(route)
      ? { ...route, handle: async context => await route.handle(await addressed(book, context)) }
      : route,
  );
}

/** The socket table, the same way: attaching to a named agent's terminal or page. */
export function sessionAddressedSockets(
  book: SessionAddressBook,
  routes: readonly SocketRoute[],
): readonly SocketRoute[] {
  return routes.map(route =>
    takesSession(route)
      ? { ...route, accept: async context => await route.accept(await addressed(book, context)) }
      : route,
  );
}
