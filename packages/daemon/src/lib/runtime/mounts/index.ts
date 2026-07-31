import { ApiDispatcher } from '../../api/dispatcher.ts';
import type { ApiRoute } from '../../api/route.ts';
import { ApiRouter } from '../../api/router.ts';
import { daemonApiRoutes, type DaemonApiDependencies } from '../../api/server.ts';
import { ApiSocketDispatcher, type SocketRoute } from '../../api/socket.ts';
import type { AttentionService } from '../../attention/index.ts';
import type { PinService } from '../../pins/index.ts';
import { analyticsRoutes, type AnalyticsSubsystem } from './analytics.ts';
import { attentionRoutes } from './attention.ts';
import { learningRoutes, type LearningSubsystem } from './learning.ts';
import { nameRoutes, type NameSubsystem } from './names.ts';
import { pinRoutes } from './pins.ts';
import { sessionRoutes, type SessionDirectorySubsystem } from './sessions.ts';
import { taskRoutes, type TaskSubsystem } from './tasks.ts';
import { terminalRoutes, terminalSocketRoutes, type TerminalSubsystem } from './terminals.ts';

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
  /** The session read: what the fleet holds, and one session in full. Reading only — a start, a
   *  send and a stop belong to the unit that mounts the session lifecycle. */
  readonly sessions: SessionDirectorySubsystem;
  /** The task record boards: one per session, plus the fleet-wide read across all of them. */
  readonly tasks: TaskSubsystem;
  /** The fleet-wide analytics read over every finished session's durable record. */
  readonly analytics: AnalyticsSubsystem;
  /** Independent shell terminals attached to a session's working directory. */
  readonly terminals: TerminalSubsystem;
  /** Free teammate callsigns, for composing a session title before starting one. */
  readonly names: NameSubsystem;
  /** The learning review board: the evidence the daemon holds, and a human's verdict on each rule
   *  it proposes. Mining itself is not mounted — see the mount's own header. */
  readonly learning: LearningSubsystem;
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
    // The session read comes first among the subsystems: `/v1/sessions` is a fixed literal, and the
    // id pattern beneath it matches one segment, so neither can be shadowed by — or shadow — the
    // deeper per-session routes that follow.
    ...sessionRoutes(subsystems.sessions),
    ...attentionRoutes(subsystems.attention),
    ...pinRoutes(subsystems.pins),
    ...taskRoutes(subsystems.tasks),
    ...analyticsRoutes(subsystems.analytics),
    ...terminalRoutes(subsystems.terminals),
    ...nameRoutes(subsystems.names),
    ...learningRoutes(subsystems.learning),
  ];
}

/** The dispatcher the transport adapter serves, over the full mounted surface. */
export function createMountedDispatcher(base: DaemonApiDependencies, subsystems: MountedSubsystems): ApiDispatcher {
  return new ApiDispatcher(new ApiRouter(mountedDaemonRoutes(base, subsystems)), base.credentials);
}

/**
 * Every route that answers a protocol switch rather than a response.
 *
 * A SECOND table, not a flag on the first, because the two answer different questions: an `ApiRoute`
 * returns a body, a `SocketRoute` returns something that keeps talking. Terminal streaming is the
 * only one today; the browser viewer transport is built and waits on the unit that mounts browser
 * sessions.
 */
export function mountedSocketRoutes(subsystems: MountedSubsystems): readonly SocketRoute[] {
  return [...terminalSocketRoutes(subsystems.terminals)];
}

/** The socket dispatcher the transport adapter serves, over the same credentials as the HTTP one. */
export function createMountedSocketDispatcher(
  base: DaemonApiDependencies,
  subsystems: MountedSubsystems,
): ApiSocketDispatcher {
  return new ApiSocketDispatcher(new ApiRouter(mountedSocketRoutes(subsystems)), base.credentials);
}
