/**
 * The HTTP pieces the ported route bodies stand on: the kernel leaf's request/response vocabulary, the body parser
 * and the shape of a mounted route. A route's descriptor (who may call it, whether it is stored) is the manifest's;
 * a mount here is only its method, its path and its handler.
 */
import type { CallContext, RouteHandler } from '@ferretry/kernel/contract';

export {
  ApiError,
  type ApiResponse,
  decodeParameter,
  headerValue,
  jsonResponse,
  type SocketDownstream,
} from '@ferretry/kernel/contract';
export { parseBody } from './body.ts';

/** What Gate stamps for a call from a ferret's own credential: `peer:<ferret id>`. */
export const PEER_ACTOR_PREFIX = 'peer:';

export type RouteContext = CallContext;
import type { SocketAccept } from '@ferretry/kernel/contract';
export type { SocketAccept };

/** One mounted route: its method and path (the manifest's key) and the handler that serves it. */
export interface MountRoute {
  readonly method: string;
  readonly path: string;
  readonly handle: RouteHandler;
}

/** A mount list as the daemon half's `routes` record: `"POST /v1/ferrets/:ferretId/send"` -> handler. */
export function routeTable(mounts: readonly MountRoute[]): Record<string, RouteHandler> {
  return Object.fromEntries(mounts.map(mount => [`${mount.method} ${mount.path}`, mount.handle]));
}

// Gate stamps `actor` (and the rest of the standing) onto every admitted call; the declaration merges into
// `CallStanding` when its contract is in the program.
import type {} from '@ferretry/core-gate/contract';

/** `peer:<ferret>`, `device:<id>`, `admin-cli`, ...: Gate's text for who is calling. */
export type ApiActor = string;

export interface ParsedActor {
  readonly kind: string;
  readonly id?: string;
  readonly raw: string;
}

export function parseActor(source: string): ParsedActor {
  const separator = source.indexOf(':');
  if (separator === -1) return { kind: source, raw: source };
  return { kind: source.slice(0, separator), id: source.slice(separator + 1), raw: source };
}

/** One mounted socket: its method and path (the manifest's key) and the accept that opens it. */
export interface MountSocket {
  readonly method: string;
  readonly path: string;
  readonly accept: SocketAccept;
}

export function socketTable(mounts: readonly MountSocket[]): Record<string, SocketAccept> {
  return Object.fromEntries(mounts.map(mount => [`${mount.method} ${mount.path}`, mount.accept]));
}
