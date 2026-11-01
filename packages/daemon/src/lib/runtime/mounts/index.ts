import type { AgendaAgentClearer, AgendaRepliesSubsystem, AgendaService } from '../../agenda/index.ts';
import type { AgentToolService } from '../../agent-tools/service.ts';
import type { AgentIdentityResolver } from '../../agent-tools/types.ts';
import type { AnalyticsIngestionLoop } from '../../analytics/ingestion.ts';
import type { ApiCredentials } from '../../api/authentication.ts';
import type { CapabilityGuard } from '../../api/capability.ts';
import type { ResponseCompressor } from '../../api/compression.ts';
import { ApiDispatcher } from '../../api/dispatcher.ts';
import type { ApiRoute } from '../../api/route.ts';
import { ApiRouter } from '../../api/router.ts';
import { type DaemonApiDependencies, daemonApiRoutes } from '../../api/server.ts';
import { ApiSocketDispatcher, type SocketRoute } from '../../api/socket.ts';
import type { AuditedRoutesSubsystem } from '../../audit/index.ts';
import { auditedRoutes, auditedSocketRoutes } from '../../audit/routes.ts';
import type { BrowserLoginLifecycle } from '../../browser/control/index.ts';
import { type ConfigChangeSink, configAnnouncedRoutes } from '../../config-files/index.ts';
import type { AgentControlPolicy } from '../../fleet/agent-control.ts';
import type { FleetRefreshLoop } from '../../fleet-refresh/index.ts';
import type { HandoverReconcileLoop } from '../../handover/index.ts';
import type { HarnessUpdateSubsystem } from '../../harness-update/index.ts';
import type { PhoneApprovalService } from '../../input-requests/phone-approval.ts';
import type { InputRequestService } from '../../input-requests/service.ts';
import type { LegacyWireUseRecorder } from '../../legacy-wire/index.ts';
import { observedRoutes } from '../../performance/observed-routes.ts';
import type { PerformanceProbe } from '../../performance/recorder.ts';
import type { PinService } from '../../pins/index.ts';
import type { QuotaFailoverLoop } from '../../quota-failover/index.ts';
import type { CopyPlanService } from '../../secure-copy/plans.ts';
import type { PasteRuleService } from '../../secure-copy/rules.ts';
import type { SecuritySettingsService } from '../../security/index.ts';
import type { SharedDraftService } from '../../shared-drafts/index.ts';
import type { SessionFilesystem } from '../../session/filesystem/index.ts';
import type { MonitorLoop } from '../../session/monitor/types.ts';
import type { SessionObserverHost } from '../../session/observer/host.ts';
import type { QueueDeliverer } from '../../session/queue/deliverer.ts';
import type { OperatorReadService } from '../../session/reads/index.ts';
import type { SessionRuntimeSubsystem } from '../../session/runtime-control/types.ts';
import type { LegacySendReproof } from '../../session/send/reproof.ts';
import type { SendTrackingLoop } from '../../session/send/tracker.ts';
import type { TranscriptImages } from '../../session/transcript/image-reader.ts';
import type { StepUpService } from '../../step-up/index.ts';
import type { TunnelSwitchPort } from '../../tunnel/index.ts';
import type { DaemonUpdateSubsystem } from '../../update/index.ts';
import type { MillisecondClockPort } from '../boot.ts';
import type { PublishedCarrierView } from '../published-carriers.ts';
import { agendaRoutes, type DirectNotificationSubsystem } from './agenda.ts';
import { agendaClearRoutes } from './agenda-clear.ts';
import { configFilesConfirmations } from './agenda-confirms.ts';
import { agentControlledRoutes, agentControlledSockets } from './agent-control.ts';
import { agentToolRoutes, sessionCredentialDirectory } from './agent-tools.ts';
import { type AnalyticsSubsystem, analyticsRoutes } from './analytics.ts';
import { type AnalyticsPricingSubsystem, analyticsPricingRoutes } from './analytics-pricing.ts';
import { type AuditSubsystem, auditRoutes } from './audit.ts';
import { type BoardSubsystem, boardRoutes } from './board.ts';
import { type WorkSearchSubsystem, workSearchRoutes } from './work-search.ts';
import { type BoardProjectsSubsystem, type BoardSwitchSubsystem, boardProjectRoutes } from './board-projects.ts';
import { type BrowserMountedSubsystem, browserLoginRoutes, browserSocketRoutes } from './browser-login.ts';
import { type BrowserProxySubsystem, browserProxyRoutes } from './browser-proxy.ts';
import { carrierRoutes } from './carriers.ts';
import { type CatalogSubsystem, catalogRoutes } from './catalogs.ts';
import { type CgroupSubsystem, cgroupRoutes } from './cgroups.ts';
import { type ConfigFilesSubsystem, configFilesRoutes } from './config-files.ts';
import { type ConversationImportSubsystem, conversationImportRoutes } from './conversation-import.ts';
import { daemonUpdateRoutes } from './daemon-update.ts';
import { type DoctorSubsystem, doctorRoutes } from './doctor.ts';
import { type FleetCatalogSubsystem, fleetCatalogRoutes } from './fleet-catalog.ts';
import { type FleetCredentialsSubsystem, fleetCredentialRoutes } from './fleet-credentials.ts';
import {
  type ConfigChangeStreamSubsystem,
  type FleetEventStreamSubsystem,
  fleetEventSocketRoutes,
} from './fleet-events.ts';
import { type HarnessLoginSubsystem, harnessLoginRoutes } from './fleet-login.ts';
import { type FleetSetupSubsystem, fleetSetupRoutes } from './fleet-setup.ts';
import { type ForeignHistorySubsystem, foreignHistoryRoutes } from './foreign-history.ts';
import { type GrantSubsystem, grantRoutes } from './grants.ts';
import { harnessUpdateRoutes } from './harness-update.ts';
import { type DaemonHealthSubsystem, daemonHealthRoutes } from './health.ts';
import { inputRequestRoutes, phoneApprovalRoutes } from './input-requests.ts';
import { type LearningSubsystem, learningRoutes } from './learning.ts';
import { type LegacyTaskSubsystem, legacyTaskRoutes } from './legacy-tasks.ts';
import { type McpInventorySubsystem, mcpInventoryRoutes } from './mcp-inventory.ts';
import { type McpOAuthSubsystem, mcpOAuthRoutes } from './mcp-oauth.ts';
import { type ModelsSubsystem, modelRoutes } from './models.ts';
import { type NameSubsystem, nameRoutes } from './names.ts';
import { type PackSubsystem, packRoutes } from './pack.ts';
import { type DeviceGrantSubsystem, type PairingSubsystem, pairingRoutes } from './pairing.ts';
import { type PerformanceSubsystem, performanceRoutes } from './performance.ts';
import { pinRoutes } from './pins.ts';
import { type PushSubscriptionSubsystem, pushRoutes } from './push.ts';
import { type RecommendSubsystem, recommendRoutes } from './recommend.ts';
import { type ScratchGcSubsystem, scratchGcRoutes } from './scratch-gc.ts';
import { type SecretSubsystem, secretRoutes } from './secrets.ts';
import { sharedDraftRoutes } from './shared-drafts.ts';
import { type CatalogMemberSubsystem, catalogMemberRoutes } from './catalog-members.ts';
import { type SharedCatalogSubsystem, sharedCatalogRoutes } from './shared-catalogs.ts';
import { type CopyListing, type RuleProgramHomes, secureCopyRoutes } from './secure-copy.ts';
import { securityRoutes } from './security.ts';
import { type SessionAddressBook, sessionAddressedRoutes, sessionAddressedSockets } from './session-addressing.ts';
import { type SessionAgendaModeSubsystem, sessionAgendaModeRoutes } from './session-agenda-mode.ts';
import { type SessionAnswerSubsystem, sessionAnswerRoutes } from './session-answer.ts';
import { type SessionAttachSubsystem, sessionAttachRoutes } from './session-attach.ts';
import { type SessionAttachmentSubsystem, sessionAttachmentRoutes } from './session-attachments.ts';
import { type SessionConsoleSubsystem, sessionConsoleRoutes } from './session-console-input.ts';
import { knownLaunchRoots, type SessionControlSubsystem, sessionControlRoutes } from './session-control.ts';
import { type SessionDialogSubsystem, sessionDialogRoutes } from './session-dialog.ts';
import { type SessionMediaRoot, sessionFilesystemRoutes } from './session-filesystem.ts';
import { type SessionForkSubsystem, sessionForkRoutes } from './session-fork.ts';
import { type SessionHandoverSubsystem, sessionHandoverRoutes } from './session-handover.ts';
import { type SessionHypermediaSubsystem, sessionHypermediaRoutes } from './session-hypermedia.ts';
import { type CatalogInstallSubsystem, catalogInstallRoutes } from './catalog-installs.ts';
import { type SessionMcpSubsystem, sessionMcpRoutes } from './session-mcp.ts';
import { type SessionMigrateSubsystem, sessionMigrateRoutes } from './session-migrate.ts';
import { type SessionPermissionSubsystem, sessionPermissionRoutes } from './session-permission.ts';
import { type SessionProcessSubsystem, sessionProcessRoutes } from './session-processes.ts';
import { sessionReadRoutes } from './session-reads.ts';
import { type SessionRenameSubsystem, sessionRenameRoutes } from './session-rename.ts';
import { type SessionRestartSubsystem, sessionRestartRoutes } from './session-restart.ts';
import { type SessionResumeSubsystem, sessionResumeRoutes } from './session-resume.ts';
import { sessionRuntimeRoutes } from './session-runtime.ts';
import { type SessionSendSubsystem, sessionSendRoutes } from './session-send.ts';
import { type SessionSignalSubsystem, sessionSignalRoutes } from './session-signal.ts';
import { type SessionDirectorySubsystem, sessionRoutes } from './sessions.ts';
import { type SpeedupsSubsystem, speedupRoutes } from './speedups.ts';
import { stepUpRoutes } from './step-up.ts';
import { type SttEnhancementSubsystem, sttEnhancementRoutes } from './stt.ts';
import { type SystemOpenSubsystem, systemOpenRoutes } from './system-open.ts';
import { type TerminalSubsystem, terminalRoutes, terminalSocketRoutes } from './terminals.ts';
import { tunnelRoutes } from './tunnel.ts';
import { type WardenSubsystem, wardenRoutes } from './warden.ts';
import { type WebRtcSignallingSubsystem, webrtcRoutes } from './webrtc.ts';
import { type WorktreeSubsystem, worktreeRoutes } from './worktrees.ts';

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
  /** Counts the requests that reach a route kept only for older clients. Absent where nothing counts. */
  readonly legacyWire?: LegacyWireUseRecorder;
  /** Gzips a large `GET` answer for a caller that accepts it (`lib/api/compression.ts`). Absent where nothing compresses. */
  readonly compressor?: ResponseCompressor;
  /** Host dependencies, diagnosed for this daemon's own machine. */
  readonly doctor: DoctorSubsystem;
  /**
   * The daemon's own performance profile (`fy daemon profile`), and the probe every route is timed
   * into — the same recorder, so a profile sees every route the dispatcher below serves.
   */
  readonly performance: {
    readonly profiles: PerformanceSubsystem;
    readonly probe: PerformanceProbe;
    readonly clock: MillisecondClockPort;
  };
  /** Short-lived pairing codes, durable device grants and their host-local observation surface. */
  readonly pairing: PairingSubsystem;
  /** Each paired device's own grants, changed — `docs/design/zero-trust.md` B5. */
  readonly deviceGrants: DeviceGrantSubsystem;
  /** The other direction of that relationship: which browsers this daemon may WAKE. It serves the
   *  application-server key a browser subscribes with, the enrolments filed against paired devices,
   *  and the revocation of one. An enrolment cannot outlive the device grant that made it — see
   *  `src/lib/push` for the two independent reasons that holds. The browser still has no service
   *  worker to receive one. */
  readonly push: PushSubscriptionSubsystem;
  /** Passkeys and the step-up they prove — `docs/design/zero-trust.md` B2. */
  readonly stepUp: StepUpService;
  /** The machine's security settings — `docs/design/zero-trust.md` B6. */
  readonly security: SecuritySettingsService;
  /** Every way this daemon can be reached, as the daemon itself publishes it: THE SAME VIEW the pairing
   *  service hands out on redemption, so the set a device is given and the set it later refreshes are
   *  read from one owner. It changes while the daemon runs — a tunnel is published only while its
   *  connector is registered (`runtime/published-carriers.ts`). A daemon that published its carriers
   *  only at pairing time had no way to tell an already-paired phone that its reach had changed. */
  readonly carriers: PublishedCarrierView;
  /** Whether this machine runs a Cloudflare tunnel, and the switch that turns it on or off without a
   *  restart (`docs/relay-protocol.md` §15). The tunnel is opt-in. */
  readonly tunnel: TunnelSwitchPort;
  /** The peer-to-peer carrier's signalling: a paired device's offer in, this daemon's answer out
   *  (`docs/relay-protocol.md` §16). */
  readonly webrtc: WebRtcSignallingSubsystem;
  /** Driving a harness's OWN sign-in from a browser, holding no token. The daemon launches the
   *  harness's own login against one credential's store with piped stdio, publishes a verification
   *  URL — and for Codex a device code — accepts one short-lived authorization code straight into that
   *  child's stdin, and lets the harness write its own credential into its own store. Every route here
   *  is `configure`, which a caller off this host passes only behind the passkey step-up. */
  readonly harnessLogin: HarnessLoginSubsystem;
  /** Signing in to a remote MCP server from a browser, with the daemon as the OAuth client: tokens go
   *  straight into the secret store and are used by launch variable name (docs/mcp-oauth.md). Every act
   *  is `fleet.configure`. */
  readonly mcpOAuth: McpOAuthSubsystem;
  /** Every MCP server a ferret sees, from every scope, and checking one (docs/mcp-scopes.md). */
  readonly mcpInventory: McpInventorySubsystem;
  /** The account model's credentials: one login stored once, its status and usage, Check now, and
   *  sign-in targeting a credential id (docs/design/account-model.md §7). */
  readonly fleetCredentials: FleetCredentialsSubsystem;
  /** The account model's catalogue reads: the machine, its components, layered profiles and runtimes
   *  (docs/design/account-model.md §7). */
  readonly fleetCatalog: FleetCatalogSubsystem;
  /**
   * "What agents may control" (T), over this machine's own account model. NOT A SUBSYSTEM BUT A
   * PORT, like `carriers`: it serves no route of its own — Unit M's agent tool-call routes call it
   * directly — and keeping it here proves production constructs a real one rather than an
   * all-allowed stand-in nobody ever replaced.
   */
  readonly agentControl: AgentControlPolicy;
  /** The account model's first run and clone: the setup scan, tool install and the export bundle
   *  (docs/design/account-model.md §7). */
  readonly fleetSetup: FleetSetupSubsystem;
  /** How much of this machine the managed fleet may take: the aggregate every agent shares, the
   *  ceiling on any one of them, and whether either is enforced. It is the read side of the same
   *  seam the session launch uses — one saved document, one conversion to host-manager properties —
   *  so what the settings panel reports is what the next launch will write. This daemon and the
   *  supervision it runs are outside the capped slice, and the surface PROVES both from placements
   *  rather than repeating the claim. */
  readonly cgroups: CgroupSubsystem;
  /** The configuration files (docs/config-files.md): what is in effect and what is wrong, an edit, the
   *  owner's confirmation of an edit that loosens, and the agent's `config.*` tools. The subsystem owns
   *  the WATCHER as well as the routes, for the reason the warden owns its sweep. */
  readonly configFiles: ConfigFilesSubsystem;
  /** The daemon-scoped timer target that refreshes the daemon's quota evidence. It serves no route:
   *  an unattended pass exists to make the existing routes current before anyone asks them. Keeping
   *  it here proves production constructs it rather than leaving a dead timer. Account health is
   *  deliberately NOT part of it — that evidence costs a real model turn, so it is collected only for
   *  a caller who asked. */
  readonly fleetRefresh: FleetRefreshLoop;
  /** Read-only Claude/Codex conversations that existed before Ferretry. */
  readonly foreignHistory: ForeignHistorySubsystem;
  /** Existing Claude/Codex conversations the owner may keep as ferrets: listed, searched and adopted. */
  readonly conversationImport: ConversationImportSubsystem;
  readonly attention: AgendaService;
  /** Audited direct and committed-Agenda presentation through the sole push fan-out. */
  readonly notifications: DirectNotificationSubsystem;
  /** The owner's answers each ferret's outbox holds before delivering them as one message. */
  readonly agendaReplies: AgendaRepliesSubsystem;
  /** The owner's bulk "clear all from agent ferrets". */
  readonly agendaClearer: AgendaAgentClearer;
  readonly pins: PinService;
  /** The owner's unsent composer, shared live between their own devices and never journaled. */
  readonly sharedDrafts: SharedDraftService;
  /** The session read: what the fleet holds, and one session in full. */
  readonly sessions: SessionDirectorySubsystem;
  /** Which session an agent NAME addresses, for every route that takes a `:sessionId`. See
   *  `session-addressing.ts`. */
  readonly sessionAddresses: SessionAddressBook;
  /** Daemon-local project and per-session skill catalogs. */
  readonly catalogs: CatalogSubsystem;
  readonly boardProjects: BoardProjectsSubsystem;
  /** Whether each project uses the board (`docs/board.md` § The board is opt-in). */
  readonly boardSwitches: BoardSwitchSubsystem;
  /** The checkouts this daemon made: the durable registry, the live Git refresh over it, forking a
   *  new one and destroying one. It is mounted with the catalogs because it is the same subject seen
   *  from the other end — a managed worktree is joined to its Project by the repository identity the
   *  catalog already records, never by where the two happen to sit on disk. */
  readonly worktrees: WorktreeSubsystem;
  /** The session write: starting one agent and stopping it. */
  readonly sessionControl: SessionControlSubsystem;
  /** Talking to a session that is already running: handing it a later turn, and stopping the turn it
   *  is on. The verb the client has always posted and the daemon has never answered — and the one a
   *  declared wait on a peer needs, because the reply that ends such a wait IS a send. */
  readonly sessionSend: SessionSendSubsystem;
  /** Where each send WENT: the event-driven tracker that proves a send queued or delivered, re-types one
   *  proven absent, and settles the rest honestly. It is armed at boot because a restart owes every
   *  in-flight send a re-derivation from the transcript — never a re-typing. */
  readonly sendTracking: SendTrackingLoop;
  /** The one-time re-proof of the "not delivered" rows written before the queue: run in the background
   *  after the tracker is armed, and stopped on the way down (it finishes on the next start). */
  readonly sendReproof: Pick<LegacySendReproof, 'run' | 'stop'>;
  /**
   * The durable queue's deliverer: armed after the bind like every loop that can type into a pane, and
   * stopped FIRST on the way down, so a hand-over in flight is finished rather than cut in half.
   */
  readonly queueDelivery: Pick<QueueDeliverer, 'arm' | 'stop'>;
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
  /** Renaming an agent: a new first name, claimed through the same allocator a start uses, and a new
   *  task title. */
  readonly sessionRename: SessionRenameSubsystem;
  /** Whether a ferret keeps an agenda, from its next launch (docs/agenda.md). */
  readonly sessionAgendaMode: SessionAgendaModeSubsystem;
  /** Whether a ferret is told it may explain with hypermedia, from its next launch (docs/hypermedia.md). */
  readonly sessionHypermedia: SessionHypermediaSubsystem;
  /** Pack mode: its settings view, recommendations, sub-ferret starts, results and the per-ferret switch (docs/pack-mode.md). */
  readonly pack: PackSubsystem;
  /** Adding an MCP server for one ferret: to its project's `.mcp.json` (`filesystem`), or to its
   *  login's profile (`fleet`), each previewed before it is written. */
  readonly sessionMcp: SessionMcpSubsystem;
  /** Installing a skill or MCP setup from a signed catalog file: verified here, reviewed, then written
   *  only through the existing project and fleet write paths (docs/catalogs.md § The installer). */
  readonly catalogInstalls: CatalogInstallSubsystem;
  /** The declared-wait watcher: the tick that makes `signal waiting` end. It serves no route — a park
   *  is ended by a timer, not by a request — and it is a mounted subsystem for exactly that reason.
   *  A background loop nothing constructs is the same absent capability as an unserved route, and
   *  before this field the daemon recorded every park and woke none of them. */
  readonly monitor: MonitorLoop;
  /** The session observer: the ONE owner of whose turn it is in every live session — working, the
   *  person's turn, or blocked on a person — on the main thread or one worker per running session. It
   *  serves no route; the spinner, the status dots and the notifications read the field it writes, and
   *  the journal event it appends wakes every open page. `turns` is the 2 s turn tick `start` arms. */
  readonly observer: SessionObserverHost;
  /** Changing what a RUNNING session is running: which model, and how hard it thinks. Independent
   *  controls, because the browser offers them as two chips and the harnesses genuinely differ —
   *  one takes a native command, the other has only a modal picker to drive. It also serves the
   *  live catalog those choices come from, which is the account's own answer rather than a table
   *  in this repository. */
  readonly sessionRuntime: SessionRuntimeSubsystem;
  /** Moving a session onto another account: the in-flight safety gate, the restamped configuration
   *  document, and the relaunch that puts a different agent in the same session's chair. */
  readonly sessionMigrate: SessionMigrateSubsystem;
  /** Restarting the ferrets whose launch instructions are out of date: restart what is idle, queue what is busy. */
  readonly sessionRestart: SessionRestartSubsystem;
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
  /** A durable conversation fork creates a separate session without changing its source. */
  readonly sessionFork: SessionForkSubsystem;
  /** The other half of that operation: NOTICING that an account has measurably run out of tokens and
   *  moving its sessions onto a pooled same-kind account with confirmed headroom — through the same
   *  migration above, preflight included. It serves no route, and it is a mounted subsystem for the
   *  reason `monitor` is: a background loop nothing constructs is the same absent capability as an
   *  unserved route, and before this field `fy migrate` was a manual operation with nothing watching
   *  the quota that makes it necessary. */
  readonly quotaFailover: QuotaFailoverLoop;
  /** The retired per-session task store's two list reads, answered empty for older clients (see legacy-tasks.ts). */
  readonly legacyTasks: LegacyTaskSubsystem;
  /** The project boards (v2): every project's cards, one file per card, written under ownership and lineage. */
  readonly board: BoardSubsystem;
  /** One search over every card and agenda item (docs/work-search.md): the finder, `fy search` and the related check. */
  readonly workSearch: WorkSearchSubsystem;
  /** The board's GitHub watcher (board-design.md §3.1): it serves no route, and it is a mounted subsystem
   *  for the reason `handoverReconcile` is — a loop nothing arms is a watcher that never looks. */
  readonly boardGitHub: { arm(): () => void };
  /** The fleet-wide analytics read over every finished session the daemon has ingested. */
  readonly analytics: AnalyticsSubsystem;
  /** Operator-owned future pricing plus exact-preview synchronization from configured feeds. */
  readonly analyticsPricing: AnalyticsPricingSubsystem;
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
  /** "Test proxy" and the machine-wide browser state: owner-only, over fake-able ports. */
  readonly browserProxy: BrowserProxySubsystem;
  /** Terminals and browser pages driven by name — by an agent through its own session credential, and
   *  by a person through the CLI or the app — with take over / hand back. */
  readonly agentTools: { readonly service: AgentToolService; readonly identities: AgentIdentityResolver };
  /** The owner's answers to an agent's request for a password, a code or an answer (docs/input-requests.md). */
  readonly inputRequests: InputRequestService;
  /** Approving a sign-in on the phone (docs/input-requests.md, "Approve on your phone"); absent: no such routes. */
  readonly phoneApprovals?: PhoneApprovalService;
  /** Secure copy (docs/secure-copy.md): copies by description, pre-approval rules and paste plans. */
  readonly secureCopy: {
    readonly copies: CopyListing;
    readonly rules: PasteRuleService;
    readonly plans: CopyPlanService;
    /** Where a terminal rule's program lives, so a rule into the owner's own profile says so. */
    readonly homes?: RuleProgramHomes;
  };
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
  /** Optional provider keys (Jev, Groq, Cerebras): which are set, and a Test that spends one once through
   *  the daemon's outbound holder. No key travels on either route — see `mounts/speedups.ts`. */
  readonly speedups: SpeedupsSubsystem;
  /** The model catalogs in effect and the published catalog this machine follows (docs/model-catalog.md). */
  readonly models: ModelsSubsystem;
  /** How this machine's daemon was installed, the latest release, and starting an update. The
   *  subsystem owns its check loop as well as its routes — see `mounts/daemon-update.ts`. */
  readonly daemonUpdate: DaemonUpdateSubsystem;
  /** How this machine's `claude` and `codex` were installed, whether Ferretry verified their versions, and
   *  updating them on request. No loop: npm is asked only when somebody reads — see `mounts/harness-update.ts`. */
  readonly harnessUpdate: HarnessUpdateSubsystem;
  /** One session's working tree, read-only and confined by descriptor: a listing, one file, the change
   *  list and one path's diff. The confinement is the feature — see `src/lib/session/filesystem`. */
  readonly sessionFilesystem: SessionFilesystem;
  /** Names a session's media folder, which `/fs/file?scope=media` reads. Absent: no such folder. */
  readonly sessionMediaRoot?: SessionMediaRoot;
  /** Expired session scratch, planned or reclaimed only after all safety gates pass. */
  readonly scratchGc: ScratchGcSubsystem;
  /** Hands a web address to this computer's own browser, for a caller on this machine only. */
  readonly systemOpen: SystemOpenSubsystem;
  /** The daemon's secret store, and the use-without-read primitive that is the point of it: an agent
   *  names a secret, the daemon spawns a child holding the value, and only that child's scrubbed
   *  output comes back. NOTHING here can project a value — see `mounts/secrets.ts` for why that is a
   *  property of the types rather than a rule, and for the boundary it does and does not draw. */
  readonly secrets: SecretSubsystem;
  /** The catalogs this machine publishes: signed files of skills and MCP setups for another machine to install. */
  readonly sharedCatalogs: SharedCatalogSubsystem;
  readonly catalogMembers: CatalogMemberSubsystem;
  /** Fleet supervision: the deterministic anomaly sweep, the wardens it spawns to judge a suspect
   *  session, and the operator configuration that decides whether it may spend a session at all. The
   *  subsystem owns the sweep TIMER as well as the routes — a supervision loop with no route would be
   *  invisible to the reachability gate, which is how a background subsystem ships unmounted. */
  readonly warden: WardenSubsystem;
  /** How a human watches one session: what the daemon recorded, what its screen shows now, and what the
   *  agent itself wrote. Every one of these refuses rather than answering blank — see the domain's own
   *  header for why a dead pane and an unresolved transcript are errors and an empty event page is not. */
  readonly sessionReads: OperatorReadService;
  /** One image of that transcript, named by the handle its log carried: proved before it is served. */
  readonly transcriptImages: TranscriptImages;
  /** A short-lived, freshly validated tmux identity for a local human attach. */
  readonly sessionAttach: SessionAttachSubsystem;
  /** Typing into a session's own pane — the Console — governed as a session terminal is. */
  readonly sessionConsole: SessionConsoleSubsystem;
  /** A ferret's own processes — listed, their output followed, one stopped — governed as the Console is. */
  readonly sessionProcesses: SessionProcessSubsystem;
  /** Answering the harness's permission prompt on a session's own pane, governed as the Console is. */
  readonly sessionPermission: SessionPermissionSubsystem;
  /** Answering the harness's own dialog (hooks review, an MCP server, a sign-in) the same way. */
  readonly sessionDialog: SessionDialogSubsystem;
  /** This daemon's bounded recent event tail followed by its own live journal appends. */
  readonly fleetEvents: FleetEventStreamSubsystem;
  /**
   * "The configuration moved": the stream `/v1/events?topic=config` serves, and the sink the routes in
   * `ANNOUNCED_ROUTES` announce into. One ledger behind both (docs/config-files.md "Live changes").
   */
  readonly configChanges: ConfigChangeStreamSubsystem & ConfigChangeSink;
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
  /**
   * The security log: its read route, and the sink every audited route above records into.
   *
   * The WHOLE table is decorated rather than each mount, so a relayed request — which is dispatched
   * through this same table — is recorded exactly like a direct one. See `auditedRoutes`.
   */
  readonly audit: AuditSubsystem & AuditedRoutesSubsystem;
}

