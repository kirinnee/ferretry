#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { accessSync, constants as fsConstants, existsSync, statSync, writeSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type Advertisement,
  type DaemonCarrier,
  FY_DEFAULT_DAEMON_PORT,
  type LearningConfig,
  localOnlyNotice,
  type MigrateSessionRequest,
  type RegisterProjectRequest,
  refusalNotice,
  type RuntimeControlRequest,
  type SessionConfig,
  SessionConfigSchema,
  SessionStateSchema,
  type SessionView,
  type SignalSessionRequest,
  type StartSessionRequest,
  type TaskBoardChildAccess,
  TERMINAL_MAX_GLOBAL,
  TERMINAL_MAX_PER_SESSION,
} from '@ferretry/protocol';
// One WebCrypto binding of the relay's crypto port serves the daemon, the browser and the Worker that
// verifies the claim. Two implementations that agree about a primitive and disagree about an encoding
// is the class of bug this removes.
import { WebCryptoRelayCrypto } from '@ferretry/relay/adapters';
import type { z } from 'zod';
import pkg from '../package.json' with { type: 'json' };
import { BunSqliteAnalyticsStoreFactory, HttpAnalyticsPricingFeed } from '../src/adapters/analytics/index.ts';
import { FileSessionAttachmentStore, NodeRawDeflate } from '../src/adapters/attachments/index.ts';
import { FileAttentionLedgerRepository } from '../src/adapters/attention/file-attention-ledger-repository.ts';
import { BunGitRunner } from '../src/adapters/git/index.ts';
import {
  BrowserLoginWindowService,
  BrowserProfileStore,
  NodeSessionBrowserLauncher,
  BrowserWorkerClient,
  BunApiServer,
  BunCommandRunner,
  BunProcessProbe,
  BunRelayCarrier,
  BunSecretChildRunner,
  BunSecretShell,
  BunSqliteIndexFactory,
  CachedUsageFeed,
  FileCgroupApplyStatusStore,
  FileCgroupConfigStore,
  FileSessionSpawnFacts,
  hostCgroupFacts,
  ProcCgroupPlacements,
  RegisteredCgroupPaneLedger,
  SpawnCgroupCommands,
  CommandUsageSource,
  ConfigGrantDocument,
  ConfigSecretRecipes,
  DaemonBinder,
  DaemonHealthProbe,
  DaemonSecretsLoader,
  DaemonStorageFactory,
  daemonSecretSourceProgram,
  ExplicitDaemonConfig,
  FetchEnhancementTransport,
  FileDaemonConfig,
  FileOperatorPassword,
  FileProjectCatalog,
  FileQuotaFailoverConfigStore,
  FileQuotaFailoverStateStore,
  FileRoutingCatalog,
  FileScratchCollector,
  FileSecretDocumentStore,
  FileSecretKey,
  FleetUsageSource,
  foreignHistoryRoots,
  HostedRelayDirectory,
  HttpUsageSource,
  JournalGrantAudit,
  KeyedSerialExecutor,
  harnessHomeLayouts,
  ManifestAccountInventory,
  NodeBrowserLoginRuntime,
  NodeHarnessHomeDocuments,
  NodeCatalog,
  NodeForeignHistoryFiles,
  NodePairingCryptography,
  NodeSocketTicketSecrets,
  type OpenedDaemonStorage,
  PaneProcessInventory,
  PerformanceStopwatch,
  ProcessSecretReader,
  quotaFailoverRoot,
  RandomUnlockTokens,
  RuntimeEnvironment,
  SocketViewerDownstream,
  SqliteHomeLockFactory,
  StateApiCredentials,
  StateFileSystem,
  StateFileSystemFactory,
  StateHomeLayout,
  StateHomeLockedError,
  StatePairingRepository,
  StatePushRepository,
  StateVapidKeys,
  SystemClock,
  SystemFrameClock,
  SystemGrantClock,
  TmuxPaneSnapshot,
  type ViewerSocket,
  WebCryptoRelayIdentityKeys,
  WebCryptoSecretCipher,
  WebPushFetchTransport,
  type WorkerClientOptions,
  XvfbDisplay,
} from '../src/adapters/index.ts';
import {
  FileSessionForkReceiptStore,
  forkOpeningTurnRefusal,
  forkReceiptFile,
  SessionForkTargetBinder,
  SessionForkTargetResolver,
  type SessionForkStartAccountResolver,
} from '../src/adapters/fork/index.ts';
import {
  FileSessionAttachmentCopier,
  FileSessionTransferBriefWriter,
  FileSessionTransferTargetPlanStore,
  GitTransferWorkspaceProbe,
  SessionAttachmentTransferReader,
  StorageTransferConversationReader,
  StorageTransferEnvelopeWriter,
  StorageTransferSourceReader,
} from '../src/adapters/transfer/index.ts';
import {
  AttachmentFacetContributor,
  ConversationFacetContributor,
  LineageFacetContributor,
  ReferenceFacetContributor,
  SessionTransferPreparer,
  TransferPrepareError,
  WorkspaceFacetContributor,
} from '../src/lib/transfer/index.ts';
import {
  SessionForkFacade,
  type SessionForkIdFactory,
  sessionForkKey,
  SessionForkService,
} from '../src/lib/fork/index.ts';
import type { SessionForkSubsystem } from '../src/lib/runtime/mounts/session-fork.ts';
import { StorageSessionProvenanceStore } from '../src/adapters/session/provenance/index.ts';
import { FileLearningStore, LearningMiner } from '../src/adapters/learning/index.ts';
import { FileHandoverReceiptStore } from '../src/adapters/handover/file-handover-receipt-store.ts';
import { FileMigrationReportStore } from '../src/adapters/migrate/file-migration-report.ts';
import { FileNameClaimStore } from '../src/adapters/names/index.ts';
import { FileNotificationDeliveryLedger } from '../src/adapters/notifications/index.ts';
import { FilePinRepository, FilePinSessionDirectory } from '../src/adapters/pins/index.ts';
import { loadDirectorySyscalls } from '../src/adapters/session/filesystem/directory-syscalls.ts';
import {
  PosixSessionRootPinner,
  ProcfsSessionRootPinner,
  RunnerSessionGit,
} from '../src/adapters/session/filesystem/index.ts';
import {
  CodexAppServerCatalog,
  TmuxCodexPickerDrive,
  TmuxCodexPickerPane,
} from '../src/adapters/session/harness/index.ts';
import {
  DurableTerminalPaneRegistrar,
  DurableTerminalPaneStore,
  ExactTmuxPaneReaper,
  FileSessionEnvironmentStore,
  FileSessionTaskStore,
  lifecycleConfigDocument,
  NodeSessionCredentialIssuer,
  NodeWorkingDirectoryResolver,
  type SessionProtocolEnvelope,
  StorageSessionLifecycleRepository,
  TimeSessionIdFactory,
  TmuxSessionLifecycleLauncher,
} from '../src/adapters/session/lifecycle/index.ts';
import { FileSessionEffectLedger } from '../src/adapters/session/effects/index.ts';
import { sessionTmuxName } from '../src/lib/session/lifecycle/policy.ts';
import { startupModelArguments } from '../src/lib/session/harness/startup.ts';
import {
  FileWaitHeartbeat,
  MonitorTickRunner,
  SendMonitorNudge,
  StorageMonitorWaits,
} from '../src/adapters/session/monitor/index.ts';
import { FileAnswerLedger, TmuxStructuredQuestionDriver } from '../src/adapters/session/question/index.ts';
import {
  FileResumeTurnStore,
  FileSelfRestartStampStore,
  FileSessionHealthEventSink,
  InMemoryLaunchGate,
  NoMonitorSupervision,
  StorageConsistencyPass,
  StorageResumeRepository,
  StorageSessionHealthInventory,
  SystemMonotonicClock,
  TmuxResumeLauncher,
  UnmountedSupervisionRepair,
} from '../src/adapters/session/resume/index.ts';
import {
  FileSendChannel,
  FileSendLedger,
  FileSendTurnStore,
  ResumeSendReviver,
  StorageSendRepository,
  TmuxSendTerminal,
} from '../src/adapters/session/send/index.ts';
import {
  FileSignalArtifacts,
  LauncherSignalTerminal,
  StorageSignalRepository,
} from '../src/adapters/session/signal/index.ts';
import { FileLastSnapshotStore } from '../src/adapters/session/snapshot/index.ts';
import {
  FileHarnessWrapperSource,
  FileSessionTranscriptMessageTokenCodec,
  NodeCodexRolloutIndex,
  sessionMessageTokenKeyFile,
  StorageTranscriptClaims,
  StorageTranscriptDigestJournal,
  StorageTranscriptProvenanceStore,
  storedTranscriptProvenance,
} from '../src/adapters/session/transcript/index.ts';
import type { DaemonStorage } from '../src/adapters/storage/session-storage.ts';
import {
  FileTaskBoardRepository,
  NodeTaskBoardCredentialIssuer,
  StateBoardAdminCapability,
  StateTaskBoardCoordinatorReplacementCapability,
  StorageTaskBoardSessionDirectory,
} from '../src/adapters/task-boards/index.ts';
import {
  FileTaskStore,
  KeyedSerialExecutor as TaskBoardSerialExecutor,
  TaskRecordService,
} from '../src/adapters/tasks/index.ts';
import {
  ManagedTerminalService,
  TerminalRuntimeError,
  TerminalServiceError,
  TerminalStreamBridge,
  type TerminalStreamScheduler,
  TmuxTerminalRuntime,
} from '../src/adapters/terminal/index.ts';
import { BunTmuxProcess, TmuxPaneDelivery, TmuxPaneQueue } from '../src/adapters/tmux/index.ts';
import { NodeTranscriptSource } from '../src/adapters/transcript/index.ts';
import {
  FileWardenArtifacts,
  FileWardenConfigStore,
  FileWardenStateStore,
  NodeWardenReportFileSystem,
  WardenReportReader,
} from '../src/adapters/warden/index.ts';
import {
  FileManagedWorktreeRegistry,
  GitWorktreeGateway,
  ManagedWorktreeAdapter,
  NodeWorktreeFileSystem,
  SystemWorktreeClock,
  WorktreeOperationQueue,
} from '../src/adapters/worktrees/index.ts';
import {
  type AnalyticsPricingConfigurationPort,
  AnalyticsPricingService,
} from '../src/lib/analytics/pricing-service.ts';
import {
  type AccountInventoryPort,
  type AnalyticsIndexStoreFactory,
  type AnalyticsIngestCandidate,
  type AnalyticsIngestCandidateSource,
  AnalyticsIngestionService,
  type AnalyticsSubsystem,
  type AnalyticsTranscriptEvidenceSource,
  AnswerAcknowledged,
  AnswerReleased,
  AnswerRequestConflict,
  AnswerTerminalFailure,
  AnswerToolAlreadyHandled,
  AnswerUnconfirmed,
  type ApiServerHandle,
  type ApiServerPort,
  type ArgumentAnswer,
  type AssigneeObservation,
  type AttentionActor,
  AttentionService,
  accountLaunchability,
  advertisesForeignAddress,
  answerArguments,
  authorizeSessionCommand,
  type BootNoticePort,
  type BootRefusal,
  type BrowserLoginLifecycle,
  type BrowserViewerHost,
  BrowserViewerStream,
  BrowserSessionService,
  CALLSIGN_WINDOW_MS,
  CapabilityGrantService,
  type CatalogSubsystem,
  CgroupLaunchPlanner,
  CgroupService,
  type ChildGrantRequester,
  ClaudeTranscriptParser,
  type ClockPort,
  CodexPickerCleanup,
  CodexRuntimeCatalogCache,
  CodexTranscriptParser,
  type CoreAccount,
  childGrantRequester,
  chooseRelayCarrierSources,
  configuredAt,
  contextWindowForSession,
  createFoundationPaths,
  createMountedDispatcher,
  createMountedSocketDispatcher,
  createSessionPaths,
  createWardenPaths,
  type DaemonConfig,
  type DaemonConfigStore,
  type DaemonHealthSubsystem,
  type DecodedInitialAttachment,
  DONE_MARKER_FILENAME,
  decodeInitialAttachments,
  defaultSessionLifecycleSettings,
  defaultSessionMonitorSettings,
  defaultSessionResumeSettings,
  defaultSessionSendSettings,
  defaultStartWaitPolicy,
  describeAbsentRelayCarrier,
  describeConfiguration,
  describeGrantPosture,
  describeRelayCarrierPosture,
  dialledRelayUrl,
  doneMarkerCertifiesTurn,
  type ExecutableResolverPort,
  exactWorkerAssignee,
  FleetEventStreamService,
  FleetManifestUnreadableError,
  FleetRefreshService,
  ForeignHistoryImporter,
  type FoundationPaths,
  firstWriteReleasedAnswerAttention,
  fleetManifestRefusal,
  foreignAdvertisementNotice,
  HARNESS_PICKER_COMMAND,
  DEFAULT_HANDOVER_SETTINGS,
  HandoverError,
  type HandoverJournalAppend,
  type HandoverReceiptStore,
  HandoverReconcileLoop,
  SessionHandoverService,
  type HarnessDiscoveryPolicy,
  type HarnessPreflight,
  HarnessQuirkService,
  harnessQuirks,
  harnessAbsentWarning,
  harnessDiscoveryPolicy,
  harnessLocationSummary,
  harnessMigrationRefusal,
  harnessOverrideFailures,
  harnessPreflightSummary,
  InitialAttachmentError,
  InvalidDeadlineRefused,
  isTaskBoardError,
  jsonObject,
  type LearningSubsystem,
  type LogLevel,
  MigrationPreflight,
  type MigrationReportStore,
  defaultManagedWorktreeRoot,
  ManagedWorktreeService,
  type ManagedWorktreeOperations,
  type ManagedWorktreeRegistry,
  type MillisecondClockPort,
  mayTrustDirectLoopback,
  type MountedSubsystems,
  type NameAllocationErrorCode,
  type NameAllocationRequest,
  type NameAllocationResult,
  NameAllocator,
  NotificationService,
  type NameClaim,
  type NameSubsystem,
  NO_PASSWORD_DISCLOSURE,
  type OperatorMessageSource,
  normalizeCallsign,
  type ObservedSession,
  observedRuntimeStatePatch,
  type OpenedAnalyticsIndexStore,
  type OperatorPasswordPort,
  OperatorReadService,
  overriddenBy,
  PairedPushDevices,
  PairingDeviceRegistry,
  PairingService,
  PinService,
  type PlannedAttachmentFile,
  type PlannedInitialAttachments,
  PushService,
  packageRole,
  paneShowsActiveWork,
  parseSessionId,
  parseWardenConfigPatch,
  planInitialAttachments,
  portCandidates,
  projectStructuredQuestion,
  publishableDirectCarrier,
  publishedDaemonCarriers,
  projectObservedRuntime,
  type QuotaFailoverLoop,
  QuotaFailoverService,
  RELAY_DIRECTORY_NOT_ASKED,
  RecommendError,
  type RecommendSubsystem,
  type RelayApiDispatch,
  type RelayCarrierSource,
  type RelayDeviceDirectory,
  type RelayDirectoryPort,
  type RelayPairingRedeemer,
  type RelayStreamDispatch,
  type ResumeAnswerAttention,
  ResumeCancelled,
  type ResumeLauncher,
  ResumeRefused,
  ReviveDedupeConflict,
  type RoutingCatalogPort,
  type RunOverrides,
  readDaemonRelayIdentity,
  readDoctorReport,
  readHarnessPreflight,
  reconcileAnswerEvidence,
  refuseExhaustedCandidates,
  refuseHeldStateHome,
  refuseOccupiedAddress,
  refuseUnbindableAddress,
  relaunchCommand,
  relayCarrierRemedy,
  relayCarriersNeedDiscovery,
  releasedAnswerAttentionOwnedBy,
  renderConfiguration,
  renderDoctorReport,
  renderHarnessPreflight,
  renderInitialAttachmentSection,
  resolveStateHome,
  type ScratchReclamation,
  SecretDirectory,
  SecretRedactor,
  type SecretSubsystem,
  SecretUseService,
  SecretVault,
  SelfRestartCoordinator,
  SendPending,
  SendRefused,
  type SerialExecutor,
  SessionAnswerError,
  type SessionAnswerSubsystem,
  SessionAttachmentError,
  SessionAttachmentStore,
  SessionAttachService,
  SessionControlError,
  type SessionControlFailure,
  type SessionControlSubsystem,
  type SessionDirectorySubsystem,
  SessionFilesystem,
  SessionHealthService,
  type SessionHealthSettings,
  type SessionId,
  type SessionIdFactory,
  SessionLifecycleConfigSchema,
  type SessionLifecycleLauncher,
  SessionLifecycleService,
  SessionMigrateError,
  type SessionMigrateFailure,
  type SessionMigrateSubsystem,
  SessionMonitorService,
  SessionPlanner,
  type SessionAncestor,
  SessionProvenanceRecorder,
  SessionProvenanceStamper,
  SessionReadError,
  SessionResumeError,
  SessionResumeService,
  type SessionResumeSubsystem,
  type SessionRootPinner,
  SessionRuntimeControlService,
  type SessionRuntimeStartupHeldPort,
  runtimeQuarantineState,
  SessionSendError,
  SessionSendService,
  type SessionSendSubsystem,
  SessionSignalError,
  SessionSignalService,
  type SessionSignalSubsystem,
  SessionTranscriptReader,
  SessionTranscriptResolver,
  SESSION_TRANSCRIPT_MESSAGE_TOKEN_SELECTION_DOMAIN,
  type SessionTranscriptMessageTokenCodec,
  type SessionTranscriptTail,
  SignalRefused,
  type SocketTicketBroker,
  SocketTicketRegistry,
  STRUCTURED_ANSWER_RELEASED_ATTENTION_KIND,
  StructuredAnswerCoordinator,
  StructuredQuestionAttemptFailed,
  StructuredQuestionRefused,
  StructuredQuestionService,
  SttEnhancementService,
  type SttEnhancementSubsystem,
  searchTranscript,
  selectableAutoAccounts,
  sessionHealthSettingsAt,
  structuredQuestionStatePatch,
  supersededCarrierKeys,
  type TaskAssigneeCandidate,
  type TaskBoardSubsystem,
  type TaskBoardTaskActionAuthorizer,
  TaskError,
  type TaskSubsystem,
  TeamAdvisor,
  TerminalMountError,
  TerminalReapService,
  type TerminalRuntimePort,
  type TerminalSessionResolver,
  type TerminalSubsystem,
  TmuxController,
  type TranscriptEvent,
  type TranscriptFileResolver,
  TranscriptProvenanceCapture,
  type TranscriptSearchMatch,
  type TranscriptSearchOptions,
  type TranscriptSource,
  taskBoardTaskActionAuthorizer,
  temporaryFilePath,
  tryParseSessionId,
  UnknownPeerRefused,
  type UsageFeedPort,
  unreadableManifestPreflight,
  usageProbeCommand,
  usageRefreshMs,
  verifySessionTranscriptMessageToken,
  WARDEN_LABEL,
  type WardenFleetSession,
  type WardenSubsystem,
  WardenSweepLoop,
  WardenSweepService,
  type WorkingDirectoryResolver,
} from '../src/lib/index.ts';
import { MAX_ASSET_FILE_BYTES } from '../src/lib/fleet/assets.ts';
import {
  decideFleetBootPreparation,
  fleetNothingAddedNotice,
  fleetPreparationDisclosure,
  fleetPreparationFailure,
  fleetPreparationRefusal,
  fleetPreparedDisclosure,
} from '../src/lib/fleet/boot-preparation.ts';
import { readHarnessDiscovery } from '../src/lib/fleet/harness-discovery.ts';
import { createDaemonFleetSubsystem } from '../src/lib/runtime/mounts/fleet.ts';
import { PlatformFleetCredentialStore, readFleetWrapperScript, SpawnCredentialCommand } from '@ferretry/fleet/adapters';
import { harnessLoginTimer, spawnHarnessLoginChild } from '../src/adapters/fleet-login/login-child.ts';
import { HarnessLoginService } from '../src/lib/fleet-login/service.ts';
import { daemonVersion } from '../src/lib/version.ts';

// Identity is single-sourced from package.json, matching the CLI's composition root.
const DAEMON_NAME = Object.keys(pkg.bin ?? {})[0] ?? pkg.name;

/** The CLI a human drives. Named here rather than derived, because the daemon
 *  package cannot read the CLI package's `bin` without depending on it. */
const CLIENT_NAME = 'fy';

/**
 * Which containment the working-tree viewer gets, decided by what this kernel can express.
 *
 * Linux keeps the procfs implementation, whose descriptor alias is a plain path and needs no borrowing
 * of the working directory. Everywhere else the POSIX one gives the same guarantee by installing the
 * held directory for the instant of each open — and refuses the whole surface if it cannot. Neither
 * ever falls back to the configured pathname, which is the one answer that would be a lie.
 */
function sessionRootPinner(): SessionRootPinner {
  return process.platform === 'linux' ? new ProcfsSessionRootPinner() : new PosixSessionRootPinner();
}

/** The tmux process port demands an absolute executable; PATH lookup is the root's business. */
function resolveTmuxExecutable(): string {
  const executable = Bun.which('tmux');
  if (executable === null) throw new Error('tmux was not found on PATH; it is required to manage sessions');
  return executable;
}
/** Fallback when tmux is not on `$PATH`. Absolute by construction: the tmux adapter refuses a bare
 *  name so no lookup can ever land on the machine's default socket, and an absent binary surfaces
 *  as a failed inspection, which the migration gate then refuses. */
const FALLBACK_TMUX = '/usr/bin/tmux';

/**
 * The three things the managed-worktree surface cannot decide for itself.
 *
 * Each is a fact about THIS boot rather than about worktrees: the registry is a document inside the
 * state home that was just opened, the managed root is derived from that home's name, and the Git
 * operations are the one collaborator whose real behaviour means creating and destroying checkouts
 * on the machine running the test. Grouping them keeps the composition seam one parameter wide.
 */
export interface WorktreeComposition {
  readonly operations: ManagedWorktreeOperations;
  readonly registry: ManagedWorktreeRegistry;
  /** Absent means this daemon hosts no managed checkouts, which every route then says plainly. */
  readonly managedRoot: string | undefined;
}

/**
 * The adapters a daemon process needs. Subsystem units add their ports here as they land; this is
 * the ONLY seam where pure domain (`src/lib`) meets IO (`src/adapters`).
 *
 * It exists because the two repository gates pull in opposite directions: the architecture gate
 * forbids `src/lib` from importing `src/adapters`, while production dead-code analysis requires
 * every module to be reachable from the package entry. A composition root outside both directories
 * satisfies each — the same reason `packages/cli/bin/fy.ts` is shaped this way.
 */
export interface DaemonWorld {
  readonly role: typeof packageRole;
  readonly storage: DaemonStorageFactory;
  /**
   * The analytics materialization this daemon ingests into.
   *
   * A SEPARATE acquisition from the session index rather than another table inside it: the two are
   * dropped for different reasons — a session index when a journal moves, this one when the analytics
   * derivation changes — and the session index refuses to open a file carrying tables it does not
   * recognise, so an extra table in it would drop every daemon's event index on upgrade.
   */
  readonly analyticsIndexes: AnalyticsIndexStoreFactory;
  readonly worktrees: ManagedWorktreeAdapter;
  readonly boot: {
    readonly probe: DaemonHealthProbe;
    readonly binder: DaemonBinder;
    /**
     * The address a boot tries FIRST when the configuration document records none.
     *
     * A WORLD FIELD rather than a constant read where it is used, and the reason is a test one: the
     * fallback walk is the behaviour that has to be proved, and proving it against the real
     * well-known port would mean a test binding the address a developer's own daemon lives at. A
     * test substitutes an ephemeral port and drives the identical code path.
     *
     * It is only ever consulted for an UNRECORDED port. A recorded one is a claim — bound or refused
     * — so no default may quietly stand in for it.
     */
    readonly preferredPort: number;
  };
  readonly config: DaemonConfigStore;
  /**
   * Whether this machine has an operator password, for the queries that report it.
   *
   * THE SAME PORT THE GRANT SERVICE USES, deliberately: `--check` must not answer from a second copy
   * of a fact the running daemon decides differently. It is exposed as the whole port rather than a
   * boolean so it stays use-never-read — there is no getter to reach for, here or anywhere above it,
   * so no query can grow into one that prints a password.
   */
  readonly operatorPassword: OperatorPasswordPort;
  /** What this invocation said on the command line, overriding the document for this run only. */
  readonly overrides: RunOverrides;
  /**
   * The state home this invocation would own, and whether the environment named it.
   *
   * Reported rather than derived at the point of use, because `--print-config` has to say WHERE each
   * value came from and "the environment chose this" is the answer an operator most often needs — a
   * daemon looking at a different state home than the one they are editing explains almost every
   * otherwise inexplicable configuration.
   */
  readonly stateHome: { readonly path: string; readonly fromEnvironment: boolean };
  /**
   * How this host resolves an agent harness: the published fleet and this machine's own `PATH`.
   *
   * THE SAME PAIR A START RESOLVES AN ACCOUNT FROM, deliberately, and it is a world field so the
   * preflight can be driven from a test without installing Claude Code on the machine running it.
   * A boot reports on these two facts; `resolveStartAccount` refuses on them. Reusing the pair is
   * what stops a preflight promising a harness that a start would then reject.
   */
  readonly harnesses: { readonly accounts: AccountInventoryPort; readonly executables: ExecutableResolverPort };
  /**
   * Where a boot states what stopped it.
   *
   * A WORLD FIELD so the refusals below are provable without reading a real log file, and a port
   * rather than a direct write because `src/lib` owns the decision about what is said and may not
   * reach a stream. Every non-zero return from `start` writes through this first: an exit code that
   * explains nothing is the defect this seam exists to prevent recurring.
   */
  readonly notices: BootNoticePort;
  readonly secrets: DaemonSecretsLoader;
  /** The destructive-migration safety gate: it inventories in-flight work and refuses to migrate
   *  a session whose work cannot be shown to survive the relaunch. */
  readonly migratePreflight: MigrationPreflight;
  /** Warden report access. The reports directory hangs off the state home,
   *  which is only known once storage has resolved it, so this is a factory
   *  rather than an instance. */
  readonly wardenReports: (stateDirectory: string) => WardenReportReader;
  readonly browserTransport: BrowserTransportWorld;
  /**
   * The daemon-global human browser-login window, and the release of the X display it renders on.
   *
   * A world FIELD for the same reason `terminalRuntime` and `sessionLauncher` are: its real behaviour
   * cannot be driven from a test without putting an X server, a Chrome and a VNC listener on the host.
   * A test substitutes this and keeps the mount, the routes, the credentials and the dispatcher
   * exactly as production builds them.
   *
   * It is built at process start rather than per opened storage because none of it reads the session
   * index — the profile is one directory in the state home, and the window is about that profile
   * rather than about any session.
   *
   * `close` is here because the window holds host processes: an X server for the daemon's lifetime,
   * and while a window is open a Chrome and a VNC listener too. A daemon that exited without
   * releasing them would leave a desktop on the machine that nothing is left to close.
   */
  readonly browserLogin: BrowserLoginWorld;
  /**
   * Where a managed agent actually runs: a tmux pane on the daemon's own private socket.
   *
   * It is a world FIELD for the same reason `terminalRuntime` is — it is the one adapter in the
   * lifecycle whose real behaviour cannot be driven from a test without spawning an agent process on
   * the host. A test substitutes this and keeps the service, the reconciled documents, the routes and
   * the real state home exactly as production builds them.
   */
  readonly sessionLauncher: SessionLifecycleLauncher;
  /**
   * Session lifecycle: create, launch, deliver turn one, stop. The authoritative store is only
   * open once storage has resolved and locked the state home, so the service is built per opened
   * storage rather than at process start.
   *
   * ONE SERVICE PER START, because two of its ports are per-request. The `envelope` carries the
   * protocol fields that start decided, and `id` is minted by the caller rather than inside `create`
   * so the session's shape can be planned — its model, its remote-control arguments — against the
   * very id the record will carry. The launcher is passed IN rather than captured so overriding
   * `sessionLauncher` on a world actually changes what starts.
   */
  readonly createSessionLifecycle: (
    storage: DaemonStorage,
    launcher: SessionLifecycleLauncher,
    envelope?: SessionProtocolEnvelope,
    id?: SessionId,
  ) => SessionLifecycleService;
  readonly createTerminalReaper: (storage: DaemonStorage) => TerminalReapService;
  /**
   * The daemon's own self-check: it measures how late its tick was, reconciles the session index
   * against the authoritative session directories, and escalates an index that will not heal. Built
   * per opened storage for the same reason as the lifecycle above.
   *
   * `supervision` declares which repairable subsystems this daemon actually runs. Both are false
   * today — no per-session monitor subsystem and no warden sweep timer are mounted yet — so the
   * self-check measures and reconciles without planning repairs it could not carry out. The units
   * landing those subsystems flip the flags and replace `UnmountedSupervisionRepair`.
   *
   * ONE instance serves both callers: `start` ticks it on a timer, and `GET /v1/health` reports the
   * ledgers those ticks fill. A second instance for the route would report a ledger nothing had ever
   * ticked — permanently zero self-checks beside a daemon that was self-checking every minute.
   *
   * `settings` is passed IN rather than defaulted here, because the cadence is the operator's
   * (`healthIntervalSeconds`) and it is only known once configuration has loaded. The service, its
   * consistency pass and the timer must all read the same object — a detector measuring lateness
   * against a period the timer does not fire on is a detector measuring nothing.
   */
  readonly createSessionHealth: (storage: DaemonStorage, settings: SessionHealthSettings) => SessionHealthService;
  /**
   * The terminal a revive replaces: tmux panes on the daemon's own private socket, never the host's
   * default one.
   *
   * A FACTORY rather than an instance, for the same reason `wardenReports` is one: the launcher reads
   * the session's own configuration document to learn which pane, directory and command it is
   * relaunching, and no document is readable until storage has resolved and locked the state home.
   *
   * It is a world field for the same reason `sessionLauncher` and `terminalRuntime` are — it is the
   * one adapter in the resume path whose real behaviour cannot be driven from a test without killing
   * and respawning a pane on the host. A test substitutes this and keeps the service, the real
   * documents, the journal and the routes exactly as production builds them.
   */
  readonly createResumeLauncher: (storage: DaemonStorage) => ResumeLauncher;
  /**
   * Reviving a stopped or dead session with its conversation intact: replace the terminal, hand the
   * agent its next turn, and refuse the revives that would destroy work rather than recover it.
   *
   * Its monitor control is `NoMonitorSupervision` for now — this daemon runs no per-session
   * monitors, so there is genuinely nothing to disarm before a revive or arm after one. The unit
   * that lands monitoring replaces it.
   *
   * The launcher is passed IN rather than captured so overriding `createResumeLauncher` on a world
   * actually changes what revives.
   */
  readonly createSessionResume: (
    storage: DaemonStorage,
    launcher: ResumeLauncher,
    /** Where the released structured-answer advisory is durably dismissed; see
     *  `createResumeAnswerAttention`. Passed IN for the launcher's reason: it is built from the
     *  answer ledger and the answer queue, which belong to the mounted subsystems rather than the
     *  world, and a second construction would dismiss on a queue nothing else holds. */
    answerAttention: ResumeAnswerAttention,
    /** The session's ANSWER/monitor queue, used as the resume service's own serializer. Passed in
     *  because it belongs to the mounted subsystems, and shared because a dismissal must hold it
     *  from the old pane's release through the final clear — see `SessionResumePorts.serial`. */
    serial: KeyedSerialExecutor,
  ) => SessionResumeService;
  /** The daemon-wide account-health feed: one snapshot shared by every session
   *  instead of one probe per session. Its sources are configured and its refresh
   *  period is the fleet's declared `usage.interval`, so it is built once both
   *  documents have been read — which is why it resolves rather than returns. */
  readonly createUsageFeed: (config: DaemonConfig) => Promise<UsageFeedPort>;
  /**
   * Opens this daemon's durable identity and device grants before any remote route is served.
   *
   * IT OPENS PUSH ENROLMENT WITH THEM, in one call, because the two share a lifetime rather than merely
   * a state home: an enrolment is filed against a device grant and is purged when that grant is
   * revoked, so the pairing service has to be constructed already holding the thing it purges. Building
   * push later and attaching it afterwards would make the purge a wire somebody can forget to connect.
   */
  readonly createPairing: (
    config: DaemonConfig,
    clock: MillisecondClockPort,
    carriers: readonly DaemonCarrier[],
    /**
     * The rendezvous a fresh device can discover for itself — see {@link discoverableRelayUrl}.
     *
     * REQUIRED RATHER THAN OPTIONAL, because the interesting value is `undefined` and an omitted
     * argument and a deliberate "there is none" would be the same call. A boot that forgot to derive
     * it would silently stop drawing the default install's QR, which is the regression this whole
     * field exists to prevent.
     */
    discoveredRelayUrl: string | undefined,
  ) => Promise<{
    readonly subsystem: PairingService;
    readonly credentials: PairingDeviceRegistry;
    readonly push: PushService;
  }>;
  /** The shape of one session: its name, parent, display model, context window
   *  and launch window. */
  readonly sessions: SessionPlanner;
  /** Warden provenance: which warden a session traces back to, and whether it
   *  descends from one. Stamped at spawn and re-stamped on every resume, because
   *  a warden is pruned while its children still run and the detector's shield
   *  reads the stamp, not the parent chain. */
  readonly provenance: SessionProvenanceStamper;
  /** Per-harness workarounds: how each harness changes the model of a live
   *  session, and how the daemon recovers when driving Codex's modal picker
   *  fails part-way. */
  readonly harness: HarnessQuirkService;
  readonly transcripts: TranscriptWorld;
  /** The daemon's HTTP surface: `/healthz`, `/v1/health`, `/usage`, `/v1/usage`
   *  and `/metrics` today, plus whatever each subsystem unit mounts as it lands. */
  readonly api: ApiServerPort;
  /**
   * Where a terminal actually runs: tmux panes on the daemon's own private socket, never the host's
   * default one.
   *
   * It is a world FIELD rather than a private of the factory below because it is the one adapter in
   * the terminal subsystem whose real behaviour cannot be driven from a test without spawning
   * shells. A test substitutes this and keeps everything else — the lifecycle service, the routes,
   * the session resolver over real storage — exactly as production builds them.
   */
  readonly terminalRuntime: TerminalRuntimePort;
  /** Creates the one memory-only ticket registry for one daemon start. It is a world seam so the
   * production socket path can be exercised at an elapsed deadline without making an integration
   * test sleep for the public thirty-second ticket lifetime. */
  readonly createSocketTickets: () => SocketTicketBroker;
  /**
   * The OTHER carriers this daemon can be reached over: outbound sockets to rendezvous.
   *
   * THE DAEMON DIALS. This is not a second listener — a daemon on `127.0.0.1` has no inbound route,
   * and the only reason a relay makes it reachable is that the connection is opened outbound from
   * behind the NAT. It carries the SAME dispatcher the bound address serves, so a relayed request
   * reaches exactly the routes a direct one reaches and there is no second surface to keep in step.
   *
   * The factory answers a refusal rather than throwing, and the refusal is printed. A daemon with no
   * relay and a daemon whose relays are broken look identical from the outside, and this migration
   * has shipped that confusion three times: the sentence is the difference.
   */
  readonly createRelayCarriers: (
    sources: readonly RelayCarrierSource[],
    dispatch: RelayApiDispatch,
    sockets: RelayStreamDispatch,
    devices: RelayDeviceDirectory,
    pairing: RelayPairingRedeemer,
  ) => Promise<
    | {
        readonly carriers: readonly {
          readonly carrier: BunRelayCarrier;
          readonly source: RelayCarrierSource;
        }[];
      }
    | { readonly refusal: string }
  >;
  /**
   * WHERE DISCOVERED CARRIERS COME FROM — one HTTP read, once per boot.
   *
   * A world FIELD rather than a private of the factory above because `--check` asks it too, and
   * because it is the one collaborator in this subsystem that talks to a service off this machine:
   * a test substitutes it and keeps the choices, carriers and notices exactly as production
   * builds them.
   */
  readonly relayDirectory: RelayDirectoryPort;
  /**
   * The subsystems mounted onto that surface. Every field the result carries is a capability the
   * running product actually has; a subsystem absent from it is one the daemon never constructs.
   *
   * Built per opened storage rather than at process start because a subsystem that reads the
   * authoritative session set — the task boards do, for the fleet-wide read and for the live view —
   * cannot be handed a session index that has not been opened and locked yet.
   *
   * The terminal runtime is passed IN rather than captured, so overriding `terminalRuntime` on a
   * world actually changes what the mounted subsystems get. A factory that closed over the field
   * would silently keep the production one and make the seam a lie.
   */
  readonly createSubsystems: (
    storage: DaemonStorage,
    terminals: TerminalRuntimePort,
    /**
     * The account-health feed, passed IN for the same reason the terminal runtime is: it is built
     * from configuration in `start`, and the recommender must read the same snapshot the `/usage`
     * feed serves rather than probing the providers a second time.
     */
    usage: UsageFeedPort,
    /**
     * The self-check, passed IN for the same reason: `start` owns its tick timer, and the health
     * route must report the ledgers THAT service filled rather than a second one's empty ones.
     */
    health: SessionHealthService,
    /**
     * The agent launcher, passed IN for the same reason the terminal runtime is: session control
     * builds a lifecycle service per start, and a factory that closed over the field would keep the
     * production tmux launcher no matter what a test substituted.
     */
    launcher: SessionLifecycleLauncher,
    /**
     * The pane a revive replaces, passed IN for the same reason: the resume service is built once per
     * opened storage, and a factory that closed over `createResumeLauncher` would keep the production
     * tmux launcher no matter what a test substituted.
     */
    reviver: ResumeLauncher,
    /**
     * The destructive-migration gate, passed IN for the same reason as every other host adapter here:
     * it walks the machine's own process table and reads live panes, so it is the one collaborator in
     * a migration whose real behaviour cannot be driven from a test without running the work it is
     * inspecting. A test substitutes this and keeps the restamp, the report, the relaunch, the real
     * documents and the route exactly as production builds them.
     */
    preflight: MigrationPreflight,
    /**
     * The login window, passed IN for the same reason as every other host adapter here: opening one
     * puts an X server, a Chrome and a VNC listener on the machine, so a test substitutes this and
     * keeps the routes, the credentials and the dispatcher exactly as production builds them. A
     * factory that closed over `browserLogin` would keep the production one no matter what a test
     * supplied.
     */
    browserLogin: BrowserLoginLifecycle,
    /**
     * Dictation enhancement, passed IN for the same reason as every other host adapter here: one call
     * spends the operator's provider credential over the network. A test substitutes this and keeps
     * the route, the credentials and the dispatcher exactly as production builds them.
     */
    sttEnhancement: SttEnhancementSubsystem,
    /** Local paths are configuration, so the catalog is constructed against this exact document. */
    catalogs: CatalogSubsystem,
    /** Operator-owned API-equivalent pricing for this daemon's analytics only. */
    /**
     * The managed-worktree durable half, passed IN because both members are decided by the state home
     * this boot opened: the registry is a document inside it, and the managed root is derived from
     * its name. The Git operations come with them so a test can drive every route of this surface
     * against a scratch repository without the composition root reaching for a second seam.
     */
    worktrees: WorktreeComposition,
    /**
     * The analytics materialization, passed IN because opening it touches the disk: it walks its own
     * paths through the confined filesystem port, may discard an index it cannot reuse, and must be
     * closed with the rest of this boot's acquisitions. A factory that opened it here would open a
     * second database every time a test built subsystems.
     */
    analyticsStore: OpenedAnalyticsIndexStore,
    /** Pairing is opened before the dispatcher so its live device registry is the auth boundary. */
    pairing: PairingService,
    /** Opened WITH pairing, because an enrolment's lifetime is a device grant's — see `createPairing`. */
    push: PushService,
    /** The exact published set pairing redemption receives and authenticated refresh serves. */
    carriers: readonly DaemonCarrier[],
    socketTickets: SocketTicketBroker,
    /**
     * Where this operator has said the harnesses are, passed IN for the same reason the usage feed
     * is: it is read from the configuration this boot loaded, and the doctor route must report the
     * resolution the boot milestone reported rather than a second one built from its own reading.
     */
    harnessDiscovery: HarnessDiscoveryPolicy,
  ) => MountedSubsystems;
  /** The bearer tokens the API accepts, minted into the state home on first boot. */
  readonly credentials: StateApiCredentials;
  /** Wall-clock milliseconds. Injected rather than read from `Date.now()` at the point of use so
   *  the uptime and freshness the API reports are drivable from a test. */
  readonly clock: MillisecondClockPort;
  /**
   * The hosted-model pass that repairs a dictated transcript — the daemon's whole remaining share of
   * dictation, now that recognition happens in the browser.
   *
   * Typed as the MOUNT's narrow interface rather than as `SttEnhancementService`, so a test can
   * answer the route without an outbound transport, a secret reader and a stopwatch behind it. The
   * production service satisfies it structurally.
   */
  readonly sttEnhancement: SttEnhancementSubsystem;
  /** Resolves when the process should shut down. Injected so a test can drive a
   *  full boot without the daemon running forever. */
  readonly untilShutdown: () => Promise<void>;
}

