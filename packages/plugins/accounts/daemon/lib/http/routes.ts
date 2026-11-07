import type { RouteHandler } from '@ferretry/kernel/contract';

/**
 * One route as a mount writes it: its key's method and path, and its handler. The descriptor (minimum, caller,
 * capability, audit, guard) is the manifest's, never repeated here.
 */
export interface MountedRoute {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly handle: RouteHandler;
}

/** A mount's routes keyed as the manifest declares them (`'GET /v1/sign-in-rules'`), for the daemon half. */
export function routeHandlers(routes: readonly MountedRoute[]): Readonly<Record<string, RouteHandler>> {
  const keyed: Record<string, RouteHandler> = {};
  for (const route of routes) {
    const key = `${route.method} ${route.path}`;
    if (key in keyed) throw new TypeError(`route ${key} is mounted twice`);
    keyed[key] = route.handle;
  }
  return keyed;
}