/**
 * The daemon's complete route table: the base feeds, then each mounted subsystem.
 *
 * Order matters — the router tries routes in registration order — and the base feeds are all fixed
 * literal paths (`/healthz`, `/usage`, `/metrics`), so no subsystem pattern can shadow one.
 */
export function mountedDaemonRoutes(base: DaemonApiDependencies, subsystems: MountedSubsystems): readonly ApiRoute[] {
  // Outermost, so the audit log and the agent-control switches below see the session a name addressed
  // rather than the name. See `session-addressing.ts`.
  return sessionAddressedRoutes(
    subsystems.sessionAddresses,
    auditedRoutes(
      subsystems.audit,
      agentControlledRoutes(subsystems.agentControl, [
        ...daemonApiRoutes(base),
        // Pairing is public redemption plus the code and device operations that produce and end the
        // credentials it hands out. It sits beside the base surface because it establishes the credential
        // every remote route later sees — and it is governed by the `pairing` capability rather than by the
        // `host` scope, because a browser is always a paired device and could otherwise never add a second
        // one. See the mount's header for why that is the correct layer.
        ...pairingRoutes(subsystems.pairing, subsystems.deviceGrants),
        // Push enrolment registers beside pairing because it is the same subject: only a paired device may
        // enrol, and its enrolment dies with its grant. Every path is under `/v1/push`, which no other
        // subsystem uses, and its one pattern is registered after its two fixed literals — so it can
        // neither shadow nor be shadowed by anything here.
        ...pushRoutes(subsystems.push, subsystems.grants),
        // The passkey step-up sits beside pairing too: it is how a paired device proves its owner is
        // holding it. Every path is under `/v1/passkeys` or `/v1/step-up`, which nothing else uses, and
        // there are no patterns among them, so it can neither shadow nor be shadowed.
        ...stepUpRoutes(subsystems.stepUp, subsystems.secrets.seeds),
        // The machine's security settings sit beside the step-up they tune. `/v1/security` is a fixed
        // literal no other subsystem uses, so it can neither shadow nor be shadowed.
        ...securityRoutes(subsystems.security),
        // The grant surface sits beside pairing for the same reason pairing sits beside the base feeds:
        // it establishes what the credential pairing hands out is then ALLOWED to do. Every path is under
        // `/v1/grants`, which no other subsystem uses, so it can neither shadow nor be shadowed. It is
        // registered EARLY and is itself ungoverned so a restricted UI can always read the reason it is
        // restricted — a grant report a restricted caller could not fetch would be the greyed control
        // with no explanation this whole feature exists to remove.
        ...grantRoutes(subsystems.grants),
        // The security log sits beside the grants and pairing it records. `/v1/audit` is used by nothing else.
        ...auditRoutes(subsystems.audit),
        // The carrier refresh sits beside pairing because it is the SECOND half of one exchange: pairing
        // hands a device the set of ways to reach this daemon, and this is where that device asks again
        // when the set has changed. `/v1/carriers` is a fixed literal no other subsystem uses, so it can
        // neither shadow nor be shadowed. It is authenticated rather than operator-scoped — the remote
        // device is the reader, and nothing here is a secret. See the mount's own header.
        ...carrierRoutes(subsystems.carriers),
        // The tunnel switch sits beside the carrier refresh because it changes what that refresh answers:
        // a tunnel switched on is published there once it connects. `/v1/tunnel` is a fixed literal no
        // other subsystem uses, so it can neither shadow nor be shadowed. See the mount's own header.
        ...tunnelRoutes(subsystems.tunnel),
        // The second way to reach this daemon is asked for inside the first, which is why it sits beside
        // the carrier refresh: a paired device that reached it over the relay offers a peer-to-peer path
        // here. `/v1/webrtc` is used by nothing else, so it can neither shadow nor be shadowed.
        ...webrtcRoutes(subsystems.webrtc),
        // The daemon's own health sits with the base feeds it completes: `/healthz` is the public
        // liveness answer, and this is the scoped report the protocol declares under the same subject.
        // Both are fixed literals, so neither can shadow or be shadowed by a subsystem pattern.
        ...daemonHealthRoutes(subsystems.health),
        ...doctorRoutes(subsystems.doctor),
        // The performance profile sits beside the doctor: both describe this machine to its owner.
        // `/v1/diagnostics/profile` is used by nothing else, so it can neither shadow nor be shadowed.
        ...performanceRoutes(subsystems.performance.profiles),
        // The account model's tables (docs/design/account-model.md §7). Fleet paths are fixed literals
        // under their own namespace, so they cannot shadow any session route below.
        ...fleetCredentialRoutes(subsystems.fleetCredentials),
        ...fleetCatalogRoutes(subsystems.fleetCatalog),
        ...fleetSetupRoutes(subsystems.fleetSetup),
        // The sign-in surface sits directly beside the fleet it signs in, under `/v1/fleet/login` — a fixed
        // literal with a one-segment id beneath it, so it can neither shadow nor be shadowed by anything in
        // the fleet tables above.
        ...harnessLoginRoutes(subsystems.harnessLogin),
        ...mcpOAuthRoutes(subsystems.mcpOAuth),
        // `/v1/mcp` and `/v1/mcp/check` are fixed literals no other route uses; the per-session list ends in
        // `mcp/servers`, a literal pair the session MCP routes below do not use, so none can shadow another.
        ...mcpInventoryRoutes(subsystems.mcpInventory),
        // Resource limits register beside the fleet they bound, and are governed by the same capability
        // for the same reason: this is a machine-wide setting about the agents this daemon runs. Both
        // paths are the one fixed literal `/v1/cgroups/config`, which no other subsystem uses, so this
        // table can neither shadow nor be shadowed by anything around it.
        ...cgroupRoutes(subsystems.cgroups),
        // The configuration files, beside the machine-wide settings they hold. Every path is under
        // `/v1/config` or is the one literal `/v1/agent/config`, which no other subsystem uses, so this
        // table can neither shadow nor be shadowed by anything around it.
        ...configFilesRoutes(subsystems.configFiles),
        // Imported harness history is intentionally outside `/v1/sessions`: no foreign transcript has
        // the journal/pane evidence a managed session requires, so it cannot acquire live controls by
        // looking like one.
        ...foreignHistoryRoutes(subsystems.foreignHistory),
        ...conversationImportRoutes(subsystems.conversationImport),
        ...scratchGcRoutes(subsystems.scratchGc),
        ...systemOpenRoutes(subsystems.systemOpen),
        // Every secret path is under `/v1/secrets`, which no other subsystem uses, so this table can
        // neither shadow nor be shadowed by anything around it. It registers with the daemon-wide
        // surfaces above rather than among the per-session ones because a secret belongs to the MACHINE:
        // it is not addressed by a session, and no session owns one.
        ...secretRoutes(subsystems.secrets),
        ...sharedCatalogRoutes(subsystems.sharedCatalogs),
        ...catalogMemberRoutes(subsystems.catalogMembers),
        // The session read comes first among the subsystems: `/v1/sessions` is a fixed literal, and the
        // id pattern beneath it matches one segment, so neither can be shadowed by — or shadow — the
        // deeper per-session routes that follow.
        ...sessionRoutes(subsystems.sessions),
        ...catalogRoutes(subsystems.catalogs, subsystems.sessions),
        ...boardProjectRoutes(subsystems.boardProjects, subsystems.sessions, subsystems.boardSwitches),
        // The worktree surface registers beside the catalogs for the reason its subsystem field states.
        // Every path is under `/v1/worktrees`, which no other subsystem uses, so it can neither shadow
        // nor be shadowed — and its own two deeper literals are registered before the collection they
        // sit under, which would otherwise match them first.
        ...worktreeRoutes(subsystems.worktrees),
        // The write surface registers AFTER the read for the same reason the read comes first: `POST
        // /v1/sessions` is a fixed literal and the stop is a deeper pattern, so neither shadows the
        // other and both sit above every per-session subsystem that follows.
        ...sessionControlRoutes(subsystems.sessionControl, {
          guard: subsystems.grants,
          knownRoots: knownLaunchRoots(subsystems.catalogs, subsystems.worktrees),
        }),
        // The revive registers with the rest of the write surface, above every per-session subsystem, so
        // its one-segment pattern sits beside the stop it is the counterpart of rather than below the
        // deeper patterns. Neither can shadow the other: they differ in their final literal segment.
        ...sessionResumeRoutes(subsystems.sessionResume),
        // The migration registers beside the revive it is built on: both are one-segment patterns under
        // `/v1/sessions/:sessionId` that differ only in their final literal, so neither can shadow the
        // other, and both belong above the deeper per-session subsystems.
        ...sessionMigrateRoutes(subsystems.sessionMigrate),
        // `/v1/restarts` is a prefix no other route uses, so it can neither shadow nor be shadowed.
        ...sessionRestartRoutes(subsystems.sessionRestart),
        // The handover registers immediately after the migration it is the cross-family counterpart of, so
        // the two operations a caller chooses between sit together. Its three paths are one and two
        // segments under `/v1/sessions/:sessionId` ending in the literal `handover` — and `handover/cancel`
        // beneath it, registered in the same table after its parent — so none can shadow or be shadowed by
        // the migrate above or the deeper per-session subsystems below.
        ...sessionHandoverRoutes(subsystems.handover),
        // Same shape and depth as its neighbours: the literal `fork` cannot shadow or be shadowed by a
        // sibling, nor by the shallower session read above.
        ...sessionForkRoutes(subsystems.sessionFork),
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
        // Same shape and depth as the signal: a one-segment pattern whose final literal (`rename`) no other
        // route uses, so it can neither shadow nor be shadowed.
        ...sessionRenameRoutes(subsystems.sessionRename),
        // Same shape and depth as the rename: a one-segment pattern whose final literal (`hypermedia`) no
        // other route uses, so it can neither shadow nor be shadowed.
        ...sessionHypermediaRoutes(subsystems.sessionHypermedia),
        // `agenda-mode` is a final literal no other one-segment session route uses.
        ...sessionAgendaModeRoutes(subsystems.sessionAgendaMode),
        // `/v1/pack…` is a prefix no other route uses; the two session paths end in literals (`result`,
        // `pack`) no other one-segment session route uses, so none can shadow or be shadowed.
        ...packRoutes(subsystems.pack),
        // Every path ends in literals under `mcp`, which no other route uses, and the subsystem registers its
        // deeper `preview` paths before the shallower ones itself, so none can shadow or be shadowed.
        ...sessionMcpRoutes(subsystems.sessionMcp),
        ...catalogInstallRoutes(subsystems.catalogInstalls),
        // The send and the interrupt register with the rest of the write surface, for the reason the
        // revive, the migration and the signal all do: each is a one-segment pattern under
        // `/v1/sessions/:sessionId` whose final literal no other route uses, so none can shadow or be
        // shadowed, and all belong above the deeper per-session subsystems.
        ...sessionSendRoutes(subsystems.sessionSend),
        ...sessionAnswerRoutes(subsystems.sessionAnswer),
        // Attachment routes are mounted before sends may honour attachment ids. Their
        // deeper unlock path cannot shadow this one-segment upload route.
        ...sessionAttachmentRoutes(subsystems.sessionAttachments),
        ...agendaRoutes(
          subsystems.attention,
          subsystems.notifications,
          subsystems.agendaReplies,
          configFilesConfirmations(subsystems.configFiles.service),
        ),
        ...agendaClearRoutes(subsystems.agendaClearer),
        ...pinRoutes(subsystems.pins),
        ...sharedDraftRoutes(subsystems.sharedDrafts),
        ...legacyTaskRoutes(subsystems.legacyTasks),
        // The project boards live under `/v1/board`, which no other subsystem uses, and their fixed
        // literals are registered before the patterns beneath them.
        ...boardRoutes(subsystems.board),
        // `/v1/search` is a fixed literal no other subsystem uses.
        ...workSearchRoutes(subsystems.workSearch),
        ...analyticsRoutes(subsystems.analytics),
        ...analyticsPricingRoutes(subsystems.analyticsPricing),
        // The agent's route is a fixed literal under `/v1/agent`, and a person's are under
        // `/v1/sessions/:sessionId/surfaces`, which no other subsystem uses: none can shadow or be shadowed.
        ...agentToolRoutes(subsystems.agentTools.service, subsystems.agentTools.identities),
        ...inputRequestRoutes(subsystems.inputRequests),
        // `/v1/phone-approvals` and `/v1/sessions/:sessionId/phone-approvals/*` are literals no other subsystem uses.
        ...(subsystems.phoneApprovals === undefined ? [] : phoneApprovalRoutes(subsystems.phoneApprovals)),
        ...secureCopyRoutes(
          subsystems.secureCopy.copies,
          subsystems.secureCopy.rules,
          subsystems.secureCopy.plans,
          subsystems.secureCopy.homes,
        ),
        ...terminalRoutes(subsystems.terminals),
        // The login window is a fixed literal under `/v1/browser`, which no other subsystem uses, so it
        // can neither shadow nor be shadowed. Its per-session refusal is a deeper pattern ending in the
        // literal `browser`, which distinguishes it from every other `/v1/sessions/:id/...` route above.
        ...browserLoginRoutes(subsystems.browserLogin, subsystems.browser),
        ...browserProxyRoutes(subsystems.browserProxy),
        ...nameRoutes(subsystems.names),
        ...learningRoutes(subsystems.learning),
        ...recommendRoutes(subsystems.recommend),
        // Dictation enhancement is a fixed literal under `/v1/stt`, which no other subsystem uses, so it
        // can neither shadow nor be shadowed by anything around it. It registers with the daemon-wide
        // surfaces rather than among the per-session ones because it belongs to the MACHINE: the
        // credential it spends is the operator's, and no session owns a transcript.
        ...sttEnhancementRoutes(subsystems.sttEnhancement),
        // Fixed literals under `/v1/speedups`, which no other subsystem uses: none can shadow or be shadowed.
        ...speedupRoutes(subsystems.speedups),
        // Fixed literals under `/v1/models`, which no other subsystem uses: none can shadow or be shadowed.
        ...modelRoutes(subsystems.models),
        // Fixed literals under `/v1/daemon`, which no other subsystem uses: none can shadow or be shadowed.
        ...daemonUpdateRoutes(subsystems.daemonUpdate),
        // Fixed literals under `/v1/harnesses`, which no other subsystem uses: none can shadow or be shadowed.
        ...harnessUpdateRoutes(subsystems.harnessUpdate),
        // The working-tree read registers last among the per-session subsystems: three of its four paths are
        // two segments deep under `/v1/sessions/:sessionId`, and its own deeper patterns are registered before
        // its one-segment `fs`, so nothing here can shadow or be shadowed.
        ...sessionFilesystemRoutes(subsystems.sessionFilesystem, subsystems.sessions, subsystems.sessionMediaRoot),
        // Every warden path is under `/v1/warden`, which no other subsystem uses, so this table can
        // neither shadow nor be shadowed by anything above it.
        ...wardenRoutes(subsystems.warden),
        // The operator reads register last, beside the working-tree read they sit alongside. All three are
        // one-segment patterns under `/v1/sessions/:sessionId` whose final literals (`events`, `snapshot`,
        // `logs`) no other route uses, so they can neither shadow nor be shadowed by anything above.
        ...sessionReadRoutes(subsystems.sessionReads, subsystems.sessions, subsystems.transcriptImages),
        // The attach proof sits with the operator reads but is its own capability: unlike a screen or a
        // transcript it authorizes a local process action, and its mount revalidates the pane identity.
        ...sessionAttachRoutes(subsystems.sessionAttach, subsystems.sessions),
        // The Console's input: two segments deep under `/v1/sessions/:sessionId`, ending in the literal
        // `console/input` no other route uses, so it can neither shadow nor be shadowed.
        ...sessionConsoleRoutes(subsystems.sessionConsole, subsystems.sessions),
        // The Processes tab: one to three segments under `/v1/sessions/:sessionId` starting with the literal
        // `processes` no other route uses, so they can neither shadow nor be shadowed.
        ...sessionProcessRoutes(subsystems.sessionProcesses, subsystems.sessions),
        // A permission answer: one segment under `/v1/sessions/:sessionId`, ending in the literal
        // `permission` no other route uses, so it can neither shadow nor be shadowed.
        ...sessionPermissionRoutes(subsystems.sessionPermission, subsystems.sessions),
        ...sessionDialogRoutes(subsystems.sessionDialog, subsystems.sessions),
        // The event ticket counter for the socket table. `/v1/events/ticket` is a fixed literal that
        // only the request/response table carries — the socket table's `/v1/events` matches GET on one
        // segment less — so the two cannot shadow each other and a POST here is never an upgrade.
      ]),
    ),
  );
}