/**
 * Transcript access: one bounded follower per harness, plus the search that runs over what they
 * produce. The daemon never branches on harness — it picks the source whose `harness` matches the
 * session and reads through the common port.
 */
export interface TranscriptWorld {
  readonly sources: readonly TranscriptSource[];
  search(
    events: readonly TranscriptEvent[],
    query: string,
    options?: TranscriptSearchOptions,
  ): readonly TranscriptSearchMatch[];
}

/** Resolves on the first termination signal, so the API server is stopped and its port released
 *  before the process exits rather than being torn down by the kernel mid-request. */
function untilTerminated(): Promise<void> {
  return new Promise<void>(resolve => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => resolve());
  });
}

/**
 * The human login window and the teardown of everything it put on the host.
 *
 * TWO members rather than one, because the window's own lifecycle contract has no release: `start`
 * and `stop` are a person's intent about one sign-in, and the X display outlives any single window by
 * design (see `XvfbDisplay`). So the intent goes on the route and the release goes to `cleanups`.
 */
export interface BrowserLoginWorld {
  readonly window: BrowserLoginLifecycle;
  readonly close: () => Promise<void>;
}

/**
 * The browser transport seam: the session runtime asks for a driver and for viewer streams, and never
 * learns what a child process or a socket is.
 */
export interface BrowserTransportWorld {
  connectWorker(options: WorkerClientOptions): Promise<BrowserWorkerClient>;
  openViewerStream(host: BrowserViewerHost, sessionId: string, socket: ViewerSocket): Promise<BrowserViewerStream>;
}

/**
 * The task record boards, over the state home and the opened session index.
 *
 * The board is ONE JSON snapshot inside the session's own private directory, which is why the path
 * is derived here and never by the store: layout is the composition root's business, and a store that
 * derived its own path could not be pointed at a test's temp home.
 *
 * The id is PARSED rather than asserted. A path-unsafe session id must never become a directory, so
 * the refusal is raised in the task protocol's own taxonomy — the mount answers `invalid` with 400
 * instead of leaking a schema error as a 500.
 */
function createTaskSubsystem(
  paths: FoundationPaths,
  storage: DaemonStorage,
  clock: SystemClock,
  boards: TaskBoardSerialExecutor,
  boardActions: TaskBoardTaskActionAuthorizer,
): TaskSubsystem {
  /** The document a session's own state directory holds, parsed, or `undefined` when unusable. */
  const observed = async (id: SessionId): Promise<AssigneeObservation | undefined> => {
    const [rawConfig, rawState] = await Promise.all([storage.readConfig(id), storage.readState(id)]);
    const state = SessionStateSchema.safeParse(rawState);
    if (!state.success) return undefined;
    const config = SessionConfigSchema.safeParse(rawConfig);
    return {
      sessionId: id,
      // A missing or unreadable configuration costs the display name, not the whole observation: the
      // state document is what carries the facts the board reports.
      name: config.success ? config.data.name : null,
      status: state.data.status,
      lastActivityAt: state.data.lastActivityAt ?? null,
    };
  };
  return {
    board: sessionId => {
      const id = tryParseSessionId(sessionId);
      if (id === undefined) throw new TaskError('invalid', `${JSON.stringify(sessionId)} is not a usable session id`);
      return new TaskRecordService(
        id,
        new FileTaskStore(join(createSessionPaths(paths, id).directory, 'tasks.json'), { executor: boards }),
      );
    },
    sessionIds: async () => storage.listSessions().map(session => session.id),
    /**
     * An assignee is a TEAMMATE, and this is where the name a human typed becomes a session.
     *
     * `fy task create --assignee <who>` documents its argument as "the teammate who owns it", so a
     * session id is the exception rather than the rule. This used to match ids only — every task a
     * person assigned by callsign reported a null live column — and the recorded reason was the cost:
     * resolving a name means reading the documents that carry names. The mount asks for the DISTINCT
     * assignees of one response instead of one row at a time, so that cost is one fan-out per request
     * rather than one per task, which is the same fan-out `/v1/names` already performs.
     *
     * A KNOWN SESSION ID SHORT-CIRCUITS, so the common single-task read stays two document reads: an
     * assignee the index already holds needs no directory at all.
     *
     * `exactWorkerAssignee` is the DOMAIN's resolution rule, not a second one written here — an exact
     * id, then a callsign, then a display name only for a session with no callsign of its own, and
     * `null` whenever two sessions answer to one name. Ambiguity reported as unknown is the point: the
     * alternative attributes a task to whichever session the index happened to list first.
     */
    observe: async assignees => {
      const resolved = new Map<string, AssigneeObservation>();
      const unresolved: string[] = [];
      for (const assignee of assignees) {
        const id = tryParseSessionId(assignee);
        if (id !== undefined && storage.findSession(id) !== undefined) {
          const observation = await observed(id);
          if (observation !== undefined) resolved.set(assignee, observation);
        } else unresolved.push(assignee);
      }
      if (unresolved.length === 0) return resolved;
      const candidates = await assigneeCandidates(storage);
      for (const assignee of unresolved) {
        const named = exactWorkerAssignee({ assignee }, candidates);
        const id = named === null ? undefined : tryParseSessionId(named);
        const observation = id === undefined ? undefined : await observed(id);
        if (observation !== undefined) resolved.set(assignee, observation);
      }
      return resolved;
    },
    now: () => clock.now(),
    boardActions,
  };
}

/**
 * Every session an assignee could name, as the three fields the resolution rule reads.
 *
 * The BOARD's own session directory is deliberately not reused, however similar it looks: it omits
 * every session without a `sessionCapabilityHash`, because a session that cannot hold a capability
 * cannot be a member of a board. That is right for authorization and wrong here — a task assigned to
 * a teammate whose session predates the credential would read as unknown — and this is a display
 * question, so it answers over every session the index holds.
 *
 * A session whose configuration document does not parse is LEFT OUT rather than guessed at, matching
 * every other reader in this root: a candidate assembled from a document the protocol schema rejected
 * is a candidate whose name nobody can vouch for, and matching a task against one would attribute it
 * to a session the daemon cannot describe.
 */
async function assigneeCandidates(storage: DaemonStorage): Promise<readonly TaskAssigneeCandidate[]> {
  const candidates = await Promise.all(
    storage.listSessions().map(async (session): Promise<TaskAssigneeCandidate | undefined> => {
      const config = SessionConfigSchema.safeParse(await storage.readConfig(session.id));
      return config.success
        ? { id: config.data.id, name: config.data.name, teammate: config.data.teammate ?? null }
        : undefined;
    }),
  );
  return candidates.filter((candidate): candidate is TaskAssigneeCandidate => candidate !== undefined);
}

/**
 * The session read, over the authoritative index and the documents in the state home.
 *
 * BOTH DOCUMENTS ARE PARSED, and a session whose pair does not parse is left out of the list rather
 * than reported with holes: a view assembled from a config the protocol schema rejected is a view
 * whose fields nobody can vouch for. The single read refuses that same session instead of omitting
 * it, so the gap in the list is answerable rather than silent.
 *
 * The DIRECTORY is derived from the layout, never from the request: `createSessionPaths` takes a
 * parsed id, so a path-unsafe reference is refused in the reader's own taxonomy before it can become
 * a filesystem path.
 */
function createSessionDirectorySubsystem(
  paths: FoundationPaths,
  storage: DaemonStorage,
  project?: (id: SessionId, config: SessionConfig) => Promise<void>,
): SessionDirectorySubsystem {
  /** The pair of documents for one indexed session, parsed, or `undefined` when either is unusable. */
  const view = async (id: SessionId): Promise<SessionView | undefined> => {
    const rawConfig = await storage.readConfig(id);
    const config = SessionConfigSchema.safeParse(rawConfig);
    if (config.success) await project?.(id, config.data);
    const state = SessionStateSchema.safeParse(await storage.readState(id));
    if (!config.success || !state.success) return undefined;
    return { config: config.data, state: state.data, directory: createSessionPaths(paths, id).directory };
  };
  return {
    list: async () => {
      const views = await Promise.all(storage.listSessions().map(async session => await view(session.id)));
      return views.filter((session): session is SessionView => session !== undefined);
    },
    get: async reference => {
      const id = tryParseSessionId(reference);
      if (id === undefined)
        throw new SessionReadError('invalid', `${JSON.stringify(reference)} is not a usable session id`);
      if (storage.findSession(id) === undefined) return undefined;
      const found = await view(id);
      if (found === undefined)
        throw new SessionReadError('unusable', `the documents for session ${reference} do not satisfy the protocol`);
      return found;
    },
  };
}

/**
 * The operator knobs a start records when the caller names none.
 *
 * They are DECLARED here, at the composition root, because they are this deployment's answers rather
 * than the protocol's: `SessionConfigSchema` demands every one of them and defaults none, so a
 * session document cannot exist without a number for each. Zero means "no such deadline" throughout —
 * a nudge, a kill and a hard timeout are supervision this daemon does not mount, and a non-zero
 * deadline nothing enforces would be a promise the product does not keep.
 */
const SESSION_START_DEFAULTS = {
  intervalSeconds: 30,
  timeoutSeconds: 0,
  nudgeAfterSeconds: 0,
  killAfterSeconds: 0,
  directSendMaxChars: 4_096,
  resumeMenuChoice: 'full',
  maxSnapshots: 10,
  // No retry is attempted because no supervisor exists to attempt one; a policy claiming otherwise
  // would be read as a guarantee by every surface that displays it.
  retry: { transientAttempts: 0, stalledAttempts: 0, waitForQuotaReset: false, allowAccountFailover: false },
} as const;

/**
 * Naming a request body by its content, which is how the protocol client identifies the start it is
 * recovering.
 *
 * A PORT rather than a `createHash` call at the point of use, because `src/lib` may not reach a
 * platform capability and the mount must stay a pure function of its request. The algorithm is not
 * this daemon's choice: the client sends the SHA-256 hex of the body it posted, so anything else
 * would never match.
 */
interface PayloadDigestPort {
  hex(payload: string): string;
}

/**
 * Callsign claiming, as a START needs it: take a name, and give one back when the start it was taken
 * for never happened.
 *
 * The two halves come from different objects — the allocator decides, the ledger persists — and this
 * is the pair the composition root hands over, so the mount's own dependency is the capability rather
 * than two collaborators it would have to know how to assemble.
 */
interface CallsignClaims {
  allocate(request: NameAllocationRequest): Promise<NameAllocationResult>;
  release(callsign: string, ownerId: string): Promise<void>;
}

/**
 * An opening message's attachments, as a start needs them: decided, then written.
 *
 * The two halves are one dependency because they are one capability whose seam is an ORDERING — the
 * decision must be taken before the session record exists and the write must happen after it. Layout
 * and the extractor are the composition root's to supply, so the mount asks for the capability
 * rather than for a directory and an inflater it would have to assemble.
 */
interface InitialAttachments {
  plan(id: SessionId, attachments: readonly DecodedInitialAttachment[]): PlannedInitialAttachments;
  write(files: readonly PlannedAttachmentFile[]): Promise<void>;
}

/** The opening message an agent will be handed, and the files that must exist before it is. */
interface OpeningMessage {
  readonly prompt: string | undefined;
  readonly files: readonly PlannedAttachmentFile[];
}

/**
 * The opening message, with every attachment decided but none of them written yet.
 *
 * THE ORDER IS FORCED, and it is worth stating because it is not the obvious one. A session's
 * directory belongs to storage, which refuses to adopt one already holding files it did not create —
 * so attachments cannot be written before the session record exists. The record carries the prompt,
 * and the prompt names the attachments. Deciding everything in memory first breaks that cycle:
 * extraction is a pure function over bytes already in this request, so the paths, the character
 * counts and the refusals are all knowable before the first write. The start then creates the
 * record, writes the files, and only then launches — so the document the agent opens never names a
 * file that is not there.
 *
 * An attachment with NO opening message is refused rather than invented into one. `fy start -f`
 * describes a file attached "to the opening message", and the CLI refuses the same combination on
 * `fy send` — a bare interactive session is started with nothing typed into it, so there would be no
 * document for the reference to live in.
 */
function composeOpeningMessage(
  attachments: InitialAttachments,
  id: SessionId,
  request: StartSessionRequest,
): OpeningMessage {
  const stated = request.initialAttachments ?? [];
  if (stated.length === 0) return { prompt: request.prompt, files: [] };
  if (request.prompt === undefined)
    throw new SessionControlError(
      'invalid',
      'attachments belong to an opening message: start with a prompt, or start bare without files',
    );
  try {
    const planned = attachments.plan(id, decodeInitialAttachments(stated));
    return {
      prompt: `${request.prompt}\n${renderInitialAttachmentSection(planned.delivered)}`,
      files: planned.files,
    };
  } catch (error) {
    if (error instanceof InitialAttachmentError) throw new SessionControlError('invalid', error.message);
    throw error;
  }
}

/**
 * The harness preflight, for every surface that reports one: the boot trail, `fyd --check` and the
 * doctor route.
 *
 * ONE reader, because a manifest this daemon cannot read must not become "no accounts published" on
 * any of the three. Read through {@link unreadableManifestPreflight}, the refusal travels as itself
 * and each surface says the weaker, true thing.
 */
async function readHarnesses(
  accounts: AccountInventoryPort,
  executables: ExecutableResolverPort,
  policy: HarnessDiscoveryPolicy,
): Promise<HarnessPreflight> {
  try {
    return readHarnessPreflight(await accounts.accounts(), executables, policy);
  } catch (error) {
    if (!(error instanceof FleetManifestUnreadableError)) throw error;
    return unreadableManifestPreflight(fleetManifestRefusal(error, CLIENT_NAME), executables, policy);
  }
}

/**
 * What this operator has said about where the harnesses are, read once per invocation.
 *
 * BOTH SURFACES ARE READ HERE, in the composition root, because only here are both available: the
 * document comes off the configuration this boot loaded, and the environment is this host's. A daemon
 * started by a service manager inherits a minimal environment, which is the whole reason the two
 * surfaces exist — the unit file can set a variable and cannot edit a JSON document.
 *
 * THE DECLARATIONS ARE READ ONCE AND THE LOOKUP IS NOT. A declaration is configuration and changes
 * when the daemon is restarted, exactly like every other value in that document; whether a harness is
 * installed right now is asked at the moment of the lookup, so a harness installed after this daemon
 * came up is still found.
 */
function harnessDeclarations(config: DaemonConfig): HarnessDiscoveryPolicy {
  return harnessDiscoveryPolicy({
    document: config.harness,
    environment: name => process.env[name],
    homeDirectory: homedir(),
  });
}

/**
 * The account this start names, or a refusal that says which half of the resolution failed.
 *
 * THE LAUNCHABILITY RULE IS THE DOMAIN'S, not a second copy written here. `fyd --check` and the boot
 * preflight report on whether a harness could serve, and they answer that question by asking this
 * same `accountLaunchability`. Two spellings of "could a start run this?" would eventually disagree,
 * and the disagreement would be a preflight that promises a harness a start then refuses.
 */
async function resolveStartAccount(
  accounts: AccountInventoryPort,
  requested: string,
  executables: ExecutableResolverPort,
): Promise<{ readonly account: CoreAccount; readonly executable: string }> {
  // A manifest this daemon cannot read refuses the START, rather than answering it with an empty
  // fleet and the unknown-agent message that empty fleet would earn. The caller asked for an account
  // that may well be published; what this daemon has is no way to tell.
  const published = await accounts.accounts().catch((error: unknown) => {
    if (error instanceof FleetManifestUnreadableError)
      throw new SessionControlError('unavailable', fleetManifestRefusal(error, CLIENT_NAME));
    throw error;
  });
  // The wrapper NAME first, then the opaque id: `fy start claude-auto-loge` names the wrapper a human
  // types, and the recommender answers with account ids, so both must resolve.
  const account = published.find(row => row.agent === requested) ?? published.find(row => row.id === requested);
  if (account === undefined)
    throw new SessionControlError(
      'unknown_agent',
      `no account in the fleet manifest is published as ${JSON.stringify(requested)}`,
    );
  const launchability = accountLaunchability(account, executables);
  // Both halves are `unavailable` to a caller: the account exists and cannot serve. Which half is
  // the operator's business, and it is the reason the rule reports the two separately.
  if (launchability.kind !== 'launchable') throw new SessionControlError('unavailable', launchability.reason);
  return { account, executable: launchability.executable };
}

/** How each allocation refusal is answered. A taken callsign is a conflict a human can resolve by
 *  choosing another name; an exhausted pool is the daemon having nothing left to offer; a claim store
 *  the daemon cannot read or write is a server-side unavailable condition the caller may retry once it
 *  is mended, never a launch defect. */
const CALLSIGN_REFUSALS: Readonly<Record<NameAllocationErrorCode, SessionControlFailure>> = {
  invalid_callsign: 'invalid',
  callsign_taken: 'callsign_taken',
  pool_exhausted: 'unavailable',
  claim_store_failed: 'callsign_unavailable',
  random_source_failed: 'failed',
};

/**
 * The callsign this session will answer to, CLAIMED rather than recorded.
 *
 * A start that merely wrote down the requested name would let two sessions answer to one callsign,
 * and a bare callsign then resolves to both — which is the whole reason `NameAllocator` exists. The
 * claim is taken before the session document is written, because the document is what everything else
 * derives ownership from and it does not exist yet.
 *
 * A start that names NO callsign gets none. Allocating automatically would burn a pool name on every
 * session nobody addresses by name, and `teammate` is optional on the wire precisely because a session
 * need not be a teammate.
 */
async function claimCallsign(
  callsigns: CallsignClaims,
  owner: SessionId,
  request: StartSessionRequest,
): Promise<string | undefined> {
  if (request.teammate === undefined) return undefined;
  const allocated = await callsigns.allocate({
    ownerId: owner,
    nowMs: Date.now(),
    requested: request.teammate,
    // The caller decides whether a taken name is a refusal or a fallback; the daemon does not guess.
    ...(request.teammateFallback === true ? { fallback: true } : {}),
  });
  if (!allocated.ok) throw new SessionControlError(CALLSIGN_REFUSALS[allocated.error.code], allocated.error.message);
  return allocated.claim.callsign;
}

/**
 * The attachment files, written onto a session that now exists.
 *
 * A FAILURE HERE IS RECORDED ON THE RECORD, never raised bare. The session document already exists
 * by this point, so a start that only threw would leave a `created` session nothing will ever launch
 * and no stated reason anywhere. Stopping it with the reason answers the caller with the session
 * that holds the evidence, which is exactly what a failed launch does.
 */
async function storeAttachments(
  lifecycle: SessionLifecycleService,
  attachments: InitialAttachments,
  id: SessionId,
  files: readonly PlannedAttachmentFile[],
): Promise<void> {
  try {
    await attachments.write(files);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await lifecycle.stop(id, `the opening message's attachments could not be stored: ${reason}`).catch(() => undefined);
    throw error;
  }
}

/**
 * Starting and stopping a session, over the lifecycle service that was built for exactly this and
 * never called.
 *
 * WHAT THIS FACTORY HAS TO RECONCILE, because the two halves of the daemon were ported by different
 * units and describe a session differently:
 *
 *   * THE AGENT IS TWO VALUES. The protocol's `agent` is the wrapper name an account is published
 *     under; the lifecycle's is the absolute executable its authorization checks. This resolves one
 *     into the other through the fleet manifest and this host's PATH, and refuses when either half
 *     has no answer — a fleet naming a wrapper the host cannot run is a configuration fault, not a
 *     session that fails at launch.
 *   * THE DOCUMENT IS ONE FILE. `StorageSessionLifecycleRepository` writes the protocol's fields
 *     alongside the lifecycle's from the envelope built here, so a session this start creates is
 *     visible to the session list, task-board enrichment, analytics and the callsign pool rather
 *     than dropped by every one of them.
 *   * THE ID IS MINTED BEFORE THE PLAN. `SessionPlanner` decides the model and the remote-control
 *     arguments FROM the session id, so the id is minted here and handed to the lifecycle.
 *
 * IDEMPOTENCY IS IN MEMORY, and that is the honest scope for it. The hazard is the protocol client's
 * own automatic retry seconds after a transport error: without a ledger that retry opens a second
 * pane and a second agent against the same task. A restart between the two attempts loses the ledger,
 * but it also loses the connection the retry would have travelled on, so the client sees a transport
 * failure rather than a duplicate session.
 */
function createSessionControlSubsystem(
  storage: DaemonStorage,
  sessions: SessionDirectorySubsystem,
  createLifecycle: DaemonWorld['createSessionLifecycle'],
  planner: SessionPlanner,
  launcher: SessionLifecycleLauncher,
  accounts: AccountInventoryPort,
  executables: ExecutableResolverPort,
  ids: SessionIdFactory,
  callsigns: CallsignClaims,
  digests: PayloadDigestPort,
  attachments: InitialAttachments,
  boardGrants: ChildGrantRequester,
  /**
   * The evidence a session's transcript is identified from, taken here because here is the only
   * place it exists: the wrapper about to be launched, the directory it will run in, and — for
   * Claude — an id this start is free to choose because nothing has started yet.
   */
  transcripts: TranscriptProvenanceCapture,
  /**
   * The same canonicalization the lifecycle applies, run BEFORE the launch argv is built.
   *
   * Claude's transcript directory is a pure function of the working directory the harness process
   * actually runs in, which is the canonical one the record holds — so deriving the path from the
   * raw request would name the wrong file whenever the caller passed a symlink or a trailing slash.
   */
  directories: WorkingDirectoryResolver,
  /** The session's own private directory, which is the string a Codex rollout is correlated by. */
  sessionDirectory: (id: SessionId) => string,
  /**
   * The STARTUP half of the one runtime subsystem, applying effort before turn one is delivered.
   *
   * Not the mounted control, and for the same reason a fork does not use it: at this point the
   * session is `starting`, which the public path refuses by design. A start and a fork occupy the
   * identical window and go through the identical entry point.
   */
  runtime: SessionRuntimeStartupHeldPort,
  /**
   * The spawn-side warden stamp, decided at create because create is the only moment it can be.
   *
   * It also owns the LABEL: a warden descendant is force-labelled, so the label and the stamp have
   * to be decided by the same call or the two shield mechanisms can disagree about one session.
   */
  provenance: SessionProvenanceStamper,
  clock: ClockPort,
): SessionControlSubsystem {
  /** Request id to the session it started, plus the exact body it started from, for this process's
   *  lifetime. The body is kept VERBATIM because the recovery read identifies it by digest. */
  const spent = new Map<string, { readonly sessionId: SessionId; readonly payload: string }>();

  /** The view of a session this mount just wrote. A document it cannot read back is a wiring fault. */
  const view = async (id: SessionId): Promise<SessionView> => {
    const found = await sessions.get(id).catch(() => undefined);
    if (found === undefined)
      throw new SessionControlError(
        'failed',
        `session ${id} was written but its documents do not satisfy the protocol`,
      );
    return found;
  };

  return {
    start: async (request, requestId, payload, boardCapability) => {
      const already = spent.get(requestId);
      if (already !== undefined) {
        if (already.payload !== payload)
          throw new SessionControlError(
            'conflict',
            `request id ${JSON.stringify(requestId)} already started session ${already.sessionId} from a different request`,
          );
        return await view(already.sessionId);
      }
      // A start with no working directory would run the agent wherever the DAEMON happens to be,
      // which is never what a caller meant; the resolver refuses a relative one for the same reason.
      if (request.cwd === undefined)
        throw new SessionControlError('invalid', 'a start must name the absolute working directory to run in');
      // The board ask, resolved BEFORE anything is written and as one value rather than two loose
      // ones: the role and the secret that authorizes it are only ever meaningful together, and a
      // start that carried the role without the secret would otherwise be startable with the grant
      // silently skipped — a session whose document claims board access nothing asked the board for.
      // The mount refuses this case already; this is the fail-closed answer for any other caller.
      const boardAsk = ((): { readonly role: TaskBoardChildAccess; readonly capability: string } | undefined => {
        if (request.boardAccess === 'none') return undefined;
        if (boardCapability === undefined || boardCapability === '')
          throw new SessionControlError(
            'invalid',
            `a start asking for ${request.boardAccess} board access must present the requesting session's own board capability`,
          );
        return { role: request.boardAccess, capability: boardCapability };
      })();
      const { account, executable } = await resolveStartAccount(accounts, request.agent, executables);
      // Canonicalized HERE rather than only inside the lifecycle, because the transcript path below
      // is derived from it. The lifecycle resolves it again over an already-canonical value, and a
      // directory the agent could not have started in is refused as an invalid request — which is
      // exactly what this failure taxonomy calls "an absent cwd".
      const cwd = await directories.resolve(request.cwd).catch((error: unknown) => {
        throw new SessionControlError('invalid', error instanceof Error ? error.message : String(error));
      });
      const id = ids.next();
      // BEFORE the callsign and the plan, because it decides part of the launch argv: Claude is
      // told which session id to write its transcript under, and that has to be in `command` when
      // the record is created. Nothing here can fail a start — a wrapper with no declared home
      // yields no record and no arguments.
      const transcript = await transcripts.capture({
        harness: account.kind,
        executable,
        cwd,
        correlationToken: sessionDirectory(id),
        at: clock.now(),
      });
      /**
       * The spawn stamp, decided here because here is where the fleet and the request are both in
       * hand and nothing has been written yet.
       *
       * THE LABEL COMES BACK FROM THE STAMPER, and that is not a convenience. `resolveSpawnLabel`
       * FORCES a warden descendant's label, and inherits the parent's otherwise. Writing
       * `request.label` beside a `wardenLineage: true` stamp would produce a session whose two
       * shield mechanisms — the label check and the stamp check — disagree, and the detector reading
       * the label first would mask the disagreement until somebody edited the label.
       *
       * `requestedByHuman` is `request.parent === undefined`: a start with no parent arrived from a
       * human surface, and one with a parent was spawned by the session that named itself the
       * parent. It decides `origin` only — warden descent overrides it either way — so the worst a
       * wrong reading does is misattribute, never unshield.
       */
      const stamped = provenance.stamp(
        {
          id,
          ...(request.label === undefined ? {} : { label: request.label }),
          ...(request.parent === undefined ? {} : { parent: request.parent }),
          requestedByHuman: request.parent === undefined,
        },
        await spawnAncestry(storage, sessions),
      );
      // BEFORE the callsign is claimed, so a start refused over an unusable attachment does not park
      // a pool name for the whole resolution window on a session that never happens.
      const opening = composeOpeningMessage(attachments, id, request);
      const prompt = opening.prompt;
      // BEFORE the plan, because the callsign is what the harness's own remote-control session is
      // named after: a plan built on the requested name and a document recording the fallback would
      // disagree about who this session is.
      const teammate = await claimCallsign(callsigns, id, request);
      const plan = planner.plan({
        id,
        account,
        mode: request.mode,
        ...(teammate === undefined ? {} : { teammate }),
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.model === undefined ? {} : { requestedModel: request.model }),
        ...(request.parent === undefined ? {} : { parent: request.parent }),
      });
      const startupRuntime: RuntimeControlRequest | undefined =
        request.effort === undefined
          ? undefined
          : harnessQuirks(account.kind).effortIsRuntimeCommand
            ? { action: 'effort', effort: request.effort }
            : { action: 'model', model: plan.model, effort: request.effort };
      // The remote-control arguments are added only when the caller asked for the surface, because
      // they are what makes the harness publish one — adding them anyway would open a control channel
      // for a session whose own document records that it has none.
      const command = [
        executable,
        ...(request.remoteControl === true ? plan.extraArgs : []),
        ...transcript.launchArguments,
        // The catalogue-proved model is the daemon's default. A free-form operator flag is last,
        // as documented: an explicitly supplied `--model` wins over that default.
        ...startupModelArguments(plan.model),
        ...(request.harnessFlags ?? []),
      ];
      const envelope: SessionProtocolEnvelope = {
        agent: account.agent,
        harness: account.kind,
        // An incarnation names one RUN of a session: this is its first, and a revive is what mints
        // the next. The generation is the daemon-side counter of those relaunches.
        incarnation: `${id}-1`,
        runtimeGeneration: 1,
        // What the caller asked for, on the document the API projects. Recording `none` for a start
        // that asked for `worker` would make every surface reading this session disagree with the
        // grant intent the board is holding for it.
        boardAccess: request.boardAccess,
        // What the caller asked for, kept beside the model that was actually resolved for it: the
        // hint is evidence about the request and the model is the decision.
        modelHint: request.model ?? account.defaultModel ?? '',
        model: plan.model,
        remoteControl: request.remoteControl === true,
        harnessFlags: [...(request.harnessFlags ?? [])],
        /**
         * WHICH TURN THIS SESSION IS ON, which is the number of the turn document it was handed.
         *
         * It is not "turns answered". Nothing in this daemon observes an agent answering, and the
         * counter has a second reader that decides behaviour from it: a revive writes
         * `turns/turn-<turn + 1>.md` and hands the agent that file. Recording zero for a session that
         * was already given `turn-001.md` therefore makes the FIRST revive plan turn one and overwrite
         * the very document holding the session's original assignment.
         *
         * A start with no prompt handed over no document, so it is genuinely on turn zero — and the
         * first revive of it writes `turn-001.md` with nothing to overwrite.
         */
        turn: prompt === undefined ? 0 : 1,
        /**
         * WHERE THIS SESSION'S TRANSCRIPT IS, recorded in the same single write as everything else
         * the start decided.
         *
         * It is here rather than added afterwards for the reason the whole unit exists: the
         * evidence is only true at this instant. A record written after the launch would be
         * describing a harness that has already started writing somewhere, and the only way to find
         * out where would be to guess.
         */
        ...(transcript.provenance === undefined ? {} : { transcript: transcript.provenance }),
        ...(teammate === undefined ? {} : { teammate }),
        // The STAMPER's label, never the request's — see the stamp above for why the two must be
        // decided together.
        ...(stamped.label === undefined ? {} : { label: stamped.label }),
        provenance: stamped.provenance,
        ...SESSION_START_DEFAULTS,
        ...(request.intervalSeconds === undefined ? {} : { intervalSeconds: request.intervalSeconds }),
        ...(request.timeoutSeconds === undefined ? {} : { timeoutSeconds: request.timeoutSeconds }),
        ...(request.nudgeAfterSeconds === undefined ? {} : { nudgeAfterSeconds: request.nudgeAfterSeconds }),
        ...(request.killAfterSeconds === undefined ? {} : { killAfterSeconds: request.killAfterSeconds }),
        ...(request.directSendMaxChars === undefined ? {} : { directSendMaxChars: request.directSendMaxChars }),
        ...(request.resumeMenuChoice === undefined ? {} : { resumeMenuChoice: request.resumeMenuChoice }),
        ...(request.maxSnapshots === undefined ? {} : { maxSnapshots: request.maxSnapshots }),
      };
      const lifecycle = createLifecycle(storage, launcher, envelope, id);
      try {
        // CREATE, then write the attachments, then START — the one ordering storage's own layout
        // rule allows. The record claims the session directory; the files land inside the directory
        // it now owns; the launch writes the turn-one document that names them. See
        // `composeOpeningMessage` for why the decision had to be taken before any of the three.
        await lifecycle.create({
          agent: executable,
          command,
          // The canonical directory, so the record and the transcript path above agree about which
          // directory this session actually runs in.
          cwd,
          mode: request.mode,
          ...(request.name === undefined ? {} : { name: request.name }),
          ...(prompt === undefined ? {} : { prompt }),
          ...(request.parent === undefined ? {} : { parent: request.parent }),
        });
        if (opening.files.length > 0) await storeAttachments(lifecycle, attachments, id, opening.files);
        // AFTER the record and BEFORE the launch, which is the only window in which both halves are
        // true: the board's session directory reads the session's own documents, so the target must
        // exist for the grant to name it, and a refusal must not have cost an agent.
        if (boardAsk !== undefined) await boardGrants(boardAsk.capability, id, boardAsk.role);
        await lifecycle.start(
          id,
          startupRuntime === undefined
            ? undefined
            : async () => {
                await runtime.startupWhileHeld(id, startupRuntime, `${requestId}:startup-runtime`);
              },
        );
      } catch (error) {
        // A BOARD refusal is not a launch failure and must not be answered as one: nothing launched,
        // and the caller asked for a session WITH board access. The record is retired with the
        // board's own reason so the refusal leaves no session that will never run, and the error
        // travels on for the mount to restate in the board's own vocabulary.
        if (isTaskBoardError(error)) {
          await lifecycle.stop(id, `board access refused: ${error.message}`).catch(() => undefined);
          throw error;
        }
        // The record survives a failed launch with the reason in it, so the failure is answered with
        // the session that holds the evidence rather than an error the caller cannot follow up.
        const failed = storage.findSession(id) === undefined ? undefined : await view(id).catch(() => undefined);
        if (failed !== undefined) return failed;
        // Nothing was recorded, so nothing holds this callsign: releasing the reservation is what
        // stops a start that never happened from parking a name for the whole resolution window.
        if (teammate !== undefined) await callsigns.release(teammate, id).catch(() => undefined);
        throw new SessionControlError('failed', error instanceof Error ? error.message : String(error));
      }
      spent.set(requestId, { sessionId: id, payload });
      return await view(id);
    },
    /**
     * The session a request id started, when the caller can prove which body it sent.
     *
     * The ledger is this PROCESS's, which is the honest scope and the same one the idempotency map
     * has: the hazard being recovered from is a response lost in flight, and a daemon that restarted
     * between the start and the recovery also dropped the connection the recovery would travel on. A
     * restart therefore surfaces as "no such request id", which is a miss rather than a wrong answer.
     */
    recover: async (requestId, digest) => {
      const already = spent.get(requestId);
      if (already === undefined) return undefined;
      if (digests.hex(already.payload) !== digest)
        throw new SessionControlError(
          'conflict',
          `request id ${JSON.stringify(requestId)} started session ${already.sessionId} from a different request`,
        );
      return await view(already.sessionId);
    },
    stop: async (reference, reason) => {
      const id = tryParseSessionId(reference);
      if (id === undefined)
        throw new SessionControlError('invalid', `${JSON.stringify(reference)} is not a usable session id`);
      if (storage.findSession(id) === undefined) throw new SessionControlError('not_found', `no session ${reference}`);
      // No envelope: this session's protocol half is already in its document, and the repository
      // merges the transition over it rather than replacing it.
      const lifecycle = createLifecycle(storage, launcher);
      try {
        await lifecycle.stop(id, reason);
      } catch (error) {
        throw new SessionControlError('failed', error instanceof Error ? error.message : String(error));
      }
      return await view(id);
    },
  };
}

/** How each resume refusal the domain raises is answered. The three are genuinely different next
 *  actions for a caller — send a message, re-read the session, resume it explicitly — so they are not
 *  collapsed into one conflict. */
function resumeRefusal(error: unknown): never {
  // The most specific subclass first: both extend `ResumeRefused`, and a plain refusal is the base.
  if (error instanceof ResumeCancelled) throw new SessionResumeError('guard_failed', error.message);
  if (error instanceof ReviveDedupeConflict) throw new SessionResumeError('suppressed', error.message);
  if (error instanceof ResumeRefused) throw new SessionResumeError('refused', error.message);
  // A relaunch that was attempted and failed. The session's own record already holds the reason —
  // `recover` journalled `session.failed` before rethrowing — so this answers with it rather than
  // inventing one.
  throw new SessionResumeError('failed', error instanceof Error ? error.message : String(error));
}

/**
 * Reviving a session, over the resume service that was built for exactly this and never called.
 *
 * ONE SERVICE FOR THE WHOLE OPENED STORAGE, and that is a correctness requirement rather than tidiness.
 * Two of the service's collaborators are process-wide ledgers: the `KeyedSerialExecutor` is what stops
 * two revivers replacing one session's pane at the same time, and `InMemoryLaunchGate` is what makes a
 * resume that lands mid-launch wait rather than fight the bootstrap for the same terminal name. A
 * service built per request would give each caller its own executor and its own gate, and neither
 * would see the other — so the serialization would be a lie and the amnesty would not apply.
 *
 * That is why the SERVICE is passed in rather than the factory: the migration below relaunches through
 * the same machinery, and a second service built for it would be a second executor and a second gate —
 * so a migrate and a revive of one session could replace its pane at the same moment.
 *
 * THE ID IS PARSED AND THE SESSION IS LOOKED UP HERE, before the service is asked, for the same reason
 * the stop does it: `ResumeRepository.read` answers `undefined` for a session that does not exist and
 * the service turns that into a `ResumeRefused`, which would surface as a 409 about a session the
 * caller should simply be told does not exist.
 */
