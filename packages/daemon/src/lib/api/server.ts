import type { MillisecondClockPort } from '../runtime/boot.ts';
import type { UsageFeedPort } from '../usage/types.ts';
import type { ApiCredentials } from './authentication.ts';
import { ApiDispatcher } from './dispatcher.ts';
import { NO_GOVERNED_ROUTES_GUARD } from './capability.ts';
import type { ApiRoute } from './route.ts';
import { ApiRouter } from './router.ts';
import { healthRoutes } from './routes/health.ts';
import { usageRoutes } from './routes/usage.ts';
import type { ApiSocketDispatcher } from './socket.ts';

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
 * Every part of the surface one adapter serves: request/response routes and protocol switches.
 *
 * They travel together because they share credentials and a peer. A dispatcher built from different
 * credentials than the HTTP one is a second, quieter authorization boundary, and the two would
 * drift.
 *
 * There was a THIRD member — routes that answered with the transport's own `Response` because their
 * traffic could not be a string. The daemon's speech recognition was its only user; recognition
 * moved into the browser and the seam went with it. See `runtime/mounts/index.ts` for the record.
 */
export interface ApiSurface {
  readonly http: ApiDispatcher;
  readonly sockets: ApiSocketDispatcher;
  /** Exact browser origins admitted by the transport-level CORS boundary. */
  readonly corsOrigins: readonly string[];
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
  return new ApiDispatcher(
    new ApiRouter(daemonApiRoutes(dependencies)),
    dependencies.credentials,
    NO_GOVERNED_ROUTES_GUARD,
  );
}
