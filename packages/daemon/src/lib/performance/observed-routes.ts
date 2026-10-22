import { ApiError } from '../api/error.ts';
import type { ApiRoute } from '../api/route.ts';
import type { MillisecondClockPort } from '../runtime/boot.ts';
import type { PerformanceProbe } from './recorder.ts';

/**
 * Every route, timed into the probe under its PATTERN — `GET /v1/sessions/:id`, never the path a caller
 * sent, so a report can neither name a session nor split one route into a row per session.
 *
 * Wrapping the table rather than the dispatcher keeps the pattern for free: the route that answered is
 * the one being timed, and a refused or unknown request — answered before any route is reached — costs
 * the table nothing and is not counted as a route.
 */
export function observedRoutes(
  routes: readonly ApiRoute[],
  probe: PerformanceProbe,
  clock: MillisecondClockPort,
): readonly ApiRoute[] {
  return routes.map(route => {
    const name = `${route.method.toUpperCase()} ${route.path}`;
    return {
      ...route,
      handle: async context => {
        if (!probe.recording) return await route.handle(context);
        const startedAt = clock.now();
        try {
          const response = await route.handle(context);
          probe.route(name, clock.now() - startedAt, response.status, Buffer.byteLength(response.body));
          return response;
        } catch (error) {
          probe.route(name, clock.now() - startedAt, error instanceof ApiError ? error.status : 500, 0);
          throw error;
        }
      },
    };
  });
}