/**
 * The fleet as lineage resolution may consult it: id, label, parent, stamp, and nothing else.
 *
 * Snapshotted per spawn rather than held, because descent is decided against the fleet as it is at
 * that moment — a cached map would let a session resolve against an ancestor that has since been
 * pruned, or miss one that has since appeared, and both answers outlive the request that made them.
 *
 * The projection is deliberately narrow. Handing the resolver whole session views would let it start
 * reading fields whose meaning it has no business depending on, and the four it gets are exactly the
 * four `SessionAncestor` declares.
 */
async function spawnAncestry(
  storage: DaemonStorage,
  sessions: SessionDirectorySubsystem,
): Promise<ReadonlyMap<string, SessionAncestor>> {
  /**
   * A FAILED READ IS NOT AN EMPTY FLEET, and the difference is the whole shield.
   *
   * The public session list deliberately omits a session whose documents do not parse, so it cannot
   * be the source of an ancestry proof: damage to a parent would become the false fact that the
   * parent does not exist. The storage index names the authoritative set first, and the strict
   * per-session read then either proves every member or propagates the damaged document. If an
   * indexed session has disappeared by that strict read, `get` returns undefined and that is also a
   * failed snapshot, never a row to filter away.
   *
   * So the failure propagates, and both callers fail SAFE without either of them deciding to:
   * a start raises before anything is created, so no unshielded session exists; and a revive's
   * recorder is wrapped in a catch that leaves the durable configuration exactly as it was, so an
   * existing shield survives untouched.
   */
  const views = await Promise.all(
    storage.listSessions().map(async indexed => {
      const view = await sessions.get(indexed.id);
      if (view === undefined)
        throw new Error(`indexed session ${indexed.id} disappeared while its spawn ancestry was being read`);
      return { id: indexed.id, view };
    }),
  );
  return new Map(
    views.map(({ id, view }) => [
      id,
      {
        id,
        ...(view.config.label === undefined ? {} : { label: view.config.label }),
        ...(view.config.parent === undefined ? {} : { parent: view.config.parent }),
        ...(view.config.provenance === undefined ? {} : { provenance: view.config.provenance }),
      },
    ]),
  );
}

/**
 * Re-stamps one relaunched session from its CURRENT label and parent.
 *
 * The request must carry both: the stamper's answer is the label the session is stored under, and a
 * relaunch that passed an empty shell would drop the group the session belongs to. They are read
 * from the session's own view rather than remembered, because a migration or an edit may have moved
 * either since the session was created.
 */
async function recordRelaunchProvenance(
  recorder: SessionProvenanceRecorder,
  sessions: SessionDirectorySubsystem,
  id: SessionId,
): Promise<void> {
  const current = await sessions.get(id);
  if (current === undefined) return;
  await recorder.recordRelaunch({
    id,
    ...(current.config.label === undefined ? {} : { label: current.config.label }),
    ...(current.config.parent === undefined ? {} : { parent: current.config.parent }),
    // A revive is not a spawn: nobody is asking for a NEW session, so this decides nothing on its
    // own. `restamp` recovers the origin from the existing stamp when there is one, and a session
    // with no stamp and no parent was a root start, which is the human case.
    requestedByHuman: current.config.parent === undefined,
  });
}

function createSessionResumeSubsystem(
  storage: DaemonStorage,
  sessions: SessionDirectorySubsystem,
  service: SessionResumeService,
  provenance: SessionProvenanceRecorder,
): SessionResumeSubsystem {
  return {
    resume: async (reference, actor, message) => {
      const id = tryParseSessionId(reference);
      if (id === undefined)
        throw new SessionResumeError('invalid', `${JSON.stringify(reference)} is not a usable session id`);
      if (storage.findSession(id) === undefined) throw new SessionResumeError('not_found', `no session ${reference}`);
      await service
        .resume({ id, actor, ...(message === undefined ? {} : { message }) })
        .catch((error: unknown) => resumeRefusal(error));
      /**
       * The spawn stamp is brought up to date HERE, between the relaunch and the read-back.
       *
       * It cannot ride the lifecycle: `configDocument` merges `{ ...envelope, ...stored, ...record
       * .config }`, and a stored document beats the envelope — right for monotonicity, and it means
       * a session created before stamping existed would never acquire one. Doing it before the view
       * is read means the answer the caller gets already carries the stamp, rather than showing a
       * session that will only look correct on the next request.
       *
       * A failure here must not fail a revive that has already relaunched a pane: the stamp is a
       * shield that the next relaunch will try again for, and refusing the whole revive over it
       * would turn a recoverable gap into a session the operator cannot bring back.
       */
      await recordRelaunchProvenance(provenance, sessions, id).catch(() => undefined);
      // Read back through the SAME reader the list and the single read serve, so a revive answers with
      // the view those surfaces will show rather than a projection of the resume outcome.
      const view = await sessions.get(id).catch(() => undefined);
      if (view === undefined)
        throw new SessionResumeError(
          'failed',
          `session ${id} was revived but its documents do not satisfy the protocol`,
        );
      return view;
    },
  };
}

/**
 * The durable half of dismissing a released structured-answer advisory.
 *
 * THIS REPLACES A WRAPPER THAT RAN AFTER THE SERVICE, and every clause below is one of the ways
 * that wrapper was wrong. It read the state BEFORE the resume and appended AFTER it, so the service
 * had already cleared the attention by the time the record was written — the opposite of the order
 * the survey claims. It accepted `preserved`, which is a relaunch that failed. It did not require a
 * message-free request, so prose could dismiss the warning. It selected by
 * `needsHuman.includes(toolUseId)` and looped over EVERY match, so one dismissal could close
 * several tools, including a `failed` one. And it cleared the state itself, giving the daemon two
 * owners for one decision.
 *
 * Here the service decides and calls this; this one only picks the record and appends.
 *
 * IT TAKES NO LOCK OF ITS OWN, and that is load-bearing twice over. The resume service is built on
 * the SAME answer/monitor executor (see `createSessionResume`), so by the time this runs the answer
 * queue is already held for this session — a nested acquisition would deadlock the dismissal
 * against itself, and it would buy nothing, because the queue it wants is the one it is inside.
 * Holding that queue across the whole critical section is also what makes the clear that follows
 * safe: no drive and no projection can publish a newer advisory between this append and it.
 *
 * THE RECORD IS THE ONE THE STANDING ADVISORY NAMES, decided by `releasedAnswerAttentionOwnedBy` —
 * the projection's own ownership predicate, reused rather than reimplemented. Counting quarantined
 * rows was the first thing wrong with the obvious version: a session carrying an unrelated older
 * quarantine would refuse to dismiss the warning actually on screen. Looking for the tool id inside
 * the prose was the second: `tool-1` matches a sentence about `tool-10`, and neither a tool id nor a
 * request id is constrained enough to be recovered from a sentence at all. The predicate compares
 * the standing message against the exact one this daemon would have minted FOR THAT RECORD, so a
 * message this daemon did not write owns nothing.
 *
 * PER RECORD, NOT PER TOOL. Two request ids may name one rendered form, and the canonical message
 * carries both — so collapsing the owners by tool id would call two genuinely distinct operations
 * one owner and dismiss whichever came first.
 *
 * FAIL CLOSED ON ANYTHING BUT EXACTLY ONE OWNER. Zero means nothing in the ledger claims the warning
 * on screen, and inventing an owner would fabricate a dismissal; several mean the daemon cannot tell
 * WHICH operation the person read about — which is the honest answer for the composition root's
 * first-write wording, since it names only the tool and several records may share one. Both leave
 * the advisory standing, which is the recoverable direction: a warning that stays up can be
 * dismissed again, a record that was wrongly closed cannot be reopened.
 *
 * AN ALREADY-ACKNOWLEDGED OWNER IS SUCCESS, NOT A CONFLICT. The append is durable before the state
 * clears, so a crash in that gap leaves exactly this shape: the row says `acknowledged` and the
 * advisory still stands. Refusing there would strand the session forever on the one path meant to
 * recover it, so the retry appends nothing, returns, and lets the service finish the clear.
 */
function createResumeAnswerAttention(storage: DaemonStorage, answerLedger: FileAnswerLedger): ResumeAnswerAttention {
  return {
    acknowledge: async (id, actor) => {
      const state = SessionStateSchema.safeParse(await storage.readState(id));
      if (!state.success)
        throw new Error(
          `session ${id} has no readable state document, so the structured-answer advisory it carries ` +
            `cannot be matched to the operation it names; the advisory stands`,
        );
      const records = [...(await answerLedger.all(id)).values()];
      // OWNERSHIP IS COUNTED OVER EVERY RECORD, not over the dismissable ones. The rendered
      // sentence is not an injective encoding of the pair that built it — `(requestId "r",
      // toolUseId "t for u")` and `(requestId "r for t", toolUseId "u")` render the same string,
      // and the composition root's first write renders the same string for every request id that
      // ever named its tool. Counting only the candidates would let a `confirmed` co-owner sit
      // outside the count, leaving exactly one candidate and an ambiguity the guard exists to
      // catch. So: exactly one owner in the whole ledger, THEN that owner must be dismissable.
      const owners = records.filter(record => releasedAnswerAttentionOwnedBy(state.data, record));
      if (owners.length !== 1)
        throw new Error(
          `the released structured-answer advisory on session ${id} is owned by ${owners.length} answer ` +
            `operations rather than exactly one, so there is no single dismissal to record; it stands`,
        );
      // biome-ignore lint/style/noNonNullAssertion: the list was just checked to hold exactly one
      const record = owners[0]!;
      // Already closed, and the advisory is still up: this is the crash gap between the append and
      // the clear, so the retry does nothing here and lets the service finish the clear.
      if (record.outcome === 'acknowledged') return;
      // `failed`, `accepted`, `confirmed` and `withdrawn` are other things entirely, and rewriting
      // any of them as `acknowledged` would misreport what happened to that operation.
      if (record.outcome !== 'quarantined')
        throw new Error(
          `the answer operation owning the advisory on session ${id} reads as ${record.outcome}, not a ` +
            `released quarantine, so dismissing it would misreport what happened; the advisory stands`,
        );
      await answerLedger.append(id, {
        ...record,
        outcome: 'acknowledged',
        reason: 'an explicit human relaunch dismissed the structured-answer advisory without confirming its answer',
      });
      // Best effort, and deliberately after the ledger: the audit line is for a reader, the
      // ledger row is the decision, and a journal that will not accept a line must not undo one.
      await storage
        .append(id, 'interaction.answer_acknowledged', {
          toolUseId: record.toolUseId,
          requestId: record.requestId,
          // The operator the SERVICE already authorized, carried through for attribution. Nothing
          // here re-decides eligibility from it — that decision is the action bit, and a second
          // copy of the test living down here is exactly how the old wrapper drifted.
          actor,
          resolution: 'explicit-human-relaunch',
        })
        .catch(() => undefined);
    },
  };
}

/**
 * How each send refusal the domain raises is answered.
 *
 * `pending` is kept apart from `refused` because the two ask the caller for different things: a
 * launch still in flight becomes a retry, while a quarantine or an open question becomes a change of
 * plan. Collapsing them would tell an operator to fix something that is merely not ready yet.
 */
function sendRefusal(error: unknown): never {
  // The subclasses first: both extend `SendRefused`, and a plain refusal is the base.
  if (error instanceof SendPending) throw new SessionSendError('pending', error.message);
  if (error instanceof SendRefused) throw new SessionSendError('refused', error.message);
  // Acted on and failed: the keystroke, the relaunch or a document write. Whatever got as far as
  // being recorded is in the session's own journal and its send ledger.
  throw new SessionSendError('failed', error instanceof Error ? error.message : String(error));
}

/**
 * Handing a running session its next turn, and stopping the turn it is on.
 *
 * THE ID IS PARSED AND LOOKED UP HERE, before the service is asked, for the reason the stop, the
 * revive and the signal all do it: the repository answers `undefined` for a session that does not
 * exist and the service turns that into a refusal, which would surface as a 409 about a session the
 * caller should simply be told is not here.
 *
 * THE ANSWER IS READ BACK through the same reader the list and the single read serve, so a send
 * answers with the view those surfaces will show rather than a projection of its own outcome. The
 * disposition is the one thing the view cannot carry, because it describes what the TRANSPORT did.
 */
function createSessionSendSubsystem(
  storage: DaemonStorage,
  sessions: SessionDirectorySubsystem,
  service: SessionSendService,
): SessionSendSubsystem {
  const require = (reference: string): SessionId => {
    const id = tryParseSessionId(reference);
    if (id === undefined)
      throw new SessionSendError('invalid', `${JSON.stringify(reference)} is not a usable session id`);
    if (storage.findSession(id) === undefined) throw new SessionSendError('not_found', `no session ${reference}`);
    return id;
  };
  const view = async (id: SessionId, what: string): Promise<SessionView> => {
    const current = await sessions.get(id).catch(() => undefined);
    if (current === undefined)
      throw new SessionSendError('failed', `session ${id} ${what} but its documents do not satisfy the protocol`);
    return current;
  };
  return {
    send: async (reference, request) => {
      const id = require(reference);
      const outcome = await service
        .send({
          id,
          sendId: request.sendId,
          message: request.message,
          ...(request.attachmentIds === undefined ? {} : { attachmentIds: request.attachmentIds }),
          ...(request.now === undefined ? {} : { now: request.now }),
          ...(request.replyExpected === undefined ? {} : { replyExpected: request.replyExpected }),
          ...(request.senderSessionId === undefined ? {} : { senderReference: request.senderSessionId }),
        })
        .catch((error: unknown) => sendRefusal(error));
      return { ...(await view(id, 'took the message')), disposition: outcome.disposition };
    },
    interrupt: async reference => {
      const id = require(reference);
      await service.interrupt(id).catch((error: unknown) => sendRefusal(error));
      return await view(id, 'was interrupted');
    },
  };
}

/**
 * The structured-answer half of the live session surface.  A response is not
 * considered delivered when tmux accepted keys: the driver returns only after
 * the bound menu visibly advanced, and only then does this write clear the
 * exact pending tool id.  Broken state therefore refuses rather than becoming
 * an absent question or a blind keystroke.
 */
function createSessionAnswerSubsystem(
  storage: DaemonStorage,
  sessions: SessionDirectorySubsystem,
  tmux: TmuxController,
  clock: ClockPort,
  ledger: FileAnswerLedger,
  serial: KeyedSerialExecutor,
  lastSnapshots: FileLastSnapshotStore,
): SessionAnswerSubsystem {
  const statusProtectedFromAnswer = (status: SessionView['state']['status']): boolean =>
    status === 'completed' || status === 'stopped' || status === 'failed' || status === 'kill_failed';
  const require = (reference: string): SessionId => {
    const id = tryParseSessionId(reference);
    if (id === undefined)
      throw new SessionAnswerError('invalid', `${JSON.stringify(reference)} is not a usable session id`);
    if (storage.findSession(id) === undefined) throw new SessionAnswerError('not_found', `no session ${reference}`);
    return id;
  };
  const tmuxSession = async (id: SessionId): Promise<string> =>
    SessionLifecycleConfigSchema.parse(lifecycleConfigDocument(await storage.readConfig(id))).tmuxSession;
  const driver = new TmuxStructuredQuestionDriver(tmux, tmuxSession, milliseconds => Bun.sleep(milliseconds));
  const service = new StructuredQuestionService(
    {
      pending: async id => {
        const state = SessionStateSchema.safeParse(await storage.readState(id));
        if (!state.success)
          throw new SessionAnswerError(
            'failed',
            `session ${id} state is unreadable; it cannot be treated as no question`,
          );
        if (statusProtectedFromAnswer(state.data.status))
          throw new StructuredQuestionRefused(
            state.data.status === 'kill_failed'
              ? `the previous terminal shutdown for ${id} was not confirmed; stop it successfully before answering`
              : `session ${id} is ${state.data.status}; a terminal session cannot accept a structured answer`,
          );
        return state.data.pendingQuestion ?? undefined;
      },
      answered: async (id, toolUseId, answers, confirmation) => {
        await storage.updateState(id, current => {
          const parsed = SessionStateSchema.safeParse(current);
          if (!parsed.success)
            throw new SessionAnswerError('failed', `session ${id} state became unreadable while confirming the answer`);
          if (parsed.data.pendingQuestion?.toolUseId !== toolUseId)
            throw new SessionAnswerError('refused', `question ${toolUseId} is no longer pending; it was not cleared`);
          const next: Record<string, unknown> = {
            ...(current as Record<string, unknown>),
            // The transform runs under storage's session lock. If a lifecycle stop committed while
            // the driver was waiting for visible advance, its verdict wins this race even though the
            // answer itself may still be stamped as visibly delivered.
            status: statusProtectedFromAnswer(parsed.data.status) ? parsed.data.status : 'running',
            lastAnsweredQuestionToolUseId: toolUseId,
          };
          delete next.pendingQuestion;
          return next as typeof current;
        });
        // The state stamp is the answer commit point. A best-effort audit line must never turn its
        // successful atomic clear into a failure that recovery would misread as an open form.
        await storage
          .append(id, 'interaction.answer', {
            toolUseId,
            confirmation: confirmation.confirmedBy,
            answerCount: answers.length,
          })
          .catch(() => undefined);
      },
      retained: async (id, question, answers, context) => {
        const questionText = question.questions.map(item => item.question).join('\n\n');
        const pane = context.snapshot;
        await storage
          .append(id, 'interaction.question_failed', {
            action: 'answer',
            disposition: 'retained',
            toolUseId: question.toolUseId,
            error: context.failure.message,
            acceptance: context.failure.acceptance,
            matcher: context.failure.diagnostics,
            answerCount: answers.length,
            questionText,
            questions: question.questions.map(item => item.question),
            pendingQuestion: question,
            ...(context.snapshot === undefined ? {} : { snapshot: 'last-snapshot.txt' }),
            ...(context.snapshotError === undefined ? {} : { snapshotError: context.snapshotError }),
            ...(context.cancellationError === undefined ? {} : { cancellationError: context.cancellationError }),
            ...(pane === undefined
              ? {}
              : {
                  pane: {
                    alive: pane.alive,
                    dead: pane.dead,
                    promptReady: pane.promptReady,
                    activeWork: pane.alive && !pane.dead && paneShowsActiveWork(pane.visible),
                    excerpt: pane.visible.split('\n').slice(-40).join('\n').slice(-6_000),
                  },
                }),
          })
          .catch(() => undefined);
      },
      failed: async (id, question, answers, context) => {
        const questionText = question.questions.map(item => item.question).join('\n\n');
        // The service calls this boundary only after the exact form's cancellation was positively
        // observed. An unconfirmed Escape never reaches this writer and therefore cannot erase the
        // pending binding merely because prose would be more convenient.
        const pane = context.cancellation?.pane ?? context.snapshot;
        const active = pane?.alive === true && !pane.dead && paneShowsActiveWork(pane.visible);
        const cancelledPane = context.cancellation?.pane;
        const running =
          cancelledPane?.alive === true &&
          !cancelledPane.dead &&
          !cancelledPane.promptReady &&
          paneShowsActiveWork(cancelledPane.visible);
        const promptReady = cancelledPane?.alive === true && !cancelledPane.dead && cancelledPane.promptReady;
        const reason = `structured answer failed; structured form released; reply in prose to: ${questionText.replaceAll('\n', ' / ')}`;
        await storage.updateState(id, current => {
          const parsed = SessionStateSchema.safeParse(current);
          if (!parsed.success)
            throw new SessionAnswerError('failed', `session ${id} state became unreadable while releasing the form`);
          // A newer question owns itself. Failure recovery may release only the exact tool id whose
          // drive failed; observing that it already vanished is also a successful release.
          if (
            parsed.data.pendingQuestion !== undefined &&
            parsed.data.pendingQuestion !== null &&
            parsed.data.pendingQuestion.toolUseId !== question.toolUseId
          )
            return current;
          const next: Record<string, unknown> = { ...(current as Record<string, unknown>) };
          if (parsed.data.pendingQuestion?.toolUseId === question.toolUseId) {
            // A concurrent lifecycle verdict is stronger than answer recovery. Release the exact
            // form binding, but never turn a completed/stopped/failed/kill_failed session live or
            // overwrite the reason explaining that verdict.
            if (!statusProtectedFromAnswer(parsed.data.status)) {
              next.status = running ? 'running' : 'awaiting_user';
              next.health = running ? 'healthy' : 'idle';
              next.promptReady = promptReady;
              next.reason = reason;
              next.lastActivityAt = clock.now();
            }
            next.openTools = (parsed.data.openTools ?? []).filter(tool => tool !== question.toolUseId);
            delete next.pendingQuestion;
          }
          // Do not infer ownership from prose here. The ledger projector is the sole owner of an
          // exact structured-answer attention clear, after the failed receipt has been appended.
          return next as typeof current;
        });
        // Both audit lines are downstream of the atomic state release and best-effort. Losing an
        // append cannot make a successfully released question look like a failed recovery.
        await storage
          .append(id, 'interaction.question_failed', {
            action: 'answer',
            toolUseId: question.toolUseId,
            error: context.failure.message,
            acceptance: context.failure.acceptance,
            matcher: context.failure.diagnostics,
            answerCount: answers.length,
            questionText,
            questions: question.questions.map(item => item.question),
            ...(context.snapshot === undefined ? {} : { snapshot: 'last-snapshot.txt' }),
            ...(context.snapshotError === undefined ? {} : { snapshotError: context.snapshotError }),
            ...(context.cancellationError === undefined ? {} : { cancellationError: context.cancellationError }),
            ...(pane === undefined
              ? {}
              : {
                  pane: {
                    alive: pane.alive,
                    dead: pane.dead,
                    promptReady: pane.promptReady,
                    activeWork: active,
                    excerpt: pane.visible.split('\n').slice(-40).join('\n').slice(-6_000),
                  },
                }),
          })
          .catch(() => undefined);
        await storage
          .append(id, 'interaction.question_cancelled', {
            toolUseId: question.toolUseId,
            reason: 'answer failed; structured form released for prose reply',
            confirmedBy: context.cancellation?.confirmedBy ?? context.releaseConfirmedBy ?? 'state-release',
            ...(context.cancellationError === undefined ? {} : { cancellationError: context.cancellationError }),
            questionText,
            pendingQuestion: null,
          })
          .catch(() => undefined);
      },
    },
    driver,
    {
      snapshot: async id => {
        const pane = await tmux.state(await tmuxSession(id));
        const text = pane.history.trim() === '' ? pane.visible : pane.history;
        if (text.trim() !== '') await lastSnapshots.write(id, text);
        return pane;
      },
      cancel: async (id, question) => await driver.cancel(id, question),
    },
  );
  const coordinator = new StructuredAnswerCoordinator({
    service,
    ledger,
    // The answer/monitor queue supplied by the composition root. It is not STORAGE's queue: clearing
    // the form re-enters storage, while transcript reprojection must wait out this live drive.
    serial,
    clock,
    // Reconciliation reads the state document and nothing else, so an unreadable one is missing
    // evidence rather than evidence of absence: it keeps the receipt accepted and never re-drives.
    state: async id => {
      const parsed = SessionStateSchema.safeParse(await storage.readState(id).catch(() => undefined));
      return parsed.success ? parsed.data : undefined;
    },
    // RE-READ, never cached. The answer's outcome is that the form is settled; the view is derived
    // state that keeps moving, and a stored copy would answer a replay with a session as it was.
    view: async id => {
      const view = await sessions.get(id).catch(() => undefined);
      if (view === undefined)
        throw new SessionAnswerError(
          'failed',
          `session ${id} answer was confirmed but its updated documents are unreadable`,
        );
      return view;
    },
    // This is an advisory only after the service positively released the exact native form. It
    // remains durable across reads and prose sends, but send/resume policy does not mistake it for
    // an unknown modal. The original answer remains unconfirmed until the authoritative answer
    // stamp can prove it; prose is progress, not retroactive confirmation.
    quarantine: async (id, record) => {
      await storage
        .updateState(id, current => {
          const parsed = SessionStateSchema.safeParse(current);
          if (!parsed.success) return current;
          const next: Record<string, unknown> = {
            ...(current as Record<string, unknown>),
            status: statusProtectedFromAnswer(parsed.data.status) ? parsed.data.status : 'awaiting_user',
            needsHumanKind: STRUCTURED_ANSWER_RELEASED_ATTENTION_KIND,
            // The projection's own builder, not a copy of its sentence: this first write IS one of
            // the two messages `releasedAnswerAttentionOwnedBy` recognises, so a second literal here
            // would be a fact with two owners — and the day they drifted, ownership would silently
            // read false and the advisory would become undismissable.
            needsHuman: firstWriteReleasedAnswerAttention(record.toolUseId),
          };
          if (parsed.data.pendingQuestion?.toolUseId === record.toolUseId) delete next.pendingQuestion;
          return next as typeof current;
        })
        .catch(() => undefined);
      await storage
        .append(id, 'interaction.answer_unconfirmed', {
          toolUseId: record.toolUseId,
          requestId: record.requestId,
          acceptedAt: record.acceptedAt,
        })
        .catch(() => undefined);
    },
  });
  return {
    answer: async (reference, request) => {
      const id = require(reference);
      return await coordinator
        .answer({
          id,
          requestId: request.requestId,
          request: {
            toolUseId: request.toolUseId,
            labels: request.labels,
            ...(request.other === undefined ? {} : { other: request.other }),
            ...(request.responses === undefined ? {} : { responses: request.responses }),
            ...(request.answers === undefined ? {} : { answers: request.answers }),
          },
        })
        .catch(error => {
          // Three different next actions, so three different refusals: fix the request, use a fresh
          // id, or go and look at the session. Collapsing them would tell a caller to retry in the
          // one case where retrying is the thing that must not happen.
          if (error instanceof StructuredQuestionRefused) throw new SessionAnswerError('refused', error.message);
          if (error instanceof AnswerRequestConflict) throw new SessionAnswerError('conflict', error.message);
          if (error instanceof AnswerToolAlreadyHandled) throw new SessionAnswerError('refused', error.message);
          if (error instanceof AnswerUnconfirmed) throw new SessionAnswerError('unconfirmed', error.message);
          if (
            error instanceof AnswerAcknowledged ||
            error instanceof AnswerReleased ||
            error instanceof AnswerTerminalFailure
          )
            throw new SessionAnswerError('released', error.message);
          if (error instanceof StructuredQuestionAttemptFailed) {
            if (error.receipt === 'accepted') throw new SessionAnswerError('unconfirmed', error.message);
            if (error.receipt === 'failed' || error.receipt === 'quarantined')
              throw new SessionAnswerError('released', error.message);
            throw new SessionAnswerError('failed', error.message);
          }
          if (error instanceof SessionAnswerError) throw error;
          throw new SessionAnswerError('failed', error instanceof Error ? error.message : String(error));
        });
    },
  };
}

/** How each signal refusal the domain raises is answered. The three are genuinely different next
 *  actions — fix the request, revive the session, name a peer that exists — so they are not collapsed
 *  into one conflict. */
function signalRefusal(error: unknown): never {
  // The most specific subclasses first: both extend `SignalRefused`, and a plain refusal is the base.
  if (error instanceof InvalidDeadlineRefused) throw new SessionSignalError('invalid', error.message);
  if (error instanceof UnknownPeerRefused) throw new SessionSignalError('unknown_peer', error.message);
  if (error instanceof SignalRefused) throw new SessionSignalError('refused', error.message);
  // Acted on and failed: the evidence, the pane or the document write. The session's own journal holds
  // whatever got as far as being recorded.
  throw new SessionSignalError('failed', error instanceof Error ? error.message : String(error));
}

/** The wait fields, which only a `waiting` signal carries. Narrowed on the discriminant rather than
 *  probed, so a new kind gaining an `until` cannot silently start parking sessions. */
function waitFields(request: SignalSessionRequest) {
  return request.kind === 'waiting'
    ? {
        ...(request.until === undefined ? {} : { until: request.until }),
        ...(request.condition === undefined ? {} : { condition: request.condition }),
        ...(request.peer === undefined ? {} : { peer: request.peer }),
      }
    : {};
}

/**
 * What a session says about itself, over the signal domain this unit built.
 *
 * ONE SERVICE FOR THE WHOLE OPENED STORAGE, for the reason the revive gives: its `SerialExecutor` is
 * what stops a completion and a park of the same session interleaving, and a service built per request
 * would hand each caller a private queue that sees none of the others.
 *
 * THE TERMINAL IS THE REVIVE'S OWN LAUNCHER, not a second tmux adapter, and that is a correctness
 * requirement. `TmuxResumeLauncher` keeps the final frame of every pane it snapshots in its own map, so
 * a completion that captured its last screen through a different object would file that frame where no
 * revive could find it.
 *
 * THE ID IS PARSED AND LOOKED UP HERE, before the service is asked, for the reason the stop and the
 * revive both do it: the repository answers `undefined` for a session that does not exist and the
 * service turns that into a refusal, which would surface as a `409` about a session the caller should
 * simply be told is not here.
 */
function createSessionSignalSubsystem(
  storage: DaemonStorage,
  sessions: SessionDirectorySubsystem,
  service: SessionSignalService,
): SessionSignalSubsystem {
  return {
    signal: async (reference, request) => {
      const id = tryParseSessionId(reference);
      if (id === undefined)
        throw new SessionSignalError('invalid', `${JSON.stringify(reference)} is not a usable session id`);
      if (storage.findSession(id) === undefined) throw new SessionSignalError('not_found', `no session ${reference}`);
      await service
        .signal({
          id,
          kind: request.kind,
          ...(request.message === undefined ? {} : { message: request.message }),
          ...waitFields(request),
        })
        .catch((error: unknown) => signalRefusal(error));
      // Read back through the SAME reader the list and the single read serve, so a signal answers with
      // the view those surfaces will show rather than a projection of the signal's own outcome.
      const view = await sessions.get(id).catch(() => undefined);
      if (view === undefined)
        throw new SessionSignalError(
          'failed',
          `session ${id} recorded its ${request.kind} signal but its documents do not satisfy the protocol`,
        );
      return view;
    },
  };
}

/**
 * How long the daemon remembers when the last sweep finished, for its own health report.
 *
 * MUTABLE ON PURPOSE, and it is the one piece of shared state this root holds. The self-check is
 * built before the subsystems are — it is passed INTO `createSubsystems` — and it needs a synchronous
 * answer to "how stale is the sweep", while the sweep itself learns the answer asynchronously much
 * later. A holder both sides close over is what lets the health report tell an armed-but-late timer
 * apart from an absent one, which is the distinction `wardenTimerArmed` exists to make.
 */
interface WardenSupervisionState {
  armed: boolean;
  armedAtMs: number | undefined;
  intervalMs: number;
  lastSweepAt: string | undefined;
}

/**
 * Provenance for every attention item the warden writes.
 *
 * `warden-escalation` is a DISTINCT daemon cause from ordinary source
 * reconciliation, and the state machine reads it: an agent can never dismiss a
 * daemon-raised item, and a reader can tell a warden's interruption apart from a
 * session's own request without parsing its prose.
 */
const WARDEN_ESCALATION_ACTOR: AttentionActor = { kind: 'daemon', cause: 'warden-escalation' };

/** The collaborators a warden subsystem needs from the rest of the root. */
interface WardenParts {
  readonly sessions: SessionDirectorySubsystem;
  readonly control: SessionControlSubsystem;
  /**
   * The ONE attention service every other caller uses, not a second one.
   *
   * A warden escalation lands on the flagged session's own board, through the
   * same state machine, the same locking and the same durable document a person
   * answers it on. A private store here would be a second account of what a
   * session is waiting for, and the two would disagree the first time anybody
   * resolved anything.
   */
  readonly attention: AttentionService;
  readonly usage: UsageFeedPort;
  readonly accounts: AccountInventoryPort;
  readonly files: NodeWardenReportFileSystem;
  readonly reportsReader: WardenReportReader;
  readonly wardenRoot: string;
  readonly reportsDirectory: string;
  readonly supervision: WardenSupervisionState;
}

/**
 * Fleet supervision, assembled from the modules that had no way to reach a running daemon.
 *
 * THE FLEET READER IS THE SAME SESSION READER EVERY OTHER SURFACE USES, so the sessions a warden
 * judges are the sessions the list shows, parsed by the same schemas from the same documents. A
 * private reader would let the warden act on a view nobody else can see.
 *
 * `hasLiveMonitor` IS ALWAYS FALSE, because this daemon runs no per-session monitors, and that is the
 * truth rather than a placeholder. The sweep is told so through `supervisesMonitors` and collapses
 * what would otherwise be one `dead_monitor` anomaly per live session into the single daemon-level
 * fault it is — see `collapseUnsupervisedMonitors`. Reporting the fleet as watched would be the
 * dangerous lie: it would also switch on the sus classifiers, which reason over a liveness ledger
 * nothing here updates.
 *
 * `stopCapability` IS RECORDED AND NOT DELIVERED. The sweep mints an unguessable secret per
 * assignment and the durable state holds it, but this daemon's start declares no field to carry one
 * into the warden's own terminal, so no warden can present it. That is why `mayAct` is false: the
 * prompts say plainly that the report is the deliverable rather than handing a warden commands it
 * cannot run.
 */
