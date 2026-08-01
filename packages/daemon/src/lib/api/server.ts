import type { UsageFeedPort } from '../usage/types.ts';
import type { ApiCredentials } from './authentication.ts';
import { ApiDispatcher } from './dispatcher.ts';
import type { ApiRawDispatcher } from './raw.ts';
import type { ApiRoute } from './route.ts';
import type { ApiSocketDispatcher } from './socket.ts';
import type { MillisecondClockPort } from '../runtime/boot.ts';
import { healthRoutes } from './routes/health.ts';
import { usageRoutes } from './routes/usage.ts';
import { ApiRouter } from './router.ts';

/** Where the HTTP host should listen. */
export interface ApiBindOptions {
  readonly host: string;
  /**
   * The TCP port. `0` asks the operating system for an ephemeral one, which is what every test
   * binds: a test that pins a port collides with whatever is already running on the developer's
   * machine and fails for a reason that has nothing to do with the test.
   */
  readonly port: number;
}

/** A listening host. The adapter owns the sockets; nothing in the domain does. */
export interface ApiServerHandle {
  /** The address actually bound, which is the only way to learn an ephemeral port. */
  readonly url: string;
  readonly port: number;
  /**
   * Ends every live socket, telling each handler to release what it holds.
   *
   * Separate from `stop` and registered ahead of it at the composition root: a terminal stream owns
   * a redraw timer armed against its socket, and pulling the host out from under it would leave the
   * timer firing at a peer that no longer exists.
   */
  closeSockets(): void;
  stop(): Promise<void>;
}

/**
 * Every part of the surface one adapter serves: request/response routes, protocol switches, and the
 * byte-shaped routes that own the transport's own request and response.
 *
 * They travel together because they share credentials and a peer. A dispatcher built from different
 * credentials than the HTTP one is a second, quieter authorization boundary, and the two would
 * drift.
 */
export interface ApiSurface {
  readonly http: ApiDispatcher;
  readonly sockets: ApiSocketDispatcher;
  /** Routes whose request or response cannot be a string — audio in, a ranged model file out. See
   *  `api/raw.ts`. */
  readonly raw: ApiRawDispatcher;
}

/** The transport seam. Implemented by an adapter around whatever server the runtime offers. */
export interface ApiServerPort {
  listen(surface: ApiSurface, options: ApiBindOptions): Promise<ApiServerHandle>;
}

/** Everything the daemon's API surface is built from. Subsystem units add their own ports here as
 *  they land, and their routes to `daemonApiRoutes` below. */
export interface DaemonApiDependencies {
  readonly credentials: ApiCredentials;
  readonly usage: UsageFeedPort;
  readonly clock: MillisecondClockPort;
  /** Epoch milliseconds at which this daemon process started, for the liveness answer. */
  readonly startedAtMs: number;
}

/**
 * The daemon's complete route table.
 *
 * Order matters — the router tries routes in registration order — so literal paths belong before
 * the patterns that could also match them.
 */
export function daemonApiRoutes(dependencies: DaemonApiDependencies): readonly ApiRoute[] {
  return [
    ...healthRoutes(dependencies.clock, dependencies.startedAtMs),
    ...usageRoutes(dependencies.usage, dependencies.clock),
  ];
}

/** Builds the dispatcher the transport adapter serves. */
export function createApiDispatcher(dependencies: DaemonApiDependencies): ApiDispatcher {
  return new ApiDispatcher(new ApiRouter(daemonApiRoutes(dependencies)), dependencies.credentials);
}
