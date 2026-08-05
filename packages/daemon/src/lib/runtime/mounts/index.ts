import type { AnalyticsIngestionLoop } from '../../analytics/ingestion.ts';
import { ApiDispatcher } from '../../api/dispatcher.ts';
import { ApiRawDispatcher, type RawRoute } from '../../api/raw.ts';
import type { ApiRoute } from '../../api/route.ts';
import { ApiRouter } from '../../api/router.ts';
import { type DaemonApiDependencies, daemonApiRoutes } from '../../api/server.ts';
import { ApiSocketDispatcher, type SocketRoute } from '../../api/socket.ts';
import type { SocketTicketRedeemer } from '../../api/socket-ticket.ts';
import type { AttentionService } from '../../attention/index.ts';
import type { BrowserLoginLifecycle } from '../../browser/control/index.ts';
import type { PinService } from '../../pins/index.ts';
import type { QuotaFailoverLoop } from '../../quota-failover/index.ts';
import type { SessionFilesystem } from '../../session/filesystem/index.ts';
import type { MonitorLoop } from '../../session/monitor/types.ts';
import type { OperatorReadService } from '../../session/reads/index.ts';
import { type AnalyticsSubsystem, analyticsRoutes } from './analytics.ts';
import { attentionRoutes } from './attention.ts';
import { browserLoginRoutes } from './browser-login.ts';
import { type CatalogSubsystem, catalogRoutes } from './catalogs.ts';
import { type FleetSubsystem, fleetRoutes } from './fleet.ts';
import { type FleetEventStreamSubsystem, fleetEventSocketRoutes } from './fleet-events.ts';
import { type DaemonHealthSubsystem, daemonHealthRoutes } from './health.ts';
import { type LearningSubsystem, learningRoutes } from './learning.ts';
import { type NameSubsystem, nameRoutes } from './names.ts';
import { type PairingSubsystem, pairingRoutes } from './pairing.ts';
import { pinRoutes } from './pins.ts';
import { type RecommendSubsystem, recommendRoutes } from './recommend.ts';
import { type ScratchGcSubsystem, scratchGcRoutes } from './scratch-gc.ts';
import { type SecretSubsystem, secretRoutes } from './secrets.ts';
import { type SessionAttachSubsystem, sessionAttachRoutes } from './session-attach.ts';
import { type SessionControlSubsystem, sessionControlRoutes } from './session-control.ts';
import { sessionFilesystemRoutes } from './session-filesystem.ts';
import { type SessionMigrateSubsystem, sessionMigrateRoutes } from './session-migrate.ts';
import { sessionReadRoutes } from './session-reads.ts';
import { type SessionResumeSubsystem, sessionResumeRoutes } from './session-resume.ts';
import { type SessionSendSubsystem, sessionSendRoutes } from './session-send.ts';
import { type SessionSignalSubsystem, sessionSignalRoutes } from './session-signal.ts';
import { type SessionDirectorySubsystem, sessionRoutes } from './sessions.ts';
import { type SocketTicketSubsystem, socketTicketRoutes } from './socket-tickets.ts';
import { type SttSubsystem, sttRawRoutes } from './stt.ts';
import { type TaskBoardSubsystem, taskBoardRoutes } from './task-boards.ts';
import { type TaskSubsystem, taskRoutes } from './tasks.ts';
import { type TerminalSubsystem, terminalRoutes, terminalSocketRoutes, terminalTicketRoutes } from './terminals.ts';
import { type WardenSubsystem, wardenRoutes } from './warden.ts';

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
  /** Short-lived pairing codes, durable device grants and their host-local observation surface. */
  readonly pairing: PairingSubsystem;
  /** Declared fleet evidence, the shared pure plan, usage, and host-local provisioning. */
  readonly fleet: FleetSubsystem;
  readonly attention: AttentionService;
  readonly pins: PinService;
  /** The session read: what the fleet holds, and one session in full. */
  readonly sessions: SessionDirectorySubsystem;
  /** Daemon-local project and per-session skill catalogs. */
  readonly catalogs: CatalogSubsystem;
  /** The session write: starting one agent and stopping it. */
  readonly sessionControl: SessionControlSubsystem;
  /** Talking to a session that is already running: handing it a later turn, and stopping the turn it
   *  is on. The verb the client has always posted and the daemon has never answered — and the one a
   *  declared wait on a peer needs, because the reply that ends such a wait IS a send. */
  readonly sessionSend: SessionSendSubsystem;
  /** Reviving a stopped or dead session with its conversation intact, and typing a next turn into a
   *  live one. This is the nearest thing the daemon has to a send: the resume domain plans one when
   *  the pane it found is genuinely alive rather than replacing it. */
  readonly sessionResume: SessionResumeSubsystem;
  /** What a session says about ITSELF: it finished, it is parked, it is stuck, it is working again.
   *  The only path that can write `completed`, and the only one that can declare the wait the warden
   *  detector was already built to read. */
  readonly sessionSignal: SessionSignalSubsystem;
  /** The declared-wait watcher: the tick that makes `signal waiting` end. It serves no route — a park
   *  is ended by a timer, not by a request — and it is a mounted subsystem for exactly that reason.
   *  A background loop nothing constructs is the same absent capability as an unserved route, and
   *  before this field the daemon recorded every park and woke none of them. */
  readonly monitor: MonitorLoop;
  /** Moving a session onto another account: the in-flight safety gate, the restamped configuration
   *  document, and the relaunch that puts a different agent in the same session's chair. */
  readonly sessionMigrate: SessionMigrateSubsystem;
  /** The other half of that operation: NOTICING that an account has measurably run out of tokens and
   *  moving its sessions onto a pooled same-kind account with confirmed headroom — through the same
   *  migration above, preflight included. It serves no route, and it is a mounted subsystem for the
   *  reason `monitor` is: a background loop nothing constructs is the same absent capability as an
   *  unserved route, and before this field `fy migrate` was a manual operation with nothing watching
   *  the quota that makes it necessary. */
  readonly quotaFailover: QuotaFailoverLoop;
  /** The task record boards: one per session, plus the fleet-wide read across all of them. */
  readonly tasks: TaskSubsystem;
  /** The shared task-board MEMBERSHIP lifecycle — who is on a board and what they may do — as
   *  distinct from `tasks`, which is the records themselves. Three of the CLI's eleven board routes
   *  are not served; the mount's own header names each one and why. */
  readonly taskBoards: TaskBoardSubsystem;
  /** The fleet-wide analytics read over every finished session the daemon has ingested. */
  readonly analytics: AnalyticsSubsystem;
  /** The other half of analytics: the pass that PUTS a finished session in the store, folding its
   *  transcript once and pricing it at the rates in force when the row was written. It serves no route
   *  — nobody asks for an ingestion — and it is a mounted subsystem for the reason `monitor` and
   *  `quotaFailover` are: a background loop nothing constructs is the same absent capability as an
   *  unserved route, and an analytics store nothing writes to answers every query with an empty fleet. */
  readonly analyticsIngest: AnalyticsIngestionLoop;
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
  /** One session's working tree, read-only and confined by descriptor: a listing, one file, the change
   *  list and one path's diff. The confinement is the feature — see `src/lib/session/filesystem`. */
  readonly sessionFilesystem: SessionFilesystem;
  /** Expired session scratch, planned or reclaimed only after all safety gates pass. */
  readonly scratchGc: ScratchGcSubsystem;
  /** The daemon's secret store, and the use-without-read primitive that is the point of it: an agent
   *  names a secret, the daemon spawns a child holding the value, and only that child's scrubbed
   *  output comes back. NOTHING here can project a value — see `mounts/secrets.ts` for why that is a
   *  property of the types rather than a rule, and for the boundary it does and does not draw. */
  readonly secrets: SecretSubsystem;
  /** Fleet supervision: the deterministic anomaly sweep, the wardens it spawns to judge a suspect
   *  session, and the operator configuration that decides whether it may spend a session at all. The
   *  subsystem owns the sweep TIMER as well as the routes — a supervision loop with no route would be
   *  invisible to the reachability gate, which is how a background subsystem ships unmounted. */
  readonly warden: WardenSubsystem;
  /** How a human watches one session: what the daemon recorded, what its screen shows now, and what the
   *  agent itself wrote. Every one of these refuses rather than answering blank — see the domain's own
   *  header for why a dead pane and an unresolved transcript are errors and an empty event page is not. */
  readonly sessionReads: OperatorReadService;
  /** A short-lived, freshly validated tmux identity for a local human attach. */
  readonly sessionAttach: SessionAttachSubsystem;
  /** This daemon's bounded recent event tail followed by its own live journal appends. */
  readonly fleetEvents: FleetEventStreamSubsystem;
  /** The credential a browser CAN carry onto an upgrade. One subsystem serves both halves of the
   *  exchange: the route below sells a ticket, and the socket dispatcher is the only boundary handed
   *  the redeemer — which is what keeps a ticket useless against an ordinary route. */
  readonly socketTickets: SocketTicketSubsystem & SocketTicketRedeemer;
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
    // Pairing is three fixed paths: public redemption and two host-local admin operations. It sits
    // beside the base surface because it establishes the credential every remote route later sees.
    ...pairingRoutes(subsystems.pairing),
    // The daemon's own health sits with the base feeds it completes: `/healthz` is the public
    // liveness answer, and this is the scoped report the protocol declares under the same subject.
    // Both are fixed literals, so neither can shadow or be shadowed by a subsystem pattern.
    ...daemonHealthRoutes(subsystems.health),
    // Fleet paths are fixed literals under their own namespace and disclose operator configuration,
    // so their mount owns the admin scope and cannot shadow any session route below.
    ...fleetRoutes(subsystems.fleet),
    ...scratchGcRoutes(subsystems.scratchGc),
    // Every secret path is under `/v1/secrets`, which no other subsystem uses, so this table can
    // neither shadow nor be shadowed by anything around it. It registers with the daemon-wide
    // surfaces above rather than among the per-session ones because a secret belongs to the MACHINE:
    // it is not addressed by a session, and no session owns one.
    ...secretRoutes(subsystems.secrets),
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
    // The signal registers with the rest of the write surface for the same reason the revive and the
    // migration do: it is a one-segment pattern under `/v1/sessions/:sessionId` whose final literal
    // (`signal`) no other route uses, so it can neither shadow nor be shadowed, and it belongs above
    // the deeper per-session subsystems.
    ...sessionSignalRoutes(subsystems.sessionSignal),
    // The send and the interrupt register with the rest of the write surface, for the reason the
    // revive, the migration and the signal all do: each is a one-segment pattern under
    // `/v1/sessions/:sessionId` whose final literal no other route uses, so none can shadow or be
    // shadowed, and all belong above the deeper per-session subsystems.
    ...sessionSendRoutes(subsystems.sessionSend),
    ...attentionRoutes(subsystems.attention),
    ...pinRoutes(subsystems.pins),
    ...taskRoutes(subsystems.tasks),
    // The board membership surface registers beside the records it governs. Every path is under
    // `/v1/task-boards`, which no other subsystem uses, so it can neither shadow nor be shadowed —
    // and its own fixed literals are registered before its deeper patterns.
    ...taskBoardRoutes(subsystems.taskBoards),
    ...analyticsRoutes(subsystems.analytics),
    ...terminalRoutes(subsystems.terminals),
    ...terminalTicketRoutes(subsystems.terminals, subsystems.socketTickets),
    // The login window is a fixed literal under `/v1/browser`, which no other subsystem uses, so it
    // can neither shadow nor be shadowed. Its per-session refusal is a deeper pattern ending in the
    // literal `browser`, which distinguishes it from every other `/v1/sessions/:id/...` route above.
    ...browserLoginRoutes(subsystems.browserLogin),
    ...nameRoutes(subsystems.names),
    ...learningRoutes(subsystems.learning),
    ...recommendRoutes(subsystems.recommend),
    // The working-tree read registers last among the per-session subsystems: three of its four paths are
    // two segments deep under `/v1/sessions/:sessionId`, and its own deeper patterns are registered before
    // its one-segment `fs`, so nothing here can shadow or be shadowed.
    ...sessionFilesystemRoutes(subsystems.sessionFilesystem, subsystems.sessions),
    // Every warden path is under `/v1/warden`, which no other subsystem uses, so this table can
    // neither shadow nor be shadowed by anything above it.
    ...wardenRoutes(subsystems.warden),
    // The operator reads register last, beside the working-tree read they sit alongside. All three are
    // one-segment patterns under `/v1/sessions/:sessionId` whose final literals (`events`, `snapshot`,
    // `logs`) no other route uses, so they can neither shadow nor be shadowed by anything above.
    ...sessionReadRoutes(subsystems.sessionReads, subsystems.sessions),
    // The attach proof sits with the operator reads but is its own capability: unlike a screen or a
    // transcript it authorizes a local process action, and its mount revalidates the pane identity.
    ...sessionAttachRoutes(subsystems.sessionAttach, subsystems.sessions),
    // The event ticket counter for the socket table. `/v1/events/ticket` is a fixed literal that
    // only the request/response table carries — the socket table's `/v1/events` matches GET on one
    // segment less — so the two cannot shadow each other and a POST here is never an upgrade.
    ...socketTicketRoutes(subsystems.socketTickets),
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
  return [
    // Fixed literal first; it cannot shadow the deeper terminal pattern and makes the fleet feed's
    // optional session filter one route rather than a second dispatcher.
    ...fleetEventSocketRoutes(subsystems.fleetEvents, subsystems.sessions),
    ...terminalSocketRoutes(subsystems.terminals),
  ];
}

/**
 * The socket dispatcher the transport adapter serves, over the same credentials as the HTTP one —
 * plus the ticket redeemer, which is deliberately given to this boundary and to no other.
 */
export function createMountedSocketDispatcher(
  base: DaemonApiDependencies,
  subsystems: MountedSubsystems,
): ApiSocketDispatcher {
  return new ApiSocketDispatcher(
    new ApiRouter(mountedSocketRoutes(subsystems)),
    base.credentials,
    subsystems.socketTickets,
  );
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