function createWardenSubsystem(parts: WardenParts): WardenSubsystem {
  const artifacts = new FileWardenArtifacts(parts.files, parts.reportsReader, parts.reportsDirectory);
  const service = new WardenSweepService(
    {
      fleet: {
        fleet: async () =>
          await Promise.all((await parts.sessions.list()).map(view => wardenFleetSession(parts, view))),
      },
      spawner: {
        spawn: async request => {
          const start = {
            agent: request.agent,
            ...(request.model === undefined ? {} : { model: request.model }),
            name: request.name,
            // The label is what the detector's lineage shield reads: a warden that was not labelled
            // would be swept, flagged and investigated by the next warden, forever.
            label: WARDEN_LABEL,
            mode: 'auto' as const,
            prompt: request.prompt,
            cwd: request.cwd,
            boardAccess: 'none' as const,
          };
          const payload = JSON.stringify(start);
          const view = await parts.control.start(start, crypto.randomUUID(), payload);
          return {
            sessionId: view.config.id,
            createdAt: view.config.createdAt,
            agent: view.config.agent,
            harness: view.config.harness === 'codex' ? 'codex' : 'claude',
            // The model the start actually resolved, never the one that was asked for: provenance
            // records what RAN. `modelHint` is the planner's resolution when the account pinned none.
            model: view.config.model ?? view.config.modelHint,
            modelSource: view.config.model === undefined ? 'configured' : 'agent',
          };
        },
      },
      artifacts,
      state: new FileWardenStateStore(parts.files, parts.wardenRoot),
      config: new FileWardenConfigStore(parts.files, parts.wardenRoot),
      agents: {
        installed: async () => selectableAutoAccounts(await parts.accounts.accounts()).map(account => account.id),
      },
      // The daemon-wide feed, with the one shape difference reconciled here: the wire lets `retryAt`
      // be explicitly null to mean "the provider named no retry time", and the warden's health type
      // says `undefined` for the same thing. Collapsing it at the boundary is what stops a null
      // reading as an epoch instant that has already passed.
      usage: {
        accounts: async () =>
          (await parts.usage.accounts()).map(({ retryAt, ...account }) => ({
            ...account,
            ...(typeof retryAt === 'number' ? { retryAt } : {}),
          })),
      },
      // The SAME reader the verdict route serves from, so "what the report says" has one answer.
      // An unreadable directory answers `undefined` rather than a short list: a missing NEEDS_HUMAN
      // marker and a marker nobody could read must not both look like "nothing to escalate".
      verdicts: { recent: async () => await parts.reportsReader.readVerdicts().catch(() => undefined) },
      attention: {
        board: async sessionId => {
          const listed = await parts.attention.list(sessionId).catch(() => undefined);
          return listed?.ok === true
            ? { sessionId, items: listed.value.items, resolved: listed.value.resolved }
            : undefined;
        },
        raise: async (sessionId, request) => {
          const mutation = await parts.attention
            .raise(
              sessionId,
              {
                source: request.source,
                sourceRef: request.sourceRef,
                subject: request.subject,
                why: request.why,
                context: request.context,
                waitingSince: request.waitingSince,
                howToResolve: request.howToResolve,
                // NO STRUCTURED ASK. This is an instruction, not a question: the daemon has nothing
                // to do with an answer, and a bare `resolve` is what a person needs to be able to
                // reach for once they have acted.
              },
              WARDEN_ESCALATION_ACTOR,
            )
            .catch(() => undefined);
          if (mutation === undefined || !mutation.ok) return 'rejected';
          return mutation.change === 'created' || mutation.change === 'refreshed' ? mutation.change : 'unchanged';
        },
        resolveSource: async (sessionId, source, sourceRef, note) => {
          const mutation = await parts.attention
            .resolveSource(sessionId, source, sourceRef, WARDEN_ESCALATION_ACTOR, note)
            .catch(() => undefined);
          if (mutation === undefined || !mutation.ok) return false;
          return mutation.changed;
        },
      },
      // The journal is the daemon's own log for now: the fleet event tier these belong on is
      // `emitTransient`, which section I of the survey records as absent. A supervision decision an
      // operator cannot see is worse than a noisy one, so they are written rather than dropped.
      journal: {
        record: (type, data) =>
          process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), type, data })}\n`),
      },
      nowMs: () => Date.now(),
      // Two UUIDs concatenated: the value authorizes stopping a session, so it is minted from the
      // same source as every other secret here and is longer than one.
      capabilities: () => `${crypto.randomUUID()}${crypto.randomUUID().replaceAll('-', '')}`,
    },
    {
      clientName: CLIENT_NAME,
      // The state home, never an agent's workspace: a warden must not be able to be mistaken for
      // work on a repository, and its own prompt forbids touching one.
      wardenCwd: parts.wardenRoot,
      supervisesMonitors: false,
      mayAct: false,
    },
  );
  // The loop drives a WRAPPED service so the holder is refreshed by the timer's sweeps as well as by
  // a manual one. Wrapping here rather than after `loop.run` is the difference: a periodic tick calls
  // the loop directly and would never reach a wrapper placed outside it, so the daemon's health
  // report would show the sweep ageing forever while the timer worked perfectly.
  const loop = new WardenSweepLoop(
    {
      run: async options => {
        const view = await service.run(options);
        parts.supervision.lastSweepAt = view.sweptAt;
        return view;
      },
      intervalMs: async () => await service.intervalMs(),
    },
    {
      every: (intervalMs, tick) => {
        const handle = setInterval(tick, intervalMs);
        return () => clearInterval(handle);
      },
    },
  );
  return {
    status: async () => await service.status(),
    verdicts: async () => await parts.reportsReader.readVerdicts(),
    report: async (reportPath: string) => await parts.reportsReader.readReportAt(reportPath),
    run: async (force: boolean) => await loop.run(force),
    config: async () => await service.view(),
    updateConfig: async (patch: unknown) => await service.updateConfig(parseWardenConfigPatch(patch)),
    lastSweepAt: async () => await service.lastSweepAt(),
    intervalMs: async () => await service.intervalMs(),
    arm: async () => {
      parts.supervision.intervalMs = await service.intervalMs();
      const disarm = await loop.arm();
      // The timer is evidence only after the scheduler accepted it. The instant lets health classify
      // the deliberate pre-first-sweep window as grace rather than as unknown supervision.
      parts.supervision.armedAtMs = Date.now();
      parts.supervision.armed = true;
      return () => {
        parts.supervision.armed = false;
        parts.supervision.armedAtMs = undefined;
        disarm();
      };
    },
  };
}

/**
 * One session as the warden reads it.
 *
 * The done marker is READ here — the reader `FileSignalArtifacts` was written for. Without it the
 * detector's guard is dead and every session whose pane died after its teammate declared the work
 * finished is reported as abandoned wreckage on every sweep.
 */
async function wardenFleetSession(parts: WardenParts, view: SessionView): Promise<WardenFleetSession> {
  const marker = await parts.files.readText(join(view.directory, DONE_MARKER_FILENAME)).catch(() => undefined);
  return {
    config: {
      id: view.config.id,
      mode: view.config.mode,
      createdAt: view.config.createdAt,
      updatedAt: view.config.updatedAt,
      ...(view.config.teammate === undefined ? {} : { teammate: view.config.teammate }),
      ...(view.config.label === undefined ? {} : { label: view.config.label }),
      ...(view.config.parent === undefined ? {} : { parent: view.config.parent }),
      /**
       * The detector's second lineage mechanism, and until now it was dead in production.
       *
       * `WardenSessionConfig.wardenLineage` is a PROJECTION of the spawn stamp, never a second
       * lineage shape — the boolean the detector needs, derived from the one durable record. Nothing
       * projected it before, so only the label check and the parent walk ran, and the walk is exactly
       * the backstop the stamp exists to replace: a warden is pruned while its children are still
       * running, so the walk reaches the truth only while the ancestor it needs still exists.
       *
       * Projected as a boolean rather than passing the stamp through, because a `wardenLineage`
       * field on the session config document would be the second shape this deliberately avoids.
       */
      ...(view.config.provenance === undefined ? {} : { wardenLineage: view.config.provenance.wardenLineage }),
      agent: view.config.agent,
      ...(view.config.model === undefined ? {} : { model: view.config.model }),
      // The start's own resolution, carried beside the configured value rather than folded into it —
      // an escalation naming this node's model wants what actually ran, and a session whose account
      // pinned nothing has it only here.
      ...(view.config.modelHint === undefined ? {} : { modelHint: view.config.modelHint }),
      intervalSeconds: view.config.intervalSeconds,
    },
    state: view.state,
    directory: view.directory,
    cwd: view.config.cwd,
    turn: view.state.turn,
    // Always false, and honestly so: no monitor subsystem exists. See `createWardenSubsystem`.
    hasLiveMonitor: false,
    hasDoneMarker: doneMarkerCertifiesTurn(marker, view.state.turn),
  };
}

/** The collaborators a migration needs. Grouped because eight positional arguments in the order the
 *  flow happens to use them is a call site nobody can check. */
interface SessionMigrateParts {
  readonly storage: DaemonStorage;
  readonly sessions: SessionDirectorySubsystem;
  /** The SAME service the revive uses — see `createSessionResumeSubsystem`. */
  readonly resume: SessionResumeService;
  readonly preflight: MigrationPreflight;
  readonly reports: MigrationReportStore;
  readonly planner: SessionPlanner;
  readonly accounts: AccountInventoryPort;
  readonly executables: ExecutableResolverPort;
  readonly clock: SystemClock;
  /**
   * The session's own transcript, which is what the preflight joins its open tool ids against.
   *
   * Until a session recorded its transcript this was an EMPTY array and every open tool was
   * classified `unknown`, which the gate refuses on — the daemon knew a tool was running and not
   * what it was. With provenance persisted the join has real evidence, and a session that still has
   * no locatable transcript degrades to exactly the previous behaviour rather than to a guess.
   */
  readonly transcripts: SessionTranscriptReader;
  /** The target account's own transcript evidence, taken before the relaunch argv is authorized. */
  readonly transcriptProvenance: TranscriptProvenanceCapture;
  /** The session's own private directory, which is what a Codex rollout is correlated by. */
  readonly sessionDirectory: (id: SessionId) => string;
  /** Serializes whole migrations of one session, so two cannot restamp the same document. */
  readonly serial: KeyedSerialExecutor;
}

/** The documents a migration reasons about, parsed by the schemas that govern them. */
interface MigrateSubject {
  readonly config: z.infer<typeof SessionConfigSchema>;
  readonly state: z.infer<typeof SessionStateSchema>;
  readonly tmuxSession: string;
}

/** How each account-resolution refusal is restated in the migration's own taxonomy. The resolver is
 *  shared with the start, and its vocabulary is the start's. */
const MIGRATE_RESOLUTION_REFUSALS: Partial<Record<SessionControlFailure, SessionMigrateFailure>> = {
  unknown_agent: 'unknown_agent',
  unavailable: 'unavailable',
};

/** How each resume refusal is restated once a migration is the thing that asked for the relaunch. */
function migrateRelaunchRefusal(error: unknown): never {
  // A guard or a dedupe conflict cannot reach here: the migration states its own policy, which sets
  // neither an expected status nor the dedupe heuristic. Everything the domain refuses is therefore
  // the session's own condition — a live pane holding an unanswered question, an unconfirmed kill.
  if (error instanceof ResumeRefused) throw new SessionMigrateError('refused', error.message);
  throw new SessionMigrateError('failed', error instanceof Error ? error.message : String(error));
}

/**
 * The window this session is running in today.
 *
 * The observed model is deliberately carried through: aliases are configured
 * names, whereas a context override describes the model the harness actually
 * serves.  The core projection also retains a configured `[1m]` selector that
 * harness output strips away.
 */
function currentContextWindow(config: z.infer<typeof SessionConfigSchema>, state: z.infer<typeof SessionStateSchema>) {
  return contextWindowForSession({
    configuredModel: config.model,
    modelHint: config.modelHint,
    observedModel: state.observedModel,
    reportedWindow: state.contextWindow,
  });
}

/**
 * Moving one session onto another account, over the preflight that was built for exactly this and
 * never called.
 *
 * WHAT A MIGRATION IS MADE OF, and why each part is where it is:
 *
 *   * THE GATE RUNS FIRST AND WRITES NOTHING. `MigrationPreflight` inventories the pane's process
 *     tree, the codex footer and the session's own open tools, and refuses work it cannot show will
 *     survive the kill. Nothing above it is allowed to mutate the session, so a refused migration
 *     leaves a session exactly as it found it.
 *   * THE REPORT IS WRITTEN BEFORE THE PANE DIES, because it is the only account of what the kill
 *     destroyed and the pane is the evidence. It is also what the replacement agent is handed: the
 *     handoff message names the file.
 *   * THE DOCUMENT IS RESTAMPED, NOT REPLACED. `updateConfig` merges over what is on disk, so the
 *     session keeps its id, directory, journal, callsign and history and changes only the account,
 *     the model, the argv the relaunch will run, and the incarnation counting the relaunches.
 *   * THE RELAUNCH IS THE REVIVE, with one policy field flipped. Everything a safe replacement needs
 *     — snapshot before kill, journalled composer discard, the turn document, the launch gate, the
 *     per-session queue — is the resume domain's, already built and tested. `replaceLiveTerminal`
 *     is what stops it taking its send shortcut and typing the handoff into the agent being replaced.
 *
 * ONLY `revived` IS A MIGRATION. The resume domain answers three other dispositions, and two of them
 * are relaunch failures that do NOT throw: `preserved` means the replacement reported failure while
 * the OLD harness was still at a prompt, and `retry-scheduled` means the relaunch failed and a retry
 * was booked. Both leave the session on the account it started on while its record already names the
 * new one, so both settle the report as a FAILURE. Treating the absence of an exception as success
 * here is precisely how a migration reports a move that did not happen.
 *
 * THE CONFIGURATION IS NOT ROLLED BACK when the relaunch fails, and the report says so in those
 * words. A rollback is a second write that can fail on its own, and it would race whatever the resume
 * domain did next — it may have preserved a live harness or scheduled a retry that will relaunch from
 * this very document. Reporting "left staged on the target" is a fact; reporting a rollback that was
 * attempted and not verified would not be.
 */
function createSessionMigrateSubsystem(parts: SessionMigrateParts): SessionMigrateSubsystem {
  /** Both documents plus the tmux address, or a stated refusal. A session whose pair does not parse
   *  is one nothing may restamp: the write would merge new fields over a document already broken. */
  const subject = async (id: SessionId): Promise<MigrateSubject> => {
    const raw = await parts.storage.readConfig(id);
    const config = SessionConfigSchema.safeParse(raw);
    const state = SessionStateSchema.safeParse(await parts.storage.readState(id));
    if (!config.success || !state.success)
      throw new SessionMigrateError('unusable', `the documents for session ${id} do not satisfy the protocol`);
    // The tmux address lives in the lifecycle's half of the same document, and it is what every
    // signal the preflight reads is addressed by.
    const lifecycle = SessionLifecycleConfigSchema.safeParse(lifecycleConfigDocument(raw));
    if (!lifecycle.success)
      throw new SessionMigrateError('unusable', `session ${id} records no terminal this daemon could inspect`);
    return { config: config.data, state: state.data, tmuxSession: lifecycle.data.tmuxSession };
  };

  /** The view of a session this mount just moved. A document it cannot read back is a wiring fault. */
  const view = async (id: SessionId, when: string): Promise<SessionView> => {
    const found = await parts.sessions.get(id).catch(() => undefined);
    if (found === undefined) throw new SessionMigrateError('failed', `session ${id} ${when} but cannot be read back`);
    return found;
  };

  /** What the session looks like after a failed attempt, for the outcome section. An unreadable one
   *  is reported as absent rather than guessed at — the renderer says UNKNOWN, which is the truth. */
  const observed = async (id: SessionId): Promise<ObservedSession | undefined> => {
    const found = await parts.sessions.get(id).catch(() => undefined);
    if (found === undefined) return undefined;
    return {
      binary: found.config.agent,
      ...(found.config.model === undefined ? {} : { model: found.config.model }),
      status: found.state.status,
    };
  };

  const migrate = async (id: SessionId, request: MigrateSessionRequest): Promise<SessionView> => {
    const { config, state, tmuxSession } = await subject(id);
    const { account, executable } = await resolveStartAccount(parts.accounts, request.agent, parts.executables).catch(
      (error: unknown) => {
        if (!(error instanceof SessionControlError)) throw error;
        const failure = MIGRATE_RESOLUTION_REFUSALS[error.failure];
        if (failure === undefined) throw error;
        throw new SessionMigrateError(failure, error.message);
      },
    );
    // SAME-KIND, ENFORCED HERE — the first thing decided once both families are known, and before any
    // other work at all. Everything below it either reads the host or writes the session: the planner,
    // the transcript capture that inspects the target's harness home, the report, the restamp and the
    // kill. Refusing at this point is what makes the refusal cost nothing and leave nothing behind, so
    // the caller may present the same request id again against an account of the right family.
    const mismatch = harnessMigrationRefusal({
      sourceHarness: config.harness,
      targetHarness: account.kind,
      targetAgent: account.agent,
    });
    if (mismatch !== undefined) throw new SessionMigrateError('harness_mismatch', mismatch);
    // The same planner the start uses, so the model a migration records and the window it is measured
    // against come from the one decision rather than two that can disagree.
    const plan = parts.planner.plan({
      id,
      account,
      mode: config.mode,
      ...(config.teammate === undefined ? {} : { teammate: config.teammate }),
      ...(config.name === undefined ? {} : { name: config.name }),
      ...(request.model === undefined ? {} : { requestedModel: request.model }),
      ...(config.parent === undefined ? {} : { parent: config.parent }),
    });
    // Rebuilt rather than patched: the remote-control arguments are the TARGET harness's, and a
    // codex session inheriting a claude session's flags would relaunch into an argument error.
    //
    // AUTHORIZED with the start's own rule, because a migration does not go through the lifecycle
    // service that applies it. The relaunch reads this argv straight out of the document written
    // below, so without this check a fleet manifest publishing something that is not an auto wrapper
    // would be launchable by a migrate and refused by a start.
    //
    // THE TRANSCRIPT IS RE-CAPTURED FOR THE TARGET, for the same reason the flags are rebuilt: the
    // record the session carries describes the account it is LEAVING. Keeping it would point a
    // codex session at a claude transcript — parsed by the wrong parser, attributed to the wrong
    // harness — so it is replaced by the target's own evidence, or by nothing when the target
    // declares no resolvable home.
    const relaunchTranscript = await parts.transcriptProvenance.capture({
      harness: account.kind,
      executable,
      cwd: config.cwd,
      correlationToken: parts.sessionDirectory(id),
      at: parts.clock.now(),
    });
    const command = ((): readonly string[] => {
      try {
        return authorizeSessionCommand(
          executable,
          [
            executable,
            ...(config.remoteControl ? plan.extraArgs : []),
            ...relaunchTranscript.launchArguments,
            ...config.harnessFlags,
          ],
          defaultSessionLifecycleSettings,
        );
      } catch (error) {
        throw new SessionMigrateError('unavailable', error instanceof Error ? error.message : String(error));
      }
    })();
    const window = currentContextWindow(config, state);
    if (plan.contextWindow < window && !request.allowContextDowngrade)
      throw new SessionMigrateError(
        'context_downgrade',
        `${account.agent} serves ${plan.model} with a ${plan.contextWindow}-token window and this session is ` +
          `running in ${window}; the conversation would be truncated. Send allowContextDowngrade to accept that.`,
      );
    const report = await parts.preflight.inspect(
      {
        sessionId: id,
        harness: config.harness,
        tmuxSession,
        status: state.status,
        turn: state.turn,
        // The state document's own record of the tool calls this session has open.
        openTools: state.openTools ?? [],
        ...(state.subprocessSince === undefined ? {} : { subprocessSince: state.subprocessSince }),
      },
      // The session's OWN transcript, resolved from the provenance its start recorded. A session
      // with none reads as an empty tail, which classifies every open tool `unknown` and refuses
      // the migration — the same fail-closed answer this call gave before, now reached only when
      // the evidence is genuinely absent rather than always.
      await parts.transcripts.tail({ sessionId: id, harness: config.harness === 'codex' ? 'codex' : 'claude' }),
    );
    const decision = parts.preflight.gate(report);
    if (!decision.proceed)
      throw new SessionMigrateError('refused', `${decision.reason}\n${parts.preflight.summarize(report)}`);
    const at = parts.clock.now();
    const reportPath = await parts.reports.write(
      id,
      parts.preflight.document(report, {
        sessionId: id,
        targetAgent: account.agent,
        targetModel: plan.model,
        forced: decision.forced,
        at,
      }),
    );
    const from = config.agent;
    const generation = config.runtimeGeneration + 1;
    await parts.storage.updateConfig(id, current => {
      // The previous account's transcript record is REMOVED rather than merged over: a target that
      // declares no resolvable home must leave the session with no transcript, and a merge would
      // silently keep the old harness's file under the new harness's name.
      const { transcript: _replaced, ...retained } = jsonObject(current) ?? {};
      return {
        ...retained,
        agent: account.agent,
        harness: account.kind,
        model: plan.model,
        modelHint: request.model ?? account.defaultModel ?? '',
        command: [...command],
        incarnation: `${id}-${generation}`,
        runtimeGeneration: generation,
        migration: { from, to: account.agent, at },
        ...(relaunchTranscript.provenance === undefined ? {} : { transcript: relaunchTranscript.provenance }),
        updatedAt: at,
      };
    });
    await parts.storage.append(id, 'session.migrating', {
      from,
      to: account.agent,
      model: plan.model,
      report: reportPath,
      verdict: report.worstVerdict,
    });
    const settle = async (ok: boolean, detail?: string): Promise<void> => {
      const record = await observed(id);
      await parts.reports.append(
        id,
        parts.preflight.settle({
          ok,
          from,
          targetAgent: account.agent,
          targetModel: plan.model,
          at: parts.clock.now(),
          ...(detail === undefined ? {} : { detail }),
          ...(record === undefined ? {} : { observed: record }),
        }),
      );
      await parts.storage.append(id, ok ? 'session.migrated' : 'session.migrate_failed', {
        from,
        to: account.agent,
        ...(detail === undefined ? {} : { detail }),
      });
    };
    const outcome = await parts.resume
      .resume({
        id,
        // Neither an expected status nor the dedupe heuristic: an operator asked for THIS session by
        // id, and the preflight above is the guard a migration has.
        policy: { automatic: false, dedupeSharedRecoveryScope: false, replaceLiveTerminal: true },
        message: parts.preflight.handoff(reportPath),
      })
      .catch(async (error: unknown) => {
        await settle(false, error instanceof Error ? error.message : String(error));
        migrateRelaunchRefusal(error);
      });
    if (outcome.disposition !== 'revived') {
      const detail =
        outcome.disposition === 'preserved'
          ? `the relaunch failed and the previous harness was still at a prompt, so ${from} is still serving ` +
            `this session while its record already names ${account.agent}`
          : `the relaunch failed and an automatic retry was scheduled; the session is still on ${from}`;
      await settle(false, detail);
      throw new SessionMigrateError('failed', detail);
    }
    await settle(true);
    // Read back through the SAME reader the list and the single read serve, so a migration answers
    // with the view those surfaces will show rather than a projection of its own writes.
    return await view(id, 'was migrated');
  };

  return {
    migrate: async (reference, request) => {
      const id = tryParseSessionId(reference);
      if (id === undefined)
        throw new SessionMigrateError('invalid', `${JSON.stringify(reference)} is not a usable session id`);
      if (parts.storage.findSession(id) === undefined)
        throw new SessionMigrateError('not_found', `no session ${reference}`);
      // WHOLE migrations serialize, not just their writes: the gate reads a pane, the restamp writes
      // the document that pane's replacement is launched from, and a second migration interleaving
      // between the two would relaunch the first one's target under the second one's account.
      return await parts.serial.run(id, async () => await migrate(id, request));
    },
  };
}

/** The collaborators automatic quota failover needs from the rest of the root. */
interface QuotaFailoverWiring {
  readonly root: string;
  readonly storage: DaemonStorage;
  readonly sessions: SessionDirectorySubsystem;
  readonly accounts: AccountInventoryPort;
  readonly usage: UsageFeedPort;
  /** The SAME migration the route serves — see below for why it is this one and not a private copy. */
  readonly migrate: SessionMigrateSubsystem;
}

/**
 * The loop that makes `fy migrate` answer the journey the product advertises.
 *
 * THE MIGRATOR IS THE MOUNTED SUBSYSTEM ITSELF, not a second path built beside it. Everything that
 * makes a migration safe lives inside `createSessionMigrateSubsystem` — the in-flight preflight, the
 * same-kind refusal, the forensic report written before the pane dies, the per-session queue — and a
 * failover that reached around it to "just get the session moving" would be the exact bug the
 * preflight exists to prevent, committed by the one caller with no human watching.
 *
 * `allowContextDowngrade` IS FALSE AND NOT CONFIGURABLE. A downgrade silently truncates the
 * conversation a migration exists to preserve; a human may accept that for a session they are
 * looking at, and an unattended loop may not accept it on their behalf. A target with a smaller
 * window is therefore refused here and recorded as a refusal, which is a fact a human can act on.
 *
 * NO MODEL IS NAMED, so the planner serves the target account's own default. Carrying the source
 * account's model across would ask the new account for a model it may not publish, and the refusal
 * would arrive as an unavailability that looks like the failover failing.
 *
 * THE FEED IS THE DAEMON-WIDE CACHED ONE every other consumer reads, so a move can never be made on
 * a quota reading that disagrees with what `/v1/usage` is serving the human at the same moment.
 */
function createQuotaFailoverSubsystem(wiring: QuotaFailoverWiring): QuotaFailoverLoop {
  return new QuotaFailoverService({
    config: new FileQuotaFailoverConfigStore(wiring.root),
    state: new FileQuotaFailoverStateStore(wiring.root),
    roster: {
      sessions: async () =>
        (await wiring.sessions.list()).map(view => ({
          id: view.config.id,
          agent: view.config.agent,
          harness: view.config.harness,
          status: view.state.status,
        })),
    },
    accounts: wiring.accounts,
    usage: wiring.usage,
    migrator: {
      migrate: async (sessionId, agent) => {
        await wiring.migrate.migrate(sessionId, { agent, allowContextDowngrade: false });
      },
    },
    journal: {
      record: async (sessionId, event, data) => {
        // PARSED, not asserted: an id the layout would not accept must never become a journal path.
        const id = tryParseSessionId(sessionId);
        if (id === undefined) return;
        await wiring.storage.append(id, event, data);
      },
    },
    // Epoch milliseconds rather than the daemon's ISO clock: every rule this loop applies is a
    // subtraction — snapshot age, retry cooldown, revisit cooldown — and the domain says so.
    clock: { nowMs: () => Date.now() },
  });
}

/**
 * How many events one page of the duplicate search reads.
 *
 * A PAGE SIZE, NOT A BOUND ON THE SEARCH. `replay` returns a forward PREFIX from a sequence, so any
 * finite limit read once would answer about the OLDEST events in the journal — and the event this is
 * looking for is the newest. On a session with more than one page of history that search would find
 * nothing every time and append a duplicate on every replay, which is precisely the contract
 * `appendOnce` exists to keep. The search below therefore pages forward to the true end, and this
 * number only decides how many round trips that takes.
 */
const HANDOVER_JOURNAL_PAGE = 1_000;

/**
 * Appends one handover event to a session's journal, AT MOST ONCE.
 *
 * WHY THIS IS NOT A PLAIN APPEND. Completion writes to two journals in a fixed order — the
 * predecessor's, then the replacement's — and a crash between them replays the step. A plain append
 * would then write the predecessor's completion a second time, and the fleet's own history would claim
 * one session was handed over twice. The core states that contract in the port's name (`appendOnce`)
 * and derives an `operationId` from the receipt and the side precisely so the second attempt is
 * recognisable as the first.
 *
 * THE DEDUPLICATION IS DURABLE, and the durable record is the JOURNAL ITSELF rather than a set held in
 * this process: a process-local guard is empty again after exactly the event that makes the replay
 * happen — the restart — so it would answer "not yet written" for the one case it exists to catch. The
 * question is asked of the same document the answer is written to.
 *
 * THE SEARCH RUNS TO THE TRUE END OF THE JOURNAL, and that is the whole of the correctness argument.
 * `replay` answers with a forward PREFIX from a sequence, so reading one bounded page would ask about
 * the journal's OLDEST events while the event being looked for is its NEWEST. On any session with more
 * history than one page, that search finds nothing every time — so every replay appends again, and the
 * bound silently converts "at most once" into "once per restart". There is no session-journal operation
 * ledger in this repository to ask instead, so the pages are walked until `hasMore` is false.
 *
 * A session id the layout would not accept is dropped rather than journalled, for the reason every
 * other journal write in this root drops one: an id that is not a session is not a path.
 */
export async function appendHandoverEventOnce(
  storage: DaemonStorage,
  serial: SerialExecutor,
  input: HandoverJournalAppend,
): Promise<void> {
  const id = tryParseSessionId(input.sessionId);
  if (id === undefined) return;
  const carriesOperation = (event: { readonly type: string; readonly data: unknown }): boolean =>
    event.type === input.type &&
    typeof event.data === 'object' &&
    event.data !== null &&
    !Array.isArray(event.data) &&
    (event.data as Record<string, unknown>).operationId === input.operationId;
  // THE SEARCH AND THE APPEND ARE ONE CRITICAL SECTION, per session. The storage locks each `replay`
  // and each `append` individually, so without this two concurrent attempts at the SAME operation can
  // both finish scanning — each finding nothing, because neither has written yet — and then both
  // append. The durable journal answers the RESTART half of "at most once"; this lock answers the
  // CONCURRENT half, and the contract needs both. The key is the session id, so one session's
  // completion never waits behind another's.
  await serial.run(`handover-journal:${id}`, async () => {
    let after = 0;
    for (;;) {
      const page = await storage.replay(id, after, HANDOVER_JOURNAL_PAGE);
      if (page.events.some(carriesOperation)) return;
      // `nextSequence` is absent exactly when the page was empty, which is the end of the journal
      // however `hasMore` was computed — so the walk terminates on the weaker of the two signals rather
      // than trusting one of them alone.
      if (!page.hasMore || page.nextSequence === undefined) break;
      after = page.nextSequence;
    }
    await storage.append(id, input.type, { ...input.data, operationId: input.operationId });
  });
}

/** The collaborators a cross-harness handover needs from the rest of the root. */
interface SessionHandoverWiring {
  readonly paths: FoundationPaths;
  readonly storage: DaemonStorage;
  readonly sessions: SessionDirectorySubsystem;
  readonly accounts: AccountInventoryPort;
  readonly executables: ExecutableResolverPort;
  readonly planner: SessionPlanner;
  readonly clock: SystemClock;
  /** Serializes the journal's read-then-write per session, which is what makes `appendOnce` hold
   *  against CONCURRENT callers as well as against a restart. Owned by the composition root, because a
   *  lock created per call would serialize nothing. */
  readonly journalSerial: SerialExecutor;
}

/**
 * The cross-harness handover, wired to the surfaces that already exist.
 *
 * WHAT THIS OPERATION IS, in one line, because the word next to it means something else: a migration
 * keeps a session and moves it to another account of the SAME family, and a handover crosses families,
 * which the conversation cannot survive — so a NEW top-level session is started, every durable
 * coordination fact is carried into it, it proves it holds and can use the predecessor's board
 * membership, and only then is the predecessor retired.
 *
 * THE SHARED TRANSFER SEAM EXISTS, BUT THIS HANDOVER IS NOT WIRED TO IT YET. Its generic preparer,
 * importer and target plan store are now available to the fork; the handover still lacks the
 * handover-specific composition that would choose a replacement and bind the board and lifecycle legs.
 * A handover cannot be performed without those legs, so each raises `step_failed` naming the missing
 * capability.
 * What this deliberately does NOT do is invent a second preparation: a private copy here would be the
 * parallel domain the seam exists to prevent, and it would have to be deleted — with its receipts
 * already on disk — the moment the real one landed.
 *
 * The consequence is stated rather than hidden: `POST /v1/sessions/:id/handover` refuses every request
 * until those land, and the refusal says which piece is missing. Everything else about the operation —
 * the receipt store, the phase ladder, the reconciler, the refusal taxonomy, the routes — is real,
 * wired and exercised, which is what makes landing the seam a small change rather than a second
 * integration.
 */
export function createSessionHandoverSubsystem(
  wiring: SessionHandoverWiring,
  receipts: HandoverReceiptStore,
): SessionHandoverService {
  /** The generic seam is present; this operation deliberately refuses until its remaining legs exist. */
  const seamAbsent = (piece: string): never => {
    throw new HandoverError(
      'step_failed',
      `this build carries the shared session-transfer seam, but a handover cannot ${piece}: its ` +
        'handover-specific replacement, board and lifecycle composition is not wired yet',
    );
  };
  return new SessionHandoverService(
    {
      receipts,
      sessions: {
        /**
         * MISSING IS NOT UNREADABLE, and after `source_lost` exists the difference is destructive.
         *
         * `null` from this port means the session is externally ABSENT — which the handover is entitled
         * to act on: it may settle `source_lost`, and it may clean up a replacement it decides has no
         * predecessor left. A catch-all that turned every failure into `null` would hand that same
         * authority to a corrupt document, a closed index or a transient read fault, and the handover
         * would terminalize — and stop a live replacement — on evidence it never actually had.
         *
         * `SessionDirectorySubsystem.get` already draws the line: it resolves to `undefined` for a
         * session that is not there and REJECTS for a session it could not read. So the rejection is
         * propagated untouched, and the service parks and retries on the next tick rather than writing a
         * settlement. The same adapter answers for the source and for the replacement, so this holds for
         * both observations.
         */
        read: async sessionId => {
          const view = await wiring.sessions.get(sessionId);
          if (view === undefined) return null;
          return {
            sessionId: view.config.id,
            incarnation: view.config.incarnation,
            runtimeGeneration: view.config.runtimeGeneration,
            parentSessionId: view.config.parent ?? null,
            mode: view.config.mode,
            status: view.state.status,
            // The family as the DOCUMENT records it, unnarrowed: a session written by a future daemon
            // may name one this build has never heard of, and `harness_unknown` is the refusal that
            // exists for exactly that rather than a guess.
            harness: view.config.harness,
            agent: view.config.agent,
            teammate: view.config.teammate ?? null,
            cwd: view.config.cwd,
            label: view.config.label ?? null,
          };
        },
        create: async () => seamAbsent('create its replacement'),
        start: async () => seamAbsent('start its replacement'),
        stop: async () => seamAbsent('retire its predecessor'),
      },
      board: {
        requestInvitation: async () => seamAbsent('invite its replacement onto the board'),
        approveInvitation: async () => seamAbsent('approve its invitation'),
        acceptInvitation: async () => seamAbsent('accept its invitation'),
        requestChildGrant: async () => seamAbsent('request its coordinator grant'),
        approveChildGrant: async () => seamAbsent('approve its coordinator grant'),
        replaceCoordinator: async () => seamAbsent('seat its replacement coordinator'),
        relinquish: async () => seamAbsent('relinquish its predecessor membership'),
      },
      boardReader: {
        membership: async () => null,
        observe: async () => null,
      },
      accounts: {
        resolve: async (agent, model) => {
          const { account } = await resolveStartAccount(wiring.accounts, agent, wiring.executables);
          // The SAME planner the start and the migration use, so the model a handover records and the
          // window it is measured against come from one decision rather than two that can disagree.
          const plan = wiring.planner.plan({
            id: 'handover-probe',
            account,
            mode: 'interactive',
            ...(model === null ? {} : { requestedModel: model }),
          });
          return {
            accountId: account.id,
            agent: account.agent,
            harness: account.kind,
            model: plan.model,
            effort: null,
            contextWindow: plan.contextWindow,
          };
        },
      },
      preparer: { prepare: async () => seamAbsent('prepare its transfer plan') },
      importer: { importPlan: async () => seamAbsent('import its transfer plan') },
      preflight: {
        // Advisory at `requested` and binding before the retirement. Absent a seam nothing reaches the
        // binding call, and answering "safe" here would be a claim about a pane this build never read.
        evaluate: async () => ({
          proceed: false,
          reason: 'no in-flight inventory was taken: this build cannot perform a handover',
          reportPath: null,
        }),
      },
      attention: { raise: async () => seamAbsent('raise its attention item') },
      journal: {
        appendOnce: async input => await appendHandoverEventOnce(wiring.storage, wiring.journalSerial, input),
      },
      identity: { sessionId: () => crypto.randomUUID() },
      clock: { now: () => wiring.clock.now() },
    },
    DEFAULT_HANDOVER_SETTINGS,
  );
}

/**
 * How many finished sessions may have their transcripts folded at once.
 *
 * Small on purpose. Each read is individually bounded, so the risk is never one enormous file — it
 * is a fleet's worth of bounded reads resident at the same instant.
 */
const ANALYTICS_FOLD_CONCURRENCY = 4;

/**
 * How often the ingestion sweep looks for sessions that have ended.
 *
 * A minute, because nothing waits on it: analytics is a read over history, and a session that ended
 * thirty seconds ago is not a question anyone is asking. A pass with nothing new to do reads no
 * transcripts at all — every already-ingested session with a proven total is skipped on its signature —
 * so the cost of a quiet tick is one listing of the state home.
 */
const ANALYTICS_INGEST_INTERVAL_MS = 60_000;

/**
 * Every session the daemon holds durable documents for, as ingestion candidates.
 *
 * IT DOES NOT DECIDE ANYTHING. No gate, no fold, no pricing: it parses the two documents and hands
 * over what they say, including whether they say a session ended. Pre-filtering here would put a
 * second, unstated copy of the terminal-state rule in the composition root, where nothing tests it.
 *
 * Both documents are PARSED, and a session whose pair does not parse is left out entirely rather than
 * contributed with holes: an analytics row assembled from a config the schema rejected is a row whose
 * provenance nobody can state.
 */
function createAnalyticsCandidateSource(storage: DaemonStorage): AnalyticsIngestCandidateSource {
  const candidate = async (id: SessionId): Promise<AnalyticsIngestCandidate | undefined> => {
    const [rawConfig, rawState] = await Promise.all([storage.readConfig(id), storage.readState(id)]);
    const config = SessionConfigSchema.safeParse(rawConfig);
    const state = SessionStateSchema.safeParse(rawState);
    if (!config.success || !state.success) return undefined;
    return {
      id,
      transcriptHarness: config.data.harness === 'codex' ? 'codex' : 'claude',
      agent: config.data.agent,
      // The SELECTED model only. `observedModel` is transcript evidence, and the record's own
      // contract forbids substituting it for what the operator asked for.
      selectedModel: config.data.model ?? null,
      contextWindow: state.data.contextWindow ?? null,
      harness: config.data.harness,
      mode: config.data.mode,
      label: config.data.label ?? null,
      cwd: config.data.cwd,
      parent: config.data.parent ?? null,
      createdAt: config.data.createdAt,
      startedAt: state.data.startedAt ?? null,
      finishedAt: state.data.finishedAt ?? null,
      status: state.data.status,
      // Time-to-first-output is transcript evidence the daemon does not index; a launch instant is
      // not an output, so reporting one here would mismeasure every session.
      firstOutputAt: null,
      turns: state.data.turn,
      contextEndPercent: state.data.contextPercent ?? null,
      migrated: config.data.migration !== undefined,
    };
  };
  return {
    listCandidates: async () => {
      // Read in bounded batches rather than all at once. Each document read is small, but a fleet with
      // hundreds of sessions would hold every one of them resident under an unbounded `Promise.all`.
      const ids = storage.listSessions().map(session => session.id);
      const candidates: AnalyticsIngestCandidate[] = [];
      for (let start = 0; start < ids.length; start += ANALYTICS_FOLD_CONCURRENCY) {
        const batch = await Promise.all(ids.slice(start, start + ANALYTICS_FOLD_CONCURRENCY).map(id => candidate(id)));
        candidates.push(...batch.filter((entry): entry is AnalyticsIngestCandidate => entry !== undefined));
      }
      return candidates;
    },
  };
}

/**
 * Analytics ingestion, over this daemon's own state home.
 *
 * WHY INGESTION EXISTS AT ALL. The read used to derive everything per request — every session's
 * documents parsed and its whole transcript folded, on every question — so the cost of one query grew
 * with the entire history of the fleet, and nothing richer could be built on top of it. A session is
 * now folded and priced ONCE, when it reaches a durable terminal state, and the query reads the result.
 *
 * THE STORE IS THIS DAEMON'S ALONE. It lives under this state home, and the file records the home it
 * was built for; a copied or restored index naming another home is discarded on open rather than
 * served, because one daemon's spend reported as another's is a wrong answer, not a stale one.
 *
 * THE PRICING CATALOG comes from this daemon's validated operator configuration and is read per pass,
 * so an operator's edit takes effect on the next ingestion. It is never shared between state homes, and
 * an empty catalog makes every cost `unpriced` with a reason — the honest answer. A hardcoded table
 * would price historical runs off numbers nobody in this deployment agreed to; a zero would read as
 * free.
 */
function createAnalyticsIngestion(
  storage: DaemonStorage,
  opened: OpenedAnalyticsIndexStore,
  pricingConfiguration: AnalyticsPricingConfigurationPort,
  evidence: AnalyticsTranscriptEvidenceSource,
  clock: ClockPort,
): AnalyticsIngestionService {
  return new AnalyticsIngestionService({
    candidates: createAnalyticsCandidateSource(storage),
    evidence,
    store: opened.store,
    pricing: async () => {
      const read = await pricingConfiguration.readPricing();
      if (read.kind === 'unavailable') throw new Error(`analytics ingestion refused because ${read.message}`);
      return read.configuration.catalog;
    },
    clock,
    concurrency: ANALYTICS_FOLD_CONCURRENCY,
    rebuildRequired: opened.rebuildRequired,
  });
}

/** The analytics read, over the rows ingestion materialised. */
function createAnalyticsSubsystem(ingestion: AnalyticsIngestionService): AnalyticsSubsystem {
  return { index: () => ingestion.read() };
}

/**
 * Real one-shot timers for the terminal redraw poll.
 *
 * The bridge asks for a cancellable timer rather than accepting a runtime handle, so the only place
 * in the daemon that ever touches `setTimeout` for a stream is here. A handle typed `unknown` and
 * cast back at the cancel site would be the same thing with a cast in it.
 */
const terminalScheduler: TerminalStreamScheduler = {
  schedule: (callback, milliseconds) => {
    const handle = setTimeout(callback, milliseconds);
    return { cancel: () => clearTimeout(handle) };
  },
};

/**
 * Independent shell terminals, over the session's own working directory.
 *
 * THE ERROR TRANSLATION IS THE POINT OF THIS FUNCTION. `ManagedTerminalService` and the tmux runtime
 * behind it raise adapter-owned error classes, and a route in `src/lib` may not import them. Naming
 * them here — in the one place allowed to see both sides — is what lets a full terminal list answer
 * 409 and a tmux failure answer 502, instead of both surfacing as a 500 about a class nobody outside
 * `src/adapters` can name.
 *
 * The limits come from the PROTOCOL constants rather than the service's own defaults, so the ceiling
 * the API advertises in `limits` and the ceiling the service enforces cannot drift apart.
 *
 * The session resolver reads the authoritative configuration: a terminal opens in the session's own
 * `cwd`, and a session the index does not hold resolves to nothing rather than to the daemon's own
 * working directory.
 */
function createTerminalSubsystem(
  storage: DaemonStorage,
  runtime: TerminalRuntimePort,
  clock: MillisecondClockPort,
): TerminalSubsystem {
  const sessions: TerminalSessionResolver = {
    resolve: async reference => {
      const id = tryParseSessionId(reference);
      if (id === undefined || storage.findSession(id) === undefined) return undefined;
      const config = SessionConfigSchema.safeParse(await storage.readConfig(id));
      return config.success ? { id, cwd: config.data.cwd } : undefined;
    },
  };
  const service = new ManagedTerminalService(
    runtime,
    sessions,
    clock,
    // A terminal id is twelve hex characters by protocol. Minting it from a UUID's own randomness
    // beats a counter the next process would restart at one and collide on.
    { next: () => crypto.randomUUID().replaceAll('-', '').slice(0, 12) },
    {
      maximumPerSession: TERMINAL_MAX_PER_SESSION,
      maximumGlobal: TERMINAL_MAX_GLOBAL,
      idleTimeoutMs: TERMINAL_IDLE_TIMEOUT_MS,
    },
  );
  /** Adapter refusals, restated in the protocol's vocabulary so the mount can answer them. */
  const translate = (error: unknown): never => {
    if (error instanceof TerminalServiceError) throw new TerminalMountError(error.code, error.message);
    if (error instanceof TerminalRuntimeError) throw new TerminalMountError('upstream_failed', error.message);
    throw error;
  };
  return {
    list: async sessionId => await service.list(sessionId).catch(translate),
    // The opener the mount DERIVED from the request's credential, forwarded unchanged. The service
    // is deliberately not given the request body's `agentSessionId`: ownership is decided where the
    // credential is, and a service that could read a claimed owner would eventually be asked to.
    create: async (sessionId, input, openedBy) =>
      await service
        .create(sessionId, {
          title: input.title,
          cols: input.cols,
          rows: input.rows,
          ...(openedBy === undefined ? {} : { openedBy }),
        })
        .catch(translate),
    get: async (sessionId, terminalId) => await service.get(sessionId, terminalId).catch(translate),
    rename: async (sessionId, terminalId, title) => await service.rename(sessionId, terminalId, title).catch(translate),
    close: async (sessionId, terminalId) => await service.close(sessionId, terminalId).catch(translate),
    /**
     * One viewer socket, over the SAME lifecycle service the routes use.
     *
     * That sharing is the point: the bridge writes and captures through the service, so a keystroke
     * bumps the same activity instant the idle policy reads and a stream cannot keep a pane alive
     * that the lifecycle believes it closed. The bridge itself refuses an oversized or malformed
     * frame, bounds unwritten input, and drops output for a viewer that has stopped reading — the
     * mount hands it a socket and nothing more.
     */
    stream: async (sessionId, terminalId, downstream) =>
      new TerminalStreamBridge(service, sessionId, terminalId, downstream, terminalScheduler),
  };
}

/**
 * Which callsigns the fleet is currently using.
 *
 * `teammate` is the callsign — it is what `--teammate <callsign>` writes — and `name` is the human
 * title, so only the former is read here. A session whose configuration is unreadable or whose
 * teammate is not a well-formed callsign contributes NOTHING rather than a guess: over-reporting a
 * name as taken quietly shrinks the pool, and the failure is invisible.
 *
 * The claim window is the pool policy's own, so a callsign frees up exactly when a bare reference to
 * it stops naming that session.
 */
/**
 * The callsigns the live fleet is using, derived from each session's own configuration document.
 *
 * This is the DURABLE half of "what is taken": a session's `teammate` is what a bare callsign
 * resolves through, so a name a live session answers to is not free however the reservation ledger
 * looks. Shared by the suggestion route and the allocator's claim store so the two cannot disagree
 * about who owns a name.
 */
async function liveCallsigns(storage: DaemonStorage): Promise<readonly NameClaim[]> {
  const sessions = await Promise.all(
    storage.listSessions().map(async (session): Promise<NameClaim | undefined> => {
      const config = SessionConfigSchema.safeParse(await storage.readConfig(session.id));
      if (!config.success || config.data.teammate === undefined) return undefined;
      const callsign = normalizeCallsign(config.data.teammate);
      const claimedAtMs = Date.parse(config.data.createdAt);
      if (callsign === null || !Number.isFinite(claimedAtMs)) return undefined;
      return { callsign, ownerId: session.id, claimedAtMs, expiresAtMs: claimedAtMs + CALLSIGN_WINDOW_MS };
    }),
  );
  return sessions.filter((claim): claim is NameClaim => claim !== undefined);
}

/**
 * Callsign claiming for a start: the real allocator over the reservation ledger and the live fleet.
 *
 * The randomness is the same rotation the suggestion route uses, and for the same reason — two starts
 * racing for the pool must not both begin at its first entry — and the ledger's executor is passed in
 * so every claim in the process serializes on the one file.
 */
function createCallsignClaims(
  storage: DaemonStorage,
  files: StateFileSystem,
  paths: FoundationPaths,
  executor: KeyedSerialExecutor,
): CallsignClaims {
  const store = new FileNameClaimStore(
    join(paths.state, 'callsigns.json'),
    files,
    executor,
    async () => await liveCallsigns(storage),
  );
  const allocator = new NameAllocator(store, {
    nextIndex: upperExclusive => Math.floor(Math.random() * upperExclusive),
  });
  return {
    allocate: async request => await allocator.allocate(request),
    release: async (callsign, ownerId) => await store.release(callsign, ownerId),
  };
}

function createNameSubsystem(storage: DaemonStorage): NameSubsystem {
  return {
    claims: async () => await liveCallsigns(storage),
    now: () => Date.now(),
    // Rotating the start so two humans asking at the same moment are not both offered the same
    // first name and then made to collide when they start their sessions.
    startIndex: upperExclusive => Math.floor(Math.random() * upperExclusive),
  };
}

/** How long a terminal nobody is watching stays open. One hour, matching the service's own default;
 *  stated here so the number the API reports is the number the daemon enforces. */
const TERMINAL_IDLE_TIMEOUT_MS = 60 * 60_000;

/**
 * The learning schedule this daemon reports.
 *
 * Mining is now mounted for explicit runs. The configuration remains deployment-owned until a
 * scheduler lands; reporting it enabled tells an operator that `POST /v1/learning/run` can start a
 * bounded miner and later ingest its verified output.
 */
const LEARNING_CONFIG = {
  enabled: true,
  agent: 'claude',
  intervalMinutes: 60,
  batchSize: 20,
  maxMinersPerRun: 2,
  maxSessionsPerRun: 40,
  minSpawnGapMinutes: 30,
} as const satisfies LearningConfig;

/**
 * The learning review board, over the state home's own `learning/` directory.
 *
 * ONE executor for the whole process, keyed on the board: a verdict is a read-decide-rewrite of a
 * single JSON snapshot, so two landing together would otherwise lose one. The key is a constant
 * because there is exactly one board per state home — unlike the task boards, which are per session.
 */
/**
 * The task-board membership lifecycle, over the state home and the opened session index.
 *
 * ONE document for the whole fleet, at the state home's root beside the credential files, because the
 * reducers reason ACROSS boards: an invitation acceptance searches every board for the one that names
 * the accepting session, and a binding is what proves a session is not already a member elsewhere.
 * Sharding by board would make each of those a fan-out read no per-file lock could keep consistent.
 *
 * DELIVERY MERGES rather than replaces. The session environment store holds one document per session
 * and `FY_SESSION_BOARD_CAPABILITY` already lives in it, so writing a board capability by replacing
 * that document would take away the session's own identity — the credential the invitation-accept path
 * needs — in the act of granting it board access. The read-modify-write runs inside the SAME executor
 * every session mutation uses, so it cannot interleave with a start writing the same file.
 */
function createTaskBoardSubsystem(
  paths: FoundationPaths,
  files: StateFileSystem,
  storage: DaemonStorage,
  clock: SystemClock,
  environments: FileSessionEnvironmentStore,
  serial: KeyedSerialExecutor,
): TaskBoardSubsystem {
  const operator = new StateBoardAdminCapability(paths, files);
  return {
    repository: new FileTaskBoardRepository(join(paths.home, 'task-boards.json')),
    sessions: new StorageTaskBoardSessionDirectory({
      sessionIds: () => storage.listSessions().map(session => session.id),
      readConfig: async id => await storage.readConfig(id as SessionId),
      readState: async id => await storage.readState(id as SessionId),
    }),
    issuer: new NodeTaskBoardCredentialIssuer(),
    coordinatorReplacementCapabilities: new StateTaskBoardCoordinatorReplacementCapability(paths, files),
    now: () => clock.now(),
    operatorCapabilityHash: async () => await operator.hash(),
    deliver: async (sessionId, variables) => {
      const id = tryParseSessionId(sessionId);
      // A capability minted for an id the layout would refuse has nowhere to be written. The board
      // that granted it is already committed, so this refuses loudly rather than writing outside the
      // session tree.
      if (id === undefined) throw new TaskError('invalid', `${JSON.stringify(sessionId)} is not a usable session id`);
      await serial.run(`session:${id}`, async () => {
        const current = await environments.read(id);
        await environments.write(id, { ...current, ...variables });
      });
    },
  };
}

/**
 * The human browser-login window, over the daemon's own private profile and a private X display.
 *
 * ONE PROFILE for the whole daemon, inside the state home. It is the artefact the window exists to
 * produce: a person signs in once, the profile is marked primed, and every later browser run reuses
 * the cookies that sign-in left. The store keeps its lease, its Chrome pid and its primed marker
 * beside the profile, so a second window — or a crashed daemon's leftovers — is refused rather than
 * corrupting it.
 *
 * THE SECRET FILE SHARES THE PROFILE'S DIRECTORY rather than a temp path. x11vnc reads the password
 * once and deletes it (`-passwdfile rm:`), but between the write and that read it is a live
 * credential on disk, and the browser directory is the daemon's own 0700 tree.
 *
 * EVERY EXECUTABLE IS A PATH LOOKUP AT THE POINT OF USE, matching `executables` above: a host that
 * installs x11vnc after the daemon booted must be able to open a window without a restart, and a host
 * that has none refuses with a sentence naming what is missing rather than spawning whatever answers
 * to the name.
 */
function createBrowserLoginWorld(paths: FoundationPaths, closeAgentBrowsers: () => Promise<void>): BrowserLoginWorld {
  const profile = new BrowserProfileStore(paths.home);
  const which = (name: string) => () => Bun.which(name, { PATH: process.env.PATH }) ?? undefined;
  const runtime = new NodeBrowserLoginRuntime({
    display: new XvfbDisplay({ executable: which('Xvfb') }),
    secretsDirectory: profile.browserDirectory,
    x11vncExecutable: which('x11vnc'),
    timeoutExecutable: which('timeout'),
    // The operator's explicit Chrome, honoured ahead of this platform's candidate list. The domain
    // names the variable in its own refusal, so the name is read here rather than invented.
    chromeOverride: () => process.env.FY_CHROME_BIN,
  });
  return {
    window: new BrowserLoginWindowService({ profile, runtime, closeAgentBrowsers }),
    close: async () => await runtime.close(),
  };
}

/** A compiled daemon runs the separately compiled browser worker beside itself; source execution
 * uses Node's WebSocket transport for the TypeScript worker. FY_BROWSER_WORKER_BIN exists for
 * release smoke. */
function browserWorkerProgram(): { readonly entry: string; readonly executable: boolean } {
  const source = process.env.FY_BROWSER_WORKER_SOURCE;
  if (source?.trim()) return { entry: source, executable: false };
  const forced = process.env.FY_BROWSER_WORKER_BIN;
  if (forced?.trim()) return { entry: forced, executable: true };
  const suffix = process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64-baseline';
  const sibling = join(dirname(process.execPath), `fyd-browser-worker-${suffix}`);
  if (existsSync(sibling)) return { entry: sibling, executable: true };
  return { entry: join(import.meta.dir, 'browser-worker.ts'), executable: false };
}

function createLearningSubsystem(
  paths: FoundationPaths,
  files: StateFileSystem,
  clock: SystemClock,
  serial: TaskBoardSerialExecutor,
  sessions: SessionDirectorySubsystem,
  transcripts: SessionTranscriptReader,
  sessionControl: SessionControlSubsystem,
): LearningSubsystem {
  const store = new FileLearningStore(paths, files, clock);
  const miner = new LearningMiner(
    paths,
    files,
    store,
    sessions,
    transcripts,
    sessionControl,
    () => LEARNING_CONFIG,
    () => clock.now(),
  );
  return {
    store,
    transaction: async work => await serial.run('learning', work),
    config: () => LEARNING_CONFIG,
    now: () => clock.now(),
    run: async spawn => await miner.run(spawn),
  };
}

/**
 * The daemon's own health, over the self-check `start` ticks.
 *
 * The process id is read HERE rather than in the route, because `src/lib` may not touch `process`:
 * a domain that read its own pid could not be driven from a test, and the whole point of the field
 * is that an operator can signal the process that is actually serving.
 */
function createHealthSubsystem(health: SessionHealthService, scratch: ScratchReclamation): DaemonHealthSubsystem {
  return {
    report: async () => await health.report(),
    pid: process.pid,
    scratch,
  };
}

/**
 * Quota deliberately UNREAD, for the caller who asked for no probe.
 *
 * It is not a stub standing in for a feed that should be here: `hasSnapshot` is false and the account
 * list is empty because nothing was measured, which is exactly what the recommender then reports. The
 * engine ranks an account it knows nothing about as average rather than as empty, so declining the
 * probe costs the ordering its quota tie-breaker instead of inverting it.
 */
const UNREAD_USAGE: UsageFeedPort = {
  accounts: async () => [],
  snapshotAt: () => undefined,
  hasSnapshot: () => false,
};

/**
 * The team recommender, over the fleet manifest and the operator's routing catalog.
 *
 * TWO advisors, built from the same inventory and catalog and differing only in their usage feed,
 * because `usage: false` on the wire means the quota inputs are genuinely unread — and the only seam
 * that can express that is the feed itself. Branching inside one advisor would mean either probing
 * anyway and discarding the answer, which costs the caller the provider round trips they declined, or
 * teaching the domain a flag about its own inputs.
 */
function createRecommendSubsystem(
  advisorOver: (usage: UsageFeedPort) => TeamAdvisor,
  usage: UsageFeedPort,
): RecommendSubsystem {
  const withQuota = advisorOver(usage);
  const withoutQuota = advisorOver(UNREAD_USAGE);
  return {
    recommend: async input => await (input.usage ? withQuota : withoutQuota).recommend({ task: input.task }),
  };
}

/**
 * Which address this boot will serve, or the refusal that stops it.
 *
 * TWO PATHS, and which one applies is decided by whether the configuration document RECORDS a port.
 *
 *   * A RECORDED PORT IS A CLAIM. An operator typed it, or an earlier boot wrote down what it took,
 *     and either way something out there has been told this daemon lives at that address. So it is
 *     bound or the boot refuses — never silently moved. The occupant is identified first so the
 *     refusal can say whether it is another of these daemons (nothing to do) or a stranger (a human
 *     must act), because those are different remedies.
 *   * NO RECORDED PORT IS A PREFERENCE. This is a state home that has never started a daemon, and a
 *     first run must succeed on a machine that happens to have something on the preferred port. It
 *     walks a short consecutive sequence, takes the first free address, and the caller records it —
 *     after which every later boot is in the first case.
 *
 * FAIL CLOSED on the claimed path: `identify` treats anything it cannot positively recognise as this
 * product — including a probe that could not complete — as an occupant, so an inconclusive answer
 * refuses rather than booting a second daemon over a live one.
 */
async function decideAddress(
  world: DaemonWorld,
  loaded: DaemonConfig,
): Promise<{ readonly config: DaemonConfig } | BootRefusal> {
  if (loaded.portIsRecorded) {
    const occupant = await world.boot.probe.identify({ url: loaded.bindUrl });
    if (occupant.kind !== 'vacant')
      return refuseOccupiedAddress({
        daemonName: DAEMON_NAME,
        clientName: CLIENT_NAME,
        url: loaded.bindUrl,
        configFile: world.config.path,
        occupant,
      });
    world.notices.step('address is free', loaded.bindUrl);
    return { config: configuredAt(loaded, loaded.port) };
  }
  const candidates = portCandidates(world.boot.preferredPort);
  for (const port of candidates) {
    const config = configuredAt(loaded, port);
    const occupant = await world.boot.probe.identify({ url: config.bindUrl });
    if (occupant.kind === 'vacant') {
      world.notices.step('address chosen', `${config.bindUrl} (no port was recorded yet)`);
      return { config };
    }
    // Said out loud rather than passed over silently: an operator who expected the preferred port
    // and finds the daemon one along deserves to read why in the same log they are already reading.
    world.notices.step(
      'address in use',
      `${config.bindUrl} — ${occupant.kind === 'daemon' ? `another ${DAEMON_NAME} is serving it` : occupant.evidence}`,
    );
  }
  return refuseExhaustedCandidates(DAEMON_NAME, candidates, world.config.path);
}

/**
 * The daemon's startup account, on the standard error stream.
 *
 * `writeSync` ON THE DESCRIPTOR, not the stream object, and that is the point rather than a detail.
 * A launcher hands the daemon a file for both its streams, and the operator is then told to inspect
 * that file when something goes wrong — so anything that could leave a written line sitting in a
 * userspace buffer at the moment the daemon wedges or exits would reproduce the very symptom being
 * fixed. A descriptor write is handed to the kernel before it returns; there is nothing left to
 * flush. (Measured on this runtime, a stream write to a redirected descriptor reaches the file
 * immediately too — this simply removes the question rather than depending on the answer.)
 *
 * EVERY LINE CARRIES ELAPSED MILLISECONDS, because the failure that prompted this was a ninety-second
 * initialization that produced no output at all. A trail whose last entry is a step name and a
 * timestamp turns "it hung" into "it hung opening the state home", which is the whole difference
 * between a report someone can act on and a report that ends at an empty file.
 *
 * A FAILED WRITE IS SWALLOWED. Losing the log is bad; refusing to boot because the log could not be
 * written is worse, and a daemon that died writing about its own startup would be the least
 * debuggable outcome of all.
 */
function bootJournal(level: LogLevel = 'info'): BootNoticePort {
  const startedAtMs = Date.now();
  // Milestones are `info`; the things a human must act on are `warn` and are never filtered out —
  // a log level that could hide the reason a boot refused would recreate the empty-log defect on
  // purpose. `debug` selects the same records as `info` because nothing emits below it yet, which
  // the usage text says rather than implying a level that does something.
  const showSteps = level === 'debug' || level === 'info';
  const line = (text: string): void => {
    try {
      writeSync(2, `${DAEMON_NAME} ${new Date().toISOString()} +${String(Date.now() - startedAtMs)}ms ${text}\n`);
    } catch {
      // Intentionally ignored: a stream this daemon cannot write to must not stop it starting.
    }
  };
  return {
    step: (name, detail) => {
      if (showSteps) line(detail === undefined ? name : `${name} — ${detail}`);
    },
    state: message => line(`! ${message}`),
  };
}

/**
 * The hosted PWA and this daemon's own origins may all drive browser requests.
 *
 * BOTH addresses, because they are two different ways a browser reaches this daemon and either may
 * be the one in the address bar: the advertised origin is what a pairing link hands out, and the
 * bound one is what a person types on the host itself. They are the same string unless an operator
 * set `publicUrl`, in which case the set collapses back to one.
 */
function browserOrigins(config: DaemonConfig): readonly string[] {
  return [...new Set([...config.corsOrigins, new URL(config.publicUrl).origin, new URL(config.bindUrl).origin])];
}

/** The direct carrier this invocation may publish, or the one complete notice explaining why it cannot. */
function directCarrierPublication(
  config: DaemonConfig,
): { readonly kind: 'published'; readonly url: string } | { readonly kind: 'omitted'; readonly notice: string } {
  // The advertisement decision owns wildcard-derived omission. In particular, an operator-written
  // wildcard publicUrl is an address here and must not be reinterpreted from its hostname spelling.
  //
  // WHICH refusal it was is read off the decision rather than asserted here. There is more than one
  // way to have no address to hand out, the protocol owns a sentence for each, and `fy pair` already
  // renders those same two sentences — a third spelling on this seam would be the one that goes
  // stale, telling an operator a reason that was true of some other document than theirs.
  if (config.advertisement.kind === 'none') {
    const refusal = refusalNotice(config.advertisement.refusal);
    return {
      kind: 'omitted',
      notice: `direct carrier omitted (${config.bindUrl}) — ${refusal.audience} To publish one: ${refusal.remedy}`,
    };
  }
  const candidate = publishableDirectCarrier(config.publicUrl);
  if (candidate.kind === 'ok') return { kind: 'published', url: candidate.url };
  return {
    kind: 'omitted',
    notice:
      `direct carrier omitted — ${config.publicUrl} cannot be published: ${candidate.reason}; ` +
      'no direct entry is published, so devices can reach this daemon only over its relays; ' +
      'set "publicUrl" to an http or https origin without credentials, a path, a query, or a fragment to publish one',
  };
}

/**
 * Resolve every relay entry from one runtime advertisement read, only when an enabled discovery
 * entry actually needs that fact. Boot and `--check` each call this once for their own invocation;
 * transport construction receives the resulting sources and therefore cannot ask the directory a
 * second time behind either caller's back.
 */
async function resolveRelayCarrierSources(
  config: DaemonConfig,
  directory: RelayDirectoryPort,
): Promise<ReturnType<typeof chooseRelayCarrierSources>> {
  const advertisement = relayCarriersNeedDiscovery(config.carrierSet.relays)
    ? await directory.read()
    : RELAY_DIRECTORY_NOT_ASKED;
  return chooseRelayCarrierSources(config.carrierSet.relays, advertisement);
}

/**
 * Everything the fork subsystem is assembled from, named once so the assembly below reads as one
 * decision rather than a wall of positional arguments.
 *
 * Each field is an EXISTING owner rather than a fork-private one, and that is the point of writing
 * this out: the account resolution is the start's, the planner is the process's one planner, the
 * quirk service and the Codex catalogue cache are the runtime route's, and the lifecycle factory is
 * the same one every other create goes through. A fork that resolved an account differently from a
 * start, or read a second catalogue, would launch an agent this daemon was wrong about.
 */
interface ForkSubsystemParts {
  readonly storage: DaemonStorage;
  readonly paths: FoundationPaths;
  readonly attachmentStore: SessionAttachmentStore;
  /**
   * Where one session's attachment originals live, in the layout `SessionAttachmentStore` itself
   * uses: `<state>/attachments/<daemonId>/<sessionId>`.
   *
   * It is a PARAMETER rather than something derived here, and that is the whole point. The daemon id
   * is only known after pairing opens, and the copier and the store must address one tree: a copier
   * writing under the session's own private directory puts real bytes on disk that
   * `attachmentStore.download` and `unlock` cannot see, so a forked session shows its attachments in
   * the manifest and fails to open any of them. Wired from the same two values that construct the
   * store, in the one place that holds both.
   */
  readonly attachmentOriginals: (sessionId: string) => string;
  readonly transcriptSources: readonly TranscriptSource[];
  readonly gateway: GitWorktreeGateway;
  readonly accounts: SessionForkStartAccountResolver;
  readonly planner: SessionPlanner;
  readonly harness: Pick<HarnessQuirkService, 'planSwitch'>;
  readonly catalog: CodexRuntimeCatalogCache;
  readonly createLifecycle: (id: SessionId, envelope?: SessionProtocolEnvelope) => SessionLifecycleService;
  readonly transcripts: Pick<TranscriptProvenanceCapture, 'capture'>;
  /** The one daemon-private codec shared with the operator message read surface. */
  readonly messageTokens: SessionTranscriptMessageTokenCodec;
  /** The same fail-closed redactor used by operator transcript reads. */
  readonly redactor: Pick<SecretRedactor, 'redact'>;
  readonly environment: Pick<FileSessionEnvironmentStore, 'read'>;
  /** The startup half only — the intermediate annotation must not erase it. */
  readonly runtime: SessionRuntimeStartupHeldPort;
  readonly view: (id: SessionId) => Promise<SessionView | undefined>;
  readonly ids: SessionForkIdFactory;
  readonly clock: ClockPort;
}

/**
 * The production fork: one route, and the whole restart-safe machine behind it.
 *
 * THE PREPARATION HALF READS AND NOTHING ELSE. It is handed a source reader, a conversation reader,
 * an attachment reader and a workspace probe — no writer, no lifecycle, no board — so seam
 * invariants I1 and I2 hold because there is nothing here to violate them with.
 *
 * THE IMPORT HALF IS BOUND TO THE TARGET. Its port set is `{envelope, brief, attachments,
 * conversation}`: the first three write only into the id the binder was constructed with, and the
 * fourth is read-only revalidation of the pinned point. There is no board port and no child-grant
 * requester, so an imported session cannot inherit board access — it has no way to ask for one.
 *
 * THE REFERENCE CONTRIBUTOR IS DELIBERATELY UNINJECTED. No production counter for the reference
 * grammar exists yet, and this is not the place to invent one: a regex here would be a second
 * grammar with nothing to keep it honest against the owner's. Uninjected, the contributor reports a
 * structured `not_implemented` omission, which is the honest answer and a visible one.
 *
 * The serial executor is its OWN queue, for the reason the migration's is: a fork holds its key
 * across a create, an import and a launch, and must not make every unrelated document write in this
 * daemon wait behind it.
 */
function createForkSubsystem(parts: ForkSubsystemParts): SessionForkSubsystem {
  const forkQueue = new KeyedSerialExecutor();
  const conversation = new StorageTransferConversationReader(
    parts.transcriptSources,
    new StorageTranscriptDigestJournal(parts.storage),
    parts.redactor,
  );
  const preparer = new SessionTransferPreparer({
    source: new StorageTransferSourceReader(parts.storage),
    selection: {
      verifySelection: async (evidence, binding) =>
        (await verifySessionTranscriptMessageToken(
          parts.messageTokens,
          SESSION_TRANSCRIPT_MESSAGE_TOKEN_SELECTION_DOMAIN,
          {
            sessionId: evidence.sourceSessionId,
            incarnation: evidence.sourceIncarnation,
            provenance: evidence.transcriptProvenance,
          },
          evidence.through,
          evidence.rawPrefix,
          binding,
        )) === 'accepted',
    },
    contributors: {
      conversation: new ConversationFacetContributor(conversation, parts.redactor),
      attachments: new AttachmentFacetContributor(new SessionAttachmentTransferReader(parts.attachmentStore)),
      references: new ReferenceFacetContributor(),
      workspace: new WorkspaceFacetContributor(new GitTransferWorkspaceProbe(parts.gateway)),
      lineage: new LineageFacetContributor(),
    },
  });
  /**
   * The target's own `transfer-plan.json`, installed before import and re-read on every replay.
   *
   * TARGET-ONLY BY CONSTRUCTION. `FileSessionTransferTargetPlanStore` holds nothing but this
   * document, so the fork composition has no global transfer-receipt capability at all — the durable
   * fork receipt is `FileSessionForkReceiptStore`, and it is the single owner of that fact.
   *
   * This replaced a shim that built the two-halved `FileSessionTransferPlanStore` and fed its receipt
   * half a FABRICATED path, deriving a plan id from `{sourceSessionId: planId, requestId: planId}`.
   * That receipt half was never called, but the composition still held a writer aimed at the receipt
   * tree under a key no real fork would ever mint — a capability nothing needed and a path nothing
   * else would recognise. Reachable-but-unused is exactly the shape that becomes a second receipt
   * owner the first time somebody wires it up.
   */
  const planStore = new FileSessionTransferTargetPlanStore(id =>
    join(createSessionPaths(parts.paths, id).directory, 'transfer-plan.json'),
  );
  const briefWriter = new FileSessionTransferBriefWriter(
    id => createSessionPaths(parts.paths, parseSessionId(id)).directory,
  );
  const attachmentCopier = new FileSessionAttachmentCopier(parts.attachmentOriginals);
  /**
   * ONE resolver instance, handed to both halves.
   *
   * The service validates before the receipt is claimed, where a refusal costs nothing; the binder
   * validates again at create, so a receipt claimed by an older daemon — or before the pre-claim
   * check existed — still cannot launch a session at a level its account will not serve. Sharing the
   * instance is what makes the second call free: both hit the same held catalogue entry, so the
   * belt costs a map lookup rather than a second probe against a live account.
   */
  const resolver = new SessionForkTargetResolver({
    accounts: parts.accounts,
    planner: parts.planner,
    harness: parts.harness,
    // The ONE held Codex catalogue. It is probed by `validate`, in the working directory the plan
    // froze, rather than at resolution time — resolution runs before anything has read the source,
    // so the target's own directory is not known to it yet.
    catalog: parts.catalog,
  });
  const binder = new SessionForkTargetBinder({
    runtimeChoice: resolver,
    storage: parts.storage,
    createLifecycle: parts.createLifecycle,
    accounts: parts.accounts,
    planner: parts.planner,
    // A NAME SHIM ONLY: the binder's port spells the read `read` where the store spells it `load`.
    // Renaming either owner to match the other would touch a file this composition does not own, and
    // a second implementation would give one document two writers.
    plans: {
      read: async id => await planStore.load(id),
      install: async (id, plan) => await planStore.install(id, plan),
    },
    transcripts: parts.transcripts,
    importPorts: {
      envelope: new StorageTransferEnvelopeWriter(parts.storage),
      brief: briefWriter,
      // The store's OWN tree, not the session's private directory: bytes written anywhere else are
      // real files that `attachmentStore.download` and `unlock` cannot find, so a forked session
      // would list its attachments and fail to open a single one.
      attachments: attachmentCopier,
      conversation,
    },
    imported: { brief: briefWriter, attachments: attachmentCopier },
    environment: parts.environment,
    tmuxSession: id => sessionTmuxName(id, defaultSessionLifecycleSettings),
    runtime: parts.runtime,
    view: parts.view,
    sessionDirectory: id => createSessionPaths(parts.paths, id).directory,
    clock: parts.clock,
  });
  return new SessionForkFacade(
    new SessionForkService({
      receipts: new FileSessionForkReceiptStore(key => forkReceiptFile(parts.paths.state, key)),
      resolver,
      preparer,
      /**
       * The lifecycle's own limit, asked rather than copied.
       *
       * `forkOpeningTurnRefusal` measures the exact rendering the brief writer and the lifecycle's
       * turn-one document both use, against the very constants `lifecycle.create` parses with. It is
       * ASKED rather than re-derived: a second reading of that limit here would be a second owner of
       * it, and the arm that drifted would either claim a fork that can never be created or refuse
       * one that could. Asking it before the claim turns a conversation too large to hand over into
       * an ordinary refusal that wrote nothing, instead of a claimed receipt whose create can never
       * succeed and whose every retry re-drives the same impossible step forever.
       */
      opening: {
        assertDeliverable: plan => {
          const refusal = forkOpeningTurnRefusal(plan);
          if (refusal !== undefined) throw new TransferPrepareError('plan_invalid', refusal);
        },
      },
      binder,
      ids: parts.ids,
      clock: { now: () => parts.clock.now() },
      // The composite key becomes the executor's string key HERE, through the core's own renderer,
      // so two forks of different sources never queue behind each other for sharing a request id.
      // Its own executor, for the reason the migration has one: a fork holds its key across a
      // create, an import and a launch, and must not make unrelated document writes wait on it.
      serial: { run: async (key, work) => await forkQueue.run(sessionForkKey(key), work) },
    }),
  );
}

/** Builds the production adapter set. Subsystem units extend this as they land. */
export function buildWorld(overrides: RunOverrides = {}): DaemonWorld {
  // Pairing opens before any subsystem. Keep its validated daemon identity in
  // this composition root so the attachment store can key state by daemon
  // without widening the public pairing route interface.
  let attachmentDaemonId: string | undefined;
  const clock = new SystemClock();
  const millisecondClock = { now: () => Date.now() };
  const environment = new RuntimeEnvironment();
  const paths = createFoundationPaths(resolveStateHome(environment.stateHomeInput()));
  const messageTokenKey = sessionMessageTokenKeyFile(paths.state);
  /**
   * ONE durable private key owner for both message cursors and fork-selection bindings.
   *
   * The codec resolves lazily, so constructing it before the state home is opened performs no IO.
   * Both domains reach this same instance after boot; a second codec would still read the same file,
   * but it would be a second materialization queue and a second answer to first-use failure/retry.
   */
  const sessionTranscriptMessageTokens = new FileSessionTranscriptMessageTokenCodec(messageTokenKey, writerId =>
    temporaryFilePath(paths, messageTokenKey, writerId),
  );
  const worktreeClock = new SystemWorktreeClock();
  const files = new NodeWorktreeFileSystem();
  const gateway = new GitWorktreeGateway(new BunGitRunner(), files, worktreeClock);
  const wardenFiles = new NodeWardenReportFileSystem();
  /**
   * Shared by the self-check and the sweep, because they learn the same fact at different times and
   * in different shapes — see `WardenSupervisionState`. It starts unarmed, so a boot that fails
   * before the timer is armed reports a daemon that supervises nothing, which is what it is.
   */
  const wardenSupervision: WardenSupervisionState = {
    armed: false,
    armedAtMs: undefined,
    intervalMs: 0,
    lastSweepAt: undefined,
  };
  const tmux = new BunTmuxProcess(Bun.which('tmux') ?? FALLBACK_TMUX, join(paths.home, 'tmux.sock'));
  const stateFiles = new StateFileSystem(paths);
  // The login window is created before a state home is opened, while browser sessions are created
  // from that opened home. Keep the callback live so a human login always closes the real workers
  // that currently hold the shared profile rather than racing their lease.
  let closeAgentBrowsers: () => Promise<void> = async () => undefined;
  const daemonConfigMutations = new KeyedSerialExecutor();
  /**
   * THE OPERATOR PASSWORD'S VERIFIER, held once for this daemon, read by three collaborators.
   *
   * The grant subsystem asks it whether a candidate matches, the boot disclosure asks whether one
   * exists, and PAIRING asks the same question before it hands out a code. Hoisted so all three ask
   * ONE object about one file: the class is stateless and a second instance would answer identically
   * today, but "how many places read this fact" is exactly the question that goes wrong later, and
   * this is the fact that decides whether a new device may exist. Nothing here can read a password —
   * see `FileOperatorPassword` for why that is structural rather than a convention.
   */
  const operatorPassword = new FileOperatorPassword(paths.operatorPassword, stateFiles);
  const stateHomeDaemonConfigStore = new FileDaemonConfig(paths, stateFiles);
  /**
   * What this machine has agreed a caller who is NOT on it may do.
   *
   * Built from the SAME configuration document `--print-config` reports, so the grants an operator
   * reads and the grants the authorization boundary enforces are one value rather than two. The
   * password verifier is deliberately NOT in that document — it lives in its own mode-0600 file under
   * `state`, because the configuration document is the one that travels into backups and screen
   * shares.
   *
   * HOISTED, because ONE service has to answer for two things: the boundary's per-request decision,
   * and the fleet's per-change confirmation. A second instance would keep a second wrong-password
   * ledger, so five wrong guesses at the fleet panel and five at the grants panel would be ten — the
   * exact per-surface budget `UnlockAttemptState` is keyed per daemon to prevent.
   */
  const grants = new CapabilityGrantService({
    document: new ConfigGrantDocument(stateHomeDaemonConfigStore, daemonConfigMutations),
    passwords: operatorPassword,
    tokens: new RandomUnlockTokens(),
    clock: new SystemGrantClock(),
    audit: new JournalGrantAudit(paths.grantAudit, stateFiles),
    clientName: CLIENT_NAME,
  });
  // An operator's own document when they named one, and the state home's otherwise. The confined
  // filesystem port refuses every path outside the home, which is right for the daemon's own state
  // and wrong for a file a person named, so the two are different adapters.
  //
  // Hoisted out of the world literal because the secret subsystem reads the same document for its
  // `secretEnvironment` recipes. Two stores over one file would be two opinions about what the
  // operator wrote — and the one the UI showed would not be the one a spawned child got.
  const daemonConfigStore =
    overrides.configFile === undefined ? stateHomeDaemonConfigStore : new ExplicitDaemonConfig(overrides.configFile);
  // Read per call, not captured: an operator editing `config/daemon.json` sees the effect on the
  // next use rather than after a restart, and a document that has become unreadable answers no
  // recipes rather than the last good ones — a stale recipe is a reference resolved against a rule
  // that is no longer written down.
  const secretRecipes = new ConfigSecretRecipes(async () => {
    const peeked = await daemonConfigStore.peek().catch(() => undefined);
    return peeked?.config.secretEnvironment ?? {};
  });
  // The vault, and the two things allowed to open it. `directory` is management only — it is what a
  // route is handed, and it has no method that returns a value. See `lib/secrets/vault.ts`.
  const secretDocuments = new FileSecretDocumentStore(paths, stateFiles);
  const secretCipher = new WebCryptoSecretCipher(new FileSecretKey(secretDocuments.keyFile, stateFiles));
  const secretVault = new SecretVault(secretDocuments, secretCipher);
  const secrets: SecretSubsystem = {
    directory: new SecretDirectory(secretDocuments, secretCipher, clock),
    references: secretRecipes,
    uses: new SecretUseService(secretVault, new BunSecretChildRunner(), secretRecipes),
  };
  // Everything an operator reads back is scrubbed of every value this daemon holds, so a secret a
  // child printed is a mask by the time anybody sees it. Read `lib/secrets/redaction.ts` for what
  // that does and does not promise — in particular that a value an agent deliberately transformed is
  // not recognisable, and this is not a defence against one that is trying.
  const secretRedactor = new SecretRedactor(secretVault);
  // ONE executor for every task board in the process. The file store keys its transactions on the
  // snapshot path, so a single shared executor serializes writes PER BOARD; giving each store its own
  // would let two concurrent requests to the same board interleave read-modify-write and lose one.
  const taskBoards = new TaskBoardSerialExecutor();
  // Its own executor: a learning verdict must not queue behind a task board's transaction, and the
  // two snapshots share no file.
  const learningBoard = new TaskBoardSerialExecutor();
  // ONE executor for the callsign ledger. It is what makes a claim atomic across concurrent starts:
  // the read-modify-write of that one file must never interleave with another start's.
  const callsignClaims = new KeyedSerialExecutor();
  // ONE executor for every session mutation in the process, shared by every lifecycle service built
  // per request. Session work gets its own rather than borrowing storage's: a start holding a
  // half-launched pane must not make every unrelated document write wait behind it.
  const sessionMutations = new KeyedSerialExecutor();
  /**
   * Fleet resource limits: the three collaborators both halves of the feature share.
   *
   * ONE DOCUMENT, ONE HOST, ONE COMMAND RUNNER, and two callers — the launch below, which decides
   * the argv a pane execs, and the settings subsystem further down, which reports and applies. They
   * are separate objects because they need different things (only the settings side reads live
   * placements), and they cannot disagree because every number either one uses is derived by
   * `src/lib/cgroups` from these same three.
   *
   * THE HOST IS MEASURED ONCE. A machine does not grow CPUs while a daemon runs, and reading it per
   * request would let the effective limit the panel displays differ from the property the next
   * launch writes.
   */
  const cgroupConfigStore = new FileCgroupConfigStore(stateFiles, paths);
  const cgroupHost = hostCgroupFacts();
  // Bounded. Both callers hold the session lifecycle's barrier while this runs, so a user manager
  // that accepts a connection and never answers would otherwise stall every session start, stop and
  // resume in the daemon for as long as it stayed silent.
  const cgroupCommands = new SpawnCgroupCommands();
  const sessionSpawnFacts = new FileSessionSpawnFacts(stateFiles, paths);
  const cgroupLaunchPlanner = new CgroupLaunchPlanner({
    store: cgroupConfigStore,
    host: cgroupHost,
    commands: cgroupCommands,
    sessions: sessionSpawnFacts,
    // A nonce per launch, from the same source as every other unguessable value here, so a relaunch
    // cannot collide with a scope that is still deactivating.
    nonce: () => crypto.randomUUID().slice(0, 8),
  });
  /**
   * The routing catalog, with its ONE refusal restated in a taxonomy `src/lib` may name.
   *
   * `FileRoutingCatalog` deliberately has no default — the catalog IS the routing doctrine — so an
   * absent or malformed one throws, naming the file to write. Wrapping the PORT rather than the whole
   * advisor call is what keeps that refusal separable from a genuine defect: only a failure to read
   * the catalog becomes `unconfigured`, and anything the recommender itself gets wrong still surfaces
   * as the internal error it is.
   */
  const routing: RoutingCatalogPort = {
    catalog: async () => {
      const catalog = new FileRoutingCatalog(stateFiles, paths.routingCatalog);
      try {
        return await catalog.catalog();
      } catch (error) {
        throw new RecommendError('unconfigured', error instanceof Error ? error.message : String(error));
      }
    },
  };
  /** The published fleet, read fresh on every call. ONE inventory for the whole process: the
   *  recommender's advice and a start's account resolution must not disagree about what the fleet is. */
  const accounts = new ManifestAccountInventory(stateFiles, paths.fleetManifest);
  /**
   * What this host can actually run: a published wrapper by its path, a harness command by name.
   *
   * `PATH` is read at the point of the lookup rather than left to the default, which is resolved once
   * per process: a daemon whose environment gains a harness after it booted must see the harness this
   * host has now, not the one its startup environment happened to hold. The wrapper half never
   * consults `PATH` at all — a daemon under a service manager inherits no shell profile, so the
   * fleet's bin directory is routinely absent from it while the wrappers are perfectly present.
   *
   * Declared BEFORE the fleet mount because three things now read it and they must read the same one:
   * the boot preflight, the doctor report, and the account form's harness discovery. Two resolvers
   * would be two answers to "is Claude Code installed here", and the form's answer is the one a person
   * would then act on.
   */
  const executables: ExecutableResolverPort = {
    resolve: name => Bun.which(name, { PATH: process.env.PATH }) ?? undefined,
    runnable: path => {
      try {
        accessSync(path, fsConstants.X_OK);
        // A DIRECTORY PASSES THE EXECUTE CHECK on every POSIX host — that bit means "may be entered"
        // there, not "may be run" — so the file half is asked separately. It matters now that a
        // declared search directory produces candidates: `<dir>/claude` being a directory would
        // otherwise be reported as the harness, with an absolute path that could never launch.
        return statSync(path).isFile();
      } catch {
        return false;
      }
    },
  };
  /**
   * ONE fleet mount for this daemon, held as a local because two things now read quota through it:
   * the admin route that answers `GET /v1/fleet/usage`, and the usage feed every session, the
   * advisor, quota-failover and every scraper read. A second mount would assemble a second collector,
   * and the two would eventually disagree about whether an account has quota left — which is the one
   * thing `buildFleetUsageCollector` exists to prevent.
   *
   * The platform and the keychain account are read here because this is the only place allowed to
   * touch the environment; the mount takes them as values so a test can drive either platform.
   */
  const fleet = createDaemonFleetSubsystem({
    paths,
    userHome: homedir(),
    clock: millisecondClock,
    files: stateFiles,
    platform: process.platform,
    keychainAccount: process.env.USER ?? '',
    // Identity is minted here for the same reason everything else is: this is the only place
    // allowed to reach for randomness, and a proposal handle or an account id derived from a clock
    // would be guessable by anyone who knew roughly when it was made.
    mintId: () => crypto.randomUUID().replaceAll('-', '').slice(0, 22),
    mintUuid: () => crypto.randomUUID(),
    // The per-change confirmation, routed to the ONE grant service this daemon has. A closure rather
    // than the service itself, so the mount is given the ability to ask "was this password right"
    // and nothing else — it cannot read a grant, mint an unlock, or move the password.
    confirmChange: async password => await grants.confirmChange(password),
    clientName: CLIENT_NAME,
    // The same pinner the session file surface uses. A platform that cannot hand an open descriptor
    // to a path-only API fails here rather than falling back to a name that can be re-pointed.
    rootPinner: sessionRootPinner(),
    /**
     * What the account form fills itself in from: the same `PATH` resolver the preflight uses, this
     * host's real harness homes, and a reader that may leave the state home to see them.
     *
     * Assembled per call rather than captured once, because every one of those facts can change while
     * this daemon runs — somebody installs Claude Code, or edits the model in their settings — and a
     * form that showed the state at boot would be confidently wrong for exactly the person who just
     * fixed it. The ceiling comes from the asset rules so a document too large to be written is never
     * offered as though it could be.
     */
    harnesses: {
      report: async () =>
        await readHarnessDiscovery({
          layouts: harnessHomeLayouts(homedir()),
          executables,
          documents: new NodeHarnessHomeDocuments(),
          maxDocumentBytes: MAX_ASSET_FILE_BYTES,
        }),
    },
  });
  /**
   * Driving a harness's own sign-in from a browser, holding no token.
   *
   * IT READS THE FLEET THROUGH THE FLEET SUBSYSTEM, two methods wide. `config` and `accounts` are
   * already its public surface, so nothing here re-implements configuration or manifest loading, and
   * this service cannot propose a change, apply one, or write an asset.
   *
   * IT GETS ITS OWN CREDENTIAL STORE, and that is deliberate rather than a missed reuse: the usage
   * probe's store exists to hand a bearer token to a provider call, and this one exists to CLASSIFY and
   * to CLONE. The store is stateless and constructed from injected facts, so two instances cannot
   * disagree; sharing one would only couple two unrelated reasons for holding it.
   *
   * IT IS GIVEN THIS PROCESS'S ENVIRONMENT, which the service sanitizes before any child sees it. A
   * login started from inside an agent session must not inherit that session's provider credentials, or
   * the sign-in for account B authenticates against account A's key.
   *
   * THE CONFIRMATION IS THE SAME CLOSURE THE FLEET TAKES, routed to the one grant service this daemon
   * has, so the attempt a wrong password spends is one of the same five an unlock spends.
   */
  const harnessLogin = new HarnessLoginService({
    fleet,
    credentials: new PlatformFleetCredentialStore({
      platform: process.platform,
      command: new SpawnCredentialCommand(),
      now: () => millisecondClock.now(),
      keychainAccount: process.env.USER ?? '',
    }),
    clock: millisecondClock,
    mintId: () => crypto.randomUUID().replaceAll('-', '').slice(0, 22),
    spawn: spawnHarnessLoginChild,
    environment: process.env,
    readWrapper: readFleetWrapperScript,
    timer: harnessLoginTimer,
    confirmChange: async password => await grants.confirmChange(password),
    clientName: CLIENT_NAME,
  });
  /** One advisor per usage feed. The inventory and the catalog are the same for every caller; only
   *  how spent each account is depends on whether the caller asked for a live probe. */
  const advisorOver = (usage: UsageFeedPort): TeamAdvisor => new TeamAdvisor(accounts, routing, usage);
  /** Session ids, minted before the plan that shapes the session they name. */
  const sessionIds = new TimeSessionIdFactory();
  /** The shape of one session. ONE planner for the process: the model a start records and the window
   *  a later read reports must come from the same decision. */
  const planner = new SessionPlanner({
    startWait: defaultStartWaitPolicy,
    contextWindowOverrides: {},
    namePrefix: DAEMON_NAME,
    remoteControlPrefix: DAEMON_NAME,
  });
  /** SHA-256 hex, matching the digest the protocol client computes over the very same body text. */
  const payloadDigests: PayloadDigestPort = {
    hex: payload => createHash('sha256').update(payload, 'utf8').digest('hex'),
  };
  /**
   * The per-session credential and the file it is delivered through.
   *
   * ONE store instance for the whole process, shared by the lifecycle that writes an environment and
   * the launcher that reads it back — two stores over the same layout would be two answers to "what
   * is this session's secret" the moment either one changed.
   */
  const sessionCredentials = new NodeSessionCredentialIssuer();
  const sessionEnvironments = new FileSessionEnvironmentStore(id => createSessionPaths(paths, id).directory);
  // ONE durable owner for every irreversible pane effect in this daemon. Lifecycle turn delivery
  // and runtime controls deliberately share it so neither can mint a second replay vocabulary.
  const sessionEffects = new FileSessionEffectLedger(id => createSessionPaths(paths, id).directory);
  /**
   * The rollout index, shared by the start that records a Codex baseline and the resolver that
   * later correlates against it — one reader of one home, so the two halves cannot disagree about
   * what was there.
   */
  const codexRollouts = new NodeCodexRolloutIndex();
  /**
   * Transcript provenance, taken at creation.
   *
   * `process.env` is the environment this daemon will launch the wrapper with, which is what a
   * `$HOME` in the wrapper's declared harness home expands against. `crypto.randomUUID` mints the
   * Claude session id, because the harness's own id space is UUIDs and the daemon has to name one
   * the harness will accept.
   */
  const transcriptProvenance = new TranscriptProvenanceCapture(
    new FileHarnessWrapperSource(),
    { next: () => crypto.randomUUID() },
    codexRollouts,
    process.env,
  );
  /**
   * The parsers, held as a local so `world.transcripts` and the per-storage reader below are the
   * SAME two sources. A second construction would be a second answer to "how is a Claude record
   * normalized" the moment either one changed.
   */
  const claudeTranscriptParser = new ClaudeTranscriptParser();
  const codexTranscriptParser = new CodexTranscriptParser();
  const transcriptSources = [
    new NodeTranscriptSource(claudeTranscriptParser),
    new NodeTranscriptSource(codexTranscriptParser),
  ];
  /**
   * A separate read surface for conversations that existed before Ferretry.
   *
   * It shares the exact parser instances used by managed sessions, but its filesystem capability
   * has no mutation method and it is deliberately not backed by the session store: a foreign JSONL
   * has neither a Ferretry journal nor a live pane and must never be presented as resumable.
   */
  const foreignHistory = new ForeignHistoryImporter(new NodeForeignHistoryFiles(), foreignHistoryRoots(), {
    claude: claudeTranscriptParser,
    codex: codexTranscriptParser,
  });
  /**
   * A session's own transcript, over the provenance its start recorded.
   *
   * Per opened storage because both halves read documents: the resolver reads the provenance record
   * and writes back the rollout it correlates, and the claims reader has to see every other
   * session's attribution to keep two sessions from claiming one file.
   */
  const createTranscriptFileResolver = (storage: DaemonStorage): TranscriptFileResolver => {
    const resolver = new SessionTranscriptResolver(
      codexRollouts,
      new StorageTranscriptClaims(storage),
      new StorageTranscriptProvenanceStore(storage),
      clock,
    );
    return {
      file: async sessionId => {
        const id = tryParseSessionId(sessionId);
        if (id === undefined) return undefined;
        const config = await storage.readConfig(id).catch(() => undefined);
        return await resolver.file(sessionId, storedTranscriptProvenance(config));
      },
    };
  };
  const createTranscriptReader = (storage: DaemonStorage): SessionTranscriptReader =>
    new SessionTranscriptReader(
      transcriptSources,
      createTranscriptFileResolver(storage),
      new StorageTranscriptDigestJournal(storage),
    );
  /**
   * One addressable-message read under the provenance that resolution just completed.
   *
   * ORDER IS THE CONTRACT. The resolver may discover a Codex rollout and persist that attribution,
   * so the configuration read must happen after it. Only the completed record's incarnation and
   * provenance become token context, and only then does `portableRowsFromFile` perform the one
   * transcript-byte read. Calling `portableRows` here would go through the resolver again and make
   * the bytes and the context answers from two independently moving resolution steps.
   */
  const createSessionTranscriptMessageSource = (storage: DaemonStorage): OperatorMessageSource => {
    const resolver = createTranscriptFileResolver(storage);
    const reader = new SessionTranscriptReader(
      transcriptSources,
      resolver,
      new StorageTranscriptDigestJournal(storage),
    );
    return {
      read: async sessionId => {
        const id = tryParseSessionId(sessionId);
        if (id === undefined) return { kind: 'unresolved' };
        const file = await resolver.file(sessionId).catch(() => undefined);
        if (file === undefined) return { kind: 'unresolved' };

        const config = SessionConfigSchema.safeParse(await storage.readConfig(id).catch(() => undefined));
        if (!config.success || config.data.id !== sessionId) return { kind: 'unreadable' };
        const provenance = config.data.transcript;
        if (provenance === undefined || provenance.identity === 'undiscovered' || provenance.file !== file)
          return { kind: 'unresolved' };

        const rows = await reader
          .portableRowsFromFile({ sessionId, harness: config.data.harness }, file)
          .catch(() => undefined);
        if (rows === undefined) return { kind: 'unreadable' };
        return {
          kind: 'read',
          context: { sessionId, incarnation: config.data.incarnation, provenance },
          rows,
        };
      },
    };
  };
  /**
   * The same transcript read, for an operator who asked to SEE it.
   *
   * It reports RESOLUTION separately from content, over the one resolver the reader itself uses, and
   * that difference is the whole reason it exists. `SessionTranscriptReader` answers an unresolved
   * session with an empty batch on purpose — a question watcher must not fail an operation over
   * missing evidence — but `fy logs` handing a human a blank page tells them the agent said nothing,
   * which is a claim the daemon has no basis for. So the file is resolved first and its absence is
   * reported as an absence; only a file this daemon can prove is the session's own is ever read.
   */
  const createSessionTranscriptTail = (storage: DaemonStorage): SessionTranscriptTail => {
    const resolver = createTranscriptFileResolver(storage);
    return {
      tail: async (sessionId, limit) => {
        const file = await resolver.file(sessionId).catch(() => undefined);
        if (file === undefined) return { kind: 'unresolved' };
        const id = tryParseSessionId(sessionId);
        if (id === undefined) return { kind: 'unresolved' };
        const config = SessionConfigSchema.safeParse(await storage.readConfig(id).catch(() => undefined));
        if (!config.success) return { kind: 'unresolved' };
        const harness = config.data.harness === 'codex' ? 'codex' : 'claude';
        const source = transcriptSources.find(candidate => candidate.harness === harness);
        if (source === undefined) return { kind: 'unreadable' };
        const batch = await source.read(file, { sessionId }).catch(() => undefined);
        if (batch === undefined) return { kind: 'unreadable' };
        return { kind: 'read', events: batch.events.slice(-limit) };
      },
    };
  };
  /**
   * A finished session's whole transcript, read once, for the analytics token total.
   *
   * It is a SEPARATE read from `createSessionTranscriptTail` because the two want opposite things:
   * a tail wants the last few events and does not care what it skipped, while a bill has to account
   * for every request the session made. This one therefore reports how the read ENDED — the issues
   * raised and the bytes still pending — so the fold can refuse a total it cannot prove complete
   * instead of returning a smaller number that looks like a cheaper session.
   *
   * The parsed events are NOT retained. The subsystem memoizes the small folded total instead, so a
   * transcript's bytes live only as long as the fold that consumes them; holding the event list per
   * session is how a daemon with a busy fleet runs itself out of memory.
   */
  const createAnalyticsTranscriptEvidence = (storage: DaemonStorage): AnalyticsTranscriptEvidenceSource => {
    const resolver = createTranscriptFileResolver(storage);
    return {
      evidenceFor: async (sessionId, harness) => {
        const file = await resolver.file(sessionId).catch(() => undefined);
        if (file === undefined) return { kind: 'unresolved' };
        const source = transcriptSources.find(candidate => candidate.harness === harness);
        if (source === undefined) return { kind: 'unreadable' };
        const batch = await source.read(file, { sessionId }).catch(() => undefined);
        if (batch === undefined) return { kind: 'unreadable' };
        return {
          kind: 'read',
          harness,
          events: batch.events,
          issues: batch.issues.map(issue => issue.code),
          pendingBytes: batch.cursor.pendingBytes,
        };
      },
    };
  };
  /** The lifecycle factory, held as a local so the mounted subsystems get the same one the world
   *  publishes rather than a second construction that could drift from it. */
  const createSessionLifecycle: DaemonWorld['createSessionLifecycle'] = (storage, launcher, envelope, id) =>
    new SessionLifecycleService(
      {
        repository: new StorageSessionLifecycleRepository(storage, envelope),
        launcher,
        tasks: new FileSessionTaskStore(taskId => createSessionPaths(paths, taskId).directory),
        effects: sessionEffects,
        directories: new NodeWorkingDirectoryResolver(),
        // EVERY session gets a credential, not only one that asked for board access: the board
        // domain keys `TaskBoardSession` on this hash, so a session minted without one could never
        // be invited to a board later. Holding a credential is identity; a grant is authority, and
        // the two are separate records.
        credentials: sessionCredentials,
        environment: sessionEnvironments,
        // A caller that has already minted the id hands it over, so the plan and the record cannot
        // disagree about which session they describe.
        ids: id === undefined ? sessionIds : { next: () => id },
        clock,
        // ONE queue for every service this process builds: a per-service executor would let a stop
        // and a retried start of the SAME session interleave, and the loser's write would overwrite a
        // live session's record. The service is per request; the serialization is not.
        serial: sessionMutations,
      },
      defaultSessionLifecycleSettings,
    );
  /**
   * The pane a revive replaces, over the daemon's own private tmux socket.
   *
   * The launch spec is PARSED, not asserted: a revive addresses a real terminal and runs a real
   * command, so a configuration document that no longer validates must refuse rather than launch
   * something else. It travels through the same document mapping the lifecycle repository writes, so
   * the executable is recovered from the argv the start recorded.
   */
  const lastSnapshots = new FileLastSnapshotStore(id => {
    const parsed = tryParseSessionId(id);
    if (parsed === undefined)
      throw new Error(`cannot store a final frame for unusable session id ${JSON.stringify(id)}`);
    return createSessionPaths(paths, parsed).lastSnapshot;
  });
  const createResumeLauncher = (storage: DaemonStorage): ResumeLauncher => {
    const controller = new TmuxController(new BunTmuxProcess(resolveTmuxExecutable(), join(paths.home, 'tmux.sock')));
    const registrar = new DurableTerminalPaneRegistrar(paths.home, controller, stateFiles, paths);
    return new TmuxResumeLauncher(
      controller,
      async id => {
        const raw = await storage.readConfig(id);
        const config = SessionLifecycleConfigSchema.parse(lifecycleConfigDocument(raw));
        // A recorded `--session-id` CREATES a harness session, so re-running it verbatim would ask
        // the harness for an id it already has. The transcript the start named is the harness's own
        // record of having created it, so its existence decides between creating and resuming.
        const transcript = storedTranscriptProvenance(raw)?.file;
        const started = transcript !== undefined && (await Bun.file(transcript).exists());
        return {
          tmuxSession: config.tmuxSession,
          cwd: config.cwd,
          command: relaunchCommand(config.command, started),
          // The SAME store the launch path reads, for the same reason it reads it per launch: a
          // replacement pane must carry the session's CURRENT environment. Read here rather than
          // captured at construction, and merged with the derived session id by the launcher.
          env: await sessionEnvironments.read(id),
        };
      },
      new TmuxPaneDelivery(controller, milliseconds => Bun.sleep(milliseconds)),
      lastSnapshots,
      // The SAME planner initial startup uses: a replacement pane is a new launch and must receive
      // the configuration saved immediately before it, without restarting this daemon.
      cgroupLaunchPlanner,
      registrar,
    );
  };
  /**
   * The launch path's controller, held as a local so the launcher and its delivery adapter address
   * the SAME tmux server. Two controllers over the same socket would work; one is what makes it
   * impossible for a future edit to point delivery at a different pane than the launch created.
   */
  const launchTmux = new TmuxController(new BunTmuxProcess(resolveTmuxExecutable(), join(paths.home, 'tmux.sock')));
  /**
   * The per-harness workarounds, held as a local because TWO things read them: the world publishes
   * it, and the runtime-control subsystem below plans every switch through it. A second construction
   * would give the control path its own picker cleanup, so the recovery that runs after a failed
   * drive would not be the one this daemon declared.
   */
  const harnessService = new HarnessQuirkService(
    new CodexPickerCleanup(
      // The picker pane goes through the same private-socket process port as every
      // other tmux touch: cleanup sends keys, so reaching the host's default
      // server would be sending them into somebody else's terminal.
      new TmuxCodexPickerPane(tmux),
      { sleep: milliseconds => Bun.sleep(milliseconds) },
    ),
    // The instruction a quarantined session shows a human names the CLI they
    // actually type, not this daemon — `fyd resume` is not a command. The daemon
    // cannot read the CLI package without depending on it, so the name is a
    // constant here, as it already is everywhere the daemon quotes a `fy`
    // command.
    CLIENT_NAME,
  );
  /**
   * ONE held Codex catalog for the whole daemon.
   *
   * The probe is an ephemeral second speaker to a live account, so opening the model sheet twice must
   * not start two of them — and a per-subsystem cache would do exactly that. The probe itself runs
   * the account's OWN executable in the session's OWN directory, which is what makes its answer the
   * list that account's picker will render.
   */
  /**
   * ONE stamper for this world, hoisted so the subsystem factory below can close over it.
   *
   * It is a world field as well, but `createSubsystems` is a positional callback that receives
   * neither the world nor its siblings — so a start and a revive would otherwise each have to build
   * their own, and two stampers reading two clocks is two answers to "when did this session begin".
   * The start decides the stamp at create and the revive re-stamps through it; both go through this.
   */
  const spawnProvenance = new SessionProvenanceStamper(clock);
  const codexRuntimeModels = new CodexRuntimeCatalogCache((binary, cwd) =>
    new CodexAppServerCatalog({ clientName: DAEMON_NAME, clientVersion: daemonVersion }).models(binary, cwd),
  );
  /**
   * ONE launch gate and ONE turn store for every path that relaunches or hands over a turn.
   *
   * The gate is a process-wide ledger of launches in flight, and its whole value is that a caller
   * arriving mid-bootstrap WAITS instead of fighting for the same terminal name — which a second gate
   * would not know to do, because it would see no launches at all. The turn store owns the numbered
   * turn document and the exact set of markers a relaunch clears; a second one is how the revive and
   * the send drift until a marker one writes is one the other does not clear.
   */
  const launchGate = new InMemoryLaunchGate(milliseconds => Bun.sleep(milliseconds));
  const resumeTurns = new FileResumeTurnStore(id => createSessionPaths(paths, id).directory);
  /** The resume factory, held as a local for the same reason `createSessionLifecycle` is: the mounted
   *  subsystems must get the same one the world publishes rather than a second construction. */
  const createSessionResume: DaemonWorld['createSessionResume'] = (storage, launcher, answerAttention, serial) =>
    new SessionResumeService(
      {
        repository: new StorageResumeRepository(storage),
        launcher,
        answerAttention,
        turns: resumeTurns,
        monitors: new NoMonitorSupervision(),
        gate: launchGate,
        // The session's OWN answer/monitor queue, not a private one: a dismissal must hold it from
        // the old pane's release through the durable acknowledgement to the final clear, or a
        // projection publishes a newer advisory into the middle of it. See the port's own field.
        serial,
      },
      defaultSessionResumeSettings,
    );
  const browserTransport: BrowserTransportWorld = {
    connectWorker: options => BrowserWorkerClient.connect(options),
    openViewerStream: (host, sessionId, socket) =>
      BrowserViewerStream.connect(host, sessionId, new SocketViewerDownstream(socket), new SystemFrameClock()),
  };
  return {
    role: packageRole,
    storage: new DaemonStorageFactory(
      environment,
      new StateFileSystemFactory(),
      new StateHomeLayout(),
      new SqliteHomeLockFactory(),
      new BunSqliteIndexFactory(),
      clock,
      () => new KeyedSerialExecutor(),
    ),
    analyticsIndexes: new BunSqliteAnalyticsStoreFactory(),
    worktrees: new ManagedWorktreeAdapter(
      gateway,
      files,
      worktreeClock,
      new WorktreeOperationQueue(),
      sessionRootPinner(),
    ),
    boot: {
      probe: new DaemonHealthProbe({ fetch: (url, init) => fetch(url, init) }),
      binder: new DaemonBinder({ sleep: milliseconds => Bun.sleep(milliseconds) }, { now: () => Date.now() }),
      preferredPort: FY_DEFAULT_DAEMON_PORT,
    },
    // An operator's own document when they named one, and the state home's otherwise. The confined
    // filesystem port refuses every path outside the home, which is right for the daemon's own state
    // and wrong for a file a person named, so the two are different adapters.
    config: daemonConfigStore,
    // The same verifier the grant service and the pairing mint ask. Reading it here creates nothing.
    operatorPassword,
    overrides,
    stateHome: { path: paths.home, fromEnvironment: (environment.stateHomeInput().fyHome ?? '').trim() !== '' },
    // The SAME two collaborators a start resolves an account from, so the preflight cannot report
    // one answer while a launch gives another.
    harnesses: { accounts, executables },
    notices: bootJournal(overrides.logLevel),
    secrets: new DaemonSecretsLoader(
      new BunSecretShell({
        source: file => {
          const child = Bun.spawnSync({
            cmd: ['/bin/sh', '-c', daemonSecretSourceProgram, 'fyd-secrets', file, process.execPath],
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'ignore',
            timeout: 5_000,
            maxBuffer: 1_024 * 1_024,
          });
          return { success: child.success, stdout: child.stdout.toString() };
        },
      }),
      { set: (key, value) => (process.env[key] = value) },
    ),
    migratePreflight: new MigrationPreflight(
      new PaneProcessInventory(tmux, new BunProcessProbe(Bun.which('ps') ?? undefined)),
      new TmuxPaneSnapshot(tmux),
    ),
    wardenReports: stateDirectory => new WardenReportReader(wardenFiles, createWardenPaths(stateDirectory).reports),
    browserTransport,
    sessionLauncher: new TmuxSessionLifecycleLauncher(
      // A private absolute socket inside the state home is what keeps managed panes off any
      // tmux server the host already runs.
      launchTmux,
      new TmuxPaneDelivery(launchTmux, milliseconds => Bun.sleep(milliseconds)),
      // The pane is handed its own credential — and its own session id, which is what lets a
      // teammate attribute a message to itself — through `tmux -e`, never through argv: argv is
      // world-readable on this host through /proc, and the fleet wrappers read the values from their
      // environment anyway.
      sessionEnvironments,
      new DurableTerminalPaneRegistrar(paths.home, launchTmux, stateFiles, paths),
      lastSnapshots,
      // What makes the resource-limit settings a capability rather than a stored preference: the
      // compiled daemon's own launch path asks, per pane, whether this session runs inside a
      // scope. Supervision and this daemon are never wrapped — see `lib/cgroups/exemption.ts` and
      // the planner's header — and a launch with limits off is byte-for-byte what it always was.
      cgroupLaunchPlanner,
    ),
    createSessionLifecycle,
    createTerminalReaper: storage => {
      const store = new DurableTerminalPaneStore(storage, stateFiles, paths);
      const runtime = new ExactTmuxPaneReaper(launchTmux);
      return new TerminalReapService(
        paths.home,
        { list: daemonId => store.registrations(daemonId) },
        { list: daemonId => store.sessions(daemonId) },
        runtime,
        runtime,
      );
    },
    createSessionHealth: (storage, settings) =>
      new SessionHealthService(
        {
          inventory: new StorageSessionHealthInventory(storage, {
            monitors: false,
            // Read from the holder rather than hardcoded: a sweep timer IS armed now, and reporting
            // `false` beside a running one would make a late sweep indistinguishable from a missing
            // subsystem — the distinction this flag exists to make.
            get warden() {
              return wardenSupervision.armed;
            },
            monitored: () => false,
            get sweepIntervalMs() {
              return wardenSupervision.intervalMs;
            },
            armedAtMs: () => wardenSupervision.armedAtMs,
            lastSweepAt: () => wardenSupervision.lastSweepAt,
            // Boot state is owned by `start`; until it reports otherwise a booted daemon that
            // reached this point has finished the storage bootstrap it does have.
            bootstrapFinished: () => true,
            bootstrapErrors: () => [],
          }),
          consistency: new StorageConsistencyPass(storage, stateFiles, paths, settings),
          repair: new UnmountedSupervisionRepair(),
          events: new FileSessionHealthEventSink(stateFiles, join(paths.home, 'health-events.jsonl'), clock),
          clock,
          wallClock: { nowMs: () => Date.now() },
          monotonic: new SystemMonotonicClock(),
          restarts: new SelfRestartCoordinator(
            new FileSelfRestartStampStore(stateFiles, join(paths.home, 'self-restart.json')),
            // Nothing supervises this process yet, so the honest answer is "no restart happened":
            // the coordinator then un-latches and tells the operator to restart it themselves.
            { restart: async () => false },
            settings,
          ),
          version: pkg.version,
        },
        settings,
      ),
    createResumeLauncher,
    createSessionResume,
    createUsageFeed: async config => {
      // THIS HOST'S OWN COLLECTOR FIRST. Everything downstream of this feed — the advisor,
      // quota-failover, every session's quota block, `/metrics` — used to be answered entirely by
      // whatever external tool the two sources below were pointed at, so the daemon's quota was a
      // runtime dependency of a tool this migration exists to delete. The native source asks the
      // provider directly, through the same collector `GET /v1/fleet/usage` answers with.
      //
      // The external sources are kept BEHIND it rather than deleted: a host part-way through the
      // migration may still be running that tool, and this daemon should keep reporting quota if its
      // own fleet has not been applied yet. Both remain optional, and a daemon configured with
      // neither and no fleet serves an empty feed and says so rather than pretending every account
      // is at zero.
      const command = usageProbeCommand(config.usage.fallbackCommand);
      return new CachedUsageFeed(
        [
          new FleetUsageSource(fleet, accounts),
          ...(config.usage.url === undefined ? [] : [new HttpUsageSource(config.usage.url)]),
          ...(command === undefined ? [] : [new CommandUsageSource(new BunCommandRunner(process.env), command)]),
        ],
        // The fleet's own declared probe interval. A host with no fleet configuration has not asked
        // for a cadence at all, so it keeps the default rather than being given one by a refusal.
        {
          refreshMs: usageRefreshMs(
            await fleet.config().then(
              declared => declared.usage.interval,
              () => undefined,
            ),
          ),
        },
      );
    },
    createPairing: async (config, pairingClock, carriers, discoveredRelayUrl) => {
      const cryptography = new NodePairingCryptography();
      const repository = new StatePairingRepository(paths, stateFiles, cryptography);
      const state = await repository.open(hostname());
      attachmentDaemonId = state.daemonId;
      const credentials = new PairingDeviceRegistry(state.daemonId, cryptography, state.devices);
      // The application-server key pair, minted into the state home on first use and never returned by
      // anything: the transport below is the only holder of the signing half, and the domain above sees
      // the public point alone. See `src/adapters/push/webcrypto-vapid-keys.ts`.
      const vapidKeys = new StateVapidKeys(paths, stateFiles);
      const push = new PushService({
        store: new StatePushRepository(paths, stateFiles),
        keys: vapidKeys,
        transport: new WebPushFetchTransport(vapidKeys),
        // The grant store itself, so "is this device still paired" is answered by the document that
        // decides it rather than by a second list that could disagree with it.
        devices: new PairedPushDevices(repository),
        clock,
        // A push enrolment id is a protocol UUID under a fixed prefix, minted the way a pin id is.
        ids: { next: () => crypto.randomUUID() },
      });
      return {
        credentials,
        push,
        subsystem: new PairingService({
          daemonId: state.daemonId,
          daemonName: state.daemonName,
          // The DECISION, not an address: pairing must be able to say who can redeem what it mints,
          // and a bare `publicUrl` cannot — a default install's is loopback, which on the phone
          // reading its QR names the phone.
          advertisement: config.advertisement,
          carriers,
          // Provenance, not the first entry of `carriers`. The service cannot tell a discovered
          // rendezvous from an operator's own one, and only the first is something the phone reading
          // the QR can find for itself.
          ...(discoveredRelayUrl === undefined ? {} : { discoveredRelayUrl }),
          clock: pairingClock,
          cryptography,
          devices: repository,
          credentials,
          // Revoking a device takes its notifications away in the same act. The purge runs BEFORE the
          // grant is removed — see `PairingService.revokeDevice` for why that order is the safe one.
          deviceState: [push],
          // WHY PAIRING HOLDS THE VERIFIER. A machine with no operator password will not hand out a
          // pairing code, because pairing is the moment access leaves this host and a device paired
          // without one arrives able to configure the fleet. It is the SAME object the grant subsystem
          // verifies against, so the requirement and the gate cannot disagree about whether a password
          // exists. Nothing about local use is gated by it — see `PairingService.mint`.
          operatorPassword,
          // So the refusal names the command a person actually types rather than inventing one.
          clientName: CLIENT_NAME,
        }),
      };
    },
    sessions: planner,
    provenance: spawnProvenance,
    harness: harnessService,
    transcripts: {
      sources: transcriptSources,
      search: (events, query, options) => searchTranscript(events, query, options),
    },
    api: new BunApiServer(),
    // The daemon's OWN private socket, never the host's default: a terminal must not land on a tmux
    // server something else on this machine already runs.
    terminalRuntime: new TmuxTerminalRuntime(tmux, () => Date.now()),
    createSocketTickets: () => new SocketTicketRegistry({ now: () => Date.now() }, new NodeSocketTicketSecrets()),
    relayDirectory: new HostedRelayDirectory(environment.relayDirectoryOrigin()),
    createRelayCarriers: async (sources, dispatch, sockets, devices, pairing) => {
      const dialledSources = sources.filter(
        (source): source is Exclude<RelayCarrierSource, { readonly kind: 'direct-only' }> =>
          source.kind !== 'direct-only' && source.config.enabled,
      );
      if (dialledSources.length === 0) return { carriers: [] };
      // The key is the one PAIRING minted, read through the path both subsystems now share. A relay
      // identity of its own would carry a different fingerprint from the one in the pairing QR, and
      // every paired browser pins that one — so it would refuse the handshake, correctly, forever.
      const identity = await readDaemonRelayIdentity(
        stateFiles,
        paths.daemonIdentity,
        new WebCryptoRelayIdentityKeys(),
      );
      if (!identity.ok) return { refusal: identity.reason };
      return {
        carriers: dialledSources.map(source => ({
          source,
          carrier: new BunRelayCarrier({
            config: source.config,
            crypto: new WebCryptoRelayCrypto(),
            identity: identity.identity,
            dispatch,
            sockets,
            devices,
            pairing,
          }),
        })),
      };
    },
    browserLogin: createBrowserLoginWorld(paths, async () => await closeAgentBrowsers()),
    createSubsystems: (
      storage,
      terminals,
      usage,
      health,
      launcher,
      reviver,
      preflight,
      browserLogin,
      sttEnhancement,
      catalogs,
      worktrees,
      analyticsStore,
      pairing,
      push,
      carriers,
      socketTickets,
      harnessDiscovery,
    ) => {
      // ONE durable ledger and ONE per-session queue for BOTH answer execution and monitor
      // reprojection. Observation never waits behind a live drive: that drive owns the freshest
      // state, and a later read/tick will project it after the key becomes idle. After a restart
      // there is no holder, so stranded evidence honestly becomes quarantine.
      const answerLedger = new FileAnswerLedger(id => createSessionPaths(paths, id).directory, clock);
      // The answer, its monitor projection, released-advisory resume, and lifecycle mutation share
      // one session key. In particular, a stop that starts after answer keys land must wait for the
      // post-drive state commit; if the stop then records `kill_failed`, no later answer write can
      // resurrect it. Storage keeps its own lower-level queue, so none of these operations re-enters
      // this executor while holding it.
      const answerSerial = sessionMutations;
      // ONE reader for both halves of the session surface: what a start answers with must be the same
      // view the list and the single read serve, parsed by the same schemas from the same documents.
      //
      // TWO PROJECTIONS OVER ONE TAIL, not two reads. The open structured question and the harness's
      // own account of which model it is running are both recovered from the same 400 events, and
      // folding them into one patch is what keeps a session read at one transcript pass. Both are
      // additive over whatever the document already holds, so neither can erase the other's fields.
      const projectSessionEvidence = async (id: SessionId): Promise<void> => {
        await answerSerial.runIfIdle(id, async () => {
          const transcript = await createSessionTranscriptTail(storage).tail(id, 400);
          // A transcript that cannot be proved belongs to this session is not a
          // benign empty transcript.  Leave the durable state untouched: its own
          // parser will make a damaged session read fail rather than inventing an
          // answerable absence from missing evidence.
          if (transcript.kind !== 'read') return;
          const current = SessionStateSchema.safeParse(await storage.readState(id));
          if (!current.success) return;
          const projection = projectStructuredQuestion(transcript.events);
          const answerEvidence = reconcileAnswerEvidence(await answerLedger.all(id), current.data, {
            ...(projection.kind === 'pending' ? { activeToolUseId: projection.question.toolUseId } : {}),
            ...(projection.kind === 'resolved' ? { resolvedToolUseId: projection.toolUseId } : {}),
          });
          for (const settlement of answerEvidence.settlements) await answerLedger.append(id, settlement);
          const answerRecords = [...answerEvidence.records.values()];
          const observedRuntime = projectObservedRuntime(transcript.events);
          const question = structuredQuestionStatePatch(current.data, projection, answerRecords);
          // The model the harness SAID it was using, never the one the session was launched with.
          // Nothing else in the daemon writes these three fields, so every surface that shows a
          // running model — the composer chips, the context window, `fy ls` — is reading this.
          const patch = {
            ...question,
            ...observedRuntimeStatePatch(current.data, observedRuntime),
          };
          if (Object.keys(patch).length === 0) return;
          await storage.updateState(id, raw => {
            const verified = SessionStateSchema.safeParse(raw);
            if (!verified.success) return raw;
            // Recompute under storage's session lock. A lifecycle stop can commit after the
            // transcript read but before this transform; applying the stale patch would otherwise
            // resurrect its `kill_failed` verdict as `awaiting_question`.
            const currentQuestion = structuredQuestionStatePatch(verified.data, projection, answerRecords);
            const currentPatch = {
              ...currentQuestion,
              ...observedRuntimeStatePatch(verified.data, observedRuntime),
            };
            if (Object.keys(currentPatch).length === 0) return raw;
            const next = { ...(raw as Record<string, unknown>), ...currentPatch };
            // Removals belong to the QUESTION projection alone and only when it explicitly names
            // the field. A model observation must never erase a picker or answer quarantine.
            if (Object.hasOwn(currentQuestion, 'pendingQuestion') && currentQuestion.pendingQuestion === undefined)
              delete next.pendingQuestion;
            if (Object.hasOwn(currentQuestion, 'needsHumanKind') && currentQuestion.needsHumanKind === undefined)
              delete next.needsHumanKind;
            if (Object.hasOwn(currentQuestion, 'needsHuman') && currentQuestion.needsHuman === undefined)
              delete next.needsHuman;
            return next as typeof raw;
          });
        });
      };
      // Ordinary reads contain projection damage per session: a broken answer ledger must not take
      // the whole roster down. The monitor calls the raw projector below so it can report the exact
      // failing session instead of silently flattening missing evidence.
      const sessions = createSessionDirectorySubsystem(paths, storage, id =>
        projectSessionEvidence(id).catch(() => undefined),
      );
      // Originals are keyed by this daemon's durable pairing identity even
      // inside its private state home. A plaintext unlock is deliberately not a
      // storage operation: it remains in the store's process-local cache only.
      if (attachmentDaemonId === undefined)
        throw new Error('pairing identity was not opened before attachment mounting');
      // Held as a const so every later reader gets the SAME proven identity: the `let` above is
      // captured by closures, so its narrowing does not survive into one, and a second reader that
      // re-checked could disagree with this one about which daemon's tree it is addressing.
      const attachmentsDaemonId = attachmentDaemonId;
      const attachmentStore = new SessionAttachmentStore({ root: paths.state, daemonId: attachmentsDaemonId });
      const sessionAttachments = {
        upload: async (
          id: string,
          request: { readonly filename: string; readonly mime: string; readonly bytes: Uint8Array },
        ) => {
          if ((await sessions.get(id)) === undefined)
            throw new SessionAttachmentError('not_found', 'session was not found');
          return await attachmentStore.upload(id, request);
        },
        download: async (id: string, attachmentId: string) => {
          if ((await sessions.get(id)) === undefined)
            throw new SessionAttachmentError('not_found', 'session was not found');
          return await attachmentStore.download(id, attachmentId);
        },
        unlock: async (id: string, attachmentId: string, password: string) => {
          if ((await sessions.get(id)) === undefined)
            throw new SessionAttachmentError('not_found', 'session was not found');
          return await attachmentStore.unlock(id, attachmentId, password);
        },
        lock: async (id: string, attachmentId: string) => {
          if ((await sessions.get(id)) === undefined)
            throw new SessionAttachmentError('not_found', 'session was not found');
          return await attachmentStore.lock(id, attachmentId);
        },
      };
      // ONE resume service for this opened storage, shared by the revive and the migration: its
      // executor and its launch gate are what stop two relaunches of one session racing, and a
      // second service would give each caller a private copy of both. See the revive's own header.
      const resume = createSessionResume(
        storage,
        reviver,
        createResumeAnswerAttention(storage, answerLedger),
        // THE ANSWER QUEUE ITSELF, not a private executor. Every writer of structured-answer
        // attention already takes this key — the drives and the quarantine writer through the
        // coordinator, the monitor's reprojection through `runIfIdle` — so handing it to resume is
        // what makes a dismissal atomic against them from the old pane's release to the final clear.
        answerSerial,
      );
      // The session's own voice, over the SAME launcher the revive holds — see the subsystem's header
      // for why a second tmux adapter would misfile the final frame of every completed pane.
      // Hoisted, because the monitor loop below reads the same documents through the same narrowing:
      // a second repository would be a second opinion about what a park on a damaged record means.
      const signalRepository = new StorageSignalRepository(storage, clock);
      const signals = new SessionSignalService({
        repository: signalRepository,
        artifacts: new FileSignalArtifacts(id => createSessionPaths(paths, id).directory, clock),
        terminal: new LauncherSignalTerminal(reviver),
        // Its own queue: a completion holds its lock across writing evidence and retiring a pane, and
        // must not make every unrelated document write in the process wait behind it.
        serial: new KeyedSerialExecutor(),
        clock,
      });
      /**
       * Talking to a session that is already running.
       *
       * THE REVIVER IS THE SAME RESUME SERVICE the revive and the migration hold, not a second one:
       * see `ResumeSendReviver` for why a private copy would be a second launch gate and a second
       * per-session executor, so a send-triggered revive could replace a pane an operator's revive was
       * already replacing.
       *
       * THE PEER-WAIT ENDER IS THE SIGNAL SERVICE ITSELF. Ending a park credits the parked time back
       * against the turn ceiling and re-anchors the activity ledger, which is that slice's own
       * arithmetic; this one only reports that a reply arrived. It is reached AFTER the send releases
       * its own lock, so the two per-session queues can never wait on each other.
       */
      const sends = new SessionSendService(
        {
          repository: new StorageSendRepository(storage, clock),
          ledger: new FileSendLedger(id => createSessionPaths(paths, id).directory, clock),
          terminal: new TmuxSendTerminal(
            launchTmux,
            // PARSED, not asserted: a send types into a real terminal, so a configuration document
            // that no longer validates must refuse rather than address whatever pane it names.
            async id =>
              SessionLifecycleConfigSchema.parse(lifecycleConfigDocument(await storage.readConfig(id))).tmuxSession,
            new TmuxPaneDelivery(launchTmux, milliseconds => Bun.sleep(milliseconds)),
            new TmuxPaneQueue(launchTmux, milliseconds => Bun.sleep(milliseconds)),
          ),
          turns: new FileSendTurnStore(resumeTurns, id => createSessionPaths(paths, id).directory),
          channel: new FileSendChannel(id => createSessionPaths(paths, id).directory),
          gate: launchGate,
          reviver: new ResumeSendReviver(resume),
          peerWaits: signals,
          // Its own queue: a send holds its lock across proving a prompt landed, and must not make
          // every unrelated document write in the process wait behind a live terminal.
          serial: new KeyedSerialExecutor(),
          clock,
        },
        // The receiving agent is told the CLI a human types, not this daemon — `fyd send` is not a
        // command, exactly as the harness quirk service already reasons about `fyd resume`.
        { ...defaultSessionSendSettings, clientName: CLIENT_NAME },
      );
      /**
       * The declared-wait watcher, built LAST among the session slices because it drives two of them.
       *
       * IT ENDS PARKS THROUGH THE SIGNAL SERVICE and wakes teammates through the SEND, rather than
       * writing either itself. Clearing a wait credits the parked time back against the turn ceiling
       * and re-anchors the activity ledger — that is the signal slice's arithmetic, shared with
       * `signal working` and with the peer reply PR #153 landed — and typing into a live pane is the
       * send's, including every refusal it makes about whose composer that pane belongs to.
       *
       * ONE LOOP PER DAEMON, over the sessions of the storage this process opened. Nothing here can
       * name a session in another daemon's state home, so no tick can reach one.
       */
      const monitor = new SessionMonitorService(
        {
          waits: new StorageMonitorWaits(storage, signalRepository, signals, defaultSessionMonitorSettings),
          heartbeats: new FileWaitHeartbeat(id => createSessionPaths(paths, id).directory),
          nudge: new SendMonitorNudge(sends),
          questions: {
            reconcile: async () => {
              const outcomes = await Promise.all(
                storage.listSessions().map(async session => {
                  let failure: string | undefined;
                  try {
                    await projectSessionEvidence(session.id);
                  } catch (error) {
                    failure = error instanceof Error ? error.message : String(error);
                  }
                  return [session.id, failure] as const;
                }),
              );
              const failures = new Map<string, string>();
              for (const [id, failure] of outcomes) {
                if (failure !== undefined) failures.set(id, failure);
              }
              return failures;
            },
          },
          clock,
          wallClock: { nowMs: () => Date.now() },
          // A duration, so it is read off a clock that cannot step: a wall-clock jump would otherwise
          // make an on-time tick look hours late, or a missed one look on time.
          monotonic: new SystemMonotonicClock(),
        },
        defaultSessionMonitorSettings,
      );
      // One collector owns the lifetime counters health reports and the explicit `/v1/gc` surface.
      // It reads through opened storage and observes through the same revive adapter that would
      // replace a pane, so a scratch sweep cannot mistake another tmux server for ours.
      const scratchGc = new FileScratchCollector(
        {
          list: () => storage.listSessions(),
          config: async id => await storage.readConfig(parseSessionId(id)),
          state: async id => await storage.readState(parseSessionId(id)),
          directory: id => createSessionPaths(paths, parseSessionId(id)).directory,
        },
        { alive: async id => (await reviver.observe(parseSessionId(id))).alive },
      );
      const scratch: ScratchReclamation = {
        get enabled() {
          return scratchGc.totals().enabled;
        },
        get reclaimedSessions() {
          return scratchGc.totals().reclaimedSessions;
        },
        get reclaimedBytes() {
          return scratchGc.totals().reclaimedBytes;
        },
      };
      // ONE board world for both callers that reach the board domain: the eight `/v1/task-boards`
      // routes, and the child grant a `--board-access` start requests. Two worlds would give a start
      // its own repository handle over the same document, and the atomicity of `transaction` is what
      // the whole authorization model rests on.
      const boards = createTaskBoardSubsystem(paths, stateFiles, storage, clock, sessionEnvironments, sessionMutations);
      // The warden spawns wardens through the SAME start every other caller uses, so a warden is an
      // ordinary managed session that happens to carry the warden label — which is exactly what the
      // detector's lineage shield reads. A private launch path would produce a session the fleet
      // read could not see and the shield could not recognise.
      const sessionRuntime = new SessionRuntimeControlService({
        /**
         * The durable boundary, as five delegations.
         *
         * A reference arrives as three outcomes rather than two: not an id at all, a well-formed id
         * nobody holds, and a session. The service answers `400` and `404` from that distinction,
         * so collapsing it here would change what these routes already reply.
         */
        repository: {
          find: reference => {
            const id = tryParseSessionId(reference);
            if (id === undefined) return { kind: 'invalid' };
            return storage.findSession(id) === undefined ? { kind: 'missing' } : { kind: 'session', id };
          },
          view: async id => await sessions.get(id).catch(() => undefined),
          launch: async id => {
            // PARSED, not asserted: a control types into a real terminal, so a configuration
            // document that no longer validates must refuse rather than address whatever pane it
            // names — the same rule the send slice's terminal follows.
            const parsed = SessionLifecycleConfigSchema.safeParse(
              lifecycleConfigDocument(await storage.readConfig(id)),
            );
            return parsed.success ? parsed.data : undefined;
          },
          journal: async (id, event, data) => {
            await storage.append(id, event, data);
          },
          quarantine: async (id, patch) => {
            await storage.updateState(id, current => runtimeQuarantineState(current, patch));
          },
        },
        pane: launchTmux,
        injector: new TmuxPaneDelivery(launchTmux, milliseconds => Bun.sleep(milliseconds)),
        // Bound to one session per drive, and addressed by pane id from there on.
        picker: tmuxSession =>
          new TmuxCodexPickerDrive(
            tmux,
            launchTmux,
            new TmuxPaneDelivery(launchTmux, milliseconds => Bun.sleep(milliseconds)),
            tmuxSession,
            HARNESS_PICKER_COMMAND,
          ),
        effects: sessionEffects,
        // The world's own harness service, so the decision a control performs and the recovery a
        // failed drive runs are the ones this daemon published rather than a second construction.
        harness: harnessService,
        accounts,
        // ONE cache for the daemon. Per-subsystem caches would each spawn their own probe, which
        // is the second speaker to a live account this cache exists to prevent.
        catalog: codexRuntimeModels,
        // The lifecycle's process-wide per-session fence. Public control acquires it; startup enters
        // through the explicit held capability from lifecycle's before-first-turn callback.
        serial: sessionMutations,
        sleeper: { sleep: milliseconds => Bun.sleep(milliseconds) },
        clock,
        // The instruction a quarantined session shows a human names the CLI they actually type.
        clientName: CLIENT_NAME,
      });
      const sessionControl = createSessionControlSubsystem(
        storage,
        sessions,
        createSessionLifecycle,
        planner,
        launcher,
        accounts,
        executables,
        sessionIds,
        createCallsignClaims(storage, stateFiles, paths, callsignClaims),
        payloadDigests,
        // The session's own private directory holds the files, and the extractor over them is the
        // production one: `initialAttachments` is the only mounted route that carries document
        // bytes, so this is where a DOCX becomes text the agent can read.
        {
          plan: (id, decoded) =>
            planInitialAttachments(
              decoded,
              join(createSessionPaths(paths, id).directory, 'attachments'),
              new NodeRawDeflate(),
            ),
          write: async files => await new FileSessionAttachmentStore(() => crypto.randomUUID()).write(files),
        },
        // The board grant a `--board-access` start asks for, over the same world and the same
        // derived request id the standalone `/v1/task-boards/child-grants/request` route uses.
        childGrantRequester(boards),
        transcriptProvenance,
        new NodeWorkingDirectoryResolver(),
        id => createSessionPaths(paths, id).directory,
        sessionRuntime,
        // The stamper the world already constructed, now actually called. Before this it was a field
        // nothing dereferenced: a shield the fork wrote and no ordinary start ever did.
        spawnProvenance,
        clock,
      );
      const wardenPaths = createWardenPaths(paths.home);
      const notifications = new NotificationService({
        ledger: new FileNotificationDeliveryLedger(paths, stateFiles),
        sessions: {
          describe: async id => {
            const view = await sessions.get(id);
            return view === undefined
              ? undefined
              : { name: view.config.name, interactive: view.config.mode === 'interactive' };
          },
        },
        push,
        serial: new KeyedSerialExecutor(),
        clock,
      });
      // ONE attention service for this opened store, shared by the route a person answers on and by
      // the warden sweep that raises and clears its own escalations. Two would each hold their own
      // idea of what a session is waiting for.
      const attention = new AttentionService(
        // The ledger repository is handed raw ids from the transport, so the id is parsed here
        // rather than asserted: an id the layout would not accept must never become a directory
        // path.
        new FileAttentionLedgerRepository(id => createSessionPaths(paths, parseSessionId(id)).directory),
        clock,
        {
          // A missing attention.json is an empty board only for a session the
          // registry can prove exists. Session document damage propagates
          // rather than being flattened into "no attention".
          has: async id => (await sessions.get(id)) !== undefined,
        },
        notifications,
      );
      // ONE ingestion service for this opened store, shared by the loop that writes rows and the route
      // that reads them. Two would each hold their own account of whether a pass is in flight, and the
      // read would report `refreshing: false` while the loop was mid-pass.
      const analyticsIngestion = createAnalyticsIngestion(
        storage,
        analyticsStore,
        daemonConfigStore,
        createAnalyticsTranscriptEvidence(storage),
        clock,
      );
      const analyticsPricing = new AnalyticsPricingService(
        daemonConfigStore,
        new HttpAnalyticsPricingFeed(),
        daemonConfigMutations,
        clock,
        { next: () => crypto.randomUUID() },
      );
      // Hoisted, because the quota-failover loop below moves sessions THROUGH this exact subsystem
      // rather than through a second, ungated path of its own.
      const sessionMigrate = createSessionMigrateSubsystem({
        storage,
        sessions,
        resume,
        preflight,
        reports: new FileMigrationReportStore(id => createSessionPaths(paths, id).directory),
        planner,
        accounts,
        executables,
        clock,
        transcripts: createTranscriptReader(storage),
        transcriptProvenance,
        sessionDirectory: id => createSessionPaths(paths, id).directory,
        // Its own queue: a migration holds its lock across a pane kill and a relaunch, and must not
        // make every unrelated document write in the process wait behind it.
        serial: new KeyedSerialExecutor(),
      });
      // The SAME durable registration ledger the reap sweep reads, over the storage this boot
      // opened. Resource limits and the reap both need "which panes does this daemon own, and which
      // of their sessions are provably over" — two readers of one ledger, never two ledgers.
      const cgroupPanes = new DurableTerminalPaneStore(storage, stateFiles, paths);
      // The fork, constructed after the runtime and migration dependencies it borrows from and
      // before the subsystem literal that mounts it. Every owner it needs is already a local here:
      // taking them by name rather than rebuilding them is what keeps a fork's account resolution,
      // model planning and effort vocabulary identical to a start's.
      const sessionFork = createForkSubsystem({
        storage,
        paths,
        attachmentStore,
        // Derived from the SAME two values `attachmentStore` was constructed from, three lines above,
        // and in the only scope that holds both: `SessionAttachmentStore` composes
        // `<root>/attachments/<daemonId>/<sessionId>` internally, so the copier is pointed at that
        // tree explicitly rather than at a plausible-looking directory beside the session.
        attachmentOriginals: id => join(paths.state, 'attachments', attachmentsDaemonId, id),
        transcriptSources,
        gateway,
        accounts: async agent => await resolveStartAccount(accounts, agent, executables),
        planner,
        harness: harnessService,
        catalog: codexRuntimeModels,
        createLifecycle: (id, envelope) => createSessionLifecycle(storage, launcher, envelope, id),
        transcripts: transcriptProvenance,
        messageTokens: sessionTranscriptMessageTokens,
        redactor: secretRedactor,
        environment: sessionEnvironments,
        runtime: sessionRuntime,
        view: async id => await sessions.get(id),
        ids: sessionIds,
        clock,
      });
      // ONE receipt store for both readers of it: the service that writes a receipt and the loop that
      // rosters the ones which are not yet terminal. Two handles over one directory would be two
      // answers to "what is still in flight".
      const handoverReceipts = new FileHandoverReceiptStore(paths.sessions);
      // Hoisted for the reason the migration above is: the reconcile loop drives THIS service rather
      // than a second one of its own. Two would each hold their own per-session serialization chain
      // over one receipt document, and the whole point of that chain is that a begin and a reconciler
      // tick for one predecessor cannot interleave.
      const handover = createSessionHandoverSubsystem(
        // Its own queue, constructed here so it lives as long as the daemon does: a serializer created
        // per call would serialize nothing, which is the whole failure this guards against.
        { paths, storage, sessions, accounts, executables, planner, clock, journalSerial: new KeyedSerialExecutor() },
        handoverReceipts,
      );
      return {
        health: createHealthSubsystem(health, scratch),
        doctor: {
          report: async () => {
            let directorySyscalls = true;
            try {
              loadDirectorySyscalls();
            } catch {
              directorySyscalls = false;
            }
            return readDoctorReport({
              platform: process.platform,
              executables,
              harnesses: await readHarnesses(accounts, executables, harnessDiscovery),
              directorySyscalls,
            });
          },
        },
        pairing,
        push,
        carriers,
        // The SAME mount the usage feed collects through, so the admin route and `/usage` can never
        // report different quota for the same account on the same host.
        fleet,
        harnessLogin,
        /**
         * How much of this machine the managed fleet may take.
         *
         * IT SHARES THE LAUNCH PATH'S COLLABORATORS — the same saved document, the same measured
         * host, the same command runner — so the effective limits this reports are the ones the
         * next pane is actually given. A second store here would let the panel display a ceiling no
         * launch ever writes.
         *
         * IT TAKES THE SESSION LIFECYCLE'S OWN EXECUTOR, exclusively. That is the single owner of
         * mutation ordering in this process, and taking it is what stops a save from landing in the
         * gap between a start choosing its argv and the pane existing — and what orders two saves
         * against each other. A private lock here would be a second owner of one question, and the
         * two would order the same pair of operations differently.
         *
         * THE PANE LEDGER IS THIS DAEMON'S OWN REGISTRATIONS, read through the same two ports the
         * reap sweep uses. A pane this daemon did not register is not one it may reconfigure.
         */
        cgroups: new CgroupService({
          store: cgroupConfigStore,
          // Beside the saved document, in the same directory: what this host refused to apply
          // outlives the answer to the save that met the refusal, so a page refresh or a restart
          // cannot report a session that kept its old cap as a current one.
          applyStatus: new FileCgroupApplyStatusStore(stateFiles, paths),
          host: cgroupHost,
          commands: cgroupCommands,
          placements: new ProcCgroupPlacements(),
          panes: new RegisteredCgroupPaneLedger(
            paths.home,
            // The TOLERANT read of the same ledger the reap refuses on: a settings surface must not
            // go dark because one registration was hand-edited, and the same observer the reap uses
            // re-proves each pane's incarnation before its pid may be addressed.
            { list: daemonId => cgroupPanes.scan(daemonId) },
            { list: daemonId => cgroupPanes.sessions(daemonId) },
            new ExactTmuxPaneReaper(launchTmux),
          ),
          sessions: sessionSpawnFacts,
          serial: sessionMutations,
          // Measured, not asserted: the surface warns if this very process turns out to be inside
          // the slice it is capping.
          daemonPid: process.pid,
        }),
        foreignHistory,
        // This owns no cache and no provider policy: the daemon usage feed already owns those. One
        // service per opened state home serializes only this daemon's timer ticks, so a slow read in
        // another daemon can neither join nor delay it. It is deliberately NOT handed the fleet: the
        // health probe launches a wrapper and spends a real billable turn per account, which a timer
        // must never do. Health belongs where a person chose it.
        fleetRefresh: new FleetRefreshService({ usage }),
        notifications,
        attention,
        pins: new PinService(
          new FilePinSessionDirectory(paths, stateFiles),
          // Its own queue: a pin mutation must not serialize behind storage-wide or session work.
          new FilePinRepository(paths, stateFiles, new KeyedSerialExecutor(), clock),
          clock,
          // A pin id is a protocol UUID, so it is minted as one rather than derived from a counter the
          // next process would restart.
          { next: () => crypto.randomUUID() },
        ),
        sessions,
        catalogs,
        // The evidence is read through the SAME collaborators the rest of the daemon serves from —
        // the session directory, the terminal runtime and the project catalog — so a refusal to
        // remove a checkout because a session or a shell is still in it cites the very records the
        // client would see if it asked. Collecting any of it separately is how a safety gate ends up
        // refusing on evidence nobody else can reproduce, or worse, never firing at all.
        worktrees: new ManagedWorktreeService(
          worktrees.registry,
          worktrees.operations,
          // BOTH READS ANSWER `undefined` RATHER THAN THROWING, and neither swallows the failure: a
          // host whose tmux server will not answer used to take the whole worktree surface down with
          // a 500, and the only thing worse than that is the version that reports zero live shells
          // and lets a removal proceed. The domain turns an absent answer into an un-forceable
          // refusal, so a read still succeeds and a destructive write still refuses.
          {
            sessions: async () =>
              await sessions
                .list()
                .then(views =>
                  views.map(session => ({
                    id: session.config.id,
                    cwd: session.config.cwd,
                    status: session.state.status,
                    ...(session.state.finishedAt === undefined ? {} : { finishedAt: session.state.finishedAt }),
                  })),
                )
                .catch(() => undefined),
          },
          {
            roots: async () =>
              await terminals
                .list()
                .then(records => records.map(record => record.root))
                .catch(() => undefined),
          },
          { projects: async () => await catalogs.projects() },
          // The SAME clock the Git adapter stamps records with, so an intent this daemon writes
          // before a mutation and the record it writes after cannot disagree about when.
          worktreeClock,
          { next: () => crypto.randomUUID() },
          worktrees.managedRoot,
        ),
        sessionControl,
        sessionResume: createSessionResumeSubsystem(
          storage,
          sessions,
          resume,
          // The SAME stamper the start uses, so a create and a revive can never disagree about how
          // descent is decided; only the ancestry snapshot differs, and it is taken per relaunch.
          new SessionProvenanceRecorder(spawnProvenance, new StorageSessionProvenanceStore(storage), {
            snapshot: async () => await spawnAncestry(storage, sessions),
          }),
        ),
        sessionSend: createSessionSendSubsystem(storage, sessions, sends),
        sessionAnswer: createSessionAnswerSubsystem(
          storage,
          sessions,
          launchTmux,
          clock,
          answerLedger,
          answerSerial,
          lastSnapshots,
        ),
        sessionAttachments,
        sessionSignal: createSessionSignalSubsystem(storage, sessions, signals),
        sessionRuntime,
        // The record lives in this daemon's own state home, beside the lock and the index it was
        // opened with. Two daemons on one host have two homes and therefore two records, so neither
        // can overwrite the other's account of its own loop.
        monitor: new MonitorTickRunner(monitor, join(paths.home, 'monitor.json'), defaultSessionMonitorSettings),
        sessionMigrate,
        sessionFork,
        quotaFailover: createQuotaFailoverSubsystem({
          root: quotaFailoverRoot(paths.home),
          storage,
          sessions,
          accounts,
          usage,
          migrate: sessionMigrate,
        }),
        handover,
        // The loop drives the SAME service the route serves, so a receipt advanced by a tick and one
        // begun by a request are the same document under the same lock. Its cadence is the domain's
        // own default; the scheduler is the composition root's, because a timer is not a `src/lib`
        // fact. Errors inside a pass are swallowed by the loop itself and surface as a receipt that
        // has not advanced, which is the honest reading of a supervision failure.
        handoverReconcile: new HandoverReconcileLoop(handover, handoverReceipts, {
          every: (intervalMs, tick) => {
            const handle = setInterval(tick, intervalMs);
            return () => clearInterval(handle);
          },
        }),
        tasks: createTaskSubsystem(paths, storage, clock, taskBoards, taskBoardTaskActionAuthorizer(boards)),
        taskBoards: boards,
        analytics: createAnalyticsSubsystem(analyticsIngestion),
        analyticsPricing,
        analyticsIngest: analyticsIngestion,
        terminals: createTerminalSubsystem(storage, terminals, { now: () => Date.now() }),
        browserLogin,
        browser: (() => {
          const service = new BrowserSessionService(
            sessions,
            new NodeSessionBrowserLauncher(
              new BrowserProfileStore(paths.home),
              browserWorkerProgram().entry,
              // Bun 1.3's WebSocket client can resolve Chrome's CDP endpoint but times out during
              // the upgrade. Node's worker-compatible TypeScript loader and WebSocket stack both
              // work here, including when this daemon is itself a compiled Bun binary.
              Bun.which('node') ?? process.execPath,
              process.env,
              browserTransport.connectWorker,
              browserWorkerProgram().executable,
            ),
            () => Date.now(),
          );
          closeAgentBrowsers = async () => await service.closeAll();
          return {
            ...service,
            status: service.status.bind(service),
            act: service.act.bind(service),
            attachViewer: service.attachViewer.bind(service),
            dispatchHumanInput: service.dispatchHumanInput.bind(service),
            closeAll: service.closeAll.bind(service),
            stream: async (sessionId, downstream) => {
              let viewer: BrowserViewerStream | undefined;
              return {
                open: async () => {
                  viewer = await BrowserViewerStream.connect(service, sessionId, downstream, new SystemFrameClock());
                },
                fromClient: frame => viewer?.fromClient(frame),
                close: () => viewer?.close(),
              };
            },
          };
        })(),
        names: createNameSubsystem(storage),
        learning: createLearningSubsystem(
          paths,
          stateFiles,
          clock,
          learningBoard,
          sessions,
          createTranscriptReader(storage),
          sessionControl,
        ),
        recommend: createRecommendSubsystem(advisorOver, usage),
        sttEnhancement,
        // Constructed here rather than injected: the pinner opens nothing until a request arrives, and
        // the Git reader is the same hardened runner the worktree gateway already uses. Both are
        // stateless, so one instance serves every session.
        sessionFilesystem: new SessionFilesystem(sessionRootPinner(), new RunnerSessionGit(new BunGitRunner())),
        scratchGc,
        secrets,
        warden: createWardenSubsystem({
          sessions,
          control: sessionControl,
          attention,
          usage,
          accounts,
          files: wardenFiles,
          // The SAME reader `world.wardenReports` builds, over the same directory: the verdict list
          // and the sweep's own "was this target cleared" read must agree about what a report says.
          reportsReader: new WardenReportReader(wardenFiles, wardenPaths.reports),
          wardenRoot: wardenPaths.root,
          reportsDirectory: wardenPaths.reports,
          supervision: wardenSupervision,
        }),
        // The three operator reads, each over the evidence that actually holds the answer: the durable
        // journal this storage opened, the pane the lifecycle document names, and the transcript the
        // start proved is this session's.
        //
        // EVERY ONE IS KEYED BY SESSION ID THROUGH THIS DAEMON'S OWN STATE HOME. The journal is a file
        // under it, the pane address is read from the document beside that file, and the tmux server is
        // this daemon's private socket — so a session with the same name under another daemon cannot be
        // captured here, which is the failure a `fy stream` attaching to the wrong pane would be.
        sessionReads: new OperatorReadService(
          {
            replay: async (sessionId, afterSequence, limit) => {
              // PARSED, not asserted: an id the layout would not accept must never become a journal path.
              const id = tryParseSessionId(sessionId);
              if (id === undefined) return [];
              const page = await storage.replay(id, afterSequence, limit);
              return page.events.map(event => ({
                sequence: event.sequence,
                sessionId: event.sessionId,
                time: event.time,
                type: event.type,
                data: event.data,
              }));
            },
          },
          {
            capture: async sessionId => {
              const id = tryParseSessionId(sessionId);
              if (id === undefined) return undefined;
              // PARSED for the reason every other terminal address is: a document that no longer
              // validates must leave the session with no pane rather than address whatever it names.
              const lifecycle = SessionLifecycleConfigSchema.safeParse(
                lifecycleConfigDocument(await storage.readConfig(id).catch(() => undefined)),
              );
              if (!lifecycle.success) return undefined;
              const state = await launchTmux.state(lifecycle.data.tmuxSession);
              // The scrollback, not the visible frame: an operator reading a snapshot is catching up on
              // what happened, and the visible 24 lines are whatever the harness last redrew.
              return { alive: state.alive, dead: state.dead, text: state.history };
            },
          },
          createSessionTranscriptTail(storage),
          createSessionTranscriptMessageSource(storage),
          sessionTranscriptMessageTokens,
          lastSnapshots,
          // The screen, the transcript and the journal are the three places a secret would surface if
          // a child ever printed one, so all three are scrubbed here rather than at whichever caller
          // remembered to. See `lib/secrets/redaction.ts` for the boundary this draws.
          secretRedactor,
        ),
        // A host attach is authorized by the durable pane registration, never by the session name.
        // The observer reads the same private tmux server the launch registered, and the service
        // compares pane id, pid and process-start incarnation before revealing its socket path.
        sessionAttach: new SessionAttachService(
          paths.home,
          join(paths.home, 'tmux.sock'),
          {
            list: async daemonId =>
              await new DurableTerminalPaneStore(storage, stateFiles, paths).registrations(daemonId),
          },
          new ExactTmuxPaneReaper(launchTmux),
        ),
        // ONE feed over ONE opened storage: live listeners cannot see another daemon's appends, and
        // the fleet backfill refuses if any indexed session has lost the journal its marker owes.
        fleetEvents: new FleetEventStreamService(
          {
            replay: async (sessionId, afterSequence, limit, signal) => {
              signal.throwIfAborted();
              const page = await storage.replay(parseSessionId(sessionId), afterSequence, limit);
              signal.throwIfAborted();
              return page.events;
            },
            fleetBacklog: async (limit, signal) => {
              signal.throwIfAborted();
              const sessionIds = await storage.fleetSessionIds();
              signal.throwIfAborted();
              const events = await storage.tailEvents(limit);
              signal.throwIfAborted();
              return { sessionIds, events };
            },
            subscribe: listener => storage.subscribeEvents(listener),
          },
          {
            after: (milliseconds, action) => {
              const timer = setTimeout(action, milliseconds);
              return { cancel: () => clearTimeout(timer) };
            },
          },
        ),
        // ONE registry for both halves of the exchange: the route that sells a ticket and the socket
        // dispatcher that spends it must be the same outstanding set, or every ticket a browser buys
        // is redeemed against a registry that never issued it. Memory-only and per-daemon by
        // construction — see the domain's own header for why it is never persisted.
        socketTickets,
        // Built above, and the same instance the fleet mount confirms a change through. See its
        // definition for why one instance rather than two.
        grants,
      };
    },
    credentials: new StateApiCredentials(paths, stateFiles),
    clock: millisecondClock,
    sttEnhancement: new SttEnhancementService(
      new FetchEnhancementTransport(),
      new ProcessSecretReader(),
      new PerformanceStopwatch(),
    ),
    untilShutdown: untilTerminated,
  };
}

/**
 * Boots the daemon from an already-built world, so tests can inject their own.
 *
 * The ORDER is the design, and it is not the order the source used.
 *
 * The state home comes FIRST. Opening it takes the lifetime lock, establishes the layout and opens
 * the session index, and every document the daemon then reads or writes — configuration included —
 * lives inside it. Loading configuration first, as the source did, writes `config/daemon.json` into
 * a home that has no layout marker yet, and the layout gate correctly refuses a non-empty unmarked
 * home as foreign state: a first boot on a fresh home could not get past its own configuration
 * step. Owning the home before writing into it removes the whole class.
 *
 * A held lifetime lock is then the same answer as one of THESE daemons responding on the address —
 * another one is already serving — so both report `EXIT_ALREADY_RUNNING` rather than one of them
 * surfacing as a crash about SQLite. A responder that cannot be identified as one of these daemons
 * is a different thing entirely, and reports the address conflict it actually is.
 *
 * EVERY ONE OF THOSE EXITS SAYS SOMETHING FIRST. They used to return their code and write nothing at
 * all, so the launcher pointed the operator at a log file that was empty and a person who had done
 * everything right learned nothing.
 *
 * The socket comes last, and every acquisition registers its release as it is made rather than in
 * one block at the end, so a failure part-way through unwinds exactly what succeeded.
 */
export async function start(world: DaemonWorld, cleanups: Array<() => void | Promise<void>> = []): Promise<number> {
  if (world.role !== 'daemon') {
    world.notices.state(`this build is packaged as ${world.role} rather than a daemon and cannot serve`);
    return 1;
  }
  world.notices.step('starting', `${DAEMON_NAME} ${daemonVersion}, pid ${String(process.pid)}`);

  // Registered for release immediately: an exception from anything below must not leave the lock
  // behind, because a stale lock fails the NEXT start for a reason unrelated to what broke.
  let opened: OpenedDaemonStorage;
  try {
    opened = await world.storage.open();
  } catch (error) {
    if (error instanceof StateHomeLockedError) {
      const refusal = refuseHeldStateHome(DAEMON_NAME, CLIENT_NAME, error.lockFile);
      world.notices.state(refusal.message);
      return refusal.exitCode;
    }
    throw error;
  }
  cleanups.push(() => opened.storage.close());
  world.notices.step('state home opened', opened.paths.home);

  const peeked = await world.config.peek();
  const loaded = overriddenBy(
    peeked.document === undefined ? await world.config.load() : peeked.config,
    world.overrides,
  );
  world.notices.step('configuration loaded', world.config.path);
  await world.secrets.load(loaded.secretsFile);
  if (loaded.secretsFile !== undefined) world.notices.step('secrets loaded', loaded.secretsFile);
  // BEFORE the subsystems, because everything below assembles addresses from this document — the
  // pairing link, the browser origins, the advertised URL. A boot that only learned its real port at
  // bind time would have handed every one of them the port it did not take.
  const decided = await decideAddress(world, loaded);
  if ('exitCode' in decided) {
    world.notices.state(decided.message);
    return decided.exitCode;
  }
  const config = decided.config;
  // Read ONCE for this boot and handed to every surface that reports a harness, so the milestone
  // below and the doctor route this daemon serves cannot disagree about which `claude` is here.
  const harnessDiscovery = harnessDeclarations(config);
  for (const key of supersededCarrierKeys({ rawDocument: peeked.document ?? {}, carriers: config.carriers })) {
    world.notices.state(
      `the legacy "${key}" key in ${world.config.path} is superseded by its explicit carriers entry and has no effect`,
    );
  }
  // Recorded exactly when THIS BOOT chose the address, which is the only case where the document
  // does not already say it: a recorded port is already written, and a port named on the command
  // line was said about this run only and must not be turned into a claim on disk behind the
  // operator's back. Recording is what makes choosing safe — the next boot binds this or refuses.
  if (!loaded.portIsRecorded) {
    await world.config.record(config.port);
    world.notices.step('address recorded', `${world.config.path} now claims port ${String(config.port)}`);
  }
  // Stated rather than refused: advertising an address other than the bound one is a real deployment
  // (a proxy, a tunnel), and it is also what a home written before derived values stopped being
  // persisted looks like. Either way the operator is the one who can tell which, so say it.
  if (advertisesForeignAddress(config))
    world.notices.state(foreignAdvertisementNotice(config.bindUrl, config.publicUrl, world.config.path));
  /**
   * The runtime relay advertisement is read ONCE, here, before either consumer receives the set.
   * Construction below receives these sources rather than the directory, so no second read can hide
   * inside a carrier factory. A duplicate that only becomes visible after discovery is a boot
   * refusal: silently dropping one entry would choose between the operator's relay and the hosted
   * one on their behalf, and that choice would change when the directory changes.
   */
  const resolvedRelays = await resolveRelayCarrierSources(config, world.relayDirectory);
  if (resolvedRelays.kind === 'refused') {
    world.notices.state(`relay carrier configuration refused — ${resolvedRelays.reason}`);
    return 1;
  }
  const relaySources = resolvedRelays.sources;
  // ONE VALUE, in wire order: the externally declared direct origin first, then every enabled relay
  // in document order. The advertisement decision owns whether this boot has a publishable direct
  // origin; pairing and refresh receive this exact frozen array reference below.
  const directCarrier = directCarrierPublication(config);
  if (directCarrier.kind === 'omitted') world.notices.state(directCarrier.notice);
  const carriers = Object.freeze(
    publishedDaemonCarriers(directCarrier.kind === 'published' ? directCarrier.url : undefined, relaySources),
  );
  /**
   * Whether this host can launch an agent at all.
   *
   * EARLY, AND NEVER A REFUSAL. A daemon with no harness installed starts perfectly and can do
   * nothing — healthy by every internal measure and useless to the person in front of it, which is
   * exactly the class of failure this trail exists to stop shipping. But someone may install a
   * harness minutes after the daemon comes up, so it is said rather than enforced: a daemon that
   * refuses to start until they have is strictly worse than one that starts and says what is missing.
   *
   * It is a `state` rather than a `step` when nothing is ready, so no log level can filter away the
   * one line that explains why launching a session will fail.
   */
  const harnesses = await readHarnesses(world.harnesses.accounts, world.harnesses.executables, harnessDiscovery);
  world.notices.step('harnesses checked', harnessPreflightSummary(harnesses));
  // WHERE each command was found and WHICH RULE found it, every boot. An operator who has just
  // written down a path or a search directory has no other way to see whether this daemon read it,
  // and "it works in my terminal" is precisely the state a service-managed daemon does not share.
  world.notices.step('harness commands located', harnessLocationSummary(harnesses));
  // A named path that resolves to nothing is a `state`, so no log level can hide it: the operator
  // configured something, this daemon did NOT fall back to a search, and both halves of that have to
  // be said or they are left believing the opposite.
  for (const failure of harnessOverrideFailures(harnesses)) world.notices.state(failure);
  /**
   * Whether this start is about to give the host a fleet, decided HERE and acted on after the mounts.
   *
   * DECIDED EARLY BECAUSE IT CHANGES WHAT IS SAID NEXT. The absent-harness warning below is the
   * sentence this whole feature exists to make unreachable — "claude is on this host's PATH, but the
   * fleet manifest publishes no account for it" — and emitting it a few lines before correcting it
   * would be a boot trail that argues with itself. So the decision comes first and the warning is
   * withheld when preparation is going to run; the trail then reports the true FINAL state from a
   * re-read preflight, further down, rather than the state this line saw.
   */
  const fleetPreparation = decideFleetBootPreparation({ enabled: config.fleet.prepareDefaults, preflight: harnesses });
  const fleetLocations = {
    fleetDirectory: opened.paths.fleet,
    binDirectory: join(opened.paths.fleet, 'bin'),
    configPath: world.config.path,
  };
  if (fleetPreparation.kind === 'prepare') {
    // Said BEFORE a byte is written. This is the disclosure the whole change turns on: starting a
    // daemon is about to create executable wrappers in somebody's home, and a first run that did
    // that silently would be indefensible however local and however convenient.
    world.notices.state(fleetPreparationDisclosure(fleetPreparation.harnesses, fleetLocations));
  } else if (!harnesses.ready) {
    world.notices.state(harnessAbsentWarning(harnesses, CLIENT_NAME));
    // WHY nothing was created, beside the warning that says nothing can be launched. The two are one
    // question for the reader — "there is a harness here, why can I not use it" — and the skip reason
    // is the half that names the key or the file standing in the way.
    world.notices.state(fleetPreparation.reason);
  }

  const usage = await world.createUsageFeed(config);
  const startedAtMs = world.clock.now();
  const pairing = await world.createPairing(config, world.clock, carriers, discoverableRelayUrl(relaySources));
  world.notices.step('pairing identity opened');
  const base = {
    credentials: { ...(await world.credentials.load()), devices: pairing.credentials },
    usage,
    clock: world.clock,
    startedAtMs,
  };
  // `healthIntervalSeconds` was declared in `config/daemon.json` and read by nothing, because no
  // self-check ran to have a cadence. It is the operator's number now — and the wedge threshold moves
  // WITH it, because "the event loop stopped running" means three missed ticks rather than a fixed
  // three minutes. One settings object serves the service, its consistency pass and the timer below,
  // so the period the daemon fires on cannot drift from the period the detector measures against.
  const healthSettings = sessionHealthSettingsAt(config.healthIntervalSeconds * 1_000);
  const health = world.createSessionHealth(opened.storage, healthSettings);
  const skills = new NodeCatalog({ home: homedir() });
  const projects = new FileProjectCatalog(join(opened.paths.state, 'projects.json'));
  const catalogs = {
    projects: () => projects.projects(),
    registerProject: (request: RegisterProjectRequest) => projects.register(request),
    skills: (session: SessionView) => skills.skills(session),
  };
  /**
   * The analytics materialization, opened under the lifetime lock this boot is already holding and
   * through the same confined filesystem port.
   *
   * AFTER THE ADDRESS PROBE, so a boot that is about to hand over to an incumbent daemon does not
   * create a database file it will never write a row to.
   *
   * A FAILURE TO OPEN IT FAILS THE BOOT, deliberately. Swallowing it would leave the daemon serving
   * analytics from a store nothing could write to, and an empty store answers every question with a
   * fleet that spent nothing — the "absent evidence read as a benign result" bug this repository has
   * now fixed six times. A disk this daemon cannot materialize an index on is a fault to report at
   * startup, not one to discover as a suspiciously cheap month.
   */
  const analyticsStore = await world.analyticsIndexes.open(opened.paths, opened.fileSystem);
  cleanups.push(() => analyticsStore.store.close());
  world.notices.step('analytics index opened', analyticsStore.rebuildRequired ? 'a rebuild is required' : undefined);
  const subsystems = world.createSubsystems(
    opened.storage,
    world.terminalRuntime,
    usage,
    health,
    world.sessionLauncher,
    // Built here rather than inside `createSubsystems` because it needs the storage this boot opened,
    // and threading it through the same seam as the other host adapters is what lets a test replace
    // the one thing a revive cannot do twice on a developer's machine: kill and respawn a real pane.
    world.createResumeLauncher(opened.storage),
    world.migratePreflight,
    world.browserLogin.window,
    world.sttEnhancement,
    catalogs,
    {
      operations: world.worktrees,
      registry: new FileManagedWorktreeRegistry(join(opened.paths.state, 'worktrees.json')),
      // Derived from the state home's own name rather than configured, so two daemons on one host
      // keep two managed roots for the same reason they keep two state homes. A home whose name
      // yields nothing to derive from means this daemon hosts no managed checkouts at all, and the
      // surface says so instead of inventing a directory.
      managedRoot: defaultManagedWorktreeRoot(opened.paths.home) ?? undefined,
    },
    analyticsStore,
    pairing.subsystem,
    pairing.push,
    carriers,
    world.createSocketTickets(),
    harnessDiscovery,
  );
  // Registered BEFORE the address is bound, like every other acquisition: from here on the daemon can
  // be asked to put an X server, a Chrome and a VNC listener on this host, and whatever it took must
  // be released whether the boot completes or fails part-way.
  cleanups.push(() => world.browserLogin.close());
  // The FIRST self-check runs before the address is bound, so the daemon's very first health answer
  // is a measurement rather than an empty ledger — a supervisor that probes the moment the port opens
  // must not be told "no self-check has ever run" by a daemon that is about to run one. It is also
  // the boot-time index reconciliation: `classifySelfCheckTick` forces the deep consistency pass on
  // the first tick precisely because boot is when the index is least likely to match the session
  // directories. A failure is swallowed for the same reason the ticks below swallow theirs — a
  // self-check that could not run is reported by the next one's freshness, and refusing to serve
  // because the daemon could not measure itself is strictly worse than serving and saying so.
  world.notices.step('subsystems mounted');
  /**
   * The fleet this host gets for starting a daemon.
   *
   * AFTER THE MOUNTS, because the scaffold and the apply are the fleet subsystem's own two steps and
   * this is not a third one: the mount already owns the scaffolder, the provisioner, the configuration
   * path and the exclusive apply claim. BEFORE THE BIND, so the first caller that asks what this
   * daemon can launch is answered by a published manifest rather than by a race.
   *
   * A FAILURE NEVER REFUSES THE BOOT. `prepareDefaults` answers with a value for exactly that reason,
   * and the failure is said as a `state` so no log level can hide a host that was left part-prepared.
   */
  if (fleetPreparation.kind === 'prepare') {
    const prepared = await subsystems.fleet.prepareDefaults(fleetPreparation.harnesses);
    if (prepared.kind === 'prepared') {
      world.notices.state(
        fleetPreparedDisclosure({
          wrappers: prepared.wrappers,
          published: prepared.published,
          locations: fleetLocations,
          pathEntry: prepared.pathEntry,
          clientName: CLIENT_NAME,
        }),
      );
    } else if (prepared.kind === 'refused') {
      // NOTHING WAS WRITTEN. Applying this configuration would have taken an account away, so the
      // whole preparation was refused — and the disagreement between the configuration and the
      // manifest is itself the fact the operator needs.
      world.notices.state(
        fleetPreparationRefusal({
          harnesses: fleetPreparation.harnesses,
          conflicts: prepared.conflicts,
          locations: fleetLocations,
          clientName: CLIENT_NAME,
        }),
      );
    } else if (prepared.kind === 'nothing-added') {
      world.notices.state(
        fleetNothingAddedNotice({
          harnesses: fleetPreparation.harnesses,
          locations: fleetLocations,
          clientName: CLIENT_NAME,
        }),
      );
    } else {
      world.notices.state(
        fleetPreparationFailure({ reason: prepared.reason, created: prepared.created, clientName: CLIENT_NAME }),
      );
    }
    /**
     * The preflight taken AGAIN, so the trail reports what is true at the end of this boot.
     *
     * The first read happened before the fleet existed and its answer is now stale in the one way
     * that matters: it said no account was published for a harness that now has four. Re-reading is
     * a manifest parse and two stats — nothing is launched — and it is the only honest way to leave a
     * boot trail whose last word about the fleet is the state a session will actually meet.
     */
    const after = await readHarnesses(world.harnesses.accounts, world.harnesses.executables, harnessDiscovery);
    world.notices.step('harnesses checked', harnessPreflightSummary(after));
    if (!after.ready) world.notices.state(harnessAbsentWarning(after, CLIENT_NAME));
  }
  /**
   * The grants, read BEFORE the address is bound.
   *
   * A DAEMON THAT CANNOT SAY WHAT IT IS ALLOWED TO DO DOES NOT SERVE. A grant document this boot
   * cannot read as a complete decision is not "everything is allowed" — it is damage, and starting
   * anyway would leave every remote caller refused by a daemon that never said why. The throw is
   * caught by `execute`, which reports it and exits non-zero, so the operator is told which document
   * to repair instead of discovering it as a UI that stopped working.
   */
  await subsystems.grants.refresh();
  // Said ONCE, at boot, and only when it is true. Nobody is interrogated at install time — a person
  // on this host is governed by none of this — but a machine that will accept a paired device with
  // nothing standing behind its configure routes should have said so somewhere a human reads.
  world.notices.step(
    'capability grants read',
    subsystems.grants.hasPassword() ? 'an operator password gates remote configuration' : NO_PASSWORD_DISCLOSURE,
  );
  await health.selfCheck().catch(() => undefined);
  world.notices.step('first self-check done');
  // The address comes from configuration, never a constant: a hardcoded port is how a daemon ends
  // up fighting whatever else the host already runs on it. The bind is retried because the common
  // restart is "the outgoing daemon is still draining its socket" — kteam's own supervisor hit that
  // window routinely and reported a permanent failure for a condition that clears in a second.
  //
  // BOTH parts of the surface are served by the one host, from the one credential set: the
  // request/response routes, and the protocol switches that carry terminal streams and the event
  // feed. There was a third — routes that owned the transport's own bytes — and dictation audio was
  // its only member; recognition moved into the browser and the seam went with it.
  // Hoisted, because the relay carrier below serves this exact dispatcher rather than a second one:
  // every route a browser can reach directly it can reach relayed, on one authorization boundary.
  const dispatcher = createMountedDispatcher(base, subsystems);
  // Hoisted for the SAME reason `dispatcher` above is: the relay carriers serve this exact socket
  // table rather than a second one. A stream a browser opens over a rendezvous passes the
  // authorization boundary, the ticket-free credential rule and the per-capability guard that the
  // bound address already enforces — one privilege model, not two that drift.
  const socketDispatcher = createMountedSocketDispatcher(base, subsystems);
  let server: ApiServerHandle;
  try {
    server = await world.boot.binder.bind(
      async () =>
        await world.api.listen(
          {
            http: dispatcher,
            sockets: socketDispatcher,
            corsOrigins: browserOrigins(config),
          },
          {
            host: config.host,
            port: config.port,
            // A loopback peer is privileged only on a loopback-only direct bind. A wildcard bind
            // can still have a local reverse proxy forwarding a remote browser, so Bun's immediate
            // peer is never enough proof there — even when its public URL is the pairing remedy.
            directLoopbackIsPrivileged: mayTrustDirectLoopback(config),
          },
        ),
    );
  } catch (error) {
    // A REFUSAL, not a crash. The address was probed and looked free, so arriving here means the
    // host will not let this daemon listen there — a privileged port, a host name that resolves to
    // no local interface, or something that took the address in the interval. All three are the
    // operator's to resolve, and a stack trace about a socket says none of it.
    const refusal = refuseUnbindableAddress(
      config.bindUrl,
      error instanceof Error ? error.message : String(error),
      world.config.path,
    );
    world.notices.state(refusal.message);
    return refusal.exitCode;
  }
  // Sockets BEFORE the host, and both registered rather than relying on `stop` alone: a live
  // terminal stream holds a redraw timer armed against its socket, so the handler must be told the
  // stream is over while the socket it writes to still exists.
  cleanups.push(() => server.closeSockets());
  cleanups.push(() => server.stop());
  world.notices.step('listening', config.bindUrl);
  /**
   * The relay carriers, dialled AFTER the bind and serving the very same dispatcher.
   *
   * AFTER, deliberately: a boot that hands over to an incumbent daemon on this address must not first
   * claim the rendezvous that incumbent is holding — the claim is exclusive, so the loser of a bind
   * race would knock the winner off the relay until the heartbeat sweep evicted the dead socket.
   *
   * A REFUSAL IS SAID OUT LOUD AND THE DAEMON KEEPS SERVING. Direct clients are unaffected by a relay
   * this daemon could not dial, and the sentence is what stops "no relay configured" from looking
   * exactly like "the relay is broken" — the two are indistinguishable from outside without it.
   */
  const relay = await world.createRelayCarriers(
    relaySources,
    request => dispatcher.dispatch(request),
    async request => await socketDispatcher.upgrade(request),
    { identifyDevice: token => pairing.credentials.identify(token) },
    // The pairing state machine itself, NOT the route table. A pre-credential session redeems
    // through this port and constructs no request at all, which is what keeps `POST /v1/pair` —
    // public on the route table — unreachable over a relay.
    pairing.subsystem,
  );
  if ('carriers' in relay) {
    const started = new Map<string, ReturnType<BunRelayCarrier['status']>>();
    for (const { carrier, source } of relay.carriers) {
      // REGISTERED BEFORE IT IS STARTED, like every other acquisition this boot makes. A dial opens a
      // socket partway through `start`, so a carrier that throws on the way up has already taken
      // something — and registering afterwards is exactly the ordering in which that one is the
      // carrier nothing ever stops, while every carrier before it is released normally.
      cleanups.push(() => carrier.stop());
      // Each carrier owns its own accepted connections, and therefore independently marks every
      // relayed arrival unprivileged. No list-wide or peer-address-derived privilege exists here.
      carrier.start();
      const relayUrl = dialledRelayUrl(source);
      if (relayUrl !== undefined) started.set(relayUrl, carrier.status());
    }
    const activeCount = [...started.values()].filter(status => status.phase !== 'none').length;
    const inactiveDetail = (source: RelayCarrierSource, detail?: string): string => {
      if (detail !== undefined) return detail;
      if (source.kind === 'direct-only') return source.reason;
      if (!source.config.enabled)
        return `the configured relay ${source.config.url} is switched off in this daemon's configuration`;
      return `the relay ${source.config.url} did not produce an active carrier`;
    };
    let globalAbsenceReported = false;
    for (const source of relaySources) {
      const relayUrl = dialledRelayUrl(source);
      const status = relayUrl === undefined ? undefined : started.get(relayUrl);
      if (status === undefined || status.phase === 'none') {
        const detail = inactiveDetail(source, status?.detail);
        if (activeCount > 0 || globalAbsenceReported) {
          world.notices.state(`relay carrier inactive — ${detail}`);
          continue;
        }
        // The consequence and remedy are GLOBAL and therefore emitted once, only when the entire set
        // dials nothing. An inactive entry beside a working relay receives the specific line above.
        for (const line of describeAbsentRelayCarrier({
          source,
          carrierDetail: detail,
          configFile: world.config.path,
          host: config.host,
        }))
          world.notices.state(line);
        globalAbsenceReported = true;
        continue;
      }
      world.notices.step('dialling the relay', status.relayUrl);
    }
  } else {
    world.notices.state(`no relay carriers — ${relay.refusal}`);
  }
  // The self-check tick, armed only once the daemon is actually serving. Its cadence IS the number
  // the wedge detector measures lateness against, so it comes from the same settings object the
  // service reasons with rather than a constant here — a timer that fired on a different period
  // would make every on-time tick look late.
  //
  // Errors are swallowed rather than propagated: an unhandled rejection from a background timer
  // takes down a daemon whose fleet is fine, and the failure is already visible as the next tick's
  // freshness. The handle is registered for cancellation like every other acquisition, so a stopped
  // daemon does not leave a timer firing at closed storage.
  const ticks = setInterval(() => {
    void health.selfCheck().catch(() => undefined);
  }, healthSettings.selfCheckIntervalMs);
  cleanups.push(() => clearInterval(ticks));
  /**
   * The declared-wait tick, armed beside the self-check and for the same reasons.
   *
   * ARMED BEFORE ITS FIRST RUN, so the record it publishes says "the loop is running and has not
   * ticked yet" rather than "there is no loop". The two are the same picture from the outside and
   * completely different faults, which is the distinction this whole subsystem exists to keep.
   *
   * THE FIRST TICK RUNS IMMEDIATELY. A daemon that has just restarted is exactly when a park is most
   * likely to be overdue — nothing serviced it while the process was down — and waiting out a full
   * interval before looking would add that interval to every wake the restart already delayed.
   *
   * THE SHUTDOWN SAYS SO RATHER THAN TICKING. `close` disarms and republishes the record; it does not
   * run a tick, because cleanups run in the order they were registered and the storage a tick would
   * read is closed by the first of them. Leaving the last tick's `armed: true` behind would tell the
   * next reader that something is still watching these parks.
   */
  subsystems.monitor.arm();
  await subsystems.monitor.run();
  const waitTicks = setInterval(() => void subsystems.monitor.run(), subsystems.monitor.intervalMs);
  cleanups.push(async () => {
    clearInterval(waitTicks);
    await subsystems.monitor.close();
  });
  /**
   * The quota-failover tick, armed beside the other background loops and after the bind, because a
   * tick can migrate a session and a migration relaunches an agent.
   *
   * THE CADENCE IS READ ONCE, here, and the timer keeps firing on it until the daemon restarts — the
   * same rule the warden sweep follows, and for the same reason: re-arming would mean a tick could
   * cancel the timer currently running it.
   *
   * NO BOOT TICK. Unlike the declared-wait watcher, there is nothing here that went unserviced while
   * the daemon was down: a session whose account ran out is still exactly as stranded one interval
   * later, and the first tick after a restart would run against a usage feed that has not collected
   * yet — which the freshness gate would halt on anyway. Waiting one interval buys a real reading.
   *
   * Errors are swallowed for the reason every other background timer swallows its own: an unhandled
   * rejection from a timer takes down a daemon whose fleet is fine, and a tick that could not run is
   * visible in the ledger it did not stamp.
   */
  const failoverIntervalMs = await subsystems.quotaFailover.intervalMs().catch(() => undefined);
  if (failoverIntervalMs !== undefined) {
    const failoverTicks = setInterval(() => {
      void subsystems.quotaFailover.run().catch(() => undefined);
    }, failoverIntervalMs);
    cleanups.push(() => clearInterval(failoverTicks));
  }
  /**
   * The unattended fleet evidence pass.
   *
   * It is mounted rather than folded into a route because the point is that `/usage` and
   * `/v1/fleet/health` are already current before a browser or a person requests them. The tick
   * drives the established feeds only: `CachedUsageFeed` owns quota caching, shared in-flight work
   * and last-good retention; the mounted fleet health reader owns the equivalent health evidence.
   * This loop invents neither a cache nor an error result, so a failed probe cannot replace good
   * data with an empty fleet.
   *
   * ONE CONFIGURATION NAME chooses the cadence. `usage.interval` is the fleet declaration that
   * builds the usage feed's freshness policy too. A daemon without a fleet configuration has made
   * no cadence choice, so `usageRefreshMs(undefined)` supplies the conservative shared default.
   * The interval is read once per boot: re-arming it inside a tick can cancel a timer while it is
   * running, and retrying immediately after a failure would spend the quota the loop measures.
   */
  const fleetRefreshIntervalMs = await subsystems.fleet.config().then(
    declared => usageRefreshMs(declared.usage.interval),
    () => usageRefreshMs(undefined),
  );
  // Start a collection after binding but do not make a slow provider probe delay daemon readiness.
  // The loop serializes it with the fixed timer below, and all failures remain in the existing feeds.
  void subsystems.fleetRefresh.run();
  const fleetRefreshTicks = setInterval(() => {
    void subsystems.fleetRefresh.run();
  }, fleetRefreshIntervalMs);
  cleanups.push(() => clearInterval(fleetRefreshTicks));
  /**
   * The analytics ingestion sweep.
   *
   * THE FIRST PASS RUNS AT BOOT, and it is a REBUILD when the store reported that nothing survived
   * being opened — a schema this daemon does not recognise, or a file naming another state home. A
   * daemon that has just restarted is also exactly when the store is most likely to be behind: every
   * session that ended while the process was down went uningested, and the sweep is what catches up.
   *
   * THE PASS IS A SWEEP, NOT A TRIGGER, and correctness does not depend on its cadence. What decides
   * whether a session is ingested is the durable terminal-state gate, so a session that ends between
   * two ticks is ingested by the next one with exactly the same result. A cheap pass is the common
   * case: a session already ingested with a proven total has its transcript read once, ever.
   *
   * Errors are swallowed for the reason every other background timer swallows its own: an unhandled
   * rejection from a timer takes down a daemon whose fleet is fine. A pass that could not run leaves
   * the index reporting what it does hold, which is the honest reading.
   */
  await (analyticsStore.rebuildRequired ? subsystems.analyticsIngest.rebuild() : subsystems.analyticsIngest.ingest())
    .then(() => undefined)
    .catch(() => undefined);
  const analyticsTicks = setInterval(() => {
    void subsystems.analyticsIngest.ingest().catch(() => undefined);
  }, ANALYTICS_INGEST_INTERVAL_MS);
  cleanups.push(() => clearInterval(analyticsTicks));
  // The registry, durable session reader, exact observer and exact reaper the earlier increment
  // stubbed. Identity is re-checked at the moment of the kill, not at planning time.
  const terminalReaper = world.createTerminalReaper(opened.storage);
  const terminalReapTicks = setInterval(() => {
    void terminalReaper.sweep().catch(() => undefined);
  }, 5_000);
  cleanups.push(() => clearInterval(terminalReapTicks));
  // The warden sweep, armed only once the daemon is actually serving — like the self-check above, and
  // for the same reason: a sweep spawns sessions, and it must not race the bind it would report on.
  //
  // It arms LAST because arming fires a boot sweep, and that sweep reads the fleet and may spawn. The
  // disarm is registered like every other acquisition, so a stopped daemon does not leave a timer
  // firing at closed storage. A failure to arm is swallowed for the reason the ticks swallow theirs:
  // a daemon whose fleet is fine must not fail to serve because its supervisor could not start, and
  // the absence is already visible as `wardenTimerArmed: false` on its own health report.
  await subsystems.warden
    .arm()
    .then(disarm => cleanups.push(disarm))
    .catch(() => undefined);
  /**
   * The handover reconciler, armed beside the warden sweep and after the bind, because a pass can
   * start a session, write to a board and stop an agent.
   *
   * ARMING RUNS A PASS IMMEDIATELY, and that is the point rather than a side effect: a daemon that has
   * just restarted is exactly when a handover is most likely to be mid-ladder — nothing advanced it
   * while the process was down — and every phase this domain writes is recorded before its effect, so
   * the pass resumes from the durable receipt rather than re-deciding anything.
   *
   * The disarm is registered like every other acquisition, so a stopped daemon does not leave a timer
   * driving handovers at closed storage. Failures inside a pass are already swallowed by the loop and
   * reported as a receipt that did not advance.
   */
  cleanups.push(subsystems.handoverReconcile.arm());
  // The line an operator greps for. Everything above it is a step that can stall; a log that reaches
  // here and stops is a daemon that is serving, which is a completely different report from one that
  // stops at "state home opened" — and before any of this existed the two were the same empty file.
  world.notices.step('ready', `serving ${config.bindUrl}`);
  await world.untilShutdown();
  world.notices.step('stopping', 'releasing everything this boot acquired');
  return 0;
}

