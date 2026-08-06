import type { DaemonCarrier } from '@ferretry/protocol';
import type { AnalyticsIngestionLoop } from '../../analytics/ingestion.ts';
import type { CapabilityGuard } from '../../api/capability.ts';
import { ApiDispatcher } from '../../api/dispatcher.ts';
import type { ApiRoute } from '../../api/route.ts';
import { ApiRouter } from '../../api/router.ts';
import { type DaemonApiDependencies, daemonApiRoutes } from '../../api/server.ts';
import { ApiSocketDispatcher, type SocketRoute } from '../../api/socket.ts';
import type { SocketTicketRedeemer } from '../../api/socket-ticket.ts';
import type { AttentionService } from '../../attention/index.ts';
import type { BrowserLoginLifecycle } from '../../browser/control/index.ts';
import type { FleetRefreshLoop } from '../../fleet-refresh/index.ts';
import type { HandoverReconcileLoop } from '../../handover/index.ts';
import type { PinService } from '../../pins/index.ts';
import type { QuotaFailoverLoop } from '../../quota-failover/index.ts';
import type { SessionFilesystem } from '../../session/filesystem/index.ts';
import type { MonitorLoop } from '../../session/monitor/types.ts';
import type { OperatorReadService } from '../../session/reads/index.ts';
import { type AnalyticsSubsystem, analyticsRoutes } from './analytics.ts';
import { attentionRoutes } from './attention.ts';
import { type BrowserMountedSubsystem, browserLoginRoutes, browserSocketRoutes } from './browser-login.ts';
import { carrierRoutes } from './carriers.ts';
import { type CatalogSubsystem, catalogRoutes } from './catalogs.ts';
import { type CgroupSubsystem, cgroupRoutes } from './cgroups.ts';
import { type DoctorSubsystem, doctorRoutes } from './doctor.ts';
import { type FleetSubsystem, fleetRoutes } from './fleet.ts';
import { type FleetEventStreamSubsystem, fleetEventSocketRoutes } from './fleet-events.ts';
import { type GrantSubsystem, grantRoutes } from './grants.ts';
import { type ForeignHistorySubsystem, foreignHistoryRoutes } from './foreign-history.ts';
import { type DaemonHealthSubsystem, daemonHealthRoutes } from './health.ts';
import { type LearningSubsystem, learningRoutes } from './learning.ts';
import { type NameSubsystem, nameRoutes } from './names.ts';
import { type PairingSubsystem, pairingRoutes } from './pairing.ts';
import { pinRoutes } from './pins.ts';
import { type PushSubscriptionSubsystem, pushRoutes } from './push.ts';
import { type RecommendSubsystem, recommendRoutes } from './recommend.ts';
import { type ScratchGcSubsystem, scratchGcRoutes } from './scratch-gc.ts';
import { type SecretSubsystem, secretRoutes } from './secrets.ts';
import { type SessionAnswerSubsystem, sessionAnswerRoutes } from './session-answer.ts';
import { type SessionAttachSubsystem, sessionAttachRoutes } from './session-attach.ts';
import { type SessionAttachmentSubsystem, sessionAttachmentRoutes } from './session-attachments.ts';
import { type SessionControlSubsystem, sessionControlRoutes } from './session-control.ts';
import { sessionFilesystemRoutes } from './session-filesystem.ts';
import { type SessionHandoverSubsystem, sessionHandoverRoutes } from './session-handover.ts';
import { type SessionMigrateSubsystem, sessionMigrateRoutes } from './session-migrate.ts';
import { sessionReadRoutes } from './session-reads.ts';
import { type SessionResumeSubsystem, sessionResumeRoutes } from './session-resume.ts';
import { type SessionRuntimeSubsystem, sessionRuntimeRoutes } from './session-runtime.ts';
import { type SessionSendSubsystem, sessionSendRoutes } from './session-send.ts';
import { type SessionSignalSubsystem, sessionSignalRoutes } from './session-signal.ts';
import { type SessionDirectorySubsystem, sessionRoutes } from './sessions.ts';
import { type SocketTicketSubsystem, socketTicketRoutes } from './socket-tickets.ts';
import { type SttEnhancementSubsystem, sttEnhancementRoutes } from './stt.ts';
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