/**
 * The host's credentials plus a ferret session's own, looked up through the agent tools' resolver — the
 * one lookup the agent route already makes — and audited when refused.
 */
function withSessionCredentials(base: DaemonApiDependencies, subsystems: MountedSubsystems): ApiCredentials {
  return {
    ...base.credentials,
    sessions: sessionCredentialDirectory(subsystems.agentTools.identities, subsystems.audit.log),
  };
}

/** The dispatcher the transport adapter serves, over the full mounted surface. */
export function createMountedDispatcher(base: DaemonApiDependencies, subsystems: MountedSubsystems): ApiDispatcher {
  // The guard is the SUBSYSTEM itself, so the answer a route enforces and the answer the report shows
  // are one object rather than two that can drift.
  // The step-up witness is the subsystem the step-up routes mint into, so a confirmation is visible to
  // the very next request on the same session.
  return new ApiDispatcher(
    // A change a route makes without touching a file announces itself once the route has answered —
    // direct and relayed alike, since both dispatch here. See `ANNOUNCED_ROUTES`.
    // Every route is timed into the performance probe under its pattern; nothing is recorded unless a
    // profile is open (see `observedRoutes`).
    new ApiRouter(
      observedRoutes(
        configAnnouncedRoutes(subsystems.configChanges, mountedDaemonRoutes(base, subsystems)),
        subsystems.performance.probe,
        subsystems.performance.clock,
      ),
    ),
    withSessionCredentials(base, subsystems),
    subsystems.grants,
    undefined,
    subsystems.stepUp,
    subsystems.legacyWire,
    subsystems.compressor,
  );
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
  // Attaching to a live terminal or browser, and typing into a terminal, is recorded like the HTTP
  // table above. See `auditedSocketRoutes`.
  return sessionAddressedSockets(
    subsystems.sessionAddresses,
    auditedSocketRoutes(
      subsystems.audit,
      agentControlledSockets(subsystems.agentControl, [
        // Fixed literal first; it cannot shadow the deeper terminal pattern and makes the fleet feed's
        // optional session filter one route rather than a second dispatcher.
        ...fleetEventSocketRoutes(subsystems.fleetEvents, subsystems.sessions, subsystems.configChanges),
        ...terminalSocketRoutes(subsystems.terminals, subsystems.inputRequests),
        ...browserSocketRoutes(subsystems.browser),
      ]),
    ),
  );
}

/**
 * The socket dispatcher the transport adapter serves, over the same credentials as the HTTP one —
 * plus the ticket redeemer, which is deliberately given to this boundary and to no other.
 */
export function createMountedSocketDispatcher(
  base: DaemonApiDependencies,
  subsystems: MountedSubsystems,
  /**
   * Socket routes whose dependencies include THIS dispatcher — today only the direct carrier, which
   * dispatches a session's streams back through the same table. They cannot be a mounted subsystem
   * without a construction cycle, so the composition root hands them in.
   */
  carriers: readonly SocketRoute[] = [],
): ApiSocketDispatcher {
  return new ApiSocketDispatcher(
    new ApiRouter([...mountedSocketRoutes(subsystems), ...carriers]),
    withSessionCredentials(base, subsystems),
    // The SAME guard the request/response table uses. A terminal socket that skipped it would let a
    // browser drive a shell this machine had refused to let it open.
    subsystems.grants,
    undefined,
    subsystems.stepUp,
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