/**
 * `--print-config`: every effective value and where it came from, creating nothing.
 *
 * THIS IS THE COMMAND THAT WOULD HAVE SAVED AN EVENING. A person spent one on `port` and `publicUrl`
 * silently disagreeing — the daemon held both values and every reason for them and had no way to say
 * so, so the whole evening went on guessing at state the binary already knew. Printing values alone
 * would not have been enough; the ORIGIN column is what turns two numbers into "this one I chose and
 * this one was chosen for me".
 *
 * It PEEKS rather than loads, so asking the question does not seed a document, and it never opens
 * storage, so it does not create a state home either.
 */
export async function printConfiguration(world: DaemonWorld): Promise<number> {
  const peeked = await world.config.peek();
  const config = overriddenBy(peeked.config, world.overrides);
  const rows = describeConfiguration({
    document: peeked.document,
    config,
    overrides: world.overrides,
    configFile: world.config.path,
    stateHome: world.stateHome.path,
    stateHomeFromEnvironment: world.stateHome.fromEnvironment,
  });
  writeSync(1, `${renderConfiguration(rows, config, world.config.path)}\n`);
  return 0;
}

/**
 * WHO COULD REDEEM A CODE THIS DAEMON MINTS, on the command somebody runs when pairing will not work.
 *
 * IT IS THE QUESTION `--check` WAS MISSING. The carrier posture beside it answers "can anything off
 * this machine reach me", and this one answers "could anything off it PAIR with me" — so a daemon can
 * report a healthy carrier, a free address and a ready harness while the only thing the owner is
 * trying to do cannot work, for a reason the binary already holds. An advertisement that cannot be
 * handed to another device says so here, hours before a phone is pointed at it.
 *
 * IT NAMES THE RENDEZVOUS A FRESH DEVICE COULD FIND, AND ONLY THAT ONE. Two claims are retired here
 * rather than deleted, because both were written down as justifications and both were wrong in turn.
 * The first was "pairing is the one exchange a relay can never carry", which `docs/relay-protocol.md`
 * §14 retired: a redemption may cross a rendezvous as a sealed one-attempt exchange. The second was
 * this command passing NO carrier and calling the shortfall a uniform under-report — but a default
 * install binds loopback and dials the DISCOVERED hosted rendezvous, so that reading printed "no QR is
 * drawn" about a daemon a phone can in fact pair with. It now takes {@link discoverableRelayUrl}'s
 * answer, the same value the boot hands the pairing service.
 *
 * WHAT REMAINS IS THE DECLARED GAP, AND IT IS NARROWER THAN THE OLD SENTENCE: a rendezvous an operator
 * RUNS is not one a fresh device can discover, so a daemon published only on a self-hosted rendezvous
 * still reads as local-only with no QR. That is the correct answer for it — nothing off its LAN could
 * find that address — and closing it needs a link that names a rendezvous, which is deferred. §13
 * records it.
 *
 * THE SENTENCES COME FROM THE PROTOCOL, not from this file. `fy pair`, the browser's Add-a-device
 * panel and this command are three renderings of one fact, and a fourth wording invented here is how
 * three surfaces come to disagree about what an operator should do next.
 *
 * IT REPORTS, IT DOES NOT JUDGE — no exit code moves, exactly as the harness and grant postures do
 * not move it. A daemon nothing can pair with still starts perfectly.
 */
