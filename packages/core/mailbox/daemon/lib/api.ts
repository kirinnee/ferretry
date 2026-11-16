/**
 * The HTTP pieces the send routes stand on: the kernel leaf's request/response vocabulary, the body parser and the
 * shape of a mounted route. A route's descriptor (who may call it, whether it is stored) is the manifest's; a mount
 * here is only its method, its path and its handler.
 */
import type { CallContext, RouteHandler } from '@ferretry/kernel/contract';

export {
  answerWhenChanged,
  ApiError,
  type ApiResponse,
  decodeParameter,
  headerValue,
  jsonResponse,
  parseBody,
} from '@ferretry/kernel/contract';

export type RouteContext = CallContext;

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
