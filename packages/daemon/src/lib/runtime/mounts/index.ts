import { ApiDispatcher } from '../../api/dispatcher.ts';
import { ApiRawDispatcher, type RawRoute } from '../../api/raw.ts';
import type { ApiRoute } from '../../api/route.ts';
import { ApiRouter } from '../../api/router.ts';
import { daemonApiRoutes, type DaemonApiDependencies } from '../../api/server.ts';
import { ApiSocketDispatcher, type SocketRoute } from '../../api/socket.ts';
import type { AttentionService } from '../../attention/index.ts';
import type { BrowserLoginLifecycle } from '../../browser/control/index.ts';
import type { PinService } from '../../pins/index.ts';
import { analyticsRoutes, type AnalyticsSubsystem } from './analytics.ts';
import { attentionRoutes } from './attention.ts';
import { browserLoginRoutes } from './browser-login.ts';
import { catalogRoutes, type CatalogSubsystem } from './catalogs.ts';
import { daemonHealthRoutes, type DaemonHealthSubsystem } from './health.ts';
import { learningRoutes, type LearningSubsystem } from './learning.ts';
import { nameRoutes, type NameSubsystem } from './names.ts';
import { pinRoutes } from './pins.ts';
import { recommendRoutes, type RecommendSubsystem } from './recommend.ts';
import { sessionControlRoutes, type SessionControlSubsystem } from './session-control.ts';
import { sessionMigrateRoutes, type SessionMigrateSubsystem } from './session-migrate.ts';
import { sessionResumeRoutes, type SessionResumeSubsystem } from './session-resume.ts';
import { sessionRoutes, type SessionDirectorySubsystem } from './sessions.ts';
import { sttRawRoutes, type SttSubsystem } from './stt.ts';
import { taskBoardRoutes, type TaskBoardSubsystem } from './task-boards.ts';
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
  /** The daemon's own health, over the self-check that measures it. */
  readonly health: DaemonHealthSubsystem;
  readonly attention: AttentionService;
  readonly pins: PinService;
  /** The session read: what the fleet holds, and one session in full. */
  readonly sessions: SessionDirectorySubsystem;
  /** Daemon-local project and per-session skill catalogs. */
  readonly catalogs: CatalogSubsystem;
  /** The session write: starting one agent and stopping it. A SEND is not here — the lifecycle
   *  delivers turn one and has no method for a later turn. */
  readonly sessionControl: SessionControlSubsystem;
  /** Reviving a stopped or dead session with its conversation intact, and typing a next turn into a
   *  live one. This is the nearest thing the daemon has to a send: the resume domain plans one when
   *  the pane it found is genuinely alive rather than replacing it. */
  readonly sessionResume: SessionResumeSubsystem;
  /** Moving a session onto another account: the in-flight safety gate, the restamped configuration
   *  document, and the relaunch that puts a different agent in the same session's chair. */
  readonly sessionMigrate: SessionMigrateSubsystem;
  /** The task record boards: one per session, plus the fleet-wide read across all of them. */
  readonly tasks: TaskSubsystem;
  /** The shared task-board MEMBERSHIP lifecycle — who is on a board and what they may do — as
   *  distinct from `tasks`, which is the records themselves. Three of the CLI's eleven board routes
   *  are not served; the mount's own header names each one and why. */
  readonly taskBoards: TaskBoardSubsystem;
  /** The fleet-wide analytics read over every finished session's durable record. */
  readonly analytics: AnalyticsSubsystem;
  /** Independent shell terminals attached to a session's working directory. */
  readonly terminals: TerminalSubsystem;
  /** The daemon-global human browser-login window: a private X display, served over loopback VNC, that
   *  a person signs into by hand so the agent's browser profile is primed. Per-session browser
   *  AUTOMATION is not mounted — the mount's own header names what is missing and why. */
  readonly browserLogin: BrowserLoginLifecycle;
  /** Free teammate callsigns, for composing a session title before starting one. */
  readonly names: NameSubsystem;
  /** The learning review board: the evidence the daemon holds, and a human's verdict on each rule
   *  it proposes. Mining itself is not mounted — see the mount's own header. */
  readonly learning: LearningSubsystem;
  /** The team recommender over the published fleet manifest and the operator's routing catalog. */
  readonly recommend: RecommendSubsystem;
  /** Dictation: the Whisper worker, the model store, and the enhancement pass. Its routes are the
   *  daemon's only BYTE-shaped ones, so they are served from the raw table rather than this one —
   *  see `mounts/stt.ts`. */
  readonly stt: SttSubsystem;
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
    // The daemon's own health sits with the base feeds it completes: `/healthz` is the public
    // liveness answer, and this is the scoped report the protocol declares under the same subject.
    // Both are fixed literals, so neither can shadow or be shadowed by a subsystem pattern.
    ...daemonHealthRoutes(subsystems.health),
    // The session read comes first among the subsystems: `/v1/sessions` is a fixed literal, and the
    // id pattern beneath it matches one segment, so neither can be shadowed by — or shadow — the
    // deeper per-session routes that follow.
    ...sessionRoutes(subsystems.sessions),
    ...catalogRoutes(subsystems.catalogs, subsystems.sessions),
    // The write surface registers AFTER the read for the same reason the read comes first: `POST
    // /v1/sessions` is a fixed literal and the stop is a deeper pattern, so neither shadows the
    // other and both sit above every per-session subsystem that follows.
    ...sessionControlRoutes(subsystems.sessionControl),
    // The revive registers with the rest of the write surface, above every per-session subsystem, so
    // its one-segment pattern sits beside the stop it is the counterpart of rather than below the
    // deeper patterns. Neither can shadow the other: they differ in their final literal segment.
    ...sessionResumeRoutes(subsystems.sessionResume),
    // The migration registers beside the revive it is built on: both are one-segment patterns under
    // `/v1/sessions/:sessionId` that differ only in their final literal, so neither can shadow the
    // other, and both belong above the deeper per-session subsystems.
    ...sessionMigrateRoutes(subsystems.sessionMigrate),
    ...attentionRoutes(subsystems.attention),
    ...pinRoutes(subsystems.pins),
    ...taskRoutes(subsystems.tasks),
    // The board membership surface registers beside the records it governs. Every path is under
    // `/v1/task-boards`, which no other subsystem uses, so it can neither shadow nor be shadowed —
    // and its own fixed literals are registered before its deeper patterns.
    ...taskBoardRoutes(subsystems.taskBoards),
    ...analyticsRoutes(subsystems.analytics),
    ...terminalRoutes(subsystems.terminals),
    // The login window is a fixed literal under `/v1/browser`, which no other subsystem uses, so it
    // can neither shadow nor be shadowed. Its per-session refusal is a deeper pattern ending in the
    // literal `browser`, which distinguishes it from every other `/v1/sessions/:id/...` route above.
    ...browserLoginRoutes(subsystems.browserLogin),
    ...nameRoutes(subsystems.names),
    ...learningRoutes(subsystems.learning),
    ...recommendRoutes(subsystems.recommend),
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

/**
 * Every route that reads and writes the transport's own bytes rather than an `ApiResponse`.
 *
 * A THIRD table for the same reason there is a second: the three answer different questions. An
 * `ApiRoute` returns a string body, a `SocketRoute` returns something that keeps talking, and a
 * `RawRoute` returns a response the daemon cannot express as a string at all. Dictation is the only
 * one today; it is the only mounted subsystem whose traffic is audio and model files.
 */
export function mountedRawRoutes(subsystems: MountedSubsystems): readonly RawRoute[] {
  return [...sttRawRoutes(subsystems.stt)];
}

/** The raw dispatcher the transport adapter serves, over the same credentials as the other two. */
export function createMountedRawDispatcher(
  base: DaemonApiDependencies,
  subsystems: MountedSubsystems,
): ApiRawDispatcher {
  return new ApiRawDispatcher(new ApiRouter(mountedRawRoutes(subsystems)), base.credentials);
}