export function describePairingAdvertisement(
  advertisement: Advertisement,
  discoveredRelayUrl?: string,
): readonly string[] {
  const label = 'pairing     ';
  if (advertisement.kind === 'address')
    return [`${label} any device that can reach ${advertisement.url} may redeem a code (${advertisement.origin})`];
  const notice =
    advertisement.kind === 'local-only'
      ? localOnlyNotice(advertisement.url, discoveredRelayUrl)
      : refusalNotice(advertisement.refusal);
  return [`${label} ${notice.audience}`, `             ! ${notice.remedy}`];
}

/**
 * The rendezvous a device that has never met this daemon can find FOR ITSELF, or nothing.
 *
 * ONE DERIVATION, READ BY BOTH THE BOOT AND `--check`, so the QR `fy pair` draws and the sentence
 * `fyd --check` prints cannot disagree about the same daemon. That disagreement is not hypothetical:
 * this fact was briefly derived in the pairing service as "the first published relay of any kind",
 * and `--check` passed nothing at all — two answers for one question, one of them wrong.
 *
 * `kind === 'discovered'` IS THE WHOLE PREDICATE, and it is exact rather than approximate.
 * `chooseRelayCarrierSource` answers `configured` for an explicit `relay` block — which wins
 * unconditionally — and `discovered` only for an address read out of the hosted directory
 * advertisement. That is the same advertisement the scanning device's own build reads, so a
 * `discovered` source is true when and only when a fresh phone will find the same address. A
 * self-hosted deployment therefore discloses nothing and draws no QR for a loopback bind: the
 * declared GAP in `docs/relay-protocol.md` §13, failing closed by construction rather than by a
 * check somebody has to remember.
 *
 * `dialledRelayUrl` is what makes "enabled" part of the answer: a discovered entry the operator
 * switched off is not a carrier, and disclosing it would promise a path nothing is dialling.
 */
