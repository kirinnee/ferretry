import type { UsageFeedPort } from '../usage/types.ts';
import type { ApiCredentials } from './authentication.ts';
import { ApiDispatcher } from './dispatcher.ts';
import type { ApiRoute } from './route.ts';
import type { MillisecondClockPort } from '../runtime/readiness.ts';
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

/** A listening HTTP host. The adapter owns the socket; nothing in the domain does. */
export interface ApiServerHandle {
  /** The address actually bound, which is the only way to learn an ephemeral port. */
  readonly url: string;
  readonly port: number;
  stop(): Promise<void>;
}

/** The transport seam. Implemented by an adapter around whatever HTTP server the runtime offers. */
export interface ApiServerPort {
  listen(dispatcher: ApiDispatcher, options: ApiBindOptions): Promise<ApiServerHandle>;
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
