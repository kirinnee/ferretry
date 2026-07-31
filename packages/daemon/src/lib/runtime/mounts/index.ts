import { ApiDispatcher } from '../../api/dispatcher.ts';
import type { ApiRoute } from '../../api/route.ts';
import { ApiRouter } from '../../api/router.ts';
import { daemonApiRoutes, type DaemonApiDependencies } from '../../api/server.ts';
import type { AttentionService } from '../../attention/index.ts';
import type { PinService } from '../../pins/index.ts';
import { analyticsRoutes, type AnalyticsSubsystem } from './analytics.ts';
import { attentionRoutes } from './attention.ts';
import { pinRoutes } from './pins.ts';
import { taskRoutes, type TaskSubsystem } from './tasks.ts';
import { terminalRoutes, type TerminalSubsystem } from './terminals.ts';

/**
 * The subsystems the daemon process mounts on top of its base API surface, and the complete route
 * table that results.
 *
 * WHY THIS DIRECTORY EXISTS. By convention a route table belongs beside the others in
 * `src/lib/api/routes/`. These live here instead because `src/lib/api/**` is another unit's
 * exclusive file ownership while this migration is in flight; whoever owns that directory can move
 * them with a rename and a change to two import paths. Nothing about the code depends on the
 * location — a route is a pure function from an `ApiRequest` to an `ApiResponse` either way.
 *
 * WHAT IT IS FOR. A subsystem that is built and tested but never reachable from `bin/fyd.ts` is a
 * capability the product does not have, and this migration shipped several of those. Adding a
 * subsystem here is what makes it real: the daemon constructs it, a route demands it, and the
 * reachability gate can see the edge.
 */

/** Every already-built subsystem this daemon process serves. One field per subsystem; the field's
 *  presence is the proof that production constructs it. */
export interface MountedSubsystems {
  readonly attention: AttentionService;
  readonly pins: PinService;
  /** The task record boards: one per session, plus the fleet-wide read across all of them. */
  readonly tasks: TaskSubsystem;
  /** The fleet-wide analytics read over every finished session's durable record. */
  readonly analytics: AnalyticsSubsystem;
  /** Independent shell terminals attached to a session's working directory. */
  readonly terminals: TerminalSubsystem;
}

/**
 * The daemon's complete route table: the base feeds, then each mounted subsystem.
 *
 * Order matters — the router tries routes in registration order — and the base feeds are all fixed
 * literal paths (`/healthz`, `/usage`, `/metrics`), so no subsystem pattern can shadow one.
 */
export function mountedDaemonRoutes(base: DaemonApiDependencies, subsystems: MountedSubsystems): readonly ApiRoute[] {
  return [
    ...daemonApiRoutes(base),
    ...attentionRoutes(subsystems.attention),
    ...pinRoutes(subsystems.pins),
    ...taskRoutes(subsystems.tasks),
    ...analyticsRoutes(subsystems.analytics),
    ...terminalRoutes(subsystems.terminals),
  ];
}

/** The dispatcher the transport adapter serves, over the full mounted surface. */
export function createMountedDispatcher(base: DaemonApiDependencies, subsystems: MountedSubsystems): ApiDispatcher {
  return new ApiDispatcher(new ApiRouter(mountedDaemonRoutes(base, subsystems)), base.credentials);
}