/**
 * Everything the daemon process must already hold for its mounted surface to be real. One field per
 * dependency; the field's PRESENCE is the proof that production constructs it, and a required field is
 * how a capability stops being buildable-but-unreachable.
 *
 * MOST FIELDS ARE SUBSYSTEMS — an object with behaviour, which a route calls. A few are plain VALUES,
 * because what the surface needs is a fact rather than a collaborator: `carriers` is the set of ways
 * this daemon can be reached, resolved once at boot and constant afterwards. Declaring such a fact as a
 * subsystem with a getter would be strictly worse than declaring the value: two calls may answer
 * differently, and the pairing response and the refresh route would stop describing the same daemon.
 * The rule the list actually enforces is "nothing here may be absent from production", not "everything
 * here has methods".
 */
export interface MountedSubsystems {
  /** The daemon's own health, over the self-check that measures it. */
  readonly health: DaemonHealthSubsystem;
  /** Host dependencies, diagnosed for this daemon's own machine. */
  readonly doctor: DoctorSubsystem;
  /** Short-lived pairing codes, durable device grants and their host-local observation surface. */
  readonly pairing: PairingSubsystem;
  /** The other direction of that relationship: which browsers this daemon may WAKE. It serves the
   *  application-server key a browser subscribes with, the enrolments filed against paired devices,
   *  and the revocation of one. An enrolment cannot outlive the device grant that made it — see
   *  `src/lib/push` for the two independent reasons that holds, and for the declared GAPs: nothing in
   *  production raises a notification yet, and the browser has no service worker to receive one. */
  readonly push: PushSubscriptionSubsystem;
  /** Every way this daemon can be reached, as the daemon itself publishes it. NOT A SUBSYSTEM BUT A
   *  VALUE, and the only field here that is one: it is resolved once at boot and it is THE SAME ARRAY
   *  the pairing service hands out on redemption, so the set a device is given and the set it later
   *  refreshes cannot be two answers. A daemon that published its carriers only at pairing time had no
   *  way to tell an already-paired phone that its rendezvous had changed. */
  readonly carriers: readonly DaemonCarrier[];
  /** Declared fleet evidence, the shared pure plan, usage, and host-local provisioning. */
  readonly fleet: FleetSubsystem;
  /** How much of this machine the managed fleet may take: the aggregate every agent shares, the
   *  ceiling on any one of them, and whether either is enforced. It is the read side of the same
   *  seam the session launch uses — one saved document, one conversion to host-manager properties —
   *  so what the settings panel reports is what the next launch will write. This daemon and the
   *  supervision it runs are outside the capped slice, and the surface PROVES both from placements
   *  rather than repeating the claim. */
  readonly cgroups: CgroupSubsystem;
  /** The daemon-scoped timer target that refreshes the mounted fleet's quota and health evidence.
   *  It serves no route: an unattended pass exists to make the existing routes current before anyone
   *  asks them. Keeping it here proves production constructs it rather than leaving a dead timer. */
  readonly fleetRefresh: FleetRefreshLoop;
  /** Read-only Claude/Codex conversations that existed before Ferretry. */
  readonly foreignHistory: ForeignHistorySubsystem;
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
  /** Answering a live structured form, after a pane-bound confirmation. */
  readonly sessionAnswer: SessionAnswerSubsystem;
  /** Durable encrypted attachment originals plus process-local unlock state. */
  readonly sessionAttachments: SessionAttachmentSubsystem;
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
  /** Changing what a RUNNING session is running: which model, and how hard it thinks. Independent
   *  controls, because the browser offers them as two chips and the harnesses genuinely differ —
   *  one takes a native command, the other has only a modal picker to drive. It also serves the
   *  live catalog those choices come from, which is the account's own answer rather than a table
   *  in this repository. */
  readonly sessionRuntime: SessionRuntimeSubsystem;
  /** Moving a session onto another account: the in-flight safety gate, the restamped configuration
   *  document, and the relaunch that puts a different agent in the same session's chair. */
  readonly sessionMigrate: SessionMigrateSubsystem;
  /** The operation a migration cannot be: moving a top-level session to a DIFFERENT harness family,
   *  where the conversation is exactly the thing that cannot come along. It starts a replacement,
   *  carries every durable coordination fact into it, proves the replacement holds and can use the
   *  predecessor's board membership, and only then retires the predecessor — so the board and its
   *  tasks never move. The three routes begin one, read its durable receipt, and cancel one that has
   *  not passed the point of no return; the proof itself is deliberately not a route. */
  readonly handover: SessionHandoverSubsystem;
  /** The other half of that operation, and the reason a handover survives a caller hanging up: the
   *  tick that drives every receipt which is not yet terminal through the next step of its ladder. It
   *  serves no route — a handover advances on a timer and on an inbound board verification, not on a
   *  request — and it is a mounted subsystem for the reason `monitor` and `quotaFailover` are: a
   *  background loop nothing constructs is the same absent capability as an unserved route, and a
   *  handover nothing advanced would stop at `requested` forever. */
  readonly handoverReconcile: HandoverReconcileLoop;
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
  /** One browser host per daemon, owning the real worker, page projection and viewer socket. */
  readonly browser: BrowserMountedSubsystem;
  /** Free teammate callsigns, for composing a session title before starting one. */
  readonly names: NameSubsystem;
  /** The learning review board: the evidence the daemon holds, and a human's verdict on each rule
   *  it proposes. Mining itself is not mounted — see the mount's own header. */
  readonly learning: LearningSubsystem;
  /** The team recommender over the published fleet manifest and the operator's routing catalog. */
  readonly recommend: RecommendSubsystem;
  /** Dictation's one daemon-side half: the hosted-model pass that repairs a transcript. Recognition
   *  happens in the browser, so what is left is the call the browser cannot make — it needs a
   *  provider credential only this daemon holds. See `mounts/stt.ts`. */
  readonly sttEnhancement: SttEnhancementSubsystem;
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
  /**
   * What this machine has agreed a caller who is NOT on it may do.
   *
   * TWO ROLES IN ONE FIELD, and both are load-bearing. It serves the routes a UI reads to explain its
   * own limits, and it IS the `CapabilityGuard` the authorization boundary consults before every
   * governed request and every socket upgrade. Separating them would let a daemon serve a grant report
   * that no route was actually enforcing — a display with no evidence behind it, which is the exact
   * shape of bug this migration has already hit three times.
   */
  readonly grants: GrantSubsystem & CapabilityGuard;
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
    // Pairing is public redemption plus the code and device operations that produce and end the
    // credentials it hands out. It sits beside the base surface because it establishes the credential
    // every remote route later sees — and it is governed by the `pairing` capability rather than by the
    // `host` scope, because a browser is always a paired device and could otherwise never add a second
    // one. See the mount's header for why that is the correct layer.
    ...pairingRoutes(subsystems.pairing),
    // Push enrolment registers beside pairing because it is the same subject: only a paired device may
    // enrol, and its enrolment dies with its grant. Every path is under `/v1/push`, which no other
    // subsystem uses, and its one pattern is registered after its two fixed literals — so it can
    // neither shadow nor be shadowed by anything here.
    ...pushRoutes(subsystems.push),
    // The grant surface sits beside pairing for the same reason pairing sits beside the base feeds:
    // it establishes what the credential pairing hands out is then ALLOWED to do. Every path is under
    // `/v1/grants`, which no other subsystem uses, so it can neither shadow nor be shadowed. It is
    // registered EARLY and is itself ungoverned so a restricted UI can always read the reason it is
    // restricted — a grant report a restricted caller could not fetch would be the greyed control
    // with no explanation this whole feature exists to remove.
    ...grantRoutes(subsystems.grants),
    // The carrier refresh sits beside pairing because it is the SECOND half of one exchange: pairing
    // hands a device the set of ways to reach this daemon, and this is where that device asks again
    // when the set has changed. `/v1/carriers` is a fixed literal no other subsystem uses, so it can
    // neither shadow nor be shadowed. It is authenticated rather than operator-scoped — the remote
    // device is the reader, and nothing here is a secret. See the mount's own header.
    ...carrierRoutes(subsystems.carriers),
    // The daemon's own health sits with the base feeds it completes: `/healthz` is the public
    // liveness answer, and this is the scoped report the protocol declares under the same subject.
    // Both are fixed literals, so neither can shadow or be shadowed by a subsystem pattern.
    ...daemonHealthRoutes(subsystems.health),
    ...doctorRoutes(subsystems.doctor),
    // Fleet paths are fixed literals under their own namespace and disclose operator configuration,
    // so their mount owns the admin scope and cannot shadow any session route below.
    ...fleetRoutes(subsystems.fleet),
    // Resource limits register beside the fleet they bound, and are governed by the same capability
    // for the same reason: this is a machine-wide setting about the agents this daemon runs. Both
    // paths are the one fixed literal `/v1/cgroups/config`, which no other subsystem uses, so this
    // table can neither shadow nor be shadowed by anything around it.
    ...cgroupRoutes(subsystems.cgroups),
    // Imported harness history is intentionally outside `/v1/sessions`: no foreign transcript has
    // the journal/pane evidence a managed session requires, so it cannot acquire live controls by
    // looking like one.
    ...foreignHistoryRoutes(subsystems.foreignHistory),
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
    // The handover registers immediately after the migration it is the cross-family counterpart of, so
    // the two operations a caller chooses between sit together. Its three paths are one and two
    // segments under `/v1/sessions/:sessionId` ending in the literal `handover` — and `handover/cancel`
    // beneath it, registered in the same table after its parent — so none can shadow or be shadowed by
    // the migrate above or the deeper per-session subsystems below.
    ...sessionHandoverRoutes(subsystems.handover),
    // The runtime controls register beside the migration, and for the same reason: both change what
    // is running in a session that already exists. Both paths are one-segment patterns under
    // `/v1/sessions/:sessionId` whose final literals (`runtime`, `runtime-models`) no other route
    // uses, and a literal segment is matched literally — so `runtime-models` can neither shadow nor
    // be shadowed by `runtime`, and neither can be swallowed by the one-segment `GET
    // /v1/sessions/:sessionId` above, which is a whole segment shallower.
    ...sessionRuntimeRoutes(subsystems.sessionRuntime),
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
    ...sessionAnswerRoutes(subsystems.sessionAnswer),
    // Attachment routes are mounted before sends may honour attachment ids. Their
    // deeper unlock path cannot shadow this one-segment upload route.
    ...sessionAttachmentRoutes(subsystems.sessionAttachments),
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
    ...browserLoginRoutes(subsystems.browserLogin, subsystems.browser, subsystems.socketTickets),
    ...nameRoutes(subsystems.names),
    ...learningRoutes(subsystems.learning),
    ...recommendRoutes(subsystems.recommend),
    // Dictation enhancement is a fixed literal under `/v1/stt`, which no other subsystem uses, so it
    // can neither shadow nor be shadowed by anything around it. It registers with the daemon-wide
    // surfaces rather than among the per-session ones because it belongs to the MACHINE: the
    // credential it spends is the operator's, and no session owns a transcript.
    ...sttEnhancementRoutes(subsystems.sttEnhancement),
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
  // The guard is the SUBSYSTEM itself, so the answer a route enforces and the answer the report shows
  // are one object rather than two that can drift.
  return new ApiDispatcher(new ApiRouter(mountedDaemonRoutes(base, subsystems)), base.credentials, subsystems.grants);
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
    ...browserSocketRoutes(subsystems.browser),
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
    // The SAME guard the request/response table uses. A terminal socket that skipped it would let a
    // browser drive a shell this machine had refused to let it open.
    subsystems.grants,
  );
}

// THERE IS NO THIRD TABLE ANY MORE, and this note is here because its absence is a decision rather
// than an omission. A raw route — one that answered with the transport's own `Response` because its
// traffic could not be a string — existed for exactly one subsystem: the daemon's speech
// recognition, which streamed audio in under a byte budget and served ranged model files out.
// Recognition moved into the browser, its routes are gone, and the only survivor
// (`POST /v1/stt/enhance`) is JSON in and JSON out, so it is an ordinary `ApiRoute` above.
//
// The seam was deleted with it rather than kept: a route table with no members is machinery that
// looks like a capability, and this repository's own doctrine treats a constructed-but-uncalled
// capability as a defect. Reviving it is a small, honest change — the git history holds the
// dispatcher, the `ApiSurface` field and the adapter branch — and the subsystem that needs bytes
// again should bring it back with its own first member.