export function discoverableRelayUrl(sources: readonly RelayCarrierSource[]): string | undefined {
  for (const source of sources) {
    if (source.kind !== 'discovered') continue;
    const url = dialledRelayUrl(source);
    if (url !== undefined) return url;
  }
  return undefined;
}

/**
 * `--check`: whether this daemon would start, and what it would do, without doing any of it.
 *
 * NO DIRECTORY, NO LOCK, NO BIND. The address is probed — a request to an address is not a change to
 * this machine — and everything else is read. It exists for the same reason the argument surface
 * does: "tell me if this will work" was precisely what was missing when asking the binary its
 * version silently provisioned a state home.
 *
 * IT REPORTS THE OCCUPANT RATHER THAN A VERDICT ALONE, because "it would not start" is not useful on
 * its own and "another daemon is already serving that address" and "something unidentified holds it"
 * need different things done about them.
 */
export async function checkConfiguration(
  world: DaemonWorld,
  say: (text: string) => void = text => void writeSync(1, `${text}\n`),
): Promise<number> {
  const peeked = await world.config.peek();
  const config = overriddenBy(peeked.config, world.overrides);
  say(`state home   ${world.stateHome.path}`);
  say(`config file  ${world.config.path}${peeked.document === undefined ? '  (not written yet)' : ''}`);
  /**
   * The harnesses, BEFORE the address, so every one of the exits below has already reported them.
   *
   * It does not change the exit code, and that is deliberate rather than an omission: this command
   * answers "would this daemon start", and a daemon with no harness installed starts perfectly. What
   * it cannot do is launch a session, which is a different sentence and is printed as one. Refusing
   * here would also contradict the boot, which warns and starts.
   */
  const harnesses = await readHarnesses(
    world.harnesses.accounts,
    world.harnesses.executables,
    harnessDeclarations(config),
  );
  for (const line of renderHarnessPreflight(harnesses, CLIENT_NAME)) say(line);
  const directorySyscalls = (() => {
    try {
      loadDirectorySyscalls();
      return true;
    } catch {
      return false;
    }
  })();
  const doctor = readDoctorReport({
    platform: process.platform,
    executables: world.harnesses.executables,
    harnesses,
    directorySyscalls,
  });
  for (const line of renderDoctorReport(doctor)) say(line);
  /**
   * The grant posture, BEFORE the address, beside everything else this command reports.
   *
   * IT IS HERE BECAUSE A PERSON ASKING "would this daemon start" IS THE PERSON WHO SHOULD BE TOLD.
   * The standing complaint about this product is that it knows something and does not say it, and
   * "what will this let a phone do once it is up" is knowable from the document already read. It does
   * not change the exit code, exactly as the harness preflight does not: a daemon with any grant
   * posture starts perfectly, and this reports rather than judges.
   *
   * IT READS, IT DOES NOT CREATE. `passwordSet` is one existence check through the same verifier
   * port the grant service uses, so a query stays a query and there is no second source to drift.
   */
  /**
   * THE CARRIER POSTURE, BEFORE THE ADDRESS AND BEFORE THE GRANTS.
   *
   * THIS IS THE COMMAND THE OWNER REACHES FOR WHEN SOMETHING IS WRONG, and "can anything off this
   * machine reach it at all" is the first thing that matters — a bound address a phone cannot get to
   * is not a working daemon. It reads the directory exactly as a boot would, which is what makes the
   * answer the real one rather than a guess about what a boot might decide; that is one outbound
   * request, which is the same latitude this command already takes when it probes an address.
   *
   * An ordinary direct-only or disabled posture does not change the exit code because that daemon
   * starts perfectly. A duplicate discovered rendezvous is a refused configuration and does.
   */
  // The same sentence the boot states, in this command's column. The TEXT is the boot's, whole and
  // unaltered — a reader comparing a `--check` against a log must be able to see one fact, not two
  // renderings of it — and only the label in front of it belongs to this table.
  const directCarrier = directCarrierPublication(config);
  if (directCarrier.kind === 'omitted') say(`carrier      ${directCarrier.notice}`);
  const resolvedRelays = await resolveRelayCarrierSources(config, world.relayDirectory);
  let carrierForGrants: RelayCarrierSource | undefined;
  let carrierExitCode = 0;
  // Absent for a refused set, because a refusal names no carrier this daemon would dial and claiming
  // a redeemable link off one would be the same wrong answer the grant posture refuses to invent.
  let discoveredRelay: string | undefined;
  if (resolvedRelays.kind === 'refused') {
    say(`carrier      refused — ${resolvedRelays.reason}`);
    carrierExitCode = 1;
  } else {
    for (const carrier of resolvedRelays.sources) {
      say(describeRelayCarrierPosture(carrier, world.config.path));
    }
    const dialled = resolvedRelays.sources.find(carrier => dialledRelayUrl(carrier) !== undefined);
    carrierForGrants = dialled ?? resolvedRelays.sources[0];
    discoveredRelay = discoverableRelayUrl(resolvedRelays.sources);
    // The remedy is GLOBAL: it says this daemon dials no relay. An inactive entry beside an active
    // sibling gets its own posture line above, never a false claim that nothing off-host can connect.
    if (dialled === undefined && carrierForGrants !== undefined) {
      for (const line of relayCarrierRemedy(carrierForGrants, world.config.path, config.host)) {
        say(`             ! ${line}`);
      }
    }
  }
  // Directly beneath the carrier, because this is the address that has to work on its own and whether
  // anybody but this machine can dial it. It DOES read the carrier above it now, through the one
  // derivation the boot uses, so this line and the QR `fy pair` draws for the same daemon agree. Two
  // earlier comments here are retired: "pairing cannot use a carrier" (§14 retired it) and "this line
  // passes no candidate, so it under-reports" (it passes one for the case a device can discover). What
  // survives is narrower and is the declared GAP: a SELF-HOSTED rendezvous is not discoverable, so a
  // daemon on one still reads as local-only here — correctly, since no fresh device could find it.
  for (const line of describePairingAdvertisement(config.advertisement, discoveredRelay)) say(line);
  /**
   * A REFUSED CARRIER SET HAS NO GRANT POSTURE, AND SAYING SO IS THE WHOLE POINT.
   *
   * The posture is derived from the carrier this daemon would dial, and a refused set names no such
   * carrier — so the derivation falls all the way through to "loopback bind, no relay" and prints
   * `nothing off this host can reach this daemon`. That sentence is FALSE for the operator it is
   * shown to: they declared two rendezvous, and the refusal three lines above says so. It also sends
   * them at the opposite remedy, in the one command a person runs when something is already wrong.
   *
   * Undetermined is the honest answer and it fails closed, exactly as an undetermined document does
   * everywhere else here: nothing is claimed about a configuration this daemon has refused to act on.
   */
  if (resolvedRelays.kind === 'refused') {
    say(
      'grants       not reported — the carrier configuration above is refused, so what a caller off ' +
        'this host could do is undetermined until it is corrected',
    );
  } else {
    for (const line of describeGrantPosture({
      config,
      passwordSet: await world.operatorPassword.isSet().catch(() => false),
      clientName: CLIENT_NAME,
      carrier: carrierForGrants,
    }))
      say(line);
  }
  const checkExitCode = Math.max(doctor.ready ? 0 : 1, carrierExitCode);
  if (config.portIsRecorded) {
    const occupant = await world.boot.probe.identify({ url: config.bindUrl });
    if (occupant.kind === 'vacant') {
      say(`address      ${config.bindUrl}  (free — this daemon would bind it)`);
      return checkExitCode;
    }
    const refusal = refuseOccupiedAddress({
      daemonName: DAEMON_NAME,
      clientName: CLIENT_NAME,
      url: config.bindUrl,
      configFile: world.config.path,
      occupant,
    });
    say(`address      ${config.bindUrl}  (taken)`);
    say('');
    say(`! ${refusal.message}`);
    return Math.max(refusal.exitCode, checkExitCode);
  }
  // No port is recorded, so this reports the walk a first boot would take rather than one address.
  const candidates = portCandidates(world.boot.preferredPort);
  for (const port of candidates) {
    const candidate = configuredAt(config, port);
    const occupant = await world.boot.probe.identify({ url: candidate.bindUrl });
    if (occupant.kind === 'vacant') {
      say(`address      ${candidate.bindUrl}  (free — this daemon would take and record it)`);
      return checkExitCode;
    }
    say(
      `address      ${candidate.bindUrl}  (taken — ${occupant.kind === 'daemon' ? `another ${DAEMON_NAME}` : occupant.evidence})`,
    );
  }
  const refusal = refuseExhaustedCandidates(DAEMON_NAME, candidates, world.config.path);
  say('');
  say(`! ${refusal.message}`);
  return Math.max(refusal.exitCode, checkExitCode);
}

async function execute(answer: ArgumentAnswer & { readonly kind: 'boot' | 'check' | 'print-config' }): Promise<number> {
  const cleanups: Array<() => void | Promise<void>> = [];
  // ONE journal for the whole invocation, built before the world so a world that throws while it is
  // being assembled is still reported. `buildWorld` resolves the state home and opens a filesystem;
  // when that failed, the only thing this daemon had ever written was nothing at all.
  const notices = bootJournal(answer.overrides.logLevel);
  try {
    const world = { ...buildWorld(answer.overrides), notices };
    // The two queries answer from the same world the boot would have used, so what they report is
    // what would actually happen — and neither of them opens storage, so neither creates anything.
    if (answer.kind === 'print-config') return await printConfiguration(world);
    if (answer.kind === 'check') return await checkConfiguration(world);
    return await start(world, cleanups);
  } catch (error) {
    // The stack too, not just the message: this is the branch a crash during startup lands in, and a
    // one-line message with no frames is the difference between a bug report and a shrug.
    notices.state(error instanceof Error ? (error.stack ?? error.message) : String(error));
    return 1;
  } finally {
    // Each cleanup runs in its own try/catch so a failing one never masks the exit code.
    for (const cleanup of cleanups) {
      try {
        await cleanup();
      } catch {
        // Intentionally ignored: cleanup failures must not change the result.
      }
    }
  }
}

/**
 * The command line, answered before anything is built.
 *
 * FIRST, and that is the whole point: `buildWorld` resolves a state home and opens a filesystem, and
 * `start` creates the directory tree, takes the lifetime lock and probes the address. Asking this
 * binary its version used to do all of that. Nothing below this branch runs for a query.
 */
if (import.meta.main) {
  const answer = answerArguments(process.argv.slice(2), {
    daemonName: DAEMON_NAME,
    clientName: CLIENT_NAME,
    version: daemonVersion,
  });
  if (answer.kind === 'print') {
    writeSync(1, `${answer.text}\n`);
    process.exit(answer.exitCode);
  }
  if (answer.kind === 'refuse') {
    writeSync(2, `${answer.text}\n`);
    process.exit(answer.exitCode);
  }
  process.exit(await execute(answer));
}
