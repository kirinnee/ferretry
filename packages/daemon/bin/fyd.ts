#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  existsSync,
  constants as fsConstants,
  realpathSync,
  statSync,
  writeSync,
} from 'node:fs';
import { mkdir, realpath, rm, stat } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import {
  AGENDA_ENV,
  ALWAYS_ON_SECTIONS,
  agendaNudgeEnabled,
  CredentialStatusService,
  configJsonSchemaFiles,
  FleetIdentityService,
  FleetTokenRefreshService,
  HARNESS_BINARIES,
  type HarnessKind,
  HYPERMEDIA_ENV,
  hostCodexCredentialFile,
  hostCodexHome,
  InMemoryCredentialStatusStore,
  launchInstructions,
  type ModelCatalog,
  manifestRuntimes,
  PACK_ENV,
  PACK_ROUTING_ENV,
  PASSIVE_LEARNING_ENV,
  resolveDefaultRuntime,
  runtimeIdsPath,
  SUB_FERRET_ENV,
  sanitizeHarnessEnv,
  sharedHistoryPoolDirectory,
  wrapperNameOf,
} from '@ferretry/fleet';
import {
  claudeKeychainAccount,
  credentialFileStamp,
  FileConversationLeaseStore,
  FilePassiveUsageStore,
  type FleetBinaryLookup,
  PlatformFleetCredentialStore,
  ProcessFleetTokenRefreshPort,
  resolveUserHome,
  SpawnCredentialCommand,
  spawnFleetTokenRefreshProcess,
} from '@ferretry/fleet/adapters';
import {
  type Advertisement,
  type AgendaItem,
  type AnalyticsPricingRate,
  type AutoResumeSummary,
  CONFIG_ACCEPTED_FILE,
  type ConversionPreview,
  type ConversionSummary as ConversionSummaryView,
  commandLabel,
  configFilePath,
  DORMANT_AGENT_STATUSES,
  type FleetCredentialList,
  FY_DEFAULT_DAEMON_PORT,
  type Harness,
  ioPressureView,
  type LearningConfig,
  localOnlyNotice,
  type MigrationConversation,
  mcpOAuthSecretNames,
  PACK_CLEAN_UP_LABEL,
  type PackConfig,
  type PackRefusal,
  ProtocolVersionSchema,
  type RegisterProjectRequest,
  type RuntimeControlRequest,
  type RuntimeModelChoice,
  refusalNotice,
  type SessionConfig,
  SessionConfigSchema,
  type SessionHandoff,
  SessionStateSchema,
  type SessionView,
  type SessionWorkerPool,
  type SignalSessionRequest,
  type StartSessionRequest,
  StartSessionRequestSchema,
  sessionAgendaEnabled,
  sessionHypermediaEnabled,
  TERMINAL_MAX_GLOBAL,
  TERMINAL_MAX_PER_SESSION,
  type TranscriptProvenance,
  type WardenGuardConfig,
} from '@ferretry/protocol';
import { processIncarnationFor } from '@ferretry/protocol/process-incarnation';
// One WebCrypto binding of the relay's crypto port serves the daemon, the browser and the Worker that
// verifies the claim. Two implementations that agree about a primitive and disagree about an encoding
// is the class of bug this removes.
import { deviceRotateMessage, verifyDeviceProof } from '@ferretry/relay';
import { WebCryptoRelayCrypto } from '@ferretry/relay/adapters';
import type { z } from 'zod';
// The hosted app's release key, the one its signed release list is checked with — and so the published
// model catalog the list vouches for (docs/model-catalog.md). Compiled in as text, from its one file.
import HOSTED_APP_RELEASE_KEY from '../../pwa/release-signing-key.pub' with { type: 'text' };
import pkg from '../package.json' with { type: 'json' };
import { FileAgendaFileStore } from '../src/adapters/agenda/file-agenda-file-store.ts';
import { FileAgendaFilesMigrationMarker } from '../src/adapters/agenda/file-agenda-files-migration-marker.ts';
import { FileAgendaLedgerRepository } from '../src/adapters/agenda/file-agenda-ledger-repository.ts';
import { FileAgendaMigrationMarker } from '../src/adapters/agenda/file-agenda-migration-marker.ts';
import { FileAgendaOutboxRepository } from '../src/adapters/agenda/file-agenda-outbox-repository.ts';
import { KeyedAgendaReplyTimers } from '../src/adapters/agenda/keyed-agenda-reply-timers.ts';
import {
  LedgerAgendaReceipts,
  PaneAgendaComposer,
  SendAgendaMessenger,
} from '../src/adapters/agenda/send-agenda-delivery.ts';
import { SessionConfigAgendaModes } from '../src/adapters/agenda/session-agenda-modes.ts';
import { armSessionTurnChanges, StorageSessionStops } from '../src/adapters/agenda/session-turn-stops.ts';
import { armAgendaNudge, StorageAgendaNudgeSessions } from '../src/adapters/agenda/storage-agenda-nudge.ts';
import { StorageAgentSessions } from '../src/adapters/agenda/storage-agent-sessions.ts';
import {
  StorageHarnessPromptJournal,
  StorageHarnessPromptStates,
  StorageHarnessQuestionAnswerer,
} from '../src/adapters/agenda/storage-harness-prompt.ts';
import { StorageSessionAgendaState } from '../src/adapters/agenda/storage-session-agenda-state.ts';
import { StorageCredentialedSessions } from '../src/adapters/agent-tools/index.ts';
import {
  BunSqliteAnalyticsStoreFactory,
  HttpAnalyticsPricingFeed,
  InlineAnalyticsPersister,
  readAnalyticsTranscriptEvidence,
  WorkerAnalyticsPersister,
  WorkerTranscriptFolds,
} from '../src/adapters/analytics/index.ts';
import { KeyedSerialExecutor as LearningSerialExecutor } from '../src/adapters/atomic-file/index.ts';
import {
  decryptPdfInMemory,
  FileAttachmentOriginals,
  FileSessionAttachmentStore,
  NodeRawDeflate,
  probePdfDecryptWorker,
} from '../src/adapters/attachments/index.ts';
import { FileBoardStore } from '../src/adapters/board/file-board-store.ts';
import { FileSweepMemory } from '../src/adapters/board/file-board-sweep-state.ts';
import { StoreBoardAttachments } from '../src/adapters/board/board-attachments.ts';
import { SendReopenMessenger } from '../src/adapters/board/send-reopen-messenger.ts';
import {
  JournalBoardChanges,
  JournalBoardChecks,
  StorageSessionFocus,
  StorageSessionParents,
  StorageSubFerretDirectory,
} from '../src/adapters/board/session-board-adapters.ts';
import { type LivenessLedgerReader, StorageSessionRoster } from '../src/adapters/board/session-roster.ts';
import { GhCliRunner, GitWorkingCopies } from '../src/adapters/board-github/index.ts';
import {
  AgendaImportAgenda,
  FileBoardImportMarker,
  FileLegacyTaskSource,
  StorageImportSessions,
} from '../src/adapters/board-import/index.ts';
import { FileAcceptedConfigStore, FileConfigDirectory } from '../src/adapters/config-files/files.ts';
import { unrefFileEventTimers } from '../src/adapters/file-events/bun-file-event-source.ts';
import { platformFileEventSource } from '../src/adapters/file-events/platform.ts';
// U12 launch policy: old runtime names, and what a Codex runtime leaves behind when its session ends.
import {
  fileFleetCatalogDeps,
  readDeclaredAccountModel,
  sessionStatusOf,
} from '../src/adapters/fleet/account-model-files.ts';
import { readFleetManifest } from '../src/adapters/fleet/manifest-file.ts';
import { RuntimeAwareAccountInventory, RuntimeIdsFile } from '../src/adapters/fleet/runtime-ids-file.ts';
import { RuntimeSessionRecords } from '../src/adapters/fleet/runtime-session-records.ts';
import { fileFleetSetupDeps } from '../src/adapters/fleet/setup-files.ts';
import {
  CredentialEmailReader,
  ensurePrivateDirectory,
  runCredentialHarness,
} from '../src/adapters/fleet-credentials/credential-facts.ts';
import { deliverCodexCallback } from '../src/adapters/fleet-login/callback-delivery.ts';
import { harnessLoginTimer, spawnHarnessLoginChild } from '../src/adapters/fleet-login/login-child.ts';
import { systemPortHolders } from '../src/adapters/fleet-login/port-holders.ts';
import {
  FileSessionForkReceiptStore,
  forkOpeningTurnRefusal,
  forkReceiptFile,
  type SessionForkStartAccountResolver,
  SessionForkTargetBinder,
  SessionForkTargetResolver,
} from '../src/adapters/fork/index.ts';
import { BunGitRunner } from '../src/adapters/git/index.ts';
import { FileHandoverReceiptStore } from '../src/adapters/handover/file-handover-receipt-store.ts';
import {
  HOUSEKEEPING_WORKER,
  HousekeepingCodexRollouts,
  InlineHousekeepingJobs,
  WorkerCredentialPorts,
  WorkerHousekeepingJobs,
} from '../src/adapters/housekeeping/index.ts';
import {
  AgendaLaneAgenda,
  AnalyticsTranscriptSpend,
  AsyncActivityScope,
  AuthorizedProviderProbe,
  type BrowserDisplayPort,
  BrowserLoginWindowService,
  BrowserProfileStore,
  BrowserWorkerClient,
  BunApiServer,
  BunConnectorProcesses,
  BunProcessProbe,
  BunRelayCarrier,
  BunSecretChildRunner,
  BunSecretShell,
  BunSqliteIndexFactory,
  bundledWorkerUrl,
  CachedUsageFeed,
  CliUpdateLauncher,
  CloudflaredLocator,
  ConfigGrantDocument,
  ConfigSecretRecipes,
  DaemonBinder,
  DaemonHealthProbe,
  DaemonSecretsLoader,
  DaemonStorageFactory,
  daemonSecretSourceProgram,
  describeWorkerProbes,
  ExplicitDaemonConfig,
  FetchEnhancementTransport,
  FileAuditJournal,
  FileCgroupApplyStatusStore,
  FileCgroupConfigStore,
  FileDaemonConfig,
  FileLaneSetStore,
  FileLegacyWireUseStore,
  FileModelCatalogCache,
  FileProjectCatalog,
  FileQuotaFailoverConfigStore,
  FileQuotaFailoverStateStore,
  FileRestartQueue,
  FileRoutingCatalog,
  FileScratchCollector,
  FileSecretDocumentStore,
  FileSecretKey,
  FileSessionSpawnFacts,
  FileSpeedupTestLedger,
  FileTunnelHolding,
  FileUpdateDocuments,
  foreignHistoryRoots,
  GitHubLatestRelease,
  GitProjectFacts,
  GitRepositoryProbe,
  HostedModelCatalog,
  HostedRelayDirectory,
  HostedTunnelProvisioner,
  HostedTunnelService,
  HostHarnessFacts,
  HostHarnessProbe,
  HostInstallFacts,
  HttpUsageSource,
  hostCgroupFacts,
  InlineIndexFile,
  JournalGrantAudit,
  JscStackSampler,
  KeyedSerialExecutor,
  LoadSafeWorker,
  ManifestAccountInventory,
  MCP_OAUTH_SECRETS_DOCUMENT,
  NodeBrowserLoginRuntime,
  NodeCatalog,
  NodeConversationFiles,
  NodeConversationLinker,
  NodeDataChannelEngine,
  NodeForeignHistoryFiles,
  NodePairingCryptography,
  NodeSessionBrowserLauncher,
  NodeSkillFiles,
  NpmHarnessLatest,
  type OpenedDaemonStorage,
  PaneProcessInventory,
  PerformanceStopwatch,
  ProcCgroupPlacements,
  ProjectMcpServers,
  probeBundledWorker,
  quotaFailoverRoot,
  RegisteredCgroupPaneLedger,
  RuntimeEnvironment,
  SocketViewerDownstream,
  SpawnCgroupCommands,
  SqliteHomeLockFactory,
  STACK_SAMPLER_VARIABLE,
  StateApiCredentials,
  StateFileSystem,
  StateFileSystemFactory,
  StateHomeLayout,
  StateHomeLockedError,
  StatePairingRepository,
  StatePasskeyStore,
  StatePushRepository,
  StateSecuritySettingsDocument,
  StateUnlockLedger,
  StateVapidKeys,
  StorageConversationOwners,
  StorageSessionFacts,
  StorageSessionProjectStamp,
  SystemClock,
  SystemFrameClock,
  SystemGrantClock,
  stackSamplerEnabled,
  systemLegacyWireTimers,
  TmuxPaneSnapshot,
  TunnelProxyProbe,
  type ViewerSocket,
  WebCryptoPasskeyCrypto,
  WebCryptoRelayIdentityKeys,
  WebCryptoSecretCipher,
  WebPushFetchTransport,
  type WorkerClientOptions,
  WorkerIndexFile,
  WorkerLoopWatchdog,
  type WorkerProbeReport,
  XvfbDisplay,
} from '../src/adapters/index.ts';
import {
  CatalogPrices,
  ConfigFileLearningSettings,
  DirectoryLessonSessions,
  FileLearningStore,
  FleetGlobalLessons,
  LEARNING_MINER_LABEL,
  LearningMiner,
  NodeLessonFiles,
  SessionPassiveChannel,
} from '../src/adapters/learning/index.ts';
import {
  FileClaudeLocalScope,
  FileMcpHarnessDocuments,
  TransportMcpProbe,
} from '../src/adapters/mcp-inventory/index.ts';
import {
  AccountModelMcpServers,
  FetchMcpOAuthHttp,
  FileMcpOAuthStateStore,
  webCryptoMcpOAuth,
} from '../src/adapters/mcp-oauth/index.ts';
import { FileConversationFiles } from '../src/adapters/migrate/file-conversation-files.ts';
import { FileMigrationReportStore } from '../src/adapters/migrate/file-migration-report.ts';
import { AutoTitlingSendChannel, FileNameClaimStore, FileSystemCallsignCounters } from '../src/adapters/names/index.ts';
import { FileNotificationDeliveryLedger } from '../src/adapters/notifications/index.ts';
import {
  bunProbeSpawn,
  CliPackProbe,
  FileCleanUpRunStore,
  FilePackSpendLedger,
  FileReplacedGuide,
  FileRoutingMigrationBackup,
  readSessionResult,
} from '../src/adapters/pack/index.ts';
import { FilePinRepository, FilePinSessionDirectory } from '../src/adapters/pins/index.ts';
import { HostCodexAppServerProcesses } from '../src/adapters/process/codex-app-server-stopper.ts';
import { runPackageInstall } from '../src/adapters/process/package-install.ts';
import { releaseAcquired, terminationGate } from '../src/adapters/runtime/termination-gate.ts';
import {
  AccountAutoResumeAvailability,
  BootExitRecorder,
  FileAutoResumeLedger,
  FileAutoResumeSummaryStore,
  RepositoryAutoResumeRoster,
  StorageAutoResumeJournal,
} from '../src/adapters/session/auto-resume/index.ts';
import { FileSessionEffectLedger } from '../src/adapters/session/effects/index.ts';
import { loadDirectorySyscalls } from '../src/adapters/session/filesystem/directory-syscalls.ts';
import {
  PosixSessionRootPinner,
  ProcfsSessionRootPinner,
  RunnerSessionGit,
} from '../src/adapters/session/filesystem/index.ts';
import {
  CodexAppServerCatalog,
  readPersistedFast,
  readPersistedReasoningEffort,
  TmuxCodexPickerDrive,
  TmuxCodexPickerPane,
} from '../src/adapters/session/harness/index.ts';
import { FileLaunchSettingsDigest } from '../src/adapters/session/launch/index.ts';
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
  TmuxSessionExitObserver,
  TmuxSessionLifecycleLauncher,
} from '../src/adapters/session/lifecycle/index.ts';
import {
  RuntimeSupervisedLauncher,
  RuntimeSupervisedReaper,
} from '../src/adapters/session/lifecycle/runtime-launch-supervision.ts';
import {
  FileCompactionHistory,
  FileTranscriptChanges,
  StorageLiveActivitySource,
} from '../src/adapters/session/live/index.ts';
import {
  FileWaitHeartbeat,
  MonitorTickRunner,
  SendMonitorNudge,
  StorageMonitorWaits,
} from '../src/adapters/session/monitor/index.ts';
import {
  DEFAULT_WORKER_SUPERVISOR_SETTINGS,
  InlineObserverHost,
  SessionObservationApplier,
  WorkerObserverHost,
  WorkerSupervisor,
} from '../src/adapters/session/observer/index.ts';
import {
  HarnessProcessProvenance,
  processTreeFor,
  RegularOutputFile,
  SigtermProcessSignal,
} from '../src/adapters/session/processes/index.ts';
import { StorageSessionProvenanceStore } from '../src/adapters/session/provenance/index.ts';
import {
  FileAnswerLedger,
  readAskedQuestion,
  TmuxStructuredQuestionDriver,
} from '../src/adapters/session/question/index.ts';
import {
  FileSessionQueueStore,
  SendPathDeliveryView,
  SendPathQueueTransport,
} from '../src/adapters/session/queue/index.ts';
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
  FileSendReproofMarker,
  FileSendTurnStore,
  ResumeSendReviver,
  StorageSendRepository,
  TimerSendScheduler,
  TmuxSendTerminal,
} from '../src/adapters/session/send/index.ts';
import { sessionAddressCandidates } from '../src/adapters/session/session-address-candidates.ts';
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
  StorageTranscriptClaims,
  StorageTranscriptDigestJournal,
  StorageTranscriptProvenanceStore,
  sessionMessageTokenKeyFile,
  storedSessionStart,
  storedTranscriptProvenance,
} from '../src/adapters/session/transcript/index.ts';
import { StorageTurnPorts, storagePaneLimits } from '../src/adapters/session/turn/index.ts';
import { FileMcpProjectFiles } from '../src/adapters/session-mcp/project-files.ts';
import type { DaemonStorage } from '../src/adapters/storage/session-storage.ts';
import { BunDetachedLauncher } from '../src/adapters/system/detached-launcher.ts';
import { ProcIoPressure } from '../src/adapters/system/proc-io-pressure.ts';
import {
  ManagedTerminalService,
  systemLoginShell,
  TerminalRuntimeError,
  TerminalServiceError,
  TerminalStreamBridge,
  type TerminalStreamScheduler,
  TmuxTerminalRuntime,
} from '../src/adapters/terminal/index.ts';
import {
  BunTmuxProcess,
  ControlModeTmuxProcess,
  RealHarnessLaunchGuard,
  TmuxPaneDelivery,
  TmuxPaneQueue,
  TmuxReleaseReader,
} from '../src/adapters/tmux/index.ts';
import { CliConversionCheck, CliHarnessVersion } from '../src/adapters/transcript/conversion-check.ts';
import {
  LOOP_PARSE_PACING,
  NodeTranscriptFileRuntime,
  NodeTranscriptImageFiles,
  NodeTranscriptSource,
  TranscriptParseWorker,
  WorkerConversationDescriber,
  WorkerConversationIndex,
  WorkerForeignTranscriptReader,
  WorkerTranscriptImages,
  WorkerTranscriptSource,
} from '../src/adapters/transcript/index.ts';
import { CliRolloutFormatProbe } from '../src/adapters/transcript/rollout-format-probe.ts';
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
  ConfigFileWardenConfigStore,
  FileWardenArtifacts,
  FileWardenJevCheckLog,
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
  AgendaCardLinks,
  BOARD_SWEEP_INTERVAL_MS,
  BoardService,
  BoardSweep,
  BoardTurnCheck,
  DoneDeliveryLadder,
  LivenessActivityDeriver,
  ReopenDeliveryLadder,
  SessionCards,
  type SessionLivenessSource,
} from '../src/lib/board/index.ts';
import { isSubFerret, nudgeTarget } from '../src/lib/sub-ferret/index.ts';
import { GitHubWatcher, UnfiledRefiler } from '../src/lib/board-github/index.ts';
import { BoardImporter, LaneSetImportProjects, type TaskAssigneeCandidate } from '../src/lib/board-import/index.ts';
import {
  ConfigChangeLedger,
  ConfigChangeStreamService,
  ConfigFilesService,
  type ConfigTreeEvents,
  watchConfigFiles,
} from '../src/lib/config-files/index.ts';
import { FILE_EVENT_POLL_MS, FileEventHub } from '../src/lib/file-events/index.ts';
import { AccountModelAgentControlPolicy, type AgentControlPolicy } from '../src/lib/fleet/agent-control.ts';
import { FleetCatalogService } from '../src/lib/fleet/catalog-service.ts';
import { CodexAppServerSupervisor } from '../src/lib/fleet/codex-runtime.ts';
import {
  CREDENTIAL_LIST_FRESH_MS,
  createFleetCredentialsSubsystem,
  FleetCredentialCatalog,
} from '../src/lib/fleet/credentials-service.ts';
import { DisableExpiryWatch } from '../src/lib/fleet/disable-expiry.ts';
import { createFleetSetupSubsystem } from '../src/lib/fleet/setup-service.ts';
import { type RuntimeNamesPort, resolveStartAccount } from '../src/lib/fleet/start-resolution.ts';
import { polledDirectoryLimitations } from '../src/lib/performance/fallbacks.ts';
import { withSystemCallsign } from '../src/lib/runtime/mounts/system-session-control.ts';
import { ProcessHistory, SessionProcessService } from '../src/lib/session/processes/index.ts';
import { OpenUrlService } from '../src/lib/system/open-url.ts';

/** The ordinary revive a send uses, as the auto-resume pass sees it. */
type AutoResumeRevive = (id: string, message: string | undefined) => Promise<void>;

/** What the composition root drives: record at boot, work the ledger off once serving. */
interface AutoResumeBoot {
  /** Persists what the first self-check found. Call once, straight after that check. */
  recordBootExits(): Promise<void>;
  run(): Promise<AutoResumeSummary | undefined>;
}

import {
  countedFileOperations,
  instrumentChildProcesses,
  ProcessGauges,
} from '../src/adapters/runtime/performance-instruments.ts';
import { ToolInstallService } from '../src/lib/fleet/tool-install.ts';
import { HarnessLoginService } from '../src/lib/fleet-login/service.ts';
import {
  SessionForkFacade,
  type SessionForkIdFactory,
  SessionForkService,
  sessionForkKey,
} from '../src/lib/fork/index.ts';
import {
  HANDOFF_READ_MAX_BYTES,
  type HandoffDocuments,
  isReadableHandoff,
} from '../src/lib/imports/conversation-text.ts';
import {
  type AccountInventoryPort,
  AccountModelConversationListPolicy,
  ActivityLedger,
  type AgendaActor,
  AgendaAgentClearer,
  AgendaBoardUndelivered,
  AgendaBuzz,
  AgendaChangeFanout,
  AgendaConversation,
  AgendaReplyBatcher,
  AgendaReplyDelivery,
  AgendaResurfacer,
  AgendaService,
  AgendaTurnNudge,
  AgendaWaker,
  AgentSendFailureNotifier,
  AgentToolService,
  ANALYTICS_BACKSTOP_MS,
  ANSWER_MAY_HAVE_LANDED,
  ANSWER_NOT_DELIVERED,
  type AnalyticsIndexStoreFactory,
  type AnalyticsIngestCandidate,
  type AnalyticsIngestCandidateSource,
  AnalyticsIngestionService,
  type AnalyticsSubsystem,
  type AnalyticsTranscriptEvidenceSource,
  type AnalyticsTranscriptFoldSource,
  AnswerAcknowledged,
  AnswerAlreadyAnswered,
  AnswerReleased,
  AnswerRequestConflict,
  AnswerTerminalFailure,
  AnswerToolAlreadyHandled,
  AnswerUnconfirmed,
  type ApiServerHandle,
  type ApiServerPort,
  type ArgumentAnswer,
  AUDIT_FOLD_WINDOW_MS,
  AuditedPairingService,
  AuditLog,
  AutoResumeService,
  adoptAgendaDefault,
  adoptedTranscriptProvenance,
  advertisesForeignAddress,
  agendaBlockNotice,
  agentSpokenName,
  answerArguments,
  answerOf,
  answerPaused,
  attachmentDirectory,
  authorizeSessionCommand,
  BACKGROUND_DELAY_VARIABLE,
  BackgroundLane,
  type BootNoticePort,
  BootProgress,
  type BootRefusal,
  type BrowserLoginLifecycle,
  BrowserProxyTester,
  type BrowserSessionLauncher,
  BrowserSessionService,
  type BrowserViewerHost,
  BrowserViewerStream,
  type BrowserWorkerProgram,
  buildLaunchArgv,
  CapabilityGrantService,
  type CatalogSubsystem,
  CgroupLaunchPlanner,
  CgroupService,
  ChallengeLedger,
  ClaudeTranscriptParser,
  type ClockPort,
  type CloudflaredLocatorPort,
  CODEX_DISCOVERY_BACKSTOP_MS,
  CodexDiscoveryPacer,
  CodexPickerCleanup,
  CodexRuntimeCatalogCache,
  CodexTranscriptParser,
  type ConversationAdopter,
  type ConversationConvert,
  ConversationDigestError,
  type ConversationFilesPort,
  ConversationImportService,
  ConversationIndex,
  type ConversationLinker,
  type ConversionCheckPort,
  type ConversionSummary as ConvertedConversationSummary,
  CredentialAgentIdentities,
  CredentialUsageSource,
  canServeModel,
  chooseRelayCarrierSources,
  choosesPortAtBind,
  claimStartName,
  classifyPaneProcesses,
  codexModelProvider,
  combinedMcpOAuthServers,
  combinedReferences,
  computerConversationRoots,
  configuredAt,
  connectorBaseEnvironment,
  contextWindowForSession,
  conversationResumeArguments,
  createFoundationPaths,
  createMountedDispatcher,
  createMountedSocketDispatcher,
  createSessionDirectory,
  createSessionPaths,
  createWardenPaths,
  currentLaunchEffort,
  currentLaunchModel,
  type DaemonConfig,
  type DaemonConfigStore,
  type DaemonHealthSubsystem,
  type DaemonLivenessSource,
  DaemonUpdateService,
  DEFAULT_EVENT_LOOP_LAG_POLICY,
  DEFAULT_HANDOVER_SETTINGS,
  type DecodedInitialAttachment,
  type DeliveredAttachment,
  DeviceGrantService,
  DirectSession,
  DONE_MARKER_FILENAME,
  declaredModel,
  declaresTunnelCarrier,
  decodeInitialAttachments,
  defaultAutoResumeSettings,
  defaultManagedWorktreeRoot,
  defaultSendTrackerSettings,
  defaultSessionLifecycleSettings,
  defaultSessionMonitorSettings,
  defaultSessionResumeSettings,
  defaultSessionSendSettings,
  defaultStartWaitPolicy,
  deliveredFilename,
  describeAbsentRelayCarrier,
  describeConfiguration,
  describeDaemonTimings,
  describeGrantPosture,
  describeLoopStall,
  describeRelayCarrierPosture,
  describeTunnelPosture,
  describeWebRtcEngine,
  dialledRelayUrl,
  directCarrierSocketRoute,
  doneMarkerCertifiesTurn,
  EventLoopLagMeter,
  type ExecutableResolverPort,
  effectiveAnalyticsPricing,
  expandProjectRoots,
  FileConversationDescriber,
  FileForeignTranscriptReader,
  type FileSystemPort,
  FixedSettingsUnreadableError,
  type FleetEventSource,
  FleetEventStreamService,
  FleetLaunchEnvironment,
  FleetLaunchRenewal,
  FleetManifestUnreadableError,
  FleetReading,
  FleetRefreshService,
  FleetSecretReferences,
  FleetWardenAgents,
  ForeignHistoryImporter,
  type FoundationPaths,
  fastStartRefusal,
  findAccountByAgent,
  firstWriteReleasedAnswerAgenda,
  fleetManifestRefusal,
  foreignAdvertisementNotice,
  HANDOVER_RESCAN_INTERVAL_MS,
  HARNESS_PICKER_COMMAND,
  HandoverError,
  type HandoverJournalAppend,
  type HandoverReceiptStore,
  HandoverReconcileLoop,
  type HarnessDiscoveryPolicy,
  type HarnessPreflight,
  HarnessPromptAgenda,
  HarnessPromptAnswerDelivery,
  HarnessQuirkService,
  HarnessUpdateService,
  type HarnessVersionPort,
  HOSTED_APP_ORIGIN,
  type HousekeepingJobs,
  type HousekeepingSettings,
  handoffFolders,
  handoffPointerPaths,
  handoffView,
  harnessAbsentWarning,
  harnessConversionRefusal,
  harnessDiscoveryPolicy,
  harnessLocationSummary,
  harnessMigrationRefusal,
  harnessOverrideFailures,
  harnessPreflightSummary,
  harnessQuirks,
  INSTRUCTIONS_FEATURE,
  InferredLaneProposer,
  InitialAttachmentError,
  InstructionRefresh,
  type InterruptedLaunchOutcome,
  InterruptedLaunchReconciler,
  InvalidDeadlineRefused,
  type IoPressurePort,
  type IoPressureSourcePort,
  instructionsReplyKey,
  isControlAttachable,
  isQuestionScopedRequestId,
  isReapTerminalStatus,
  isTmuxServerAbsent,
  JevTriageGuard,
  type JsonValue,
  jsonObject,
  KnownAndFerretFolders,
  LaneProposalAcceptance,
  LaneSetService,
  type LearningSubsystem,
  LegacySendReproof,
  LegacyWireUseCounter,
  LessonsService,
  LiveDeviceConnections,
  type LivenessSample,
  type LivenessTarget,
  LocalModelsService,
  type LogLevel,
  type LoopBlockedClockPort,
  type LoopWatchdogPort,
  launchGuardActive,
  launchReasoningEffort,
  limitedCredentials,
  locateHarnessCommand,
  lookBeforeReading,
  type ManagedWorktreeOperations,
  type ManagedWorktreeRegistry,
  ManagedWorktreeService,
  McpCheckService,
  type McpInventoryAccount,
  type McpInventoryFolder,
  McpInventoryService,
  McpOAuthService,
  MigrationPreflight,
  type MigrationReportStore,
  type MillisecondClockPort,
  ModelCatalogService,
  type MountedSubsystems,
  mayTrustDirectLoopback,
  mcpCheckBaseEnvironment,
  mcpInventoryFolders,
  messageWithAttachments,
  migrateAgendaFiles,
  migrateToAgendaMode,
  modelCatalogPricingRates,
  modelCatalogsView,
  type NameAllocationErrorCode,
  type NameAllocationRequest,
  type NameAllocationResult,
  NameAllocator,
  type NameClaim,
  type NameSubsystem,
  NO_IO_PRESSURE,
  NO_STACK_SAMPLER,
  NO_WATCHDOG,
  NotificationService,
  needsRolloutFormatProbe,
  type ObservedSession,
  type OpenedAnalyticsIndexStore,
  type OperatorMessageSource,
  OperatorReadService,
  OutboundProviderAuthorizer,
  outdatedSections,
  overriddenBy,
  PacedTranscriptParser,
  PairedPushDevices,
  PairingDeviceRegistry,
  type PairingService,
  type PaneLimit,
  PassTrigger,
  type PassTriggerTimers,
  PinService,
  type PlannedAttachmentFile,
  type PlannedInitialAttachments,
  ProjectAdoption,
  ProjectMcpLaunch,
  ProjectMcpOAuthServers,
  type ProjectRegistrar,
  ProvedPaneCapture,
  ProviderPresetService,
  ProviderProbeService,
  ProviderQuotaService,
  PublishedCarrierSet,
  type PublishedCarrierView,
  PublishedModelCatalogService,
  PushNewDeviceAlert,
  PushService,
  packageRole,
  paneShowsActiveWork,
  paneTextFor,
  parseBackgroundDelay,
  parseDaemonTimings,
  parseSessionId,
  parseWardenConfigPatch,
  parseWatchdogLimit,
  passkeyVerifier,
  planConversationCarry,
  planConversationConvert,
  planInitialAttachments,
  portCandidates,
  previousConversation,
  publishableDirectCarrier,
  QUEUE_ANSWER_WAIT_MS,
  QueueDeliverer,
  QueueingSends,
  QueueRefused,
  type QuotaFailoverLoop,
  QuotaFailoverService,
  RELAY_DIRECTORY_NOT_ASKED,
  RELOAD_THE_APP,
  RETIRED_ACCOUNT_MODEL_NOTICE,
  RETIRED_FLEET_BLOCK_NOTICE,
  RETIRED_SESSION_WORKERS_SWITCH_NOTICE,
  RecommendError,
  type RecommendSubsystem,
  type RelayApiDispatch,
  type RelayCarrierSource,
  type RelayDeviceDirectory,
  type RelayDirectoryPort,
  type RelayPairingRedeemer,
  type RelayStreamDispatch,
  RememberedHandoverReceipts,
  RestartBusy,
  RestartService,
  type RestartSubject,
  type ResumeAnswerAgenda,
  ResumeCancelled,
  type ResumeLauncher,
  ResumeRefused,
  ReviveDedupeConflict,
  type RolloutFormatPort,
  type RoutingCatalogPort,
  type RunOverrides,
  readDaemonRelayIdentity,
  readDoctorReport,
  readHarnessPreflight,
  refuseExhaustedCandidates,
  refuseHeldStateHome,
  refuseOccupiedAddress,
  refuseUnbindableAddress,
  relaunchCommand,
  relayCarrierRemedy,
  relayCarriersNeedDiscovery,
  releasedAnswerAgendaOwnedBy,
  releasingAttachmentsOnStop,
  renderConfiguration,
  renderDoctorReport,
  renderHarnessPreflight,
  renderInitialAttachmentSection,
  resolveBrowserProxy,
  resolveResumePolicy,
  resolveStateHome,
  retireOperatorPassword,
  runtimeQuarantineState,
  type ScratchReclamation,
  SESSION_ROSTER_MAX_AGE_MS,
  SESSION_STATUS_TALLY_MAX_AGE_MS,
  SESSION_TRANSCRIPT_MESSAGE_TOKEN_SELECTION_DOMAIN,
  type SecretCloneIdentitySource,
  SecretDirectory,
  SecretExportService,
  SecretImportService,
  SecretRedactor,
  type SecretSubsystem,
  SecretUseService,
  SecretVault,
  SecuritySettingsService,
  SelfRestartCoordinator,
  SendDraftRefused,
  type SendEvidenceSource,
  type SendLedger,
  SendPending,
  SendRefused,
  SendTracker,
  SendUnconfirmed,
  type SerialExecutor,
  SessionAgendaModeService,
  type SessionAgendaModeSubsystem,
  SessionAgendaProjection,
  type SessionAncestor,
  SessionAnswerError,
  type SessionAnswerSubsystem,
  SessionAttachmentStore,
  SessionAttachService,
  SessionBoardResolver,
  SessionConsoleService,
  SessionControlError,
  type SessionControlFailure,
  type SessionControlSubsystem,
  SessionDialogService,
  type SessionDirectorySubsystem,
  type SessionExitPort,
  SessionFilesystem,
  SessionHandoverService,
  SessionHealthService,
  type SessionHealthSettings,
  SessionHypermediaService,
  type SessionHypermediaSubsystem,
  type SessionId,
  type SessionIdFactory,
  SessionLaunchService,
  SessionLifecycleConfigSchema,
  type SessionLifecycleLauncher,
  SessionLifecycleService,
  SessionMigrateError,
  type SessionMigrateFailure,
  type SessionMigrateSubsystem,
  SessionMonitorService,
  SessionObserver,
  SessionPermissionService,
  SessionPlanner,
  SessionProjects,
  SessionProvenanceRecorder,
  SessionProvenanceStamper,
  SessionQueueService,
  SessionRenameError,
  SessionRenameService,
  type SessionRenameSubsystem,
  SessionResumeError,
  SessionResumeService,
  type SessionResumeSubsystem,
  type SessionRootPinner,
  SessionRoster,
  SessionRuntimeControlService,
  type SessionRuntimeStartupHeldPort,
  SessionSendError,
  SessionSendService,
  type SessionSendSubsystem,
  SessionSignalError,
  SessionSignalService,
  type SessionSignalSubsystem,
  SessionStatusTally,
  SessionStopPending,
  type SessionTranscriptMessageTokenCodec,
  SessionTranscriptReader,
  SessionTranscriptResolver,
  type SessionTranscriptTail,
  SharedFleetBacklog,
  SignalRefused,
  type SkillRuntimeHome,
  SkillsInventoryService,
  type SocketRoute,
  SpeedupsService,
  STRUCTURED_ANSWER_RELEASED_AGENDA_KIND,
  type StackSamplerPort,
  StagedApiSurface,
  StepUpRegistry,
  StepUpService,
  StructuredAnswerCoordinator,
  StructuredQuestionAttemptFailed,
  StructuredQuestionAttemptPaused,
  StructuredQuestionRefused,
  StructuredQuestionService,
  SttEnhancementService,
  type SttEnhancementSubsystem,
  SurfaceControl,
  SystemCallsignIssuer,
  searchTranscript,
  secretsMatch,
  selectBrowserWorker,
  sendRecordView,
  sessionHealthSettingsAt,
  sessionNameClaim,
  sessionScopedAttachments,
  suggestedOllamaModel,
  supersededCarrierKeys,
  TERMINAL_ANALYTICS_STATUSES,
  TEST_MODE_VARIABLE,
  TEST_TIMINGS_VARIABLE,
  TeamAdvisor,
  TerminalMountError,
  TerminalReapService,
  type TerminalRuntimePort,
  type TerminalSessionResolver,
  type TerminalSubsystem,
  TmuxController,
  type TmuxLaunchGuard,
  type TranscriptEvent,
  type TranscriptFileResolver,
  type TranscriptImageLocator,
  TranscriptImageReader,
  type TranscriptImages,
  TranscriptProvenanceCapture,
  type TranscriptSearchMatch,
  type TranscriptSearchOptions,
  TranscriptSendEvidence,
  type TranscriptSource,
  TranscriptTailCache,
  type TriageGuardPort,
  TunnelCarrier,
  type TunnelCarrierDependencies,
  TunnelCarrierSwitch,
  type TunnelEntryStorePort,
  type TunnelServicePort,
  type TunnelSwitchPort,
  TurnChanges,
  tailTranscriptEvents,
  temporaryFilePath,
  transcriptKey,
  transcriptLaunchArguments,
  tryParseSessionId,
  tunnelListenerSurface,
  tunnelPeer,
  tunnelServiceOrigin,
  tunnelSessionLog,
  UnknownPeerRefused,
  UnwatchedPaneExits,
  UPDATE_BACKSTOP_INTERVAL_MS,
  type UsageFeedPort,
  unattendedUsageFeed,
  unreadableManifestPreflight,
  usageProbeUrls,
  usageRefreshMs,
  verifySessionTranscriptMessageToken,
  WARDEN_ESCALATION_SOURCE,
  WARDEN_LABEL,
  WATCHDOG_VARIABLE,
  type WardenBoardPort,
  WardenCallsignTakenError,
  type WardenFleetSession,
  type WardenJournal,
  WardenLivenessMonitor,
  type WardenRevivePorts,
  WardenReviveService,
  type WardenSubsystem,
  WardenSweepLoop,
  WardenSweepService,
  WatchedDocument,
  WatchedPanes,
  WatchedUsageFeed,
  WEBRTC_ENGINE_ON_DEMAND,
  type WebRtcAvailability,
  WebRtcCarrier,
  type WebRtcEnginePort,
  type WebRtcPeerEngine,
  type WebRtcSessionFactory,
  type WebRtcSignallingSubsystem,
  type WorkingDirectoryResolver,
  wardenEventTrigger,
  wardenTriggerEnabled,
  withContext,
  withLivenessLedger,
  withOutdated,
  xvfbMissingMessage,
} from '../src/lib/index.ts';
import {
  admitChild,
  CleanUpService,
  COMMON_SCRATCH_ROOTS,
  depthOf,
  GuideFileService,
  isScratchPath,
  JevPackRanker,
  PACK_ROUTING_MAX_AGE_MS,
  type PackParent,
  type PackProbeRequest,
  PackRoutingKeep,
  PackService,
  PackStartRefused,
  ProbeCache,
  packInstructed,
  packLaunchDefault,
  RoutingMigration,
  runningChildCount,
} from '../src/lib/pack/index.ts';
import { IDLE_DAEMON_BUDGETS } from '../src/lib/performance/budgets.ts';
import { PerformanceProfiler, sampleIntervalMs } from '../src/lib/performance/profiler.ts';
import { NO_PERFORMANCE_PROBE, PerformanceRecorder } from '../src/lib/performance/recorder.ts';
import { teeStackSampler } from '../src/lib/performance/sampler-tee.ts';
import type { PackSubsystem } from '../src/lib/runtime/mounts/pack.ts';
import type { SessionForkSubsystem } from '../src/lib/runtime/mounts/session-fork.ts';
import { createSessionMcpSubsystem } from '../src/lib/runtime/mounts/session-mcp.ts';
import {
  ConversationLeases,
  LeaseClaimingLaunchWrapper,
  LeaseReleasingSessionExits,
} from '../src/lib/session/conversation-lease.ts';
import { LaunchEnvironmentStore, type LaunchSwitchDefaults } from '../src/lib/session/lifecycle/launch-environment.ts';
import { sessionTmuxName } from '../src/lib/session/lifecycle/policy.ts';
import { SessionPackService } from '../src/lib/session/pack/index.ts';
import { knownProjectRoots } from '../src/lib/session-mcp/service.ts';
import {
  AttachmentFacetContributor,
  ConversationFacetContributor,
  LineageFacetContributor,
  ReferenceFacetContributor,
  SessionTransferPreparer,
  TransferPrepareError,
  WorkspaceFacetContributor,
} from '../src/lib/transfer/index.ts';
import { daemonVersion, productName } from '../src/lib/version.ts';

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

/**
 * The guard that keeps a daemon a test booted from ever launching a real harness, or nothing.
 *
 * On when the runner exported `FERRETRY_TEST=1`, or when the state home sits under a temporary
 * directory — which is where every suite in this repository builds one. Off for a person's own
 * daemon, which launches whatever runtime they configured. See `lib/tmux/harness-guard.ts`.
 */
function testHarnessLaunchGuard(home: string): TmuxLaunchGuard | undefined {
  const canonical = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  const temporaryRoots = [tmpdir(), '/tmp', '/var/folders'].map(canonical);
  const active = launchGuardActive({
    flag: process.env[TEST_MODE_VARIABLE],
    home: canonical(home),
    temporaryRoots,
  });
  return active ? new RealHarnessLaunchGuard(() => process.env.PATH) : undefined;
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

/** How long after a session turned terminal the reaper sweeps: a burst of writes is one sweep. */
const TERMINAL_REAP_SETTLE_MS = 1_000;
/** The reaper's slow backstop, for a pane that became reapable without this daemon writing it so. */
const TERMINAL_REAP_BACKSTOP_MS = 60_000;
/** How long after a turn ends the Attention check reads its transcript: the last words reach the file late. */
const AGENDA_NUDGE_SETTLE_MS = 2_000;

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
  /** This machine's user home, exactly as {@link WorldSeams} named it. Every harness path derives from it. */
  readonly userHome: string;
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
    /**
     * The named work in flight, shared by the boot's steps and every background tick, so an event-loop
     * stall names what was running. One ledger per world, because the stall meter reads all of it.
     */
    readonly activities: ActivityLedger;
    /** The performance probe the lag meter, the stack sampler and the child-process counter report into. */
    readonly performance?: PerformanceRecorder;
    /** Starts this boot's progress — the step `/healthz` reports — and makes it the one health reads. */
    readonly beginProgress: () => BootProgress;
    /** How long the loop may be silent before the watchdog ends the process; `0` is off. */
    readonly watchdogLimitMs: number;
    /**
     * How long after the routes are mounted the housekeeping lane opens — analytics, the fleet refresh,
     * the terminal reaper and quota failover wait until then (see `BackgroundLane`).
     */
    readonly backgroundDelayMs: number;
    /** Starts the watchdog thread. A world field so a test can drive the boot without one. */
    readonly watchdog: (limitMs: number) => LoopWatchdogPort;
    /**
     * Starts sampling the main thread's stack, so a stall names the code it spent its time in as well as
     * the labelled work around it; `undefined` where the runtime cannot sample or it is switched off.
     */
    readonly stackSampler?: () => Promise<StackSamplerPort | undefined>;
    /** The disk's pressure, kept fresh while the daemon runs, so a stall can say it was the disk. */
    readonly ioPressure?: IoPressureSourcePort;
  };
  readonly config: DaemonConfigStore;
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
   * The one place file events enter the daemon: one OS watch per directory, shared by every reader that
   * subscribes to a path in it. `close` releases the watches; `fallbacks` names any directory polled instead.
   */
  readonly fileEvents: FileEventHub;
  /**
   * The ONE long-lived tmux control client every tmux read goes through, as far as a boot's release
   * needs it: `stop` ends that client and resolves once its process has exited.
   */
  readonly tmuxControl: Pick<ControlModeTmuxProcess, 'stop'>;
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
   *
   * `loop` is the event-loop lag meter `start` arms before anything else, passed in for the same
   * reason: a tick the whole loop was too blocked to fire is not a wedge of the self-check, and only
   * that meter knows how long the loop was blocked.
   */
  readonly createSessionHealth: (
    storage: DaemonStorage,
    settings: SessionHealthSettings,
    loop: LoopBlockedClockPort,
  ) => SessionHealthService;
  /**
   * Brings back the sessions a host restart took down (docs/cli.md, `fy daemon`).
   *
   * A FACTORY because it needs the storage this boot opened and the mounted revive. It shares one
   * recorder with {@link createSessionHealth}: the FIRST self-check settles every session whose
   * terminal is gone, and those are the ones that were running when the host went down.
   */
  readonly createAutoResume: (storage: DaemonStorage, resume: AutoResumeRevive) => AutoResumeBoot;
  /**
   * Settles every launch the previous daemon process left in flight (`InterruptedLaunchReconciler`).
   *
   * Run ONCE per boot, BEFORE the daemon serves: nothing in this process can be launching yet, so a
   * record still saying `created` or `starting` with no live pane is a launch that died with the
   * old process. Without it such a session is stuck for good — it holds a Pack slot, holds its
   * conversation lease, and no exit settle will ever move it on.
   */
  readonly reconcileInterruptedLaunches: (
    storage: DaemonStorage,
    panes: Pick<ResumeLauncher, 'observe'>,
  ) => Promise<InterruptedLaunchOutcome>;
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
  readonly createResumeLauncher: (
    storage: DaemonStorage,
    /**
     * The argv a revive runs, REBUILT from the session's documents and the fleet as it is now
     * (`SessionLaunchService.relaunch`). Nothing means the session cannot be rebuilt and its record is
     * replayed. Passed IN so a test's launcher can record exactly what production would have run.
     */
    relaunch: (id: SessionId) => Promise<readonly string[] | undefined>,
  ) => ResumeLauncher;
  /** Rebuilding a session's launch on current settings, and saying whether its process is stale. */
  readonly createSessionLaunch: (storage: DaemonStorage) => SessionLaunchService;
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
     *  `createResumeAnswerAgenda`. Passed IN for the launcher's reason: it is built from the
     *  answer ledger and the answer queue, which belong to the mounted subsystems rather than the
     *  world, and a second construction would dismiss on a queue nothing else holds. */
    answerAgenda: ResumeAnswerAgenda,
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
    carriers: PublishedCarrierView,
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
    /** Passkeys and the step-up they prove, opened with pairing because revoking a device forgets them. */
    readonly stepUp: StepUpService;
    /**
     * The machine's security settings (`docs/design/zero-trust.md` B6), opened with pairing because
     * the idle period and the key rotation it governs are pairing's, and READ before anything else here
     * is asked a question. `notice` is its boot sentence when the document could not be read.
     */
    readonly security: SecuritySettingsService;
    readonly securityNotice: string | undefined;
    /** The boot sentence when the unlock ledger could not be read and every device is asked again. */
    readonly unlockNotice?: string | undefined;
    /** Bearer-token grants a pre-device-key `devices.json` held and this boot dropped. */
    readonly droppedBearerGrants: number;
  }>;
  /**
   * The DIRECT carrier: the socket route a browser that can reach this address opens its sessions on.
   *
   * Signed with the key PAIRING minted, read through the path the relay carriers already share — a
   * second key would carry a fingerprint no QR names. A refusal is answered rather than thrown, and
   * printed: without it no device can reach this daemon directly, which must not look like a network
   * fault.
   */
  readonly createDirectCarrier: (
    dispatch: RelayApiDispatch,
    sockets: RelayStreamDispatch,
    devices: RelayDeviceDirectory,
    pairing: RelayPairingRedeemer,
  ) => Promise<
    | {
        readonly route: SocketRoute;
        /**
         * The same session the route opens per socket, for a carrier that is not a socket on this
         * listener: a WebRTC data channel (`docs/relay-protocol.md` §16). One set of dependencies, so a
         * peer-to-peer session is the direct session — same identity, lease and connections — and only
         * its arrival differs.
         */
        readonly openSession: WebRtcSessionFactory;
      }
    | { readonly refusal: string }
  >;
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
  /** What starts a session's browser: a Chrome and the browser worker. A world field for the reason
   *  `terminalRuntime` is one. */
  readonly browserLauncher: BrowserSessionLauncher;
  /**
   * The private X display a Linux agent browser draws into when the machine's Browser mode is a real window
   * (docs/browser-mode.md) — taken on the first such launch, never on a headless one, and released with
   * the daemon. Its OWN Xvfb, separate from the login window's: that one is served over VNC, and an agent
   * browser's windows must never be on a screen something else publishes.
   */
  readonly agentBrowserDisplay: BrowserDisplayPort;
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
   * WHETHER THE HOSTED SERVICE PROVISIONS TUNNELS — one read per boot, from the relay directory's own
   * origin (`docs/relay-protocol.md` §15). A world field for the reason `relayDirectory` is one:
   * `--check` asks it too, and it is the tunnel's one read from a service off this machine.
   */
  readonly tunnelService: TunnelServicePort;
  /** Where `cloudflared` is: `FY_CLOUDFLARED`, else `PATH`. Asked by the boot and by `--check`. */
  readonly cloudflared: CloudflaredLocatorPort;
  /**
   * THE HOSTED TUNNEL CARRIER: provisioning, the `cloudflared` child and the dedicated listener.
   *
   * The boot supplies what only it knows — the entry, the listener it serves, where to publish — and
   * the service and locator above, PASSED IN so a test that overrides either changes what the carrier
   * uses. Production fills the rest: the holding record, the identity pairing minted, the provisioner,
   * the process spawner and the timers.
   */
  readonly createTunnelCarrier: (
    input: Pick<
      TunnelCarrierDependencies,
      'entry' | 'explicit' | 'cloudflared' | 'service' | 'openListener' | 'publish' | 'notices'
    >,
  ) => TunnelCarrier;
  /**
   * Where the tunnel switch writes its decision: the ONE `{ kind: 'tunnel' }` entry, in the document
   * this daemon booted from, under the same barrier grant and pricing writes hold — so a toggle and a
   * grant change made at once cannot each preserve a stale copy and erase the other's key.
   */
  readonly tunnelEntry: TunnelEntryStorePort;
  /**
   * The peer-to-peer carrier's native engine (`docs/relay-protocol.md` §16), asked only whether it works.
   *
   * A world field because `--check` proves it with a real self-test — two loopback peers echoing
   * one message — and a suite that is not about WebRTC should not have to load a native library to
   * ask whether a daemon would start.
   */
  readonly webrtcEngine: WebRtcEnginePort & WebRtcPeerEngine;
  /**
   * Starts every worker thread this binary carries and reports whether each one ran — for `--check`.
   * A compiled binary that did not embed a worker's program used to fail only when someone needed it.
   */
  readonly probeWorkers: () => Promise<readonly WorkerProbeReport[]>;
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
    /** Opened with pairing for the same reason: a device's passkeys die with its grant. */
    stepUp: StepUpService,
    /** The machine's security settings, opened with pairing — see `createPairing`. */
    security: SecuritySettingsService,
    /** The one published set pairing redemption reads and authenticated refresh serves. */
    carriers: PublishedCarrierView,
    /**
     * The tunnel switch, built by the boot before the subsystems because `/v1/tunnel` is a mounted
     * route, and started by it after the relays — see `TunnelCarrierSwitch`.
     */
    tunnel: TunnelSwitchPort,
    /** The peer-to-peer carrier's signalling, built by the boot because its sessions need the dispatcher. */
    webrtc: WebRtcSignallingSubsystem,
    /**
     * Where this operator has said the harnesses are, passed IN for the same reason the usage feed
     * is: it is read from the configuration this boot loaded, and the doctor route must report the
     * resolution the boot milestone reported rather than a second one built from its own reading.
     */
    harnessDiscovery: HarnessDiscoveryPolicy,
    /**
     * What starts a session's browser, passed IN for the same reason the terminal runtime is: the real
     * one puts a Chrome and a browser worker on the machine, so a test substitutes this and keeps the
     * browser service, the agent tools and the routes exactly as production builds them.
     */
    browserLauncher: BrowserSessionLauncher,
    /**
     * Whether each running session is observed on its own worker thread, and how many threads at most —
     * the document's `sessionWorkers`, read by `start` like every other configured value.
     */
    sessionWorkers: DaemonConfig['sessionWorkers'],
    /** How long the owner's attention answers are held before they reach the ferret (`attention` block). */
    agenda: DaemonConfig['attention'],
    /** Whether a message to a running ferret rides its durable queue (`delivery` block). */
    delivery: DaemonConfig['delivery'],
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

/** Where the project boards report what they could not do: the daemon's log. */
const boardDiagnostics = { warn: (message: string) => void process.stderr.write(`board: ${message}\n`) };

/** The board, and the cards a start makes on it. */
interface BoardWorld {
  readonly store: FileBoardStore;
  readonly board: BoardService;
  readonly cards: SessionCards;
  /** Which card each session works on (`config.focusTask`): what the Warden tells a ferret it starts again. */
  readonly focus: StorageSessionFocus;
  /** The one `ProjectAdoption`: a ferret's first card, and the Unfiled board's refile, register through it. */
  readonly adoption: ProjectAdoption;
}

/**
 * The project boards (v2): one file per card under `<state>/board`, written under ownership and lineage,
 * and the cards every start with a brief gets (`SessionCards`, board-design.md §3.1).
 *
 * Lanes and projects are U3's `LaneSetService`; a start in a project with no lanes is proposed the template its
 * folder suggests (`InferredLaneProposer`).
 * Activity is derived from the session roster with the Warden's liveness ledger laid over it. The agenda link reads each ferret's
 * agenda through the agenda service, and a reopen is delivered through the ordinary send path. The
 * machine id is the pairing identity's daemon id, which a write waits for rather than inventing one.
 */
function createBoardWorld(
  paths: FoundationPaths,
  stateFiles: FileSystemPort,
  storage: DaemonStorage,
  clock: SystemClock,
  machineId: () => string | undefined,
  /** Which board a session works on, each board's lanes and its name (U3's `LaneSetService`). */
  lanes: Pick<LaneSetService, 'projectOf' | 'laneSet' | 'project' | 'apply'>,
  sends: Pick<SessionSendService, 'send'>,
  /** The same send path as the owner's front: what the owner did to a card (done, reopen) is stamped as theirs. */
  ownerSends: Pick<SessionSendService, 'send'>,
  /** One ferret's open agenda items; read lazily, because the agenda service is built after the board. */
  agendaItems: (sessionId: string) => Promise<readonly AgendaItem[]>,
  bin: string,
  /** Every session's life-signs, with the Warden's liveness ledger laid over them, for "last touched". */
  sessions: SessionLivenessSource,
  /** Registers a folder as a project: the catalog `POST /v1/projects` writes through, so both share its dedupe. */
  registrar: ProjectRegistrar,
  /** The folders a ferret's repository is registered from (`projectRoots`), read per adoption. */
  projectRoots: () => Promise<readonly string[]>,
  userHome: string,
  /** The attachment store: the files the owner sends with "Not good" are named and carried through it. */
  attachments: StoreBoardAttachments,
): BoardWorld {
  const diagnostics = boardDiagnostics;
  const parents = new StorageSessionParents(storage);
  const focus = new StorageSessionFocus(storage);
  // ONE store per daemon: the service and the legacy import share its id counter.
  const store = new FileBoardStore(join(paths.state, 'board'), stateFiles, new KeyedSerialExecutor(), diagnostics);
  const proposer = new InferredLaneProposer(lanes, new GitProjectFacts());
  // A ferret's first card in a repository nobody registered registers it (`ProjectAdoption`): ONE instance, so
  // its per-repository section is shared by `fy task create` and the cards a start makes.
  const adoption = new ProjectAdoption({
    sessions: new StorageSessionFacts(storage),
    repositories: new GitRepositoryProbe(),
    registry: registrar,
    lanes,
    proposer,
    stamp: new StorageSessionProjectStamp(storage),
    places: async () => ({
      projectRoots: expandProjectRoots(await projectRoots(), userHome),
      home: userHome,
      scratchRoots: [...COMMON_SCRATCH_ROOTS, tmpdir()],
    }),
    serial: new KeyedSerialExecutor(),
  });
  const board = new BoardService({
    store,
    lanes,
    parents,
    focus,
    reopen: new ReopenDeliveryLadder(
      new SendReopenMessenger(sends, new StorageSubFerretDirectory(storage), attachments),
      diagnostics,
      new SendReopenMessenger(ownerSends, undefined, attachments),
    ),
    attachments,
    done: new DoneDeliveryLadder(new SendReopenMessenger(ownerSends), diagnostics),
    activity: new LivenessActivityDeriver({ sessions, clock }),
    agenda: new AgendaCardLinks({ open: agendaItems }, machineId, diagnostics),
    changes: new JournalBoardChanges(storage),
    clock,
    diagnostics: boardDiagnostics,
    machineId,
    runningVersion: () => (ProtocolVersionSchema.safeParse(daemonVersion).success ? daemonVersion : null),
    serial: new KeyedSerialExecutor(),
    adoption,
    subFerrets: new StorageSubFerretDirectory(storage),
  });
  const cards = new SessionCards({
    board,
    lanes,
    proposer,
    adoption,
    // The name the board list shows: a registered project's, `Unfiled`, or the id of one no longer listed.
    projects: { nameOf: async projectId => (await lanes.project(projectId))?.name ?? projectId },
    focus,
    diagnostics,
    bin,
  });
  return { store, board, cards, focus, adoption };
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
 * The session read, over the authoritative index and the documents in the state home — paced, and projecting
 * only what can still change (see `createSessionDirectory`).
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
  return createSessionDirectory({
    sessions: () => storage.listSessions(),
    find: id => storage.findSession(id),
    readConfig: async id => await storage.readConfig(id),
    readState: async id => await storage.readState(id),
    directory: id => createSessionPaths(paths, id).directory,
    project,
    ended: session => session.status !== undefined && ENDED_SESSION_STATUSES.has(session.status),
    yieldToLoop: () => new Promise(resolve => setImmediate(resolve)),
  });
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
function harnessDeclarations(config: DaemonConfig, userHome: string): HarnessDiscoveryPolicy {
  return harnessDiscoveryPolicy({
    document: config.harness,
    environment: name => process.env[name],
    homeDirectory: userHome,
  });
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
 * The first name this session will answer to, CLAIMED rather than recorded.
 *
 * A start that merely wrote down the requested name would let two sessions answer to one callsign,
 * and a bare callsign then resolves to both — which is the whole reason `NameAllocator` exists. The
 * claim is taken before the session document is written, because the document is what everything else
 * derives ownership from and it does not exist yet.
 *
 * A start that names NO callsign is given one from the pool, the way kteam names every teammate: the
 * name is what the list, the header, the picker and the notifications call the agent. Only a REQUESTED
 * name can refuse a start — see `claimStartName` for why an automatic one never does.
 */
async function claimCallsign(
  callsigns: CallsignClaims,
  owner: SessionId,
  request: StartSessionRequest,
): Promise<string | undefined> {
  const claimed = await claimStartName(callsigns, owner, request, Date.now());
  if (!claimed.ok) throw new SessionControlError(CALLSIGN_REFUSALS[claimed.error.code], claimed.error.message);
  return claimed.callsign;
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
/** The two reads a start makes only when it names fast mode. */
interface StartFastPorts {
  /** The text of the login's fixed Claude `--settings` file: empty when it has none, nothing when unreadable. */
  readonly fixedSettings: (executable: string, harness: HarnessKind) => Promise<string | undefined>;
  /** The models a Codex login advertises, for a start asking for fast mode on one of them. */
  readonly codexChoices: (executable: string, cwd: string) => Promise<readonly RuntimeModelChoice[]>;
}

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
  /**
   * "Default runtime for new agents" (T): the runtime a start with no `agent` named uses, resolved
   * fresh from this machine's own configuration — never cached, so a change applies to the very next
   * start. `undefined` when nothing resolves, which {@link resolveStartAccount} then refuses in its
   * own words.
   */
  defaultAgentName: () => Promise<string | undefined>,
  /**
   * Records whether a new ferret is instructed to learn (the machine's passive default) and puts that
   * in its launch environment — after the record exists and before the pane launches. A miner or a
   * warden is never instructed. A failure here never fails the start: the ferret is then simply not
   * instructed, which is what a ferret with no record means.
   */
  adoptLearning: (id: SessionId) => Promise<void>,
  /** The folders this session's agent is pointed into to read what it was sent (`handoffFolders`). */
  readableHandoffs: (id: SessionId) => readonly string[],
  /** A digest of the fleet settings a wrapper launches under, recorded so a later read can say the
   *  running process is on older ones (`FileLaunchSettingsDigest`). */
  launchSettings: (executable: string, harness: HarnessKind) => Promise<string | undefined>,
  /** Pack mode's two hooks into every start: the sub-ferret limits, and the new ferret's own switch. */
  pack: SessionPackHooks,
  /** What a start that names fast mode reads: the fixed overlay to carry, and a Codex model's catalog. */
  fast: StartFastPorts,
  /**
   * The board card a start with a prompt gets (board-design.md §3.1), written after the record and before
   * the launch. Total: a board failure is said on stderr and never fails the start.
   */
  cards: Pick<SessionCards, 'open'>,
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
    start: async (request, requestId, payload, delegation) => {
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
      const { account, executable } = await resolveStartAccount(
        accounts,
        request.agent,
        executables,
        CLIENT_NAME,
        defaultAgentName,
      );
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
      // PACK MODE'S LIMITS, before anything is claimed or written: a parent already running as many
      // sub-ferrets as it may, or one too deep to start its own, is refused here whichever command
      // asked (docs/pack-mode.md). A warden's own spawns are the Warden's to bound, not this.
      if (request.parent !== undefined && !stamped.provenance.wardenLineage) {
        const refusal = await pack.admit(request.parent);
        if (refusal !== undefined)
          throw new SessionControlError(
            refusal.code === 'depth_exceeded' ? 'depth_exceeded' : 'limit_reached',
            refusal.message,
          );
      }
      // BEFORE the callsign is claimed, so a start refused over an unusable attachment does not park
      // a pool name for the whole resolution window on a session that never happens.
      const opening = composeOpeningMessage(attachments, id, request);
      const prompt = opening.prompt;
      // BEFORE the plan, because the callsign is what the harness's own remote-control session is
      // named after: a plan built on the requested name and a document recording the fallback would
      // disagree about who this session is.
      const teammate = await claimCallsign(callsigns, id, request);
      const planned = planner.plan({
        id,
        account,
        mode: request.mode,
        ...(teammate === undefined ? {} : { teammate }),
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.model === undefined ? {} : { requestedModel: request.model }),
        ...(request.parent === undefined ? {} : { parent: request.parent }),
      });
      // A REQUEST THIS ACCOUNT CANNOT MEET IS REFUSED, never quietly answered with something else.
      // The planner used to drop an unservable model and hand back the account's default, which then
      // went onto the launch argv and onto the document — so a caller who named a model got a session
      // running a different one, at a different price and in a different context window, and was told
      // nothing.
      //
      // THE CALLSIGN IS RELEASED FIRST. It is claimed before the plan because the plan is named after
      // it, so this is the one refusal that happens with a pool name already reserved; nothing else
      // has been written, so leaving it claimed would park a name for the whole resolution window on
      // a session that never happens — the same reason the launch failure below releases it.
      if (planned.kind === 'unservable-model') {
        if (teammate !== undefined) await callsigns.release(teammate, id).catch(() => undefined);
        throw new SessionControlError('unservable_model', planned.reason);
      }
      const plan = planned.plan;
      // FAST MODE the model cannot give is refused here, with the callsign released like the model
      // refusal above: nothing has been written, and a session that silently ran at standard speed
      // would be billed and described as fast.
      const releaseCallsign = async (): Promise<void> => {
        if (teammate !== undefined) await callsigns.release(teammate, id).catch(() => undefined);
      };
      if (request.fast === true) {
        const choices = account.kind === 'codex' ? await fast.codexChoices(executable, cwd).catch(() => []) : [];
        const refusal = fastStartRefusal(account.kind, plan.model, choices);
        if (refusal !== undefined) {
          await releaseCallsign();
          throw new SessionControlError('unservable_model', refusal);
        }
      }
      // Claude carries fast mode in a replacement `--settings`, so the overlay it replaces is read now.
      const fixedSettings =
        account.kind === 'claude' && request.fast !== undefined
          ? await fast.fixedSettings(executable, account.kind)
          : '';
      if (fixedSettings === undefined) {
        await releaseCallsign();
        throw new SessionControlError(
          'failed',
          'the login’s fixed settings could not be read, so fast mode cannot be applied',
        );
      }
      const startupRuntime: RuntimeControlRequest | undefined =
        request.effort === undefined
          ? undefined
          : harnessQuirks(account.kind).effortIsRuntimeCommand
            ? { action: 'effort', effort: request.effort }
            : { action: 'model', model: plan.model, effort: request.effort };
      // The remote-control arguments are added only when the caller asked for the surface, because
      // they are what makes the harness publish one — adding them anyway would open a control channel
      // for a session whose own document records that it has none.
      // THE SAME BUILD a Restart CLI, a migration and a revive run, so the four can never disagree
      // about what a launch carries. Effort is not on it: a start applies the requested level as a
      // runtime command before turn one (`startupRuntime` above), and a relaunch passes the level the
      // session is on by then.
      const command = await (async (): Promise<readonly string[]> => {
        try {
          return buildLaunchArgv({
            harness: account.kind,
            executable,
            remoteControl: request.remoteControl === true ? plan.extraArgs : [],
            transcript: transcript.launchArguments,
            readableFolders: readableHandoffs(id),
            model: plan.model,
            ...(request.fast === undefined ? {} : { fast: request.fast, fixedSettings }),
            harnessFlags: request.harnessFlags ?? [],
          });
        } catch (error) {
          if (!(error instanceof FixedSettingsUnreadableError)) throw error;
          await releaseCallsign();
          throw new SessionControlError('failed', error.message);
        }
      })();
      const settingsDigest = await launchSettings(executable, account.kind);
      // The level this launch starts on, so a session that has said nothing yet still shows one. A
      // single local file read: no harness is started and no provider is asked.
      const launchEffort = launchReasoningEffort(
        request.effort,
        await readPersistedReasoningEffort(account.kind, transcript.provenance?.home),
      );
      // The state fast mode starts in: the request's choice, else what the login saved. Not an
      // assertion — only a request that NAMED it is put on the argv — but the composer has to show what
      // the harness will do before it has said anything.
      const launchFast = request.fast ?? (await readPersistedFast(account.kind, transcript.provenance?.home));
      const envelope: SessionProtocolEnvelope = {
        agent: account.agent,
        harness: account.kind,
        // An interactive ferret is told it may use hypermedia and an auto one is not, until the owner says otherwise (docs/hypermedia.md).
        hypermedia: request.mode === 'interactive',
        // An incarnation names one RUN of a session: this is its first, and a revive is what mints
        // the next. The generation is the daemon-side counter of those relaunches.
        incarnation: `${id}-1`,
        runtimeGeneration: 1,
        // What the caller asked for, kept beside the model that was actually resolved for it: the
        // hint is evidence about the request and the model is the decision.
        modelHint: request.model ?? account.defaultModel ?? '',
        model: plan.model,
        ...(launchEffort === undefined ? {} : { launchReasoningEffort: launchEffort }),
        ...(launchFast === undefined ? {} : { launchFast }),
        ...(settingsDigest === undefined ? {} : { launchSettings: settingsDigest }),
        remoteControl: request.remoteControl === true && account.kind === 'claude',
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
        if (ordinaryFerret(stamped.label, stamped.provenance.wardenLineage))
          await adoptLearning(id).catch(() => undefined);
        // A miner, a guide builder or a warden is never told about Pack mode; every other ferret is, unless the
        // machine's switch is off or it sits too deep to start its own. A failure leaves it untold, never unstarted.
        await pack
          .adopt(id, ordinaryFerret(stamped.label, stamped.provenance.wardenLineage), request.parent)
          .catch(() => undefined);
        // THE CARD, after the record and before the launch (board-design.md §3.1): the agent's first turn
        // already has its focus card, and a start refused before here leaves none. A miner, a guide builder
        // or a warden is not work on a board. `open` never rejects: a board failure never fails a start.
        if (request.prompt !== undefined && ordinaryFerret(stamped.label, stamped.provenance.wardenLineage))
          await cards.open({
            sessionId: id,
            name: request.name,
            brief: request.prompt,
            parent: request.parent,
            delegation,
          });
        await lifecycle.start(
          id,
          startupRuntime === undefined
            ? undefined
            : async () => {
                await runtime.startupWhileHeld(id, startupRuntime, `${requestId}:startup-runtime`);
              },
        );
      } catch (error) {
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
        throw new SessionControlError(
          error instanceof SessionStopPending ? 'pending' : 'failed',
          error instanceof Error ? error.message : String(error),
        );
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
 * Keeping an existing CLI conversation as a ferret: the start pipeline, minus the parts that would
 * make a NEW conversation.
 *
 * The same account resolution, canonical directory, spawn stamp, callsign and plan a start takes, so
 * an adopted ferret is indistinguishable from any other on every surface. What differs is exactly
 * what adoption means:
 *
 *   * NO TRANSCRIPT IS MINTED OR BASELINED. The conversation already has its CLI id and its file; the
 *     file is made visible in the runtime's history (a link, never a copy) and recorded as `adopted`,
 *     so Chat reads it before anything launches.
 *   * THE ARGV RESUMES (`--resume <id>` / `resume <id>`), which a revive re-runs unchanged — so a
 *     ferret adopted stopped resumes the same conversation whenever the owner starts it.
 *   * NO OPENING MESSAGE. Nothing is said to the agent on the owner's behalf.
 *   * STOPPED unless asked: `start: false` records the session and retires it as stopped with the
 *     reason, which is what makes it resumable and keeps a picker from launching a burst of agents.
 */
function createConversationAdopter(
  storage: DaemonStorage,
  sessions: SessionDirectorySubsystem,
  createLifecycle: DaemonWorld['createSessionLifecycle'],
  planner: SessionPlanner,
  launcher: SessionLifecycleLauncher,
  accounts: AccountInventoryPort,
  executables: ExecutableResolverPort,
  ids: SessionIdFactory,
  callsigns: CallsignClaims,
  transcripts: Pick<TranscriptProvenanceCapture, 'home'>,
  directories: WorkingDirectoryResolver,
  provenance: SessionProvenanceStamper,
  clock: ClockPort,
  adoptLearning: (id: SessionId) => Promise<void>,
  readableHandoffs: (id: SessionId) => readonly string[],
  linker: ConversationLinker,
): ConversationAdopter {
  return {
    adopt: async ({ harness, runtime, conversation, start }) => {
      const resolved = await resolveStartAccount(
        accounts,
        runtime,
        executables,
        CLIENT_NAME,
        async () => undefined,
      ).catch((error: unknown) => error);
      if (resolved instanceof Error) return { kind: 'refused', code: 'unavailable', reason: resolved.message };
      const { account, executable } = resolved as Awaited<ReturnType<typeof resolveStartAccount>>;
      if (account.kind !== harness)
        return {
          kind: 'refused',
          code: 'harness_mismatch',
          reason: `${runtime} runs ${account.kind === 'claude' ? 'Claude Code' : 'Codex'}, not this conversation's CLI.`,
        };
      const home = await transcripts.home(harness, executable);
      if (home === undefined)
        return {
          kind: 'refused',
          code: 'unavailable',
          reason: `${runtime} declares no history folder to resume from.`,
        };
      const cwd = await directories.resolve(conversation.project).catch(() => undefined);
      if (cwd === undefined)
        return {
          kind: 'refused',
          code: 'unavailable',
          reason: `The conversation's folder ${conversation.project} is no longer there.`,
        };
      const linked = await linker.link(conversation.source, home, conversation.relativePath);
      if (linked.kind === 'conflict' || linked.kind === 'unavailable')
        return { kind: 'refused', code: linked.kind, reason: linked.reason };
      const id = ids.next();
      const stamped = provenance.stamp({ id, requestedByHuman: true }, await spawnAncestry(storage, sessions));
      const claimed = await claimStartName(callsigns, id, {}, Date.now());
      const teammate = claimed.ok ? claimed.callsign : undefined;
      const planned = planner.plan({
        id,
        account,
        mode: 'interactive',
        ...(teammate === undefined ? {} : { teammate }),
      });
      if (planned.kind === 'unservable-model') {
        if (teammate !== undefined) await callsigns.release(teammate, id).catch(() => undefined);
        return { kind: 'refused', code: 'unavailable', reason: planned.reason };
      }
      const plan = planned.plan;
      const command = buildLaunchArgv({
        harness: account.kind,
        executable,
        remoteControl: [],
        transcript: conversationResumeArguments(harness, conversation.id),
        readableFolders: readableHandoffs(id),
        model: plan.model,
        harnessFlags: [],
      });
      const envelope: SessionProtocolEnvelope = {
        agent: account.agent,
        harness: account.kind,
        // Every new ferret is told it may use hypermedia until the owner says otherwise (docs/hypermedia.md).
        hypermedia: true,
        incarnation: `${id}-1`,
        runtimeGeneration: 1,
        modelHint: conversation.model ?? account.defaultModel ?? '',
        model: plan.model,
        remoteControl: false,
        harnessFlags: [],
        turn: 0,
        transcript: adoptedTranscriptProvenance(home, conversation, clock.now()),
        ...(teammate === undefined ? {} : { teammate }),
        ...(stamped.label === undefined ? {} : { label: stamped.label }),
        provenance: stamped.provenance,
        ...SESSION_START_DEFAULTS,
      };
      const lifecycle = createLifecycle(storage, launcher, envelope, id);
      try {
        await lifecycle.create({ agent: executable, command, cwd, mode: 'interactive' });
      } catch (error) {
        if (teammate !== undefined) await callsigns.release(teammate, id).catch(() => undefined);
        throw error;
      }
      await adoptLearning(id).catch(() => undefined);
      // A failed launch keeps the record with its reason, like a start: the conversation is adopted
      // either way, and the owner can resume it once whatever stopped it is fixed.
      if (start) await lifecycle.start(id).catch(() => undefined);
      else
        await lifecycle.stop(id, 'adopted from an existing conversation; resume it to continue').catch(() => undefined);
      const view = await sessions.get(id);
      return {
        kind: 'adopted',
        session: id,
        name: view?.config.teammate ?? view?.config.name ?? id,
        status: view?.state.status ?? 'stopped',
      };
    },
  };
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
  held: Pick<SessionSendService, 'releaseHeld'>,
): SessionResumeSubsystem {
  return {
    resume: async (reference, actor, message, policy) => {
      const id = tryParseSessionId(reference);
      if (id === undefined)
        throw new SessionResumeError('invalid', `${JSON.stringify(reference)} is not a usable session id`);
      if (storage.findSession(id) === undefined) throw new SessionResumeError('not_found', `no session ${reference}`);
      await service
        .resume({
          id,
          actor,
          ...(message === undefined ? {} : { message }),
          ...(policy === undefined ? {} : { policy }),
        })
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
      /**
       * Held sends are delivered once the relaunch is accepted — the promise "kept durably; delivered
       * when this session is revived" made to their senders. Each is released at most once, keyed by
       * its own send id, and a failure here leaves it held for the next revive rather than failing
       * this one.
       */
      void held.releaseHeld(id).catch(() => undefined);
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
 * THE RECORD IS THE ONE THE STANDING ADVISORY NAMES, decided by `releasedAnswerAgendaOwnedBy` —
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
function createResumeAnswerAgenda(storage: DaemonStorage, answerLedger: FileAnswerLedger): ResumeAnswerAgenda {
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
      const owners = records.filter(record => releasedAnswerAgendaOwnedBy(state.data, record));
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
/** A queue's refusal, in the send route's taxonomy: no such message, or one no longer waiting. */
function queueRefusal(error: unknown): never {
  if (error instanceof QueueRefused)
    throw new SessionSendError(error.refusal === 'not_found' ? 'not_found' : 'refused', error.message);
  throw error;
}

function sendRefusal(error: unknown): never {
  // The subclasses first: each extends `SendRefused`, and a plain refusal is the base.
  if (error instanceof SendPending) throw new SessionSendError('pending', error.message);
  if (error instanceof SendUnconfirmed)
    throw new SessionSendError('unconfirmed', error.message, undefined, error.sendId);
  if (error instanceof SendDraftRefused) throw new SessionSendError('refused', error.message, error.draft);
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
  ledger: Pick<SendLedger, 'list'>,
  /**
   * The session's durable queue and its deliverer. With `queueing` on, a message is enqueued and the
   * deliverer types it; off, it is typed by the send path directly, as before. Read and edited either way.
   */
  queue: Pick<SessionQueueService, 'list' | 'enqueue' | 'edit' | 'cancel'>,
  deliverer: Pick<QueueDeliverer, 'enqueued'>,
  queueing: boolean,
  tracker: Pick<SendTracker, 'check' | 'watching'>,
  /** Copies each named attachment out where the agent can open it by path; see `lib/attachments/delivery.ts`. */
  deliverAttachments: (
    sessionId: SessionId,
    attachmentIds: readonly string[],
  ) => Promise<readonly DeliveredAttachment[]>,
  /** One hand-off document as the person's message; `undefined` when it is gone. */
  readHandoff: (sessionId: SessionId, name: string) => Promise<SessionHandoff | undefined>,
  /**
   * A PERSON's message read against the ferret's open Attention (`AgendaConversation`): the words it
   * receives, and the items it named made the ferret's turn once it was accepted (nothing resolves). A
   * teammate's message is never read this way — only the owner talks about the owner's items.
   */
  conversation: Pick<AgendaConversation, 'prepare' | 'settle'>,
  /**
   * The always-on instructions that changed since the ferret launched, queued once as a message of their
   * own when a PERSON writes (`InstructionRefresh`, docs/launch-settings.md). A teammate's message never
   * triggers it, and the person's words are never changed.
   */
  instructions: Pick<InstructionRefresh, 'queueIfStale'>,
): SessionSendSubsystem {
  const require = (reference: string): SessionId => {
    const id = tryParseSessionId(reference);
    if (id === undefined)
      throw new SessionSendError('invalid', `${JSON.stringify(reference)} is not a usable session id`);
    if (storage.findSession(id) === undefined) throw new SessionSendError('not_found', `no session ${reference}`);
    return id;
  };
  /** A sending ferret's callsign, for the sender chip; nothing when it cannot be read. */
  const ferretName = async (reference: string | undefined): Promise<{ readonly name?: string }> => {
    const id = reference === undefined ? undefined : tryParseSessionId(reference);
    const teammate = id === undefined ? undefined : (await sessions.get(id).catch(() => undefined))?.config.teammate;
    return teammate === undefined ? {} : { name: teammate };
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
      // A named attachment that is not this session's refuses the send rather than dropping the file:
      // a message that says "see the screenshot" with no screenshot is the worse outcome.
      const delivered =
        request.attachmentIds === undefined || request.attachmentIds.length === 0
          ? []
          : await deliverAttachments(id, request.attachmentIds).catch((error: unknown) => {
              throw new SessionSendError(
                'invalid',
                `an attached file could not be handed to the agent: ${error instanceof Error ? error.message : String(error)}`,
              );
            });
      const person = request.senderSessionId === undefined;
      const turn = person
        ? await conversation.prepare(id, request.message)
        : { message: request.message, referenced: [] };
      // `now` stops the running turn first: that is the send path's to do, not a queue's to wait for.
      // `now` rides the queue as an interrupt flag: it keeps its order, and the deliverer stops the running
      // turn when its turn comes and the input box is empty.
      if (queueing) {
        // The refusals only a person can lift are said now, exactly as the direct path says them.
        await service.authorize(id, request.attachmentIds ?? []).catch((error: unknown) => sendRefusal(error));
        const enqueued = await queue
          .enqueue(id, {
            id: request.sendId,
            sender: person ? 'human' : 'agent',
            ...(request.senderSessionId === undefined ? {} : { from: request.senderSessionId }),
            by: person ? { kind: 'owner' } : { kind: 'ferret', ...(await ferretName(request.senderSessionId)) },
            text: messageWithAttachments(turn.message, delivered),
            ...(request.attachmentIds === undefined ? {} : { attachmentIds: request.attachmentIds }),
            ...(request.replyExpected === undefined ? {} : { replyExpected: request.replyExpected }),
            ...(request.now === true ? { interrupt: true } : {}),
          })
          .catch((error: unknown) => sendRefusal(error));
        // On disk now — the first tick. The deliverer's first look types it into an empty box, and the
        // answer is then what the ledger proves, as the direct path's was; held for a reason, it is queued.
        await Promise.race([deliverer.enqueued(id).catch(() => undefined), Bun.sleep(QUEUE_ANSWER_WAIT_MS)]);
        const answer = answerOf((await ledger.list(id)).find(record => record.sendId === enqueued.message.id));
        if (turn.referenced.length > 0) await conversation.settle(id, turn);
        if (person) await instructions.queueIfStale(id);
        return {
          ...(await view(id, 'took the message')),
          disposition: answer.disposition,
          sendId: enqueued.message.id,
          fate: answer.fate,
        };
      }
      const outcome = await service
        .send({
          id,
          sendId: request.sendId,
          message: messageWithAttachments(turn.message, delivered),
          ...(request.attachmentIds === undefined ? {} : { attachmentIds: request.attachmentIds }),
          ...(request.now === undefined ? {} : { now: request.now }),
          ...(request.replyExpected === undefined ? {} : { replyExpected: request.replyExpected }),
          ...(request.senderSessionId === undefined ? {} : { senderReference: request.senderSessionId }),
        })
        .catch((error: unknown) => sendRefusal(error));
      // Only once the words were accepted: an item must never close as replied for a message the
      // ferret was not given.
      if (turn.referenced.length > 0) await conversation.settle(id, turn, request.message);
      if (person) await instructions.queueIfStale(id);
      return {
        ...(await view(id, 'took the message')),
        disposition: outcome.disposition,
        sendId: outcome.record.sendId,
        fate: sendRecordView(outcome.record).fate,
      };
    },
    interrupt: async reference => {
      const id = require(reference);
      await service.interrupt(id).catch((error: unknown) => sendRefusal(error));
      return await view(id, 'was interrupted');
    },
    // A READ IS A LOOK, BOUNDED (`lookBeforeReading`): a fresh answer when one is quick, and the ledger
    // as it stands when it is not — a slow look must never hold the reader that asked for it.
    sends: async reference => {
      const id = require(reference);
      await lookBeforeReading(tracker, id, async milliseconds => await Bun.sleep(milliseconds));
      return (await ledger.list(id))
        .map(sendRecordView)
        .sort((left, right) => Date.parse(right.acceptedAt) - Date.parse(left.acceptedAt));
    },
    queue: async reference => await queue.list(require(reference)),
    editQueued: async (reference, messageId, text) =>
      await queue.edit(require(reference), messageId, text).catch((error: unknown) => queueRefusal(error)),
    cancelQueued: async (reference, messageId) =>
      await queue.cancel(require(reference), messageId).catch((error: unknown) => queueRefusal(error)),
    sendStatus: async (reference, sendId) => {
      const id = require(reference);
      await lookBeforeReading(tracker, id, async milliseconds => await Bun.sleep(milliseconds));
      const record = (await ledger.list(id)).find(entry => entry.sendId === sendId);
      if (record === undefined) throw new SessionSendError('not_found', `session ${id} has no send ${sendId}`);
      return sendRecordView(record);
    },
    retry: async (reference, sendId, force) => {
      const id = require(reference);
      const record = await service
        .reattempt(id, sendId, { by: 'person', force })
        .catch((error: unknown) => sendRefusal(error));
      return sendRecordView(record);
    },
    cancel: async (reference, sendId) => {
      const id = require(reference);
      const record = await service.cancel(id, sendId).catch((error: unknown) => sendRefusal(error));
      return sendRecordView(record);
    },
    submit: async (reference, sendId) => {
      const id = require(reference);
      const record = await service.submit(id, sendId).catch((error: unknown) => sendRefusal(error));
      return sendRecordView(record);
    },
    composer: async (reference, request) => {
      const id = require(reference);
      const outcome = await service
        .resolveDraft(id, request.action, request.draft)
        .catch((error: unknown) => sendRefusal(error));
      return { action: request.action, outcome };
    },
    handoff: async (reference, name) => {
      const id = require(reference);
      const handoff = await readHandoff(id, name);
      if (handoff === undefined)
        throw new SessionSendError('not_found', `session ${id} has no hand-off document ${name}`);
      return handoff;
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
  // Every step of a drive is journalled as it happens, so one that stops says where and why.
  const driver = new TmuxStructuredQuestionDriver(
    tmux,
    tmuxSession,
    milliseconds => Bun.sleep(milliseconds),
    undefined,
    undefined,
    async (id, step) => {
      await storage.append(id, 'interaction.answer_step', { ...step });
    },
  );
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
      // The form stays pending exactly as it is; only the stop and how far it got are recorded.
      paused: async (id, question, answers, context) => {
        await storage
          .append(id, 'interaction.answer_paused', {
            toolUseId: question.toolUseId,
            error: context.failure.message,
            stoppedAt: context.failure.progress.stoppedAt,
            answered: context.failure.progress.answered,
            headers: question.questions.map(item => item.header ?? null),
            matcher: context.failure.diagnostics,
            answerCount: answers.length,
            ...(context.snapshotError === undefined ? {} : { snapshotError: context.snapshotError }),
            ...(context.snapshot === undefined
              ? {}
              : { excerpt: context.snapshot.visible.split('\n').slice(-40).join('\n').slice(-6_000) }),
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
            needsHumanKind: STRUCTURED_ANSWER_RELEASED_AGENDA_KIND,
            // The projection's own builder, not a copy of its sentence: this first write IS one of
            // the two messages `releasedAnswerAgendaOwnedBy` recognises, so a second literal here
            // would be a fact with two owners — and the day they drifted, ownership would silently
            // read false and the advisory would become undismissable.
            needsHuman: firstWriteReleasedAnswerAgenda(record.toolUseId),
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
          if (error instanceof AnswerRequestConflict)
            throw new SessionAnswerError(
              'conflict',
              isQuestionScopedRequestId(request.requestId)
                ? RELOAD_THE_APP
                : 'A different answer was already sent for this question. Reload the session and check it before answering again.',
              undefined,
              error.message,
            );
          if (error instanceof AnswerAlreadyAnswered)
            throw new SessionAnswerError('already_answered', error.message, error.answeredWith, error.detail);
          if (error instanceof AnswerToolAlreadyHandled) throw new SessionAnswerError('refused', error.message);
          if (error instanceof AnswerUnconfirmed)
            throw new SessionAnswerError('unconfirmed', ANSWER_MAY_HAVE_LANDED, undefined, error.message);
          if (
            error instanceof AnswerAcknowledged ||
            error instanceof AnswerReleased ||
            error instanceof AnswerTerminalFailure
          )
            throw new SessionAnswerError('released', error.message);
          // The driver's sentences are evidence, not instructions: they travel as the detail, and the
          // person is told how they can still answer.
          if (error instanceof StructuredQuestionAttemptPaused)
            throw new SessionAnswerError(
              'paused',
              answerPaused(error.failure.progress),
              undefined,
              error.message,
              error.failure.progress,
            );
          if (error instanceof StructuredQuestionAttemptFailed) {
            if (error.receipt === 'accepted')
              throw new SessionAnswerError('unconfirmed', ANSWER_NOT_DELIVERED, undefined, error.message);
            if (error.receipt === 'failed' || error.receipt === 'quarantined')
              throw new SessionAnswerError('released', ANSWER_NOT_DELIVERED, undefined, error.message);
            throw new SessionAnswerError('failed', ANSWER_NOT_DELIVERED, undefined, error.message);
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
  /** A `done` on the ferret's focus card (board-design.md §3.1 item 5); never fails the signal. */
  cards: Pick<SessionCards, 'signalled'>,
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
      // The card hears it AFTER the session recorded it: the done message becomes a note on its focus card,
      // which moves on to review when nothing else owns its lane. A board failure is said, never answered.
      if (request.kind === 'done') await cards.signalled(id, request.message);
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
 * Renaming an agent, over the session's own documents and the one name ledger.
 *
 * The decision — what may change, which name is free, what the journal says — is
 * `SessionRenameService`'s. This only reads and writes: the names come from the same reader the list
 * serves, and the write replaces `teammate` and `name` on the configuration and nothing else.
 */
function createSessionRenameSubsystem(
  storage: DaemonStorage,
  sessions: SessionDirectorySubsystem,
  claims: CallsignClaims,
  clock: ClockPort,
): SessionRenameSubsystem {
  const service = new SessionRenameService({
    current: async reference => {
      const id = tryParseSessionId(reference);
      if (id === undefined)
        throw new SessionRenameError('invalid', `${JSON.stringify(reference)} is not a usable session id`);
      const view = await sessions.get(id);
      return view === undefined
        ? undefined
        : { ...(view.config.teammate === undefined ? {} : { teammate: view.config.teammate }), name: view.config.name };
    },
    write: async (id, next, at) => {
      await storage.updateConfig(parseSessionId(id), current => {
        const { teammate: _replaced, ...retained } = jsonObject(current) ?? {};
        return {
          ...retained,
          ...(next.name === retained.name ? {} : { nameSource: 'owner' }),
          ...(next.teammate === undefined ? {} : { teammate: next.teammate }),
          name: next.name,
          updatedAt: at,
        };
      });
    },
    journal: async (id, entry) => {
      await storage.append(parseSessionId(id), 'session.renamed', entry);
    },
    claims,
    now: () => new Date(clock.now()),
  });
  return {
    rename: async (reference, request, actor) => {
      await service.rename(reference, request, actor);
      const view = await sessions.get(parseSessionId(reference));
      if (view === undefined)
        throw new SessionRenameError(
          'failed',
          `session ${reference} was renamed but its documents do not satisfy the protocol`,
        );
      return view;
    },
  };
}

/**
 * Whether a session is an ordinary ferret — told about Pack mode and lessons — rather than one of the
 * daemon's own workers: a learning miner, a routing prompt clean-up, or a warden's lineage.
 */
const ordinaryFerret = (label: string | undefined, wardenLineage: boolean | undefined): boolean =>
  label !== LEARNING_MINER_LABEL && label !== PACK_CLEAN_UP_LABEL && wardenLineage !== true;

/** Pack mode's hooks into a session start (docs/pack-mode.md). */
interface SessionPackHooks {
  /** Why `parent` may not start another sub-ferret now, or `undefined` when it may. */
  admit(parent: string): Promise<PackRefusal | undefined>;
  /** Records the new ferret's switch and writes `FY_PACK` into its launch environment. */
  adopt(id: SessionId, eligible: boolean, parent: string | undefined): Promise<void>;
  /**
   * The `FY_PACK` a launch derives from the session's record, for an environment that never stored one,
   * and — for a ferret Pack mode is on for — the routing prompt as one line, derived fresh at every launch.
   */
  launchDefault: LaunchSwitchDefaults;
}

/** A session status after which no process runs until the session is launched again. */
/** How often the deadline sweep looks for an item whose `neededBy` came near with nothing else touching its board. */
const AGENDA_DEADLINE_SWEEP_MS = 5 * 60_000;

const HYPERMEDIA_NOT_RUNNING: ReadonlySet<string> = new Set(['completed', 'failed', 'stalled', 'stopped']);

/**
 * Whether a ferret is told to use hypermedia (docs/hypermedia.md), over its own documents.
 *
 * The decision is `SessionHypermediaService`'s. This writes the two places the switch lives — the
 * configuration every surface reads and the launch environment the pane reads — together, under the
 * session's own lock, so a concurrent environment merge (a task board delivering a grant) cannot lose
 * either half.
 */
function createSessionHypermediaSubsystem(
  storage: DaemonStorage,
  sessions: SessionDirectorySubsystem,
  environments: FileSessionEnvironmentStore,
  serial: KeyedSerialExecutor,
  clock: ClockPort,
): SessionHypermediaSubsystem {
  const service = new SessionHypermediaService({
    facts: async reference => {
      const id = tryParseSessionId(reference);
      const view = id === undefined ? undefined : await sessions.get(id);
      return view === undefined
        ? undefined
        : { enabled: sessionHypermediaEnabled(view.config), running: !HYPERMEDIA_NOT_RUNNING.has(view.state.status) };
    },
    write: async (reference, enabled, at) => {
      const id = parseSessionId(reference);
      await serial.run(`session:${id}`, async () => {
        await storage.updateConfig(id, current => ({
          ...(jsonObject(current) ?? {}),
          hypermedia: enabled,
          updatedAt: at,
        }));
        await environments.write(id, { ...(await environments.read(id)), [HYPERMEDIA_ENV]: enabled ? '1' : '0' });
      });
    },
    now: () => new Date(clock.now()).toISOString(),
  });
  return {
    set: async (reference, enabled) => {
      const outcome = await service.set(reference, enabled);
      const view = await sessions.get(parseSessionId(reference));
      if (view === undefined)
        throw new Error(`session ${reference} was switched but its documents do not satisfy the protocol`);
      return { view, outcome };
    },
  };
}
/** Pack mode's view of one session's place in the tree: its facts as a parent, from the session documents. */
interface PackTree {
  parent(id: string): Promise<PackParent | undefined>;
  depth(id: string): Promise<number>;
}

function createPackTree(sessions: SessionDirectorySubsystem): PackTree {
  const depth = async (id: string): Promise<number> =>
    await depthOf(id, async candidate => (await sessions.get(candidate).catch(() => undefined))?.config);
  return {
    depth,
    parent: async id => {
      const view = await sessions.get(id).catch(() => undefined);
      if (view === undefined) return undefined;
      const all = await sessions.list();
      return {
        id: view.config.id,
        interactive: view.config.mode === 'interactive',
        depth: await depth(view.config.id),
        runningChildren: runningChildCount(
          view.config.id,
          all.map(child => ({ parent: child.config.parent, status: child.state.status })),
        ),
        cwd: view.config.cwd,
        pack: view.config.pack,
      };
    },
  };
}

/**
 * Pack mode's two hooks into every start (docs/pack-mode.md). The limits: a parent the documents do
 * not know is left alone, as a start always left it. The switch: `FY_PACK` in the new ferret's launch
 * environment, `1` exactly when the machine's switch is on and it sits shallow enough to start its own.
 */
function createSessionPackHooks(
  tree: PackTree,
  sessions: SessionDirectorySubsystem,
  environments: FileSessionEnvironmentStore,
  serial: KeyedSerialExecutor,
  packConfig: () => Promise<PackConfig>,
  routing: () => Promise<string | undefined>,
): SessionPackHooks {
  return {
    launchDefault: async (id): Promise<Readonly<Record<string, string>>> => {
      const view = await sessions.get(id).catch(() => undefined);
      // A session the documents cannot show is launched exactly as before: nothing is filled in.
      if (view === undefined) return {};
      const { config } = view;
      const depth = config.parent === undefined ? 0 : (await tree.depth(config.parent)) + 1;
      const eligible = ordinaryFerret(config.label, config.provenance?.wardenLineage);
      const pack = packLaunchDefault(await packConfig(), { eligible, ownSwitch: config.pack, depth });
      // Never stored, so every launch hears the guide saved now; the wrapper adds it only when FY_PACK is 1.
      const line = eligible ? await routing().catch(() => undefined) : undefined;
      return { [PACK_ENV]: pack, ...(line === undefined ? {} : { [PACK_ROUTING_ENV]: line }) };
    },
    admit: async parent => {
      const facts = await tree.parent(parent);
      return facts === undefined ? undefined : admitChild(facts, (await packConfig()).limits);
    },
    adopt: async (id, eligible, parent) => {
      const config = await packConfig();
      const depth = parent === undefined ? 0 : (await tree.depth(parent)) + 1;
      const on = eligible && packInstructed(config, undefined, depth);
      await serial.run(`session:${id}`, async () => {
        await environments.write(id, { ...(await environments.read(id)), [PACK_ENV]: on ? '1' : '0' });
      });
    },
  };
}

/**
 * Agenda mode's hook into every launch (docs/agenda.md): `FY_AGENDA` follows the switch recorded on the session
 * document, so the pane is told what every surface shows. A session the documents cannot show derives nothing.
 */
async function agendaLaunchDefault(
  sessions: SessionDirectorySubsystem,
  id: SessionId,
): Promise<Readonly<Record<string, string>>> {
  const view = await sessions.get(id).catch(() => undefined);
  return view === undefined
    ? {}
    : {
        [AGENDA_ENV]: sessionAgendaEnabled(view.config) ? '1' : '0',
        [SUB_FERRET_ENV]: view.config.parent === undefined || view.config.parent === '' ? '0' : '1',
      };
}

/** One ferret's own Pack switch: the document and the launch variable, under the session's lock. */
function createSessionPackSwitch(
  storage: DaemonStorage,
  sessions: SessionDirectorySubsystem,
  environments: FileSessionEnvironmentStore,
  serial: KeyedSerialExecutor,
  tree: PackTree,
  packConfig: () => Promise<PackConfig>,
  clock: ClockPort,
): PackSubsystem['setSwitch'] {
  const service = new SessionPackService({
    facts: async reference => {
      const id = tryParseSessionId(reference);
      const view = id === undefined ? undefined : await sessions.get(id);
      return view === undefined
        ? undefined
        : { enabled: view.config.pack, running: !HYPERMEDIA_NOT_RUNNING.has(view.state.status) };
    },
    write: async (reference, enabled, at) => {
      const id = parseSessionId(reference);
      const view = await sessions.get(id);
      const parent = view?.config.parent;
      const depth = parent === undefined ? 0 : (await tree.depth(parent)) + 1;
      const on = packInstructed(await packConfig(), enabled, depth);
      await serial.run(`session:${id}`, async () => {
        await storage.updateConfig(id, current => ({ ...(jsonObject(current) ?? {}), pack: enabled, updatedAt: at }));
        await environments.write(id, { ...(await environments.read(id)), [PACK_ENV]: on ? '1' : '0' });
      });
    },
    now: () => new Date(clock.now()).toISOString(),
  });
  return async (reference, enabled) => {
    const outcome = await service.set(reference, enabled);
    const view = await sessions.get(parseSessionId(reference));
    if (view === undefined)
      throw new Error(`session ${reference} was switched but its documents do not satisfy the protocol`);
    return { view, outcome };
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
 * Provenance for every agenda item the warden writes.
 *
 * `warden-escalation` is a DISTINCT daemon cause from ordinary source
 * reconciliation, and the state machine reads it: an agent can never dismiss a
 * daemon-raised item, and a reader can tell a warden's interruption apart from a
 * session's own request without parsing its prose.
 */
const WARDEN_ESCALATION_ACTOR: AgendaActor = { kind: 'daemon', cause: 'warden-escalation' };

/** How many transcript lines a Jev snapshot carries. The guard bounds them again; this bounds the read. */
const WARDEN_TRIAGE_TAIL = 12;

/** How often the liveness monitor looks at every working ferret: kteam's own tick. */
const WARDEN_LIVENESS_TICK_SECONDS = 30;

/** The collaborators a warden subsystem needs from the rest of the root. */
/**
 * `tick`, run as the labelled activity `name`, so `fy daemon profile` and a stall can name the timer
 * that did the work. The tick's own errors stay its own: a rejection is swallowed here exactly as each
 * timer already swallowed it. Without a ledger the tick runs as it always did.
 */
function asActivity(activities: ActivityLedger | undefined, name: string, tick: () => unknown): () => void {
  return () => {
    if (activities === undefined) {
      void tick();
      return;
    }
    void activities.run(name, async () => await tick()).catch(() => undefined);
  };
}

interface WardenParts {
  /** The named work in flight, so the sweep and the liveness tick are attributed in a profile. */
  readonly activities?: ActivityLedger;
  readonly sessions: SessionDirectorySubsystem;
  readonly control: SessionControlSubsystem;
  /**
   * The session documents as written, no transcript projected first: the liveness monitor's 30 s roster.
   * Its own look reads the evidence, and each running session's worker keeps its document current.
   */
  readonly documents: Pick<SessionDirectorySubsystem, 'list'>;
  /**
   * The ONE agenda service every other caller uses, not a second one.
   *
   * A warden escalation lands on the flagged session's own board, through the
   * same state machine, the same locking and the same durable document a person
   * answers it on. A private store here would be a second account of what a
   * session is waiting for, and the two would disagree the first time anybody
   * resolved anything.
   */
  readonly attention: AgendaService;
  readonly usage: UsageFeedPort;
  readonly accounts: AccountInventoryPort & Partial<RuntimeNamesPort>;
  /** The machine's default runtime, read fresh: the investigation login when `warden.yaml` names none. */
  readonly defaultRuntime: () => Promise<string | undefined>;
  readonly files: NodeWardenReportFileSystem;
  readonly reportsReader: WardenReportReader;
  readonly wardenRoot: string;
  readonly reportsDirectory: string;
  /** Where Jev's checks are kept, beside the reports. */
  readonly jevChecksDirectory: string;
  readonly supervision: WardenSupervisionState;
  /** The configuration files: `warden.yaml` is read and written through them. */
  readonly config: ConfigFilesService;
  /**
   * The operator reads — transcript tail and screen — already scrubbed by the vault redactor. The Jev
   * guard's evidence comes from here, so it is masked the same way every other read of a ferret is.
   */
  readonly reads: Pick<OperatorReadService, 'logs' | 'snapshot'>;
  /** The same redactor, for the strings of a Jev snapshot that are the Warden's own. */
  readonly redactor: Pick<SecretRedactor, 'batch'>;
  /** Jev behind the one outbound holder, built for the guard settings in effect. It holds no key. */
  readonly guard: (settings: WardenGuardConfig) => TriageGuardPort;
  /** What a verdict may do: the same send, resume, stop and migrate every other caller uses. */
  readonly sends: Pick<SessionSendService, 'send'>;
  readonly resume: Pick<SessionResumeService, 'resume'>;
  readonly migrate: SessionMigrateSubsystem;
  /** Analytics, for pricing a finished warden from its own transcript. */
  readonly analytics: Pick<AnalyticsIngestionService, 'read'>;
  /** The live journal append edge, for the events that bring a sweep forward. */
  readonly events: (listener: (event: { readonly type: string; readonly data: unknown }) => void) => () => void;
  /**
   * One liveness look at a ferret — its screen, its transcript tail and the processes under its pane — as
   * the session observer takes it (`InlineObserverHost.liveness`). The fold and the reflex stay here.
   */
  readonly livenessSample: (target: LivenessTarget) => Promise<LivenessSample>;
  /** Close the browsers a ferret launched that still run under its pane, read afresh; how many closed. */
  readonly closeLeftoverBrowsers: (sessionId: string) => Promise<number>;
  /** This machine's name, as pairing gave it: every Warden notification says which machine it is about. */
  readonly machineName: () => string | undefined;
  /**
   * Where the liveness monitor's ledger is published for the board, which judges "last touched" from the
   * same evidence. Filled in here because the monitor is built here; until then it reads nothing.
   */
  readonly ledgers: { read: LivenessLedgerReader };
  /** What auto-revive reaches the rest of the daemon through: the journal, the resume, the tmux probe, the clock. */
  readonly revive: Pick<WardenRevivePorts, 'events' | 'resume' | 'tmuxReady' | 'sleep'>;
  /** The project boards: the cards the Warden reports orphaned, and the card a ferret it starts again carries on. */
  readonly board: WardenBoardPort;
}

/**
 * Fleet supervision, assembled from the modules that had no way to reach a running daemon.
 *
 * THE FLEET READER IS THE SAME SESSION READER EVERY OTHER SURFACE USES, so the sessions a warden
 * judges are the sessions the list shows, parsed by the same schemas from the same documents. A
 * private reader would let the warden act on a view nobody else can see.
 *
 * `hasLiveMonitor` COMES FROM THE LIVENESS MONITOR. It looks at every working ferret each tick — screen,
 * transcript tail, work counters, pane subprocesses — and a ferret is watched while it has been looked at
 * recently. Its ledger is laid over the session documents, which is what switches the sus classifiers
 * on with evidence that moves; a working ferret it cannot look at is a `dead_monitor`, per ferret. The
 * reflex nudges a quiet ferret only when the owner lets the Warden nudge, and a frozen one becomes a
 * flag — nothing here stops a ferret.
 *
 * `stopCapability` IS RECORDED AND NOT DELIVERED. The sweep mints an unguessable secret per
 * assignment and the durable state holds it, but this daemon's start declares no field to carry one
 * into the warden's own terminal, so no warden can present it. That is why `mayAct` is false: the
 * prompts say plainly that the report is the deliverable rather than handing a warden commands it
 * cannot run.
 */
function createWardenSubsystem(parts: WardenParts): WardenSubsystem {
  // The liveness monitor: what the Warden SEES of each working ferret between sweeps. Its ledger is laid
  // over the session documents the sweep reads, so the sus classifiers reason over real evidence, and a
  // working ferret it has not been able to look at recently is the `dead_monitor` it claims to be.
  const liveness = new WardenLivenessMonitor(
    {
      targets: async () =>
        (await parts.documents.list())
          .filter(view => view.config.label !== WARDEN_LABEL)
          .map(view => ({
            id: view.config.id,
            status: view.state.status,
            turn: view.state.turn,
            mode: view.config.mode,
            waiting: view.state.waiting !== undefined,
            ...(view.state.turnState === undefined ? {} : { turnState: view.state.turnState }),
            nudgeAfterSeconds: view.config.nudgeAfterSeconds,
            killAfterSeconds: view.config.killAfterSeconds,
            tmuxSession: sessionTmuxName(parseSessionId(view.config.id), defaultSessionLifecycleSettings),
          })),
      // The session observer's look: three reads, each total, the screen and transcript through the operator
      // reads (masked by the vault redactor), and only their digests kept.
      sample: async target => await parts.livenessSample(target),
      nowMs: () => Date.now(),
    },
    WARDEN_LIVENESS_TICK_SECONDS,
  );
  parts.ledgers.read = sessionId => liveness.ledger(sessionId);
  const artifacts = new FileWardenArtifacts(parts.files, parts.reportsReader, parts.reportsDirectory);
  const wardenJournal: WardenJournal = {
    record: (type, data) => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), type, data })}\n`),
  };
  const revive = new WardenReviveService({
    ...parts.revive,
    journal: wardenJournal,
    focusCard: async sessionId => await parts.board.focusCard(sessionId),
    // The breaker's one notice lands on the session that tripped it, as a plain notification that buzzes.
    notifyOwner: async notice => {
      await parts.attention
        .raise(
          notice.sessionId,
          {
            source: 'agent-raised',
            sourceRef: 'warden-revive-breaker',
            subject: notice.subject,
            why: notice.why,
            context: 'Auto-revive paused itself after revived sessions kept dying.',
            waitingSince: new Date().toISOString(),
            howToResolve:
              'Nothing to answer. Look at why sessions keep dying; revives resume by themselves after the pause.',
            notice: true,
            ping: true,
            title: notice.title,
            kind: 'info',
            premise: 'Ferretry restarts sessions that die abnormally, at most a few at a time.',
          },
          WARDEN_ESCALATION_ACTOR,
        )
        .catch(() => undefined);
    },
  });
  const service = new WardenSweepService(
    {
      revive,
      board: parts.board,
      guard: parts.guard,
      // The tail and the screen as an operator would read them — already masked by the vault redactor.
      // A ferret whose transcript or pane cannot be read is simply shown with less evidence.
      evidence: {
        evidence: async sessionId => {
          const transcript = await parts.reads.logs(sessionId, WARDEN_TRIAGE_TAIL).catch(() => '');
          const screen = await parts.reads.snapshot(sessionId).catch(() => undefined);
          return {
            recentTurns: transcript
              .split('\n')
              .map(line => line.trimEnd())
              .filter(line => line !== '')
              .slice(-WARDEN_TRIAGE_TAIL),
            ...(screen === undefined ? {} : { paneTail: screen }),
          };
        },
      },
      redactor: parts.redactor,
      jevChecks: new FileWardenJevCheckLog(parts.jevChecksDirectory, () => Date.now()),
      remedies: {
        // The daemon is the sender: recorded as a person's, every Warden notice was a "human" send, kept
        // and retried as the owner's own messages are, and counted against them.
        nudge: async (sessionId, message) => {
          await parts.sends.send({
            id: parseSessionId(sessionId),
            sendId: crypto.randomUUID(),
            message,
            origin: 'daemon',
          });
        },
        // A message is the turn the ferret is handed (its focus card, `focus-card.ts`); without one the resume
        // domain hands its own default turn.
        resume: async (sessionId, message) => {
          await parts.resume.resume({
            id: parseSessionId(sessionId),
            actor: 'warden',
            ...(message === undefined ? {} : { message }),
          });
        },
        // A restart is the resume path told to replace the pane even when it looks alive: a frozen process
        // is still "alive", and typing into it would hand the turn to the very thing that is stuck. The
        // conversation is resumed in the new process, and the warden policy keeps every automatic guard.
        restart: async (sessionId, message) => {
          await parts.resume.resume({
            id: parseSessionId(sessionId),
            actor: 'warden',
            policy: { ...resolveResumePolicy('warden'), replaceLiveTerminal: true },
            ...(message === undefined ? {} : { message }),
          });
        },
        stop: async (sessionId, reason) => {
          await parts.control.stop(sessionId, reason);
        },
        failover: async (sessionId, agent) => {
          await parts.migrate.migrate(sessionId, { agent, allowContextDowngrade: false, forceInflight: false });
        },
        closeLeftoverBrowsers: async sessionId => await parts.closeLeftoverBrowsers(sessionId),
      },
      costs: {
        costUsd: async wardenSessionId => {
          const micros = parts.analytics
            .read()
            .rows.find(row => row.id === wardenSessionId)?.equivalentApiCostUsdMicros;
          return micros === null || micros === undefined ? undefined : micros / 1_000_000;
        },
      },
      feed: {
        board: async sessionId => {
          const listed = await parts.attention.list(sessionId).catch(() => undefined);
          if (listed?.ok !== true) return undefined;
          return {
            sessionId,
            parseErrors: 0,
            items: listed.value.items.map(item => ({
              id: item.id,
              source: item.source,
              subject: item.subject,
              why: item.why,
              ...(item.context === null || item.context === undefined ? {} : { context: item.context }),
              waitingSince: item.waitingSince,
              howToResolve: item.howToResolve,
              raisedBy: item.raisedBy,
              ...(item.sourceRef === null ? {} : { sourceRef: item.sourceRef }),
            })),
          };
        },
      },
      fleet: {
        fleet: async () =>
          await Promise.all((await parts.sessions.list()).map(view => wardenFleetSession(parts, view, liveness))),
        // A monitor that has stopped seeing is ONE fault of this daemon, never one per ferret.
        monitorStalled: () => liveness.stalled(),
      },
      spawner: {
        spawn: async request => {
          const start = {
            agent: request.agent,
            ...(request.model === undefined ? {} : { model: request.model }),
            name: request.name,
            // Its own callsign, with no fallback: one would draw a first name from the pool, which is for real ferrets.
            ...(request.teammate === undefined ? {} : { teammate: request.teammate }),
            // The label is what the detector's lineage shield reads: a warden that was not labelled
            // would be swept, flagged and investigated by the next warden, forever.
            label: WARDEN_LABEL,
            mode: 'auto' as const,
            prompt: request.prompt,
            cwd: request.cwd,
            ...(request.effort === undefined ? {} : { effort: request.effort }),
          };
          const payload = JSON.stringify(start);
          const view = await parts.control.start(start, crypto.randomUUID(), payload).catch((error: unknown) => {
            if (error instanceof SessionControlError && error.failure === 'callsign_taken')
              throw new WardenCallsignTakenError(request.teammate ?? '');
            throw error;
          });
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
      config: new ConfigFileWardenConfigStore(parts.config),
      agents: new FleetWardenAgents(parts.accounts, parts.defaultRuntime),
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
                // A plain notification from the Warden: no ask and no answers — reading it is acting on
                // it, and it opens the ferret's chat. Old apps read it as an `info` card.
                notice: request.notice,
                ping: request.ping,
                title: request.title,
                kind: 'info',
                premise: request.premise,
                ...(request.terms === undefined ? {} : { terms: [...request.terms] }),
              },
              WARDEN_ESCALATION_ACTOR,
            )
            .catch(() => undefined);
          if (mutation === undefined || !mutation.ok) return 'rejected';
          return mutation.change === 'created' || mutation.change === 'refreshed' ? mutation.change : 'unchanged';
        },
        // A plain notice about a CARD (an orphaned one): tied to it, so the card and the Inbox name each other.
        notice: async (sessionId, notice) => {
          const mutation = await parts.attention
            .raise(
              sessionId,
              {
                source: WARDEN_ESCALATION_SOURCE,
                sourceRef: notice.sourceRef,
                subject: notice.subject,
                why: notice.why,
                context: notice.context,
                waitingSince: notice.waitingSince,
                howToResolve: notice.howToResolve,
                notice: true,
                title: notice.title,
                kind: 'info',
                premise: notice.premise,
                task: notice.task,
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
      journal: wardenJournal,
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
      supervisesMonitors: true,
      mayAct: false,
      machineName: parts.machineName,
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
        const handle = setInterval(asActivity(parts.activities, 'warden sweep', tick), intervalMs);
        return () => clearInterval(handle);
      },
      after: (delayMs, action) => {
        const handle = setTimeout(asActivity(parts.activities, 'warden sweep', action), delayMs);
        return () => clearTimeout(handle);
      },
      nowMs: () => Date.now(),
    },
  );
  const nextSweepAt = (): string | undefined => {
    const due = loop.nextDueAtMs();
    return due === undefined ? undefined : new Date(due).toISOString();
  };
  return {
    status: async () => await service.status(nextSweepAt()),
    verdicts: async () => await parts.reportsReader.readVerdicts(),
    report: async (reportPath: string) => await parts.reportsReader.readReportAt(reportPath),
    run: async (force: boolean) => await loop.run(force),
    config: async () => await service.view(),
    updateConfig: async (patch: unknown) => await service.updateConfig(parseWardenConfigPatch(patch)),
    attention: async () => await service.agenda(),
    // Queued inside the sweep chain, then a sweep right behind it: if a slot is free the investigation
    // starts now, and the answer says whether it did.
    investigate: async request => {
      const queued = await loop.exclusive(
        async () => await service.requestInvestigation(request.sessionId, request.note),
      );
      if (queued.state === 'running') return queued;
      await loop.run(false).catch(() => undefined);
      return await service.investigationStatus(request.sessionId);
    },
    // Inside the sweep chain, like every other write of the durable state.
    leave: async request =>
      await loop.exclusive(async () => await service.leaveAlone(request.sessionId, request.duration)),
    lastSweepAt: async () => await service.lastSweepAt(),
    intervalMs: async () => await service.intervalMs(),
    arm: async () => {
      parts.supervision.intervalMs = await service.intervalMs();
      const disarm = await loop.arm();
      // The timer is evidence only after the scheduler accepted it. The instant lets health classify
      // the deliberate pre-first-sweep window as grace rather than as unknown supervision.
      parts.supervision.armedAtMs = Date.now();
      parts.supervision.armed = true;
      // A turn ending, a question waiting or a pane dying brings the next sweep forward. The settings are
      // read per event, so turning a trigger off takes effect at once; a listener must never throw into
      // the journal's append path.
      const unsubscribe = parts.events(event => {
        const trigger = wardenEventTrigger(event.type, event.data);
        if (trigger === undefined) return;
        void service
          .currentConfig()
          .then(config => {
            if (config.enabled && wardenTriggerEnabled(trigger, config.events)) loop.trigger();
          })
          .catch(() => undefined);
      });
      // The liveness monitor's own tick. One at a time: a slow tick is skipped over, never stacked. What
      // it finds is acted on inside the sweep chain, and a ferret that froze brings the next sweep forward.
      liveness.arm();
      let looking = false;
      const look = setInterval(
        asActivity(parts.activities, 'warden liveness', async () => {
          if (looking) return;
          looking = true;
          await service
            .currentConfig()
            .then(async config => await liveness.tick({ nudgeAllowed: config.enabled && config.mayActAlone.nudge }))
            .then(async events => await loop.exclusive(async () => await service.reflex(events)))
            .then(result => {
              if (result.frozen) loop.trigger();
            })
            .catch(() => undefined)
            .finally(() => {
              looking = false;
            });
        }),
        WARDEN_LIVENESS_TICK_SECONDS * 1000,
      );
      return () => {
        clearInterval(look);
        liveness.disarm();
        unsubscribe();
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
async function wardenFleetSession(
  parts: WardenParts,
  view: SessionView,
  liveness: WardenLivenessMonitor,
): Promise<WardenFleetSession> {
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
    // The session's own documents, with what the liveness monitor saw laid over them.
    state: withLivenessLedger(view.state, liveness.ledger(view.config.id)),
    directory: view.directory,
    cwd: view.config.cwd,
    turn: view.state.turn,
    // Watched when the liveness monitor has looked at it recently — see `WardenLivenessMonitor.watching`.
    hasLiveMonitor: liveness.watching(view.config.id),
    ...(liveness.frozenAt(view.config.id) === undefined ? {} : { frozenAt: liveness.frozenAt(view.config.id) }),
    // Silence is measured from when this daemon began watching — and a ferret no tick has reached yet is
    // being watched from now: a restart judges nothing on silence it did not see.
    observedSince: liveness.observedSince(view.config.id) ?? new Date().toISOString(),
    ...(liveness.leftoverBrowserSince(view.config.id) === undefined
      ? {}
      : { leftoverBrowserSince: liveness.leftoverBrowserSince(view.config.id) }),
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
  /** The transcripts a migration reads and carries into the target login's home. */
  readonly conversationFiles: ConversationFilesPort;
  /** The validation run a converted conversation must pass before a cross-harness move switches. */
  readonly conversionCheck: ConversionCheckPort;
  /** The version each harness CLI reports, which the converter is gated on. */
  readonly harnessVersion: HarnessVersionPort;
  /** The rollout format an untested Codex version writes, which lets the converter accept it. */
  readonly rolloutFormat: RolloutFormatPort;
  /** The harness CLI itself — the binary a target runtime's wrapper runs — or nothing when absent. */
  readonly locateHarness: (kind: HarnessKind) => string | undefined;
  /** A fresh harness conversation id for a converted conversation. */
  readonly conversationId: () => string;
  /** The session's own private directory, which is what a Codex rollout is correlated by. */
  readonly sessionDirectory: (id: SessionId) => string;
  /** The folders the agent is pointed into to read what it was sent (`handoffFolders`). */
  readonly readableHandoffs: (id: SessionId) => readonly string[];
  /** Serializes whole migrations of one session, so two cannot restamp the same document. */
  readonly serial: KeyedSerialExecutor;
  /** The SAME rebuild a revive runs, asked whether it would change anything. */
  readonly launch: SessionLaunchService;
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
function currentContextWindow(
  config: z.infer<typeof SessionConfigSchema>,
  state: z.infer<typeof SessionStateSchema>,
  declaredWindow?: number,
) {
  return contextWindowForSession({
    configuredModel: config.model,
    modelHint: config.modelHint,
    observedModel: state.observedModel,
    reportedWindow: state.contextWindow,
    ...(declaredWindow === undefined ? {} : { declaredWindow }),
  });
}

/** What a migration's relaunch is bound to: a carried conversation, a fresh one, or a refusal. */
type RelaunchConversation =
  | {
      readonly kind: 'carry';
      readonly provenance: TranscriptProvenance;
      readonly copy?: { readonly from: string; readonly to: string };
      readonly launchArguments: readonly string[];
    }
  | {
      readonly kind: 'fresh';
      readonly provenance?: TranscriptProvenance;
      readonly copy?: undefined;
      readonly launchArguments: readonly string[];
    }
  | {
      readonly kind: 'convert';
      readonly provenance: TranscriptProvenance;
      readonly copy?: undefined;
      readonly launchArguments: readonly string[];
      /** The converted transcript, written into the target home before the record points at it. */
      readonly transcript: { readonly file: string; readonly text: string };
      /** Attachments the converted history references, saved first. */
      readonly files: readonly { readonly file: string; readonly data: string }[];
      readonly summary: ConvertedConversationSummary;
      /** The conversation it was converted from, which stays on disk. */
      readonly from: { readonly harness: Harness; readonly conversationId: string; readonly file: string };
      /** The target conversation's fresh id. */
      readonly conversationId: string;
    }
  | {
      readonly kind: 'unresumable';
      readonly reason: string;
      readonly provenance?: undefined;
      readonly copy?: undefined;
    };

/** The most of a source transcript a conversion reads. A larger one is refused rather than cut. */
const CONVERSION_SOURCE_MAX_BYTES = 512 * 1024 * 1024;
/** The most of a Codex `config.toml` read for its model provider. */
const CODEX_CONFIG_MAX_BYTES = 256 * 1024;

/** What a conversion needs to know about the move it is part of. */
interface ConversionSubject {
  readonly id: SessionId;
  readonly config: z.infer<typeof SessionConfigSchema>;
  readonly harness: HarnessKind;
  readonly executable: string;
  readonly targetAgent: string;
  readonly targetModel: string;
  readonly targetWindow: number;
}

/**
 * The conversation converted for a cross-harness move, from reads alone — the source transcript, the
 * hand-off documents its pointers name inside the session's own folder, the target home and its CLI's
 * version. Shared by the preview and the move, so what a person confirms is what is written.
 */
async function planConversion(
  parts: SessionMigrateParts,
  subject: ConversionSubject,
  nativeShell = true,
): Promise<ConversationConvert> {
  const { id, config, harness, executable } = subject;
  const source = config.transcript;
  const sourceText =
    source?.file === undefined
      ? undefined
      : await parts.conversationFiles.read(source.file, CONVERSION_SOURCE_MAX_BYTES);
  if (source?.file !== undefined && sourceText === undefined && (await parts.conversationFiles.written(source.file)))
    return {
      kind: 'unconvertible',
      reason: `The conversation file ${source.file} couldn't be read whole (the converter reads at most 512 MB), so it can't be converted. Nothing was changed.`,
    };
  const sessionDirectory = parts.sessionDirectory(id);
  const documents = new Map<string, string>();
  for (const path of handoffPointerPaths(sourceText ?? '')) {
    // Only this session's own hand-off documents: the transcript is the agent's, and the agent does
    // not get to choose what the daemon reads.
    if (!isReadableHandoff(path, { roots: [sessionDirectory], coordinatorHomes: [] })) continue;
    const document = await parts.conversationFiles.read(path, HANDOFF_READ_MAX_BYTES);
    if (document !== undefined) documents.set(path, document);
  }
  const targetHome = await parts.transcriptProvenance.home(harness, executable);
  const binary = parts.locateHarness(harness);
  const targetVersion = binary === undefined ? undefined : await parts.harnessVersion.version(binary);
  const targetFormat =
    binary !== undefined && needsRolloutFormatProbe(harness, targetVersion)
      ? await parts.rolloutFormat.classify(binary, targetVersion)
      : undefined;
  const targetModelProvider =
    harness === 'codex' && targetHome !== undefined
      ? codexModelProvider(await parts.conversationFiles.read(join(targetHome, 'config.toml'), CODEX_CONFIG_MAX_BYTES))
      : undefined;
  return planConversationConvert({
    sourceHarness: config.harness,
    targetHarness: harness,
    source,
    sourceText,
    documents: documents satisfies HandoffDocuments,
    targetHome,
    targetVersion,
    ...(targetFormat === undefined ? {} : { targetFormat }),
    ...(targetModelProvider === undefined ? {} : { targetModelProvider }),
    targetAgent: subject.targetAgent,
    targetModel: subject.targetModel,
    targetWindow: subject.targetWindow,
    // Resolved: the CLI derives where a conversation lives from its resolved working directory, so a
    // converted Claude file written under a symlinked spelling (macOS `/tmp`, `/var`) is never found.
    cwd: await realpath(config.cwd).catch(() => config.cwd),
    sessionDirectory,
    conversationId: parts.conversationId(),
    at: parts.clock.now(),
    ...(nativeShell ? {} : { nativeShell: false }),
  });
}

/**
 * A conversion, proven: planned, then resumed by the target CLI in a throwaway home before anything is
 * switched. Any doubt is `unresumable` with the reason, and the session is left exactly as it was.
 */
async function convertRelaunchConversation(
  parts: SessionMigrateParts,
  subject: ConversionSubject,
): Promise<RelaunchConversation> {
  const native = await planConversion(parts, subject);
  if (native.kind === 'unconvertible') return { kind: 'unresumable', reason: native.reason };
  const binary = parts.locateHarness(subject.harness);
  const source = subject.config.transcript;
  // A plan exists only for a located CLI and an identified source; this restates that for the types.
  if (binary === undefined || source?.file === undefined || source.harnessSessionId === undefined)
    return { kind: 'unresumable', reason: 'The conversion could not be checked. Nothing was changed.' };
  const check = async (plan: ConversationConvert & { readonly kind: 'convert' }) =>
    await parts.conversionCheck.check({
      harness: subject.harness,
      executable: binary,
      model: subject.targetModel,
      render: plan.render,
    });
  let planned = native;
  let verdict = await check(native);
  // A CLI that does not declare its shell tool for this model gets the shell commands as text instead,
  // checked again: a lossier history is better than no move, and the summary says which it was.
  if (!verdict.ok && verdict.missingTools !== undefined) {
    const textual = await planConversion(parts, subject, false);
    if (textual.kind === 'convert') {
      planned = textual;
      verdict = await check(textual);
    }
  }
  if (!verdict.ok) return { kind: 'unresumable', reason: `${verdict.reason} Nothing was changed.` };
  return {
    kind: 'convert',
    provenance: planned.provenance,
    launchArguments: transcriptLaunchArguments(subject.harness, planned.provenance, []),
    transcript: planned.transcript,
    files: planned.files,
    summary: planned.summary,
    from: { harness: subject.config.harness, conversationId: source.harnessSessionId, file: source.file },
    conversationId: planned.conversationId,
  };
}

/** A conversion's own account, in the protocol's words. */
function conversionSummaryView(summary: ConvertedConversationSummary): ConversionSummaryView {
  return {
    converter: summary.converter,
    sourceHarness: summary.source.harness,
    ...(summary.source.version === undefined ? {} : { sourceVersion: summary.source.version }),
    targetHarness: summary.target.harness,
    targetVersion: summary.target.version,
    turns: summary.turns,
    keptTurns: summary.keptTurns,
    omittedTurns: summary.omittedTurns,
    cutNewest: summary.cutNewest,
    messages: summary.messages,
    nativeToolCalls: summary.nativeToolCalls,
    toolCallsAsText: summary.toolCallsAsText,
    attachments: summary.attachments,
    dropped: summary.dropped,
    estimatedTokens: summary.estimatedTokens,
    budgetTokens: summary.budgetTokens,
    ...(summary.formatNote === undefined ? {} : { formatNote: summary.formatNote }),
  };
}

/**
 * The conversation a migration relaunches into, decided from reads alone.
 *
 * `fresh` is the person's explicit choice and captures the target's evidence as a start would.
 * `resume` carries the bound conversation ({@link planConversationCarry}); `previous` first rebinds
 * to the newest other transcript in the session's home that names its directory
 * ({@link previousConversation}) — the repair for a session an earlier Restart moved onto an empty one.
 */
async function decideRelaunchConversation(
  parts: SessionMigrateParts,
  subject: {
    readonly id: SessionId;
    readonly config: z.infer<typeof SessionConfigSchema>;
    readonly harness: HarnessKind;
    readonly executable: string;
    readonly targetAgent: string;
    readonly targetModel: string;
    readonly targetWindow: number;
    readonly conversation: MigrationConversation;
  },
): Promise<RelaunchConversation> {
  const { id, config, harness, executable } = subject;
  if (subject.conversation === 'convert') return await convertRelaunchConversation(parts, subject);
  const at = parts.clock.now();
  if (subject.conversation === 'fresh') {
    const captured = await parts.transcriptProvenance.capture({
      harness,
      executable,
      cwd: config.cwd,
      correlationToken: parts.sessionDirectory(id),
      at,
    });
    return {
      kind: 'fresh',
      ...(captured.provenance === undefined ? {} : { provenance: captured.provenance }),
      launchArguments: captured.launchArguments,
    };
  }
  let source = config.transcript;
  if (subject.conversation === 'previous' && source !== undefined) {
    const rebound = previousConversation({
      harness,
      current: source,
      home: source.home,
      candidates: await parts.conversationFiles.prior(harness, source.home, config.cwd, parts.sessionDirectory(id)),
      at,
    });
    if (rebound.kind === 'unresumable') return rebound;
    source = rebound.provenance;
  }
  const planned = planConversationCarry({
    harness,
    source,
    sourceWritten: source?.file !== undefined && (await parts.conversationFiles.written(source.file)),
    targetHome: await parts.transcriptProvenance.home(harness, executable),
    targetAgent: subject.targetAgent,
    cwd: config.cwd,
  });
  if (planned.kind === 'unresumable') return planned;
  return { ...planned, launchArguments: transcriptLaunchArguments(harness, planned.provenance, []) };
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

  /** The account a move names, resolved with the start's own rule, its refusals in the move's words. */
  const resolveTarget = async (agent: string) =>
    await resolveStartAccount(parts.accounts, agent, parts.executables, CLIENT_NAME).catch((error: unknown) => {
      if (!(error instanceof SessionControlError)) throw error;
      const failure = MIGRATE_RESOLUTION_REFUSALS[error.failure];
      if (failure === undefined) throw error;
      throw new SessionMigrateError(failure, error.message);
    });

  /**
   * The model a move plans on the target — the same planner the start uses, so the model a migration
   * records and the window it is measured against come from the one decision rather than two that can
   * disagree. Shared by the move and the conversion preview, so the window a person was shown is the
   * window the move fits.
   */
  const planModel = (
    id: SessionId,
    config: z.infer<typeof SessionConfigSchema>,
    state: z.infer<typeof SessionStateSchema>,
    account: Awaited<ReturnType<typeof resolveTarget>>['account'],
    requestedModel: string | undefined,
  ) => {
    const shape = {
      id,
      account,
      mode: config.mode,
      ...(config.teammate === undefined ? {} : { teammate: config.teammate }),
      ...(config.name === undefined ? {} : { name: config.name }),
      ...(config.parent === undefined ? {} : { parent: config.parent }),
    };
    // A RESTART KEEPS THE MODEL THE SESSION IS ON. A request that names no model used to plan the
    // target's default, so Restart CLI — a migration onto the same account — quietly moved a session
    // the owner had switched to another model back onto the default. The model it is on now is asked
    // for instead; only when the target cannot serve it does the target's default decide, as before.
    const current = currentLaunchModel(config, state, model => canServeModel(account, model));
    const keep =
      requestedModel === undefined && current !== undefined
        ? parts.planner.plan({ ...shape, requestedModel: current })
        : undefined;
    const planned =
      keep?.kind === 'planned'
        ? keep
        : parts.planner.plan({ ...shape, ...(requestedModel === undefined ? {} : { requestedModel }) });
    return { keep, planned };
  };

  const migrate = async (
    id: SessionId,
    request: Parameters<SessionMigrateSubsystem['migrate']>[1],
  ): Promise<SessionView> => {
    const { config, state, tmuxSession } = await subject(id);
    const { account, executable } = await resolveTarget(request.agent);
    // SAME-KIND, ENFORCED HERE — the first thing decided once both families are known, and before any
    // other work at all. Everything below it either reads the host or writes the session: the planner,
    // the transcript capture that inspects the target's harness home, the report, the restamp and the
    // kill. Refusing at this point is what makes the refusal cost nothing and leave nothing behind, so
    // the caller may present the same request id again against an account of the right family.
    // A CONVERSION IS THE ONE WAY ACROSS: `conversation: 'convert'` rewrites the conversation in the
    // target's format, so it is refused the other way round — onto the session's own family.
    const converting = request.conversation === 'convert';
    const families = { sourceHarness: config.harness, targetHarness: account.kind, targetAgent: account.agent };
    const mismatch = converting ? harnessConversionRefusal(families) : harnessMigrationRefusal(families);
    if (mismatch !== undefined) throw new SessionMigrateError('harness_mismatch', mismatch);
    const { keep, planned } = planModel(id, config, state, account, request.model);
    // And the effort it is on, which no request names — unless the move crosses harnesses, whose effort
    // vocabularies differ: the target then starts on its own login's setting.
    const effort = converting ? undefined : currentLaunchEffort(config, state);
    // A MIGRATION ONTO A MODEL THE TARGET DOES NOT SERVE IS REFUSED, for the same reason the start
    // refuses it and with more at stake: a migration that quietly landed on the account's default
    // would move a live conversation into a different model and a different context window while the
    // report handed back named the one that was asked for. Refused at the same point the family
    // mismatch is, so the refusal costs nothing and leaves the session exactly where it was.
    if (planned.kind === 'unservable-model') throw new SessionMigrateError('unservable_model', planned.reason);
    const plan = planned.plan;
    // Rebuilt rather than patched: the remote-control arguments are the TARGET harness's, and a
    // codex session inheriting a claude session's flags would relaunch into an argument error.
    //
    // AUTHORIZED with the start's own rule, because a migration does not go through the lifecycle
    // service that applies it. The relaunch reads this argv straight out of the document written
    // below, so without this check a fleet manifest publishing something that is not an auto wrapper
    // would be launchable by a migrate and refused by a start.
    //
    // THE CONVERSATION GOES WITH THE SESSION. A Restart, or a move onto another login of the same
    // harness, relaunches the CLI into the conversation it is bound to — the transcript carried into
    // the target's home and resumed by its own id — rather than into a fresh one: re-capturing here
    // used to mint a new Claude id, so every Restart opened an empty conversation. Decided now, from
    // reads only; a conversation that cannot be carried is refused below, once the in-flight gate has
    // had its say, and before anything is written.
    const relaunchConversation = await decideRelaunchConversation(parts, {
      id,
      config,
      harness: account.kind,
      executable,
      targetAgent: account.agent,
      targetModel: plan.model,
      targetWindow: plan.contextWindow,
      conversation: request.conversation ?? 'resume',
    });
    const command = ((): readonly string[] => {
      try {
        return authorizeSessionCommand(
          executable,
          buildLaunchArgv({
            harness: account.kind,
            executable,
            remoteControl: config.remoteControl ? plan.extraArgs : [],
            transcript: relaunchConversation.kind === 'unresumable' ? [] : relaunchConversation.launchArguments,
            readableFolders: parts.readableHandoffs(id),
            model: plan.model,
            ...(effort === undefined ? {} : { effort }),
            // The owner's extra flags are the source CLI's; the other harness would refuse them.
            harnessFlags: converting ? [] : config.harnessFlags,
          }),
          defaultSessionLifecycleSettings,
        );
      } catch (error) {
        throw new SessionMigrateError('unavailable', error instanceof Error ? error.message : String(error));
      }
    })();
    // The window the session runs in, read the way the plan reads the target's: the harness's own report, the
    // selector in its configured model, then what its account's catalog declares for it.
    const sourceAccount = findAccountByAgent(await parts.accounts.accounts(), config.agent);
    const window = currentContextWindow(
      config,
      state,
      sourceAccount === undefined ? undefined : declaredModel(sourceAccount, config.model ?? '')?.context,
    );
    // A RESTART IS NEVER A DOWNGRADE. The same model on the same account relaunches into the window it already
    // has; a plan that disagrees is a catalog or selector gap, and refusing would make Restart impossible.
    const relaunchesSameModel =
      request.model === undefined && keep?.kind === 'planned' && account.agent === config.agent;
    // A CONVERSION FITS THE TARGET BY CONSTRUCTION: it keeps the newest history the target's window can
    // hold, tells the target how much it left out, and the preview the person confirmed said so.
    if (plan.contextWindow < window && !request.allowContextDowngrade && !relaunchesSameModel && !converting)
      throw new SessionMigrateError(
        'context_downgrade',
        `${account.agent} serves ${plan.model} with a ${plan.contextWindow}-token window and this session is ` +
          `running in ${window}, so part of this conversation would be cut off. ` +
          'Re-run with --allow-context-downgrade to accept that.',
        { downgrade: { model: plan.model, targetWindow: plan.contextWindow, currentWindow: window } },
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
    const decision = parts.preflight.gate(report, { force: request.forceInflight });
    if (!decision.proceed)
      throw new SessionMigrateError('refused', `${decision.reason}\n${parts.preflight.summarize(report)}`, {
        inflight: parts.preflight.describe(report),
      });
    // NEVER A SILENT NEW CONVERSATION. Still before the first write, so a refusal leaves the session
    // exactly as it was and the person can choose to start fresh.
    if (relaunchConversation.kind === 'unresumable')
      throw new SessionMigrateError('unresumable', relaunchConversation.reason);
    const at = parts.clock.now();
    if (decision.forced)
      await parts.storage.append(id, 'session.migrate_forced', {
        to: account.agent,
        verdict: report.worstVerdict,
        went_past: parts.preflight
          .describe(report)
          .items.filter(item => item.blocks)
          .map(item => ({ title: item.title, ...(item.detail === undefined ? {} : { detail: item.detail }) })),
      });
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
    // The level the session is on carries over; with none known, the target's own settings decide.
    const launchEffort =
      effort ?? (await readPersistedReasoningEffort(account.kind, relaunchConversation.provenance?.home));
    // A converted conversation, written before the record that points at it: its attachments first,
    // then the transcript the target CLI already accepted in the validation run.
    if (relaunchConversation.kind === 'convert') {
      const converted = relaunchConversation;
      try {
        for (const attachment of converted.files)
          await parts.conversationFiles.write(attachment.file, Buffer.from(attachment.data, 'base64'));
        await parts.conversationFiles.write(converted.transcript.file, converted.transcript.text);
      } catch (error) {
        throw new SessionMigrateError(
          'failed',
          `the converted conversation could not be written into ${account.agent}'s home (${converted.transcript.file}): ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }
    // The target login's copy of the conversation, written before the record that points at it.
    const carried = relaunchConversation.copy;
    if (carried !== undefined)
      await parts.conversationFiles.copy(carried.from, carried.to).catch((error: unknown) => {
        throw new SessionMigrateError(
          'failed',
          `the conversation could not be copied into ${account.agent}'s home (${carried.to}): ` +
            (error instanceof Error ? error.message : String(error)),
        );
      });
    await parts.storage.updateConfig(id, current => {
      // The previous account's transcript record is REMOVED rather than merged over: a target that
      // declares no resolvable home must leave the session with no transcript, and a merge would
      // silently keep the old harness's file under the new harness's name.
      // Fast mode is dropped with the effort's launch record: the target is another login, often
      // another harness, and a model there may have none. It starts on that login's own setting.
      // The conversion lineage goes with the conversation it describes: a new conversion replaces it,
      // a resume of the same conversation keeps it, and a fresh or an earlier conversation drops it.
      const {
        transcript: _replaced,
        launchReasoningEffort: _previousEffort,
        launchFast: _previousFast,
        conversion: previousLineage,
        ...retained
      } = jsonObject(current) ?? {};
      const lineage =
        relaunchConversation.kind === 'convert'
          ? {
              v: 1,
              converter: relaunchConversation.summary.converter,
              fromHarness: relaunchConversation.from.harness,
              fromConversation: relaunchConversation.from.conversationId,
              fromFile: relaunchConversation.from.file,
              toHarness: account.kind,
              toConversation: relaunchConversation.conversationId,
              at,
              keptTurns: relaunchConversation.summary.keptTurns,
              omittedTurns: relaunchConversation.summary.omittedTurns,
            }
          : (request.conversation ?? 'resume') === 'resume'
            ? previousLineage
            : undefined;
      return {
        ...retained,
        ...(lineage === undefined ? {} : { conversion: lineage }),
        ...(converting ? { harnessFlags: [] } : {}),
        ...(launchEffort === undefined ? {} : { launchReasoningEffort: launchEffort }),
        agent: account.agent,
        harness: account.kind,
        model: plan.model,
        modelHint: request.model ?? account.defaultModel ?? '',
        command: [...command],
        incarnation: `${id}-${generation}`,
        runtimeGeneration: generation,
        migration: { from, to: account.agent, at },
        ...(relaunchConversation.provenance === undefined ? {} : { transcript: relaunchConversation.provenance }),
        updatedAt: at,
      };
    });
    await parts.storage.append(id, 'session.migrating', {
      from,
      to: account.agent,
      model: plan.model,
      conversation:
        relaunchConversation.kind === 'fresh'
          ? 'fresh'
          : relaunchConversation.kind === 'convert'
            ? 'converted'
            : 'resumed',
      ...(relaunchConversation.kind === 'convert'
        ? {
            convertedFrom: {
              harness: relaunchConversation.from.harness,
              conversation: relaunchConversation.from.conversationId,
              file: relaunchConversation.from.file,
            },
            conversion: conversionSummaryView(relaunchConversation.summary),
          }
        : {}),
      ...(relaunchConversation.provenance?.harnessSessionId === undefined
        ? {}
        : { harnessSessionId: relaunchConversation.provenance.harnessSessionId }),
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
        message: parts.preflight.handoff(report, reportPath, config.mode),
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

  /**
   * What converting onto an account would carry — the same plan the move makes, minus the validation
   * run and every write. A refusal is an answer here, not an error: it is what the sheet shows in place
   * of the confirm button.
   */
  const conversionPreview = async (
    id: SessionId,
    request: { readonly agent: string; readonly model?: string },
  ): Promise<ConversionPreview> => {
    const { config, state } = await subject(id);
    const { account, executable } = await resolveTarget(request.agent);
    const refused = (reason: string): ConversionPreview => ({ kind: 'refused', targetAgent: account.agent, reason });
    const mismatch = harnessConversionRefusal({
      sourceHarness: config.harness,
      targetHarness: account.kind,
      targetAgent: account.agent,
    });
    if (mismatch !== undefined) return refused(mismatch);
    const { planned } = planModel(id, config, state, account, request.model);
    if (planned.kind === 'unservable-model') return refused(planned.reason);
    const conversion = await planConversion(parts, {
      id,
      config,
      harness: account.kind,
      executable,
      targetAgent: account.agent,
      targetModel: planned.plan.model,
      targetWindow: planned.plan.contextWindow,
    });
    if (conversion.kind === 'unconvertible') return refused(conversion.reason);
    return {
      kind: 'ready',
      targetAgent: account.agent,
      targetModel: planned.plan.model,
      summary: conversionSummaryView(conversion.summary),
    };
  };

  /** The id a caller named, parsed, of a session that exists — or the refusal saying which it is not. */
  const existing = (reference: string): SessionId => {
    const id = tryParseSessionId(reference);
    if (id === undefined)
      throw new SessionMigrateError('invalid', `${JSON.stringify(reference)} is not a usable session id`);
    if (parts.storage.findSession(id) === undefined)
      throw new SessionMigrateError('not_found', `no session ${reference}`);
    return id;
  };

  return {
    conversionPreview: async (reference, request) => await conversionPreview(existing(reference), request),
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
    relaunchSettings: async reference => {
      const id = tryParseSessionId(reference);
      if (id === undefined)
        throw new SessionMigrateError('invalid', `${JSON.stringify(reference)} is not a usable session id`);
      if (parts.storage.findSession(id) === undefined)
        throw new SessionMigrateError('not_found', `no session ${reference}`);
      return await parts.launch.drift(id);
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
        await wiring.migrate.migrate(sessionId, { agent, allowContextDowngrade: false, forceInflight: false });
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
          const { account } = await resolveStartAccount(wiring.accounts, agent, wiring.executables, CLIENT_NAME);
          // The SAME planner the start and the migration use, so the model a handover records and the
          // window it is measured against come from one decision rather than two that can disagree.
          const planned = wiring.planner.plan({
            id: 'handover-probe',
            account,
            mode: 'interactive',
            ...(model === null ? {} : { requestedModel: model }),
          });
          // A handover that named a model the replacement cannot serve is refused at RESOLUTION, which
          // is before a receipt exists: seating a replacement on the account's default instead would
          // retire the predecessor in favour of a session the requester never asked for.
          if (planned.kind === 'unservable-model') throw new HandoverError('step_failed', planned.reason);
          return {
            accountId: account.id,
            agent: account.agent,
            harness: account.kind,
            model: planned.plan.model,
            effort: null,
            contextWindow: planned.plan.contextWindow,
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
      attention: { raise: async () => seamAbsent('raise its agenda item') },
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

/** The statuses after which a session's transcript no longer changes and no watcher needs to read it. */
const ENDED_SESSION_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'stalled', 'stopped']);

/**
 * How many transcripts one ingestion pass may read; the rest wait for the catch-up pass, a minute later.
 *
 * A rebuild used to read every finished transcript in one pass, every boot — on a large Mac fleet,
 * hundreds of megabytes parsed while the daemon was trying to answer its first requests.
 */
const ANALYTICS_READS_PER_PASS = 8;

/**
 * What a profile cannot attribute to an event: the slow backstops the event-driven housekeeping keeps,
 * named so a pass that shows up with no event behind it is explained rather than suspected.
 */
function housekeepingBackstopLimitation(): string {
  const minutes = (ms: number): string => `${String(ms / 60_000)} min`;
  return (
    'Housekeeping runs on events, with slow backstops that are timers: analytics ingest every ' +
    `${minutes(ANALYTICS_BACKSTOP_MS)}, the terminal reaper every ${minutes(TERMINAL_REAP_BACKSTOP_MS)}, ` +
    `a full handover rescan every ${minutes(HANDOVER_RESCAN_INTERVAL_MS)}, the update check every ` +
    `${minutes(UPDATE_BACKSTOP_INTERVAL_MS)}, and an undiscovered Codex session's rollout walk every ` +
    `${minutes(CODEX_DISCOVERY_BACKSTOP_MS)} while its home's newest directories are watched and quiet.`
  );
}

/**
 * One-shot timers for a {@link PassTrigger}, fired OUTSIDE every activity: the timer is armed by the pass
 * before, and would otherwise count the next pass inside it. Unreferenced, so a pending pass never holds
 * the process open.
 */
function outsideActivityTimers(activities: ActivityLedger | undefined): PassTriggerTimers {
  return {
    setTimeout: (callback, ms) => {
      const handle = setTimeout(() => (activities === undefined ? callback() : activities.outside(callback)), ms);
      handle.unref?.();
      return handle;
    },
    clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

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
      //
      // FROM THE INDEX FIRST. Its status is written with every state document, and a session it says is
      // still running is one the gate refuses anyway — so only an ended session, or one whose status the
      // index does not know, has its two documents read and parsed.
      const ids = storage
        .listSessions()
        .filter(
          session =>
            session.status === undefined || (TERMINAL_ANALYTICS_STATUSES as ReadonlySet<string>).has(session.status),
        )
        .map(session => session.id);
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
 * THE PRICING CATALOG is this daemon's validated operator rates laid over the list prices the model
 * catalogs in effect carry (docs/model-catalog.md § Prices), read per pass, so an operator's edit or a
 * newer published catalog takes effect on the next ingestion — and, because the catalog's fingerprint
 * is part of every row's ingest signature, re-prices the rows it changes. An operator rate wins for its
 * whole model. A model neither prices stays `unpriced` with a reason — the honest answer; a zero would
 * read as free.
 */
function createAnalyticsIngestion(
  storage: DaemonStorage,
  opened: OpenedAnalyticsIndexStore,
  pricingConfiguration: AnalyticsPricingConfigurationPort,
  modelCatalogs: () => Promise<Readonly<Record<string, ModelCatalog>>>,
  evidence: AnalyticsTranscriptEvidenceSource,
  folds: AnalyticsTranscriptFoldSource,
  clock: ClockPort,
  activities: ActivityLedger | undefined,
): AnalyticsIngestionService {
  return new AnalyticsIngestionService({
    candidates: createAnalyticsCandidateSource(storage),
    evidence,
    folds,
    store: opened.store,
    pricing: async () => {
      const read = await pricingConfiguration.readPricing();
      if (read.kind === 'unavailable') throw new Error(`analytics ingestion refused because ${read.message}`);
      return effectiveAnalyticsPricing(read.configuration.catalog, await modelCatalogs());
    },
    clock,
    concurrency: ANALYTICS_FOLD_CONCURRENCY,
    readsPerPass: ANALYTICS_READS_PER_PASS,
    rebuildRequired: opened.rebuildRequired,
    trigger: new PassTrigger({
      backstopMs: ANALYTICS_BACKSTOP_MS,
      timers: outsideActivityTimers(activities),
      now: () => performance.now(),
    }),
  });
}

/** The analytics read, over the rows ingestion materialised, stamped with this machine's name. */
function createAnalyticsSubsystem(
  ingestion: AnalyticsIngestionService,
  machine: () => string | null,
): AnalyticsSubsystem {
  return { index: () => ingestion.read(), machine };
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
/**
 * The agent tools: terminals and browser pages driven by name, over the SAME terminal and browser
 * subsystems the person's routes serve, so a shell an agent opens is the shell a person sees.
 *
 * The agent is identified by its session credential — hashed and matched against the live sessions'
 * stored hashes through the same directory the task boards authenticate with. Control changes are
 * published to the session's own journal, which `/v1/events` streams to every viewer.
 *
 * "What agents may control" is the machine settings' own port, read per call. Takeovers and hand-overs
 * are replayed from the same journal, so they outlive a restart.
 */
function createAgentToolsSubsystem(input: {
  readonly storage: DaemonStorage;
  readonly terminals: TerminalSubsystem;
  readonly browser: MountedSubsystems['browser'];
  readonly audit: AuditLog;
  readonly policy: AgentControlPolicy;
  /** The vault redactor every operator read is scrubbed by; a page's text goes through it too. */
  readonly redactor: Pick<SecretRedactor, 'batch'>;
}): MountedSubsystems['agentTools'] {
  const clock = { now: () => Date.now() };
  const control = new SurfaceControl(
    {
      publish: async (sessionId, type, data) => {
        const id = tryParseSessionId(sessionId);
        if (id !== undefined) await input.storage.append(id, type, data);
      },
      history: async sessionId => {
        const id = tryParseSessionId(sessionId);
        const events: { readonly type: string; readonly data: unknown }[] = [];
        if (id === undefined || input.storage.findSession(id) === undefined) return events;
        for (let after = 0; ; ) {
          const page = await input.storage.replay(id, after, 10_000);
          for (const event of page.events) if (event.type.startsWith('surface.')) events.push(event);
          if (!page.hasMore || page.nextSequence === undefined) return events;
          after = page.nextSequence;
        }
      },
    },
    clock,
  );
  return {
    service: new AgentToolService({
      terminals: input.terminals,
      browser: input.browser,
      control,
      policy: input.policy,
      audit: input.audit,
      redactor: input.redactor,
      clock,
      sleep: async milliseconds => await Bun.sleep(milliseconds),
    }),
    identities: agentIdentities(input.storage),
  };
}

/** Who an agent is, from the session credential it presents — the one resolver every agent route uses. */
function agentIdentities(storage: DaemonStorage): CredentialAgentIdentities {
  return new CredentialAgentIdentities(
    new StorageCredentialedSessions({
      sessionIds: () => storage.listSessions().map(session => session.id),
      readConfig: async id => await storage.readConfig(id as SessionId),
      readState: async id => await storage.readState(id as SessionId),
    }),
    capability => createHash('sha256').update(capability, 'utf8').digest('hex'),
    secretsMatch,
  );
}

/**
 * The configuration files' routes, and the watcher they arm (docs/config-files.md).
 *
 * ARMED ONCE SERVING, like every other loop: the first load runs then — so the accepted record, the
 * schemas an editor reads and the first report of a broken file all happen against an opened state
 * home — and the watcher keeps loading after that whenever a file changes.
 */
function createConfigFilesSubsystem(input: {
  /** The named work in flight, so a reload is attributed in a profile. */
  readonly activities?: ActivityLedger;
  readonly service: ConfigFilesService;
  readonly agentControl: AgentControlPolicy;
  readonly identities: CredentialAgentIdentities;
  readonly notices: BootNoticePort;
  /**
   * Run after the first load and after every change: the fleet is republished when a model catalog
   * moved what its runtimes offer (docs/model-catalog.md). It must never throw.
   */
  readonly afterLoad?: () => Promise<void>;
  /** The tree's directories and file events: the watcher then reads on an event, not every second. */
  readonly events?: ConfigTreeEvents;
}): MountedSubsystems['configFiles'] {
  return {
    service: input.service,
    agentControl: input.agentControl,
    identities: input.identities,
    arm: async () => {
      await input.service.load();
      await input.service.publishSchemas(configJsonSchemaFiles());
      await input.afterLoad?.();
      return watchConfigFiles({
        fingerprint: async () => await input.service.fingerprint(),
        // At once, not after the debounce: readers stop answering from a load the tree has moved past.
        onEvent: () => input.service.invalidate(),
        onChange: async () => {
          await input.service.load();
          await input.afterLoad?.();
        },
        onError: error =>
          input.notices.state(`config watcher: ${error instanceof Error ? error.message : String(error)}`),
        ...(input.events === undefined ? {} : { events: input.events }),
        timers: {
          setInterval: (callback, ms) => setInterval(asActivity(input.activities, 'config watcher', callback), ms),
          clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
          setTimeout: (callback, ms) => setTimeout(asActivity(input.activities, 'config watcher', callback), ms),
          clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
        },
      });
    },
  };
}

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
      isDirectory: async path => {
        try {
          return statSync(path).isDirectory();
        } catch {
          return false;
        }
      },
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
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.folder === undefined ? {} : { folder: input.folder }),
          ...(openedBy === undefined ? {} : { openedBy }),
        })
        .catch(translate),
    get: async (sessionId, terminalId) => await service.get(sessionId, terminalId).catch(translate),
    rename: async (sessionId, terminalId, title) => await service.rename(sessionId, terminalId, title).catch(translate),
    close: async (sessionId, terminalId) => await service.close(sessionId, terminalId).catch(translate),
    write: async (sessionId, terminalId, bytes) => await service.write(sessionId, terminalId, bytes).catch(translate),
    text: async (sessionId, terminalId, lines) => await service.text(sessionId, terminalId, lines).catch(translate),
    foreground: async (sessionId, terminalId) => await service.foreground(sessionId, terminalId).catch(translate),
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
 * The names the fleet is holding, derived from each session's own configuration document.
 *
 * This is the DURABLE half of "what is taken": a session's `teammate` is what a bare callsign
 * resolves through, so a name a session holds is not free however the reservation ledger looks. How
 * long a session holds its name — for as long as it is live, and for the resolution window after it
 * ends — is `sessionNameClaim`'s decision. Shared by the suggestion route and the allocator's claim
 * store so the two cannot disagree about who owns a name.
 */
async function liveCallsigns(storage: DaemonStorage): Promise<readonly NameClaim[]> {
  const sessions = await Promise.all(
    storage.listSessions().map(async (session): Promise<NameClaim | undefined> => {
      const config = SessionConfigSchema.safeParse(await storage.readConfig(session.id));
      if (!config.success) return undefined;
      return sessionNameClaim({
        id: session.id,
        ...(config.data.teammate === undefined ? {} : { teammate: config.data.teammate }),
        createdAt: config.data.createdAt,
        updatedAt: config.data.updatedAt,
        ...(session.status === undefined ? {} : { status: session.status }),
      });
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
 * The learning review board, over the state home's own `learning/` directory.
 *
 * ONE executor for the whole process, keyed on the board: a verdict is a read-decide-rewrite of a
 * single JSON snapshot, so two landing together would otherwise lose one. The key is a constant
 * because there is exactly one board per state home — unlike the task boards, which are per session.
 */
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

/** Where this daemon's browser worker is: beside the daemon in every release channel (under its
 * installed name or its compile-output name), the TypeScript worker in a source checkout, or —
 * for a compiled daemon with neither — a plain refusal naming the fix. The executable is looked for
 * beside the daemon both as invoked and as resolved, because a Homebrew or Nix install reaches it
 * through a symlink whose directory holds no worker. */
function browserWorkerProgram(): BrowserWorkerProgram {
  const invoked = dirname(process.execPath);
  let resolved = invoked;
  try {
    resolved = dirname(realpathSync(process.execPath));
  } catch {
    // An executable that cannot be resolved is still searched where it was invoked.
  }
  return selectBrowserWorker({
    sourceOverride: process.env.FY_BROWSER_WORKER_SOURCE,
    binaryOverride: process.env.FY_BROWSER_WORKER_BIN,
    executableDirectories: [invoked, resolved],
    platform: process.platform,
    arch: process.arch,
    sourceEntry: join(import.meta.dir, 'browser-worker.ts'),
    exists: existsSync,
  });
}

/** What the learning subsystem is built from, beyond the state home's own learning directory. */
interface LearningSubsystemParts {
  readonly paths: FoundationPaths;
  readonly files: StateFileSystem;
  readonly clock: SystemClock;
  readonly serial: LearningSerialExecutor;
  readonly sessions: SessionDirectorySubsystem;
  readonly transcripts: SessionTranscriptReader;
  readonly sessionControl: SessionControlSubsystem;
  readonly config: () => LearningConfig;
  readonly configFiles: ConfigFilesService;
  readonly identities: CredentialAgentIdentities;
  /** A ferret's launch environment, merged under that session's own lock. */
  readonly mergeEnvironment: (sessionId: string, variables: Readonly<Record<string, string>>) => Promise<void>;
  /** A queued, non-interrupting send. */
  readonly send: (sessionId: string, message: string, sendId: string) => Promise<void>;
  readonly pricing: () => Promise<readonly AnalyticsPricingRate[]>;
  readonly userHome: string;
}

/**
 * The learning review board, passive lessons, Apply and the explicit scan.
 *
 * Apply writes outside the state home — the fleet's global lessons document under the asset tree, or a
 * project's AGENTS.md / CLAUDE.md — through `NodeLessonFiles`, and only after the route authorized it.
 */
function createLearningSubsystem(parts: LearningSubsystemParts): LearningSubsystem {
  const { paths, files, clock, config } = parts;
  const store = new FileLearningStore(paths, files, clock);
  const now = () => clock.now();
  const miner = new LearningMiner(
    paths,
    files,
    store,
    parts.sessions,
    parts.transcripts,
    parts.sessionControl,
    config,
    now,
  );
  const settings = new ConfigFileLearningSettings(parts.configFiles);
  const lessons = new LessonsService({
    store,
    sessions: new DirectoryLessonSessions(parts.sessions, parts.transcripts),
    files: new NodeLessonFiles(),
    global: new FleetGlobalLessons({
      assetsDirectory: join(paths.fleet, 'assets'),
      userHome: parts.userHome,
      model: () => parts.configFiles.current().evaluation.effective.model,
      writeComponent: async file => await settings.writeLessonsComponent(file),
    }),
    passive: new SessionPassiveChannel({
      variable: PASSIVE_LEARNING_ENV,
      mergeEnvironment: parts.mergeEnvironment,
      send: parts.send,
    }),
    miner,
    prices: new CatalogPrices(parts.pricing, now),
    config,
    now,
    binaryName: CLIENT_NAME,
    minerLabel: LEARNING_MINER_LABEL,
  });
  return {
    store,
    transaction: async work => await parts.serial.run('learning', work),
    config,
    now,
    run: async spawn => await miner.run(spawn),
    lessons,
    identities: parts.identities,
    writeConfig: async patch => await settings.writePassiveDefault(patch.passiveDefault),
  };
}

/**
 * The daemon's own health, over the self-check `start` ticks.
 *
 * The process id is read HERE rather than in the route, because `src/lib` may not touch `process`:
 * a domain that read its own pid could not be driven from a test, and the whole point of the field
 * is that an operator can signal the process that is actually serving.
 */
function createHealthSubsystem(
  health: SessionHealthService,
  scratch: ScratchReclamation,
  sessionWorkers: () => SessionWorkerPool,
  ioPressure: IoPressurePort,
): DaemonHealthSubsystem {
  return {
    report: async () => await health.report(),
    pid: process.pid,
    scratch,
    sessionWorkers,
    io: () => {
      const pressure = ioPressure.current();
      return pressure === undefined ? undefined : ioPressureView(pressure);
    },
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
  if (choosesPortAtBind(loaded)) {
    // Nothing to probe and nothing to walk: the bind itself asks the kernel, so no number is ever held
    // between "found free" and "bound". The address is only known — and only recorded — once it is.
    world.notices.step('address chosen', 'the operating system will assign the port when the daemon binds');
    return { config: loaded };
  }
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
   * Where one session's attachment originals live: `attachmentDirectory`'s
   * `<state>/attachments/<daemonId>/<sessionId>`, the same resolver the store's originals adapter reads.
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
  readonly redactor: Pick<SecretRedactor, 'batch'>;
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
    readableHandoffs: id =>
      handoffFolders(createSessionPaths(parts.paths, id).directory, parts.attachmentOriginals(id)),
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

/**
 * The one fact about this machine every caller must NAME.
 *
 * Bun's `homedir()` reads `HOME` only as the process was STARTED with it — a later assignment to
 * `process.env.HOME` is invisible to it — and the user database when it was absent. So a test that
 * drives this composition root in-process reaches the developer's real `~/.claude` and `~/.codex`
 * whatever it does to the environment first, and a first run COPIES a credential out of what it finds
 * there. A real process resolves its home once through `resolveUserHome`, and that one value serves
 * the state home, the harness homes, the history importer and the skills catalog alike.
 *
 * IT IS REQUIRED, and that is the guard. It used to be optional with `homedir()` behind it, and five
 * integration suites built a world without it, so every one of their boots searched the developer's
 * own `~/.claude` and `~/.codex` for a login to copy. A required field turns the next such call into
 * a type error in the gate rather than a line in a log nobody reads, and the check below refuses a
 * cast. The daemon's own entry point passes `resolveUserHome()`; a test passes a temporary directory.
 */
export interface WorldSeams {
  /** This machine's user home, absolute. Both harness home directories are derived from it. */
  readonly userHome: string;
}

/** Builds the production adapter set. Subsystem units extend this as they land. */
/**
 * The stack sampler's interval this process was started with, read as the module loads: `main` drops every
 * `BUN_JSC_*` variable before spawning anything, and the profile must still know the interval it ran at.
 */
const STARTED_SAMPLE_INTERVAL = process.env.BUN_JSC_sampleInterval;

export function buildWorld(overrides: RunOverrides, seams: WorldSeams): DaemonWorld {
  const userHome = seams.userHome;
  if (typeof userHome !== 'string' || !isAbsolute(userHome))
    throw new Error(`buildWorld needs an absolute user home, and was given ${String(userHome)}`);
  // Pairing opens before any subsystem. Keep its validated daemon identity in
  // this composition root so the attachment store can key state by daemon
  // without widening the public pairing route interface.
  let attachmentDaemonId: string | undefined;
  // The name pairing gave this machine, stamped on analytics rows as the `machine` label.
  let analyticsMachineName: string | undefined;
  const clock = new SystemClock();
  const millisecondClock = { now: () => Date.now() };
  /**
   * The boot's named work and its progress. The progress is created when a boot STARTS, not here,
   * so its elapsed time is the boot's; health reads whichever boot this world last began, and a world
   * no boot has begun is a world whose bootstrap has not finished.
   */
  /**
   * The performance probe every instrument reports into — activities, routes, child processes, the
   * state home's file port, the lag meter and the stack sampler. It records nothing until a profile
   * opens a window (`fy daemon profile`), so it stays wired in permanently.
   */
  const profilerProbe = new PerformanceRecorder();
  const ioPressure = new ProcIoPressure();
  const activities = new ActivityLedger(millisecondClock, new AsyncActivityScope(), (label, wallMs) =>
    profilerProbe.activity(label, wallMs),
  );
  let bootProgress: BootProgress | undefined;
  const environment = new RuntimeEnvironment(process.env, () => userHome);
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
  /**
   * EVERY tmux command this daemon sends, over one transport: reads answered in-band by a single
   * long-lived control-mode client, everything else (and every read the client cannot take) a process
   * of its own, as before. One instance for the whole daemon, because the point is one client — a
   * second transport over the same socket would be a second client and a second set of processes.
   */
  const tmuxExecutable = Bun.which('tmux') ?? FALLBACK_TMUX;
  const tmuxSocket = join(paths.home, 'tmux.sock');
  const tmux = new ControlModeTmuxProcess(tmuxExecutable, tmuxSocket);
  const launchGuard = testHarnessLaunchGuard(paths.home);
  const stateFiles = countedFileOperations(
    new StateFileSystem(paths, undefined, {
      hostCodexAuth: hostCodexCredentialFile(process.env.CODEX_HOME, userHome),
    }),
    'state',
    profilerProbe,
    millisecondClock,
    { home: userHome, stateHome: paths.home },
  );
  /**
   * This boot's journal, held as a local because several things write to it.
   *
   * Hoisted out of the world literal below rather than duplicated: a second journal would be a second
   * `+Nms` baseline, so two lines a person reads in one stream would disagree about when this daemon
   * started. Nothing else about it moved.
   */
  const bootNotices = bootJournal(overrides.logLevel);
  /**
   * "The configuration moved" (docs/config-files.md "Live changes"): ONE ledger every source of a change
   * announces into — a load that finds a file changed, a route that changes a login or a speed-up, a
   * sign-in that finishes on its own — and the one revision `/v1/events?topic=config` serves. Counted in
   * memory per boot; the epoch names the boot.
   */
  const configChangeTimers = {
    after: (milliseconds: number, action: () => void) => {
      const timer = setTimeout(action, milliseconds);
      return { cancel: () => clearTimeout(timer) };
    },
  };
  const configChanges = new ConfigChangeLedger(crypto.randomUUID(), configChangeTimers);
  const configChangeStream = new ConfigChangeStreamService(configChanges, configChangeTimers);
  /**
   * The configuration files (docs/config-files.md): ONE service every in-process reader of the
   * machine's configuration goes through — the fleet catalogue, the agent-control switches, the Warden,
   * Learning — so none of them can disagree about which version of a file is in effect. A broken file
   * and a held loosening are said in this boot's journal, once each, when they are first seen.
   */
  const configDirectory = new FileConfigDirectory(paths.config, stateFiles);
  const configFiles = new ConfigFilesService({
    directory: configDirectory,
    accepted: new FileAcceptedConfigStore(join(paths.state, CONFIG_ACCEPTED_FILE), stateFiles),
    log: {
      issue: issue =>
        bootNotices.state(
          `config ${issue.path}${issue.line === undefined ? '' : `:${String(issue.line)}:${String(issue.column)}`} ${issue.severity}: ${issue.message} — ${issue.fix}`,
        ),
      pending: pending =>
        bootNotices.state(
          `config ${pending.path} waits for your confirmation (${pending.changes.join('; ')}) — run \`${CLIENT_NAME} config confirm ${pending.path}\``,
        ),
    },
    digest: text => new Bun.CryptoHasher('sha256').update(text).digest('hex'),
    now: () => new Date(),
    changes: configChanges,
  });
  const configLocations = { configDirectory: paths.config, fleetDirectory: paths.fleet };
  // The login window is created before a state home is opened, while browser sessions are created
  // from that opened home. Keep the callback live so a human login always closes the real workers
  // that currently hold the shared profile rather than racing their lease.
  let closeAgentBrowsers: () => Promise<void> = async () => undefined;
  const daemonConfigMutations = new KeyedSerialExecutor();
  const stateHomeDaemonConfigStore = new FileDaemonConfig(paths, stateFiles);
  /**
   * What this machine has agreed a caller who is NOT on it may do.
   *
   * Built from the SAME configuration document `--print-config` reports, so the grants an operator
   * reads and the grants the authorization boundary enforces are one value rather than two.
   */
  // Every live socket and relayed session a paired device holds, so revoking it closes them too.
  // ONE registry, shared by the bound address, every relay carrier and the pairing service.
  // One step-up registry per process, told by the connection registry when each running copy of the
  // app opens and closes a session, so a step-up ends with the page that performed it.
  // THE STEP-UP WINDOW IS THE OWNER'S SETTING (B6), read at every question. The settings service opens
  // with pairing, later than this registry, so the window is read through a holder that answers the
  // strictest reading — every time — until the settings have been read.
  let securitySettings: SecuritySettingsService | undefined;
  const stepUpRegistry = new StepUpRegistry(
    { nowMs: () => Date.now() },
    () => securitySettings?.current().stepUpWindowMinutes ?? 0,
  );
  const deviceConnections = new LiveDeviceConnections(stepUpRegistry);
  // ONE journal for the owner's acts — grant changes and re-opened passkey windows — so two writers never
  // interleave in the same file.
  const grantAudit = new JournalGrantAudit(paths.grantAudit, stateFiles);
  const grants = new CapabilityGrantService({
    document: new ConfigGrantDocument(stateHomeDaemonConfigStore, daemonConfigMutations),
    clock: new SystemGrantClock(),
    audit: grantAudit,
    clientName: CLIENT_NAME,
    // A narrowed grant reaches the streams already open, not only the next one.
    changed: () => deviceConnections.recheckAll(),
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
  // THE FIFTH HOLDER of the vault (see `docs/secrets.md`): it puts one named provider key on one HTTPS
  // request to a host that key may reach, and hands back only the reply. Dictation clean-up, the Jev
  // guard and the Speed-ups Test all spend keys through it; none of them is ever handed a value.
  const outboundAuthorizer = new OutboundProviderAuthorizer(secretVault, new FetchEnhancementTransport());
  const speedupStopwatch = new PerformanceStopwatch();
  const secretDirectory = new SecretDirectory(secretDocuments, secretCipher, clock);
  // Copying secrets to another machine signs and checks offers with THIS daemon's identity — the key its
  // daemon id fingerprints — read per clone, so a daemon whose identity cannot be read refuses the copy
  // and serves everything else.
  const secretCloneIdentity: SecretCloneIdentitySource = {
    load: async () => {
      const read = await readDaemonRelayIdentity(stateFiles, paths.daemonIdentity, new WebCryptoRelayIdentityKeys());
      return read.ok ? read.identity : undefined;
    },
  };
  const secretCloneCrypto = new WebCryptoRelayCrypto();
  const secrets: SecretSubsystem = {
    directory: secretDirectory,
    // TWO places name secrets now: the operator's own recipes, and the fleet accounts a profile
    // authenticates. Both are listed, so an account whose credential is missing from the store is a
    // line on a screen before it is a session that dies at start.
    references: combinedReferences(
      secretRecipes,
      // Absent is a host with no fleet, which names nothing. Anything else — unreadable, a typo in the
      // YAML, the old account format — raises, because a reference list quietly missing half its
      // entries is how somebody deletes a secret their fleet still wants.
      new FleetSecretReferences(async () => await readDeclaredAccountModel(configFiles, configLocations)),
    ),
    uses: new SecretUseService(secretVault, new BunSecretChildRunner(), secretRecipes),
    imports: new SecretImportService({
      crypto: secretCloneCrypto,
      identity: secretCloneIdentity,
      directory: secretDirectory,
      clock,
    }),
    // THE SIXTH HOLDER of the vault (see `docs/secrets.md`): it seals chosen values to another machine's
    // one-time key and answers only that ciphertext, which no caller of this daemon can open.
    exports: new SecretExportService({
      crypto: secretCloneCrypto,
      identity: secretCloneIdentity,
      vault: secretVault,
      clock,
    }),
  };
  // Everything an operator reads back is scrubbed of every value this daemon holds, so a secret a
  // child printed is a mask by the time anybody sees it. Read `lib/secrets/redaction.ts` for what
  // that does and does not promise — in particular that a value an agent deliberately transformed is
  // not recognisable, and this is not a defence against one that is trying.
  const secretRedactor = new SecretRedactor(secretVault);
  // Its own executor: a learning verdict must not queue behind another document's transaction, and the
  // snapshots share no file.
  const learningBoard = new LearningSerialExecutor();
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
  const accounts = new RuntimeAwareAccountInventory(
    new ManifestAccountInventory(stateFiles, paths.fleetManifest),
    new RuntimeIdsFile(stateFiles, runtimeIdsPath(paths.fleet)),
  );
  /** Stops the app-server daemon a Codex runtime started, once nothing uses that runtime (U12). */
  const codexAppServers = new CodexAppServerSupervisor({
    inventory: accounts,
    processes: new HostCodexAppServerProcesses({
      platform: process.platform,
      psExecutable: Bun.which('ps') ?? undefined,
    }),
    homesDirectory: join(paths.fleet, 'homes'),
    sleep: milliseconds => Bun.sleep(milliseconds),
  });
  /**
   * What an account's own profile supplies at launch, when the profile authenticates it instead of a
   * login. The THIRD thing in this daemon holding a vault, and the reasoning for that — plus why it
   * reads the published manifest rather than the fleet configuration — is in
   * `lib/fleet/launch-environment.ts`. Both launch paths get the same one, because a revived pane
   * that came back without its credential is a working agent destroyed by its own recovery.
   */
  /**
   * Signing in to a remote MCP server from a browser (docs/mcp-oauth.md). The daemon is the OAuth client:
   * tokens go straight into the secret store through its WRITE half, and the vault is held only to spend
   * a refresh token at the provider that issued it. The launch environment asks it to refresh a token a
   * launch is about to use — that is the only refresh there is; no timer.
   */
  /**
   * Which project a folder is in, for MCP — the ONE source the inventory, the sign-in (a project's
   * `.mcp.json` servers sign in too, docs/mcp-scopes.md) and a launch all read. The known folders come
   * from the project catalogue and the worktree service, the ferrets' folders from the session
   * directory; all three mount with the subsystems below, and until they do there are none.
   */
  const mcpFolderSources: {
    known: () => Promise<readonly McpInventoryFolder[]>;
    ferrets: () => Promise<readonly string[]>;
  } = { known: async () => [], ferrets: async () => [] };
  const mcpFolders = new KnownAndFerretFolders(
    async () => await mcpFolderSources.known(),
    async () => await mcpFolderSources.ferrets(),
  );
  const mcpDocuments = new FileMcpHarnessDocuments();
  /** The published runtimes, as the MCP inventory names them: by runtime name, harness and config directory. */
  const mcpAccounts = async (): Promise<readonly McpInventoryAccount[]> =>
    (await accounts.accounts()).map(account => ({
      runtime: wrapperNameOf(account.wrapper),
      harness: account.kind,
      home: account.home,
      wrapper: account.wrapper,
    }));
  const mcpOAuth = new McpOAuthService({
    servers: combinedMcpOAuthServers(
      new AccountModelMcpServers(async () => await readDeclaredAccountModel(configFiles, configLocations)),
      new ProjectMcpOAuthServers(mcpFolders, mcpDocuments),
    ),
    http: new FetchMcpOAuthHttp(),
    crypto: webCryptoMcpOAuth,
    clock: millisecondClock,
    state: new FileMcpOAuthStateStore(paths, stateFiles),
    secrets: secrets.directory,
    values: secretVault,
    // Refresh tokens and client secrets: sealed under the same key in their own document, held by
    // nothing but this service — no route lists them, `use` cannot spend them, `${secret:…}` cannot
    // resolve them.
    internal: (() => {
      const documents = new FileSecretDocumentStore(paths, stateFiles, MCP_OAUTH_SECRETS_DOCUMENT);
      const directory = new SecretDirectory(documents, secretCipher, clock);
      const vault = new SecretVault(documents, secretCipher);
      return {
        list: async () => await directory.list(),
        put: async (name: string, value: string) => await directory.put(name, value),
        remove: async (name: string) => await directory.remove(name),
        values: async () => await vault.values(),
      };
    })(),
  });
  const accountLaunchEnvironment = new FleetLaunchEnvironment(
    accounts,
    secretVault,
    mcpOAuth,
    // A project's signed-in MCP servers reach a Claude ferret in that project as local-scope entries in
    // its runtime's own `.claude.json` (lib/mcp-inventory/project-sign-in.ts).
    new ProjectMcpLaunch({
      accounts: mcpAccounts,
      folders: mcpFolders,
      documents: mcpDocuments,
      secrets: secretVault,
      renewal: mcpOAuth,
      localScope: new FileClaudeLocalScope(),
    }),
  );
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
   * The account model's configuration and the published manifest, read fresh on every call.
   *
   * ONE reader of each for every in-process consumer — the launch renewal, the usage feed and its
   * cadence — so none of them can disagree about what this machine declares or has published. A
   * configuration that is absent is a host with no fleet; one in the old account format refuses.
   */
  const declaredAccountModel = async () => await readDeclaredAccountModel(configFiles, configLocations);
  /**
   * The same model as the last configuration load has it, without touching the directory: for the
   * readers that run on a timer — the credential catalogue, the usage feed and its cadence, auto-resume —
   * which each re-scanned the whole configuration tree on every pass. A change reaches them once the
   * watcher has loaded it. Anything that decides what an agent or a launch may do reads the fresh one.
   */
  const effectiveAccountModel = async () => await readDeclaredAccountModel(configFiles, configLocations, false);
  // The agent browser's own private display for a Linux real window (see `DaemonWorld.agentBrowserDisplay`).
  // Nothing is spawned until a real-window launch asks for it; a host without Xvfb is told what to install.
  const agentBrowserDisplay = new XvfbDisplay({
    executable: () => Bun.which('Xvfb', { PATH: process.env.PATH }) ?? undefined,
    missing: () => xvfbMissingMessage(command => Bun.which(command, { PATH: process.env.PATH }) !== null),
  });
  const publishedManifest = async () => await readFleetManifest(stateFiles, paths.fleetManifest);
  /** The fleet's declared probe interval. A host with no readable configuration keeps the default. */
  const declaredUsageRefreshMs = async (): Promise<number> =>
    usageRefreshMs(
      await effectiveAccountModel().then(
        model => model?.advanced.usage.interval,
        () => undefined,
      ),
    );
  /**
   * The credentials surface's list, once the subsystems are mounted. The usage feed is built before
   * them, and reads through this so it answers "could not read" rather than a list it does not have.
   */
  let credentialList: (() => Promise<FleetCredentialList>) | undefined;
  /**
   * The limits live sessions' panes prove ("You've hit your org's monthly spend limit"), once storage is
   * open. The usage feed lays them over its rows; until then it has none.
   */
  let paneLimits: (() => Promise<ReadonlyMap<string, PaneLimit>>) | undefined;
  /**
   * Environment logins' provider quotas (docs/provider-quotas.md), once the subsystems are mounted. The
   * usage feed is built before them and lays these readings over its rows; until then it has none.
   */
  let providerQuota: ProviderQuotaService | undefined;
  // Claude's own rule, never LOGNAME: under launchd or systemd USER can be unset, and Claude then
  // names its item after the OS login name — which is what every keychain read must ask for too.
  const claudeKeychain = claudeKeychainAccount(process.env.USER, () => userInfo().username);
  // The home the harness reaches with no `CLAUDE_CONFIG_DIR`, whose keychain item carries no suffix.
  // Spelled from `userHome` because the fleet layout owns the same join.
  const defaultClaudeHome = join(userHome, '.claude');
  /**
   * The one credential store the renewal and the sign-in read through. The credential status reads the
   * same stores by the same rules — this platform, this keychain account, this default home — on the
   * housekeeping worker, which builds its own from `housekeepingSettings` below.
   *
   * A renewal classifies and then classifies again, which is what decides whether it fired and whether
   * it worked. Two stores would be two readings of one home, and the second reading is the whole of
   * the renewal's verdict — so they share this one.
   */
  const harnessCredentials = new PlatformFleetCredentialStore({
    platform: process.platform,
    command: new SpawnCredentialCommand(),
    now: () => millisecondClock.now(),
    keychainAccount: claudeKeychain,
    defaultClaudeHome,
  });
  /**
   * Where this operator said the harnesses are, once this boot has read the configuration.
   *
   * A LET for the reason `attachmentDaemonId` above is one: the declaration is CONFIGURATION, and the
   * configuration is not loaded when these adapters are built. Every reader is a closure that asks at
   * the moment of the lookup, so nothing captures the absence — and a renewal that somehow ran before
   * a boot resolved this answers `unavailable` in words rather than resolving against a second rule.
   *
   * IT MUST BE `locateHarnessCommand` AND NOT `Bun.which`. A daemon started by systemd or launchd
   * inherits a minimal environment, which is the entire reason `docs/harness-paths.md` exists: a
   * renewal that searched `PATH` alone would report "the claude CLI is not on this host" on precisely
   * the hosts that feature was written for, while the operator's own `harness` block named the file.
   */
  let harnessPolicy: HarnessDiscoveryPolicy | undefined;
  /**
   * Whether the fleet's credential and usage reads run on the housekeeping worker (`housekeeping.enabled`
   * in `daemon.json`, on unless it says `false`). A LET for the reason `harnessPolicy` is one: it is
   * configuration, read when the usage feed is built from it, before the subsystems that use it mount.
   */
  let housekeepingEnabled: boolean | undefined;
  /**
   * Whether the usage feed has an external collector (`usage.url`), which only time refreshes: then the
   * fleet refresh keeps one pass an interval whatever the credentials say. Read with the feed's config.
   */
  let usageCollector = false;
  const harnessBinary: FleetBinaryLookup = binary => {
    const kind = (['claude', 'codex'] as const satisfies readonly HarnessKind[]).find(
      candidate => HARNESS_BINARIES[candidate] === binary,
    );
    if (kind === undefined || harnessPolicy === undefined) return undefined;
    const located = locateHarnessCommand(kind, harnessPolicy, executables);
    return located.outcome === 'located' ? located.path : undefined;
  };
  /**
   * Renewing a credential that can already renew itself — ONE service for this whole process.
   *
   * The instance is the dedupe. `FleetTokenRefreshService` joins concurrent renewals of one identity
   * inside itself, and a rotating refresh token is spent by whoever uses it first, so a second
   * instance would be a second window in which two spawns both fire at a token only one can spend.
   * Everything in this daemon that renews takes this object.
   *
   * It reads through the SAME store the sign-in does, so the reading that authorises a rotation is the
   * reading a clone would have decided on.
   */
  const harnessRenewal = new FleetTokenRefreshService({
    store: harnessCredentials,
    port: new ProcessFleetTokenRefreshPort({
      spawn: spawnFleetTokenRefreshProcess,
      environment: process.env,
      which: harnessBinary,
    }),
  });
  // The lease, its cap and the idle day, shortened only for a test run and never lengthened. A value
  // that would lengthen one refuses the boot; any shortening in force is said once, here.
  const timings = parseDaemonTimings(process.env[TEST_TIMINGS_VARIABLE]);
  const timingNote = describeDaemonTimings(timings);
  if (timingNote !== undefined) bootNotices.state(timingNote);
  // The security log (docs/design/zero-trust.md §C): one writer, built before pairing and the route table
  // that both record into. A write it cannot make is said in this boot's journal, never thrown into a request.
  const auditFailures = { auditWriteFailed: (message: string) => bootNotices.state(message) };
  const auditLog = new AuditLog({ journal: new FileAuditJournal(paths.state), clock, failures: auditFailures });
  /**
   * The account's own chance to renew before an agent is started on it.
   *
   * ATTENDED RENEWAL, and this is the second of its exactly two doors — a person running a command is
   * the first. There is deliberately no third: the unattended usage pass must never rotate a credential,
   * because the harness rewrites its own store by temp-file-and-rename and a writer racing it loses
   * silently, with nobody present to be told.
   *
   * It takes the SAME renewal instance everything else does, which is what makes the dedupe real: two
   * panes starting at once on one identity are one rotation of a refresh token only one of them could
   * spend. It reads through the same store, so the reading that authorises a rotation here is the
   * reading Check now would have decided on.
   */
  const accountLaunchRenewal = new FleetLaunchRenewal({
    fleet: { manifest: publishedManifest },
    identities: new FleetIdentityService(harnessCredentials),
    renewal: harnessRenewal,
    notices: bootNotices,
  });
  /**
   * The account model's credentials (docs/design/account-model.md §3.2): which logins this machine has
   * and where each one's login lives, read from the configuration files on every call. Built here because a
   * sign-in by credential id resolves through it, and the credentials subsystem below reads it too.
   */
  const credentialHostCodexHome = hostCodexHome(process.env.CODEX_HOME, userHome);
  const fleetCredentialCatalog = new FleetCredentialCatalog({
    document: effectiveAccountModel,
    paths: {
      fleetRoot: paths.fleet,
      userHome,
      ...(credentialHostCodexHome === undefined ? {} : { hostCodexHome: credentialHostCodexHome }),
    },
    inspect: async resolution => await harnessCredentials.inspectStored(resolution),
    ensureDirectory: ensurePrivateDirectory,
  });
  const locateHarness = (kind: HarnessKind): string | undefined => harnessBinary(HARNESS_BINARIES[kind]);
  /**
   * Driving a harness's own sign-in from a browser, holding no token: the harness's own login against
   * one credential's store. It is given THIS PROCESS'S ENVIRONMENT, which the service sanitizes before
   * any child sees it, so a sign-in started from inside an agent session cannot authenticate against
   * that session's login. Who may start one is the route's `fleet.configure`, which holds a caller
   * off this host behind the passkey step-up.
   */
  const harnessLogin = new HarnessLoginService({
    credentialTargets: {
      target: async id => fleetCredentialCatalog.signInTarget(await fleetCredentialCatalog.entry(id)),
    },
    locate: locateHarness,
    clock: millisecondClock,
    mintId: () => crypto.randomUUID().replaceAll('-', '').slice(0, 22),
    spawn: spawnHarnessLoginChild,
    deliverCallback: deliverCodexCallback,
    environment: process.env,
    timer: harnessLoginTimer,
    portHolders: systemPortHolders(),
    clientName: CLIENT_NAME,
    onSignedIn: () => configChanges.announce(['credentials', 'runtimes']),
  });
  /** One advisor per usage feed. The inventory and the catalog are the same for every caller; only
   *  how spent each account is depends on whether the caller asked for a live probe. */
  const advisorOver = (usage: UsageFeedPort): TeamAdvisor => new TeamAdvisor(accounts, routing, usage);
  /** Session ids, minted before the plan that shapes the session they name. */
  const sessionIds = new TimeSessionIdFactory();
  /** The shape of one session. ONE planner for the process: the model a start records and the window
   *  a later read reports must come from the same decision. */
  const contextWindowOverrides: Readonly<Record<string, number>> = {};
  const planner = new SessionPlanner({
    startWait: defaultStartWaitPolicy,
    contextWindowOverrides,
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
  // What a pane is LAUNCHED with: the stored environment over the per-ferret switches its record implies
  // (`LaunchEnvironmentStore`). The defaults are assigned once Pack mode's hooks exist below; a launch
  // before then derives nothing, as every launch did before.
  let launchSwitchDefaults: LaunchSwitchDefaults = async () => ({});
  const launchEnvironments = new LaunchEnvironmentStore(
    sessionEnvironments,
    async id => await launchSwitchDefaults(id),
  );
  // Where a session's agent puts media it made to show the person, created per launch so a pane is never
  // handed a folder that does not exist. Owner-only, like the rest of the session's state.
  // Beside it, the file Claude's question hook records an asked question in (`FY_QUESTION_FILE`).
  const sessionMedia = async (id: SessionId) => {
    const session = createSessionPaths(paths, id);
    await mkdir(session.media, { mode: 0o700, recursive: true });
    return { media: session.media, questionAsked: session.questionAsked };
  };
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
   * How often an unresolved Codex session may walk that home — one pacer for the daemon, because the
   * resolver below is built per storage and per reader and a pace kept in any one of them would be
   * forgotten with it.
   */
  const codexDiscoveryPacer = new CodexDiscoveryPacer(clock);
  /** The one hub every file watch in this daemon goes through (docs/design/event-driven-daemon.md stage 2). */
  const fileEvents = new FileEventHub(platformFileEventSource(), unrefFileEventTimers);
  /**
   * The housekeeping jobs' settings and their main-thread runner, built here because the Codex discovery
   * below runs as a job from the first read, before the worker is wired further down. The runner shares
   * `codexRollouts`, so a walk on this thread reuses what the start's baseline read already learned.
   */
  const probeUrls = usageProbeUrls(process.env.FY_USAGE_PROBE_ORIGIN);
  const housekeepingSettings: HousekeepingSettings = {
    type: 'settings',
    platform: process.platform,
    keychainAccount: claudeKeychain,
    defaultClaudeHome,
    fleetRoot: paths.fleet,
    ...(probeUrls === undefined ? {} : { probeUrls }),
  };
  const inlineHousekeeping = new InlineHousekeepingJobs(
    housekeepingSettings,
    () => millisecondClock.now(),
    codexRollouts,
  );
  /** Where a discovery walk runs: this thread until the housekeeping worker is wired below. */
  let discoveryJobs: HousekeepingJobs = inlineHousekeeping;
  /**
   * An undiscovered Codex session's walk, as a `codex.discover` job on the housekeeping worker
   * (housekeeping-worker.md §2.1), and the home's newest directories watched, so a quiet home is not
   * walked again until an event says it moved or the pacer's backstop falls due.
   */
  const codexDiscovery = new HousekeepingCodexRollouts({
    jobs: () => discoveryJobs,
    watch: (directory, listener) => fileEvents.subscribeDirectory(directory, () => listener()),
  });
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
  /**
   * The same two parsers, paced by the daemon's loop, for the readers that hold a whole transcript as
   * text: a history listing parses every file up to 32 MiB whole, and in one call it held the loop.
   */
  const pacedTranscriptParsers = {
    claude: new PacedTranscriptParser(claudeTranscriptParser, LOOP_PARSE_PACING),
    codex: new PacedTranscriptParser(codexTranscriptParser, LOOP_PARSE_PACING),
  };
  /**
   * The one thread every transcript read below is parsed on (`bin/transcript-parse.worker.ts`): the
   * window, the whole read, the tail, the conversation index, the image route and both history
   * listings. It runs the very readers the event loop would, and the loop receives their answers in
   * pages, so where a transcript is parsed changes and what it answers does not. If the thread keeps
   * failing it is retired, and every reader below does its work here on the main thread instead.
   */
  /** Where an import listing may read a transcript's hand-off pointer from: see `HandoffScope`. */
  const conversationHandoffScope = { roots: [paths.sessions], coordinatorHomes: [userHome] };
  const transcriptParseWorker = new TranscriptParseWorker({
    handoffScope: conversationHandoffScope,
    retired: () =>
      bootNotices.state(
        'the transcript worker kept failing, so transcripts are parsed on the main thread until the daemon restarts',
      ),
  });
  /** The readers the proxies fall back to: the same sources, parsing on this thread. */
  const inlineTranscriptSources = [
    new NodeTranscriptSource(claudeTranscriptParser),
    new NodeTranscriptSource(codexTranscriptParser),
  ] as const;
  const transcriptSources = inlineTranscriptSources.map(
    inline => new WorkerTranscriptSource(inline.harness, transcriptParseWorker, inline),
  );
  /**
   * Every session's addressable conversation, folded once and extended by what was appended — one for
   * the daemon, so a page of a long session costs its appended bytes rather than the whole file. See
   * `ConversationIndex` for what is proved before a held fold is extended.
   *
   * Folded and held in the transcript worker, because its input is every raw byte of the file. The
   * fallback index is over the INLINE sources: a proxy window carries no raw records, so a fold over one
   * would refuse.
   */
  const conversationIndex = new WorkerConversationIndex(
    transcriptParseWorker,
    new ConversationIndex(inlineTranscriptSources, new NodeTranscriptFileRuntime(), LOOP_PARSE_PACING),
  );
  /**
   * A separate read surface for conversations that existed before Ferretry.
   *
   * It shares the exact parser instances used by managed sessions, but its filesystem capability
   * has no mutation method and it is deliberately not backed by the session store: a foreign JSONL
   * has neither a Ferretry journal nor a live pane and must never be presented as resumable.
   */
  const foreignHistoryFiles = new NodeForeignHistoryFiles();
  const foreignHistory = new ForeignHistoryImporter(
    foreignHistoryFiles,
    foreignHistoryRoots(userHome),
    new WorkerForeignTranscriptReader(
      transcriptParseWorker,
      new FileForeignTranscriptReader(foreignHistoryFiles, pacedTranscriptParsers),
    ),
  );
  /**
   * A session's own transcript, over the provenance its start recorded.
   *
   * Per opened storage because both halves read documents: the resolver reads the provenance record
   * and writes back the rollout it correlates, and the claims reader has to see every other
   * session's attribution to keep two sessions from claiming one file.
   */
  const createTranscriptFileResolver = (storage: DaemonStorage): TranscriptFileResolver => {
    const resolver = new SessionTranscriptResolver(
      codexDiscovery,
      new StorageTranscriptClaims(storage),
      new StorageTranscriptProvenanceStore(storage),
      clock,
      codexDiscoveryPacer,
    );
    return {
      file: async sessionId => {
        const id = tryParseSessionId(sessionId);
        if (id === undefined) return undefined;
        // Asked on every transcript read of every session: as fresh as the last file event, so an unchanged
        // config costs no `stat` while its directory is watched (the daemon's own writes are seen at once).
        const config = await storage.readConfig(id, 'heard').catch(() => undefined);
        // The start anchors discovery pacing; the state is read only when a pace begins.
        return await resolver.file(sessionId, storedTranscriptProvenance(config), async () =>
          storedSessionStart(await storage.readState(id).catch(() => undefined), config),
        );
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
      conversationIndex,
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

        // A refusal keeps its reason: "could not read completely" alone cannot tell a damaged record
        // from a missing journal from a file replaced mid-read, and the operator needs to know which.
        let rows: Awaited<ReturnType<SessionTranscriptReader['portableRowsFromFile']>>;
        try {
          rows = await reader.portableRowsFromFile({ sessionId, harness: config.data.harness }, file);
        } catch (error) {
          return {
            kind: 'unreadable',
            reason: error instanceof ConversationDigestError ? error.message : 'an unexpected error stopped its read',
          };
        }
        if (rows === undefined) return { kind: 'unreadable', reason: 'no transcript source speaks its harness' };
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
  /** One memory of parsed tails for every reader this world builds, so no two of them re-parse alike. A
   *  watched tail is re-validated when its file changes rather than by a `stat` on every ask. */
  const transcriptTails = new TranscriptTailCache(undefined, undefined, {
    changes: fileEvents,
    now: () => Date.parse(clock.now()),
  });
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
        // Read from the END: a tail of a capped read from byte zero described an old moment as now.
        const read = async () => await tailTranscriptEvents(source, file, sessionId, limit).catch(() => undefined);
        // Re-parsed only when the file changed, shared by concurrent asks, and throttled daemon-wide —
        // see `TranscriptTailCache` for the minutes-long stall that an uncached tail per read caused. The
        // `stat` is skipped while the file's watch vouches for the remembered tail.
        const fingerprint = async () =>
          await stat(file).then(
            info => ({ file, size: info.size, mtimeMs: info.mtimeMs }),
            () => undefined,
          );
        const events = await transcriptTails.tail(sessionId, file, limit, fingerprint, read);
        if (events === undefined) return { kind: 'unreadable' };
        return { kind: 'read', events };
      },
    };
  };
  /**
   * One image of a session's transcript, found from the handle its log carried.
   *
   * It resolves the file and the harness exactly as the tail does, and parses ONLY the one record the
   * handle names with that harness's own paced parser — see `TranscriptImageReader` for the proof.
   */
  const createTranscriptImageReader = (storage: DaemonStorage): TranscriptImages => {
    const resolver = createTranscriptFileResolver(storage);
    const locator: TranscriptImageLocator = {
      locate: async sessionId => {
        const file = await resolver.file(sessionId).catch(() => undefined);
        if (file === undefined) return undefined;
        const id = tryParseSessionId(sessionId);
        if (id === undefined) return undefined;
        const config = SessionConfigSchema.safeParse(await storage.readConfig(id).catch(() => undefined));
        if (!config.success) return undefined;
        return { file, harness: config.data.harness === 'codex' ? 'codex' : 'claude' };
      },
    };
    // Located here, where the session's documents are; proved and read on the transcript worker.
    return new WorkerTranscriptImages(
      transcriptParseWorker,
      locator,
      new TranscriptImageReader(locator, new NodeTranscriptImageFiles(), pacedTranscriptParsers),
    );
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
        return await readAnalyticsTranscriptEvidence(source, file, sessionId, harness);
      },
    };
  };
  /** One live writer per harness conversation (account model §9.3), over the shared pool's lease files. */
  const conversationLeases = (storage: DaemonStorage): ConversationLeases =>
    new ConversationLeases(new FileConversationLeaseStore(paths.fleet, processIncarnationFor()), storage, process.pid);
  /** The board a new session works on: its parent's, its repository's, its folder's, else Unfiled. */
  const sessionBoards = (storage: DaemonStorage): SessionProjects =>
    new SessionProjects(
      new StorageSessionFacts(storage),
      new FileProjectCatalog(join(paths.state, 'projects.json')),
      new GitRepositoryProbe(),
      [...COMMON_SCRATCH_ROOTS, tmpdir()],
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
        projects: sessionBoards(storage),
        // EVERY session gets a credential, not only one that asked for board access: the board
        // domain keys `TaskBoardSession` on this hash, so a session minted without one could never
        // be invited to a board later. Holding a credential is identity; a grant is authority, and
        // the two are separate records.
        credentials: sessionCredentials,
        environment: sessionEnvironments,
        leases: conversationLeases(storage),
        // A caller that has already minted the id hands it over, so the plan and the record cannot
        // disagree about which session they describe.
        ids: id === undefined ? sessionIds : { next: () => id },
        clock,
        // ONE queue for every service this process builds: a per-service executor would let a stop
        // and a retried start of the SAME session interleave, and the loser's write would overwrite a
        // live session's record. The service is per request; the serialization is not.
        serial: sessionMutations,
        // The SAME gate a revive registers in, so a stop waits boundedly for a relaunch in flight
        // instead of queueing forever behind one that never settles.
        launches: launchGate,
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
  /** The fleet settings a wrapper launches under, digested; see `FileLaunchSettingsDigest`. */
  const launchSettings = new FileLaunchSettingsDigest(new FileHarnessWrapperSource(), process.env);
  /**
   * Every relaunch of an existing session builds its argv HERE, from its own documents and the fleet as
   * it is now — the revive, and the stale-settings read that compares against what a revive would run.
   */
  const createSessionLaunch = (storage: DaemonStorage): SessionLaunchService =>
    new SessionLaunchService({
      subject: async id => {
        const raw = await storage.readConfig(id);
        const config = SessionConfigSchema.safeParse(raw);
        const state = SessionStateSchema.safeParse(await storage.readState(id));
        const lifecycle = SessionLifecycleConfigSchema.safeParse(lifecycleConfigDocument(raw));
        if (!config.success || !state.success || !lifecycle.success) return undefined;
        return { config: config.data, state: state.data, command: lifecycle.data.command };
      },
      account: async agent =>
        await resolveStartAccount(accounts, agent, executables, CLIENT_NAME).catch(() => undefined),
      planner,
      // The attachment root is keyed by the pairing identity, which boot opens before anything can
      // revive a session or read its settings; the start's own resolver is the same expression.
      readableFolders: id => {
        if (attachmentDaemonId === undefined) throw new Error('pairing identity was not opened before a relaunch');
        return handoffFolders(
          createSessionPaths(paths, id).directory,
          attachmentDirectory(paths.state, attachmentDaemonId, id),
        );
      },
      settings: async (executable, harness) => await launchSettings.digest(executable, harness),
      fixedSettings: async (executable, harness) => await launchSettings.fixedSettings(executable, harness),
      transcriptStarted: async file => await Bun.file(file).exists(),
      authorize: (executable, argv) => authorizeSessionCommand(executable, argv, defaultSessionLifecycleSettings),
      record: async (id, launch) => {
        await storage.updateConfig(id, current => {
          const { launchSettings: _previous, ...retained } = jsonObject(current) ?? {};
          return {
            ...retained,
            command: [...launch.command],
            model: launch.model,
            ...(launch.launchReasoningEffort === undefined
              ? {}
              : { launchReasoningEffort: launch.launchReasoningEffort }),
            ...(launch.launchFast === undefined ? {} : { launchFast: launch.launchFast }),
            ...(launch.launchSettings === undefined ? {} : { launchSettings: launch.launchSettings }),
            updatedAt: clock.now(),
          };
        });
      },
    });
  const createResumeLauncher = (
    storage: DaemonStorage,
    relaunch: (id: SessionId) => Promise<readonly string[] | undefined>,
  ): ResumeLauncher => {
    const controller = new TmuxController(tmux, launchGuard);
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
        const replay = relaunchCommand(config.command, started);
        return {
          tmuxSession: config.tmuxSession,
          cwd: config.cwd,
          command: replay,
          // A revive RUNS on current settings rather than replaying the argv its start recorded.
          relaunch: async () => (await relaunch(id)) ?? replay,
          // The SAME store the launch path reads, for the same reason it reads it per launch: a
          // replacement pane must carry the session's CURRENT environment. Read here rather than
          // captured at construction, and merged with the derived session id by the launcher.
          env: await launchEnvironments.read(id),
          // The executable, so a revive can resolve the same profile the first launch did. Without
          // it a profile-authenticated account would come back with no credential at all.
          agent: config.agent,
          mode: config.mode,
        };
      },
      new TmuxPaneDelivery(controller, milliseconds => Bun.sleep(milliseconds)),
      lastSnapshots,
      // The SAME planner initial startup uses: a replacement pane is a new launch and must receive
      // the configuration saved immediately before it, without restarting this daemon.
      // A revive writes the conversation again, so it claims it first, like a start (account model §9.3).
      new LeaseClaimingLaunchWrapper(conversationLeases(storage), cgroupLaunchPlanner),
      registrar,
      undefined,
      // The SAME resolver the first launch used, for the same reason the environment above is
      // re-read: a revive must hand the replacement the credential the account has NOW.
      accountLaunchEnvironment,
      // And the same chance to renew it. A recovered agent holding an expired access token is a
      // revive that restored the pane and not the session.
      accountLaunchRenewal,
      sessionMedia,
      // The binary the wrappers' instructions name, so a revive records what its pane was told.
      CLIENT_NAME,
    );
  };
  /**
   * The launch path's controller, held as a local so the launcher and its delivery adapter address
   * the SAME tmux server. Two controllers over the same socket would work; one is what makes it
   * impossible for a future edit to point delivery at a different pane than the launch created.
   */
  // Managing sessions still requires tmux on PATH, checked here as it always was; the commands
  // themselves ride the daemon's one transport.
  resolveTmuxExecutable();
  const launchTmuxCommands = tmux;
  const launchTmux = new TmuxController(launchTmuxCommands, launchGuard);
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
  /** Set by `createSessionHealth`; read by `createAutoResume` — the two halves of one boot-time observation. */
  let bootExits: BootExitRecorder | undefined;
  /**
   * The running sessions whose pane a session worker watches: the self-check's exit pass leaves them to their
   * workers' `exited` and asks tmux only about the rest. Hosting is bound once the supervisor exists.
   */
  const watchedPanes = new WatchedPanes();
  const recordBootExits = (exits: SessionExitPort): SessionExitPort => {
    bootExits = new BootExitRecorder(exits, clock);
    return bootExits;
  };
  const autoResumeSummary = new FileAutoResumeSummaryStore(stateFiles, join(paths.home, 'auto-resume-summary.json'));
  /** The resume factory, held as a local for the same reason `createSessionLifecycle` is: the mounted
   *  subsystems must get the same one the world publishes rather than a second construction. */
  const createSessionResume: DaemonWorld['createSessionResume'] = (storage, launcher, answerAgenda, serial) =>
    new SessionResumeService(
      {
        repository: new StorageResumeRepository(storage),
        launcher,
        answerAgenda,
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
    userHome,
    storage: new DaemonStorageFactory(
      environment,
      new StateFileSystemFactory(),
      new StateHomeLayout(),
      new SqliteHomeLockFactory(),
      // Read from memory, written by its own thread: no index commit — and no checkpoint `fsync` —
      // ever runs on the event loop (src/adapters/storage/sqlite-index.ts says why).
      new BunSqliteIndexFactory(
        {
          create: file =>
            new WorkerIndexFile(file, new InlineIndexFile(file), {
              retired: () =>
                bootNotices.state(
                  'the session index writer kept failing, so the index file is written on the main thread until the daemon restarts',
                ),
            }),
        },
        { persistFailed: error => bootNotices.state(`the session index file is behind: ${error.message}; retrying`) },
      ),
      clock,
      () => new KeyedSerialExecutor(),
      // A session document a background reader asks for again (`heard`) is watched, so while its directory
      // is watched live and quiet it is answered without the identity `stat` each read cost.
      { subscribe: (path, listener) => fileEvents.subscribe(path, () => listener()) },
    ),
    // Read from memory, written by its own thread, like the session index above: the boot sweep's one
    // upsert no longer commits — or checkpoints — on the event loop.
    analyticsIndexes: new BunSqliteAnalyticsStoreFactory(
      {
        create: (file, connection) =>
          new WorkerAnalyticsPersister(file, new InlineAnalyticsPersister(connection), {
            retired: () =>
              bootNotices.state(
                'the analytics store writer kept failing, so the analytics file is written on the main thread until the daemon restarts',
              ),
          }),
      },
      { persistFailed: error => bootNotices.state(`the analytics file is behind: ${error.message}; retrying`) },
    ),
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
      activities,
      performance: profilerProbe,
      beginProgress: () => {
        bootProgress = new BootProgress(millisecondClock, activities);
        return bootProgress;
      },
      watchdogLimitMs: parseWatchdogLimit(process.env[WATCHDOG_VARIABLE]),
      backgroundDelayMs: parseBackgroundDelay(process.env[BACKGROUND_DELAY_VARIABLE]),
      watchdog: limitMs => new WorkerLoopWatchdog({ limitMs, prefix: `${DAEMON_NAME} ` }),
      stackSampler: async () =>
        stackSamplerEnabled(process.env[STACK_SAMPLER_VARIABLE]) ? await JscStackSampler.start() : undefined,
      ioPressure,
    },
    // An operator's own document when they named one, and the state home's otherwise. The confined
    // filesystem port refuses every path outside the home, which is right for the daemon's own state
    // and wrong for a file a person named, so the two are different adapters.
    config: daemonConfigStore,
    overrides,
    stateHome: { path: paths.home, fromEnvironment: (environment.stateHomeInput().fyHome ?? '').trim() !== '' },
    // The SAME two collaborators a start resolves an account from, so the preflight cannot report
    // one answer while a launch gives another.
    harnesses: { accounts, executables },
    notices: bootNotices,
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
      new PaneProcessInventory(tmux, new BunProcessProbe(Bun.which('ps') ?? undefined), {
        binaryName: CLIENT_NAME,
        servers: new ProjectMcpServers(),
      }),
      new TmuxPaneSnapshot(tmux),
    ),
    wardenReports: stateDirectory => new WardenReportReader(wardenFiles, createWardenPaths(stateDirectory).reports),
    browserTransport,
    sessionLauncher: new RuntimeSupervisedLauncher(
      new TmuxSessionLifecycleLauncher(
        // A private absolute socket inside the state home is what keeps managed panes off any
        // tmux server the host already runs.
        launchTmux,
        new TmuxPaneDelivery(launchTmux, milliseconds => Bun.sleep(milliseconds)),
        // The pane is handed its own credential — and its own session id, which is what lets a
        // teammate attribute a message to itself — through `tmux -e`, never through argv: argv is
        // world-readable on this host through /proc, and the fleet wrappers read the values from their
        // environment anyway.
        launchEnvironments,
        new DurableTerminalPaneRegistrar(paths.home, launchTmux, stateFiles, paths),
        lastSnapshots,
        // What makes the resource-limit settings a capability rather than a stored preference: the
        // compiled daemon's own launch path asks, per pane, whether this session runs inside a
        // scope. Supervision and this daemon are never wrapped — see `lib/cgroups/exemption.ts` and
        // the planner's header — and a launch with limits off is byte-for-byte what it always was.
        cgroupLaunchPlanner,
        // Resolved per launch against the store, so a rotated credential reaches the next pane with no
        // apply in between, and a missing one refuses the start naming the secret.
        accountLaunchEnvironment,
        // Attended renewal's second door: a person started this session, so the account's credential is
        // given its chance to rotate while somebody is still here to be told it could not.
        accountLaunchRenewal,
        // The pane's own media folder, `FY_MEDIA_DIR` (docs/hypermedia.md).
        sessionMedia,
        // The binary the wrappers' instructions name, so each launch records what its pane was told.
        CLIENT_NAME,
      ),
      codexAppServers,
      { text: async record => (await launchTmux.state(record.config.tmuxSession, { history: false })).visible },
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
        new RuntimeSupervisedReaper(runtime, codexAppServers, async sessionId => {
          const config = SessionConfigSchema.safeParse(await storage.readConfig(parseSessionId(sessionId)));
          return config.success ? config.data.agent : undefined;
        }),
      );
    },
    createAutoResume: (storage, resume) => {
      const service = new AutoResumeService(
        {
          ledger: new FileAutoResumeLedger(stateFiles, join(paths.home, 'auto-resume.json')),
          roster: new RepositoryAutoResumeRoster(new StorageResumeRepository(storage)),
          availability: new AccountAutoResumeAvailability(
            async id => {
              const config = SessionConfigSchema.safeParse(await storage.readConfig(parseSessionId(id)));
              return config.success ? config.data.agent : undefined;
            },
            async agent => await resolveStartAccount(accounts, agent, executables, CLIENT_NAME),
          ),
          resumer: { resume },
          journal: new StorageAutoResumeJournal(storage),
          summary: autoResumeSummary,
          setting: { enabled: async () => (await effectiveAccountModel())?.machine.autoResume ?? true },
          clock: { now: () => clock.now(), nowMs: () => Date.now() },
          sleep: async milliseconds => await Bun.sleep(milliseconds),
        },
        defaultAutoResumeSettings,
      );
      return {
        recordBootExits: async () => await service.record(bootExits?.close() ?? []),
        run: async () => await service.run(),
      };
    },
    reconcileInterruptedLaunches: async (storage, panes) =>
      await new InterruptedLaunchReconciler({
        repository: new StorageResumeRepository(storage),
        // The same gate, queue and leases a start, a revive and a stop use, so the settle can never
        // overwrite a launch this process did begin, nor interleave with a stop or a revive.
        gate: launchGate,
        panes,
        serial: sessionMutations,
        leases: conversationLeases(storage),
        clock,
      }).reconcile(),
    createSessionHealth: (storage, settings, loop) =>
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
            // Boot state is owned by `start`, through the progress it began: a daemon serving routes
            // while the rest of its boot is still running reports `bootstrapping`, which it is.
            bootstrapFinished: () => bootProgress?.finished ?? false,
            bootstrapErrors: () => [],
          }),
          // One walk of the session directories a check, handed to the consistency pass and the exit
          // observer alike — each used to take its own.
          survey: { survey: async () => await storage.surveySessionDirectories() },
          consistency: new StorageConsistencyPass(storage, stateFiles, paths, settings, activities),
          repair: new UnmountedSupervisionRepair(),
          // The same private server, registration ledger and launch gate the lifecycle and the revive
          // use, so an exit is only ever proven against a pane this daemon registered and never while
          // one of its own launches is replacing it.
          // Wrapped so a settled exit also frees the conversations that session held (account model §9.3).
          exits: recordBootExits(
            new UnwatchedPaneExits(
              new LeaseReleasingSessionExits(
                new TmuxSessionExitObserver(
                  paths.home,
                  storage,
                  new DurableTerminalPaneStore(storage, stateFiles, paths),
                  launchTmuxCommands,
                  launchGate,
                  clock,
                ),
                conversationLeases(storage),
              ),
              watchedPanes,
            ),
          ),
          events: new FileSessionHealthEventSink(stateFiles, join(paths.home, 'health-events.jsonl'), clock),
          clock,
          wallClock: { nowMs: () => Date.now() },
          monotonic: new SystemMonotonicClock(),
          loop,
          // The same ledger every timer reports into: a check runs as `self-check` and names each stage
          // inside it — `self-check › reconcile › reindex` — so a profile splits the check's time.
          activities,
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
    createSessionLaunch,
    createSessionResume,
    createUsageFeed: async config => {
      housekeepingEnabled = config.housekeeping.enabled;
      usageCollector = config.usage.url !== undefined;
      // THIS HOST'S OWN CREDENTIALS FIRST: what the account model's usage pass already read, joined to
      // each published runtime. An external collector endpoint is optional and tried behind it; a
      // daemon configured without one and with no fleet serves an empty feed and says so rather than
      // pretending every account is at zero.
      //
      // EVERY SOURCE HERE IS A READ, and that is the point of this composition. `FleetRefreshService`
      // drives this feed once at boot and again on every timer tick, with nobody present, so a source
      // that could run a command would be an arbitrary command run on a schedule on behalf of no
      // request. There used to be one, configured as argv. It is deleted, along with the field that
      // named it, rather than left unmounted behind a default.
      // The published manifest, read again only when the file-event hub says it changed (an apply, a
      // republish); while its watch is not live, every refresh reads it as before.
      const manifestReading = new WatchedDocument(paths.fleetManifest, {
        watch: (path, listener) => fileEvents.subscribe(path, () => listener()),
        load: publishedManifest,
      });
      // WATCHED, because a reader of this feed is somebody asking: a screen, the Warden, quota failover.
      // Each read lets the environment logins' provider quotas be read first, at most once a minute each;
      // the unattended refresh timer and the scrapes read its `unattended` half, which only reads the cache.
      return new WatchedUsageFeed(
        new CachedUsageFeed(
          [
            new CredentialUsageSource({
              enabled: async () => (await effectiveAccountModel())?.advanced.usage.enabled ?? true,
              manifest: async () => await manifestReading.read(),
              credentials: async () => {
                if (credentialList === undefined) throw new Error('the credentials surface is not mounted yet');
                return await credentialList();
              },
              limits: async () => (paneLimits === undefined ? new Map() : await paneLimits()),
            }),
            ...(config.usage.url === undefined ? [] : [new HttpUsageSource(config.usage.url)]),
          ],
          // The fleet's own declared probe interval. A host with no fleet configuration has not asked
          // for a cadence at all, so it keeps the default rather than being given one by a refusal.
          { refreshMs: await declaredUsageRefreshMs() },
        ),
        () => providerQuota,
      );
    },
    createPairing: async (config, pairingClock, carriers, discoveredRelayUrl) => {
      const cryptography = new NodePairingCryptography();
      const repository = new StatePairingRepository(paths, stateFiles, cryptography);
      const state = await repository.open(hostname());
      attachmentDaemonId = state.daemonId;
      analyticsMachineName = state.daemonName;
      const credentials = new PairingDeviceRegistry(state.daemonId, state.devices);
      // Read BEFORE pairing is built: the idle period and the step-up window are both asked of it.
      let pairingService: PairingService | undefined;
      const security = new SecuritySettingsService({
        document: new StateSecuritySettingsDocument(paths, stateFiles),
        audit: new JournalGrantAudit(paths.securityAudit, stateFiles, 'security.changed'),
        clock: { nowMs: () => Date.now() },
        widenCommand: `${CLIENT_NAME} daemon security set <setting> <value>`,
        devicesIdleLongerThan: days => pairingService?.devicesIdleLongerThan(days) ?? 0,
      });
      const securityNotice = await security.refresh();
      securitySettings = security;
      const securityAudit = new JournalGrantAudit(paths.securityAudit, stateFiles, 'security.changed');
      const relayCryptoForRotation = new WebCryptoRelayCrypto();
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
      // Passkeys, verified here and never by the browser (`docs/design/zero-trust.md` B2). The device
      // directory is the grant store itself, so a passkey can only ever be asked about a device that is
      // still paired, and its window is measured from the grant's own `createdAt`.
      const stepUp = new StepUpService({
        store: new StatePasskeyStore(paths, stateFiles),
        verifier: passkeyVerifier(new WebCryptoPasskeyCrypto()),
        registry: stepUpRegistry,
        audit: grantAudit,
        challenges: new ChallengeLedger(),
        random: { bytes: length => crypto.getRandomValues(new Uint8Array(length)) },
        clock: { nowMs: () => Date.now() },
        devices: {
          device: async deviceId => {
            const record = (await repository.list()).find(candidate => candidate.id === deviceId);
            return record === undefined ? undefined : { name: record.name, createdAt: record.createdAt };
          },
        },
        allowedOrigins: () => browserOrigins(config),
        relyingPartyName: 'Ferretry',
        // The name pairing gave this machine, so a passkey reads as the device and machine it binds.
        machineName: state.daemonName,
        // An added passkey is told to every enrolled browser, so the owner learns of one they did not add.
        announce: async notice => await push.notify({ payload: notice }),
        settings: () => security.current(),
        // Each device's unlock outlives a restart — an update — inside its period, bound to this identity.
        unlocks: new StateUnlockLedger(paths, stateFiles, state.daemonId),
        // A device's key, replaced inside a step-up (B6): the new key proves itself over the carrying
        // session's transcript, the grant is rewritten, the device's other sessions end as lapsed
        // leases so each reopens on the new key, and the swap is journalled.
        rotation: {
          keyIssuedAt: deviceId => pairingService?.keyIssuedAt(deviceId),
          verify: async ({ transcriptHash, deviceId, deviceKey, proof }) =>
            await verifyDeviceProof(
              relayCryptoForRotation,
              deviceKey,
              proof,
              deviceRotateMessage(transcriptHash, deviceId, deviceKey),
            ),
          rotate: async ({ deviceId, transcriptHash, deviceKey }) => {
            if (pairingService === undefined || !(await pairingService.rotateDeviceKey(deviceId, deviceKey)))
              return false;
            deviceConnections.lapseDevice(deviceId, transcriptKey(transcriptHash));
            await securityAudit.record({
              kind: 'device.key-rotated',
              actor: `device:${deviceId}`,
              changes: [`device.key-rotated=${deviceId}`],
              at: new Date().toISOString(),
            });
            return true;
          },
        },
      });
      // Every redemption, direct or relayed, recorded; a new device announced to the others.
      pairingService = new AuditedPairingService(
        {
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
          deviceState: [push, stepUp],
          // Ended AFTER the grant is gone — see `LiveDeviceConnections` for why the order matters.
          connections: deviceConnections,
          // A revocation somebody asked for lands in the owner's journal beside the grant changes.
          audit: grantAudit,
          idleExpiryDays: () => security.current().idleExpiryDays,
          idleDayMs: timings.idleDayMs,
        },
        {
          log: auditLog,
          alert: new PushNewDeviceAlert(push, state.daemonName, auditFailures),
          failures: auditFailures,
        },
      );
      // Read back before anything is served, so a device unlocked before the restart is not asked again.
      const unlockNotice = await stepUp.restore();
      return {
        credentials,
        push,
        stepUp,
        security,
        securityNotice,
        unlockNotice,
        droppedBearerGrants: state.droppedBearerGrants,
        subsystem: pairingService,
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
    terminalRuntime: new TmuxTerminalRuntime(
      tmux,
      () => Date.now(),
      // The owner's own shell, resolved once and read from the document at that moment (not captured).
      systemLoginShell(async () => (await daemonConfigStore.peek().catch(() => undefined))?.config.terminals.shell),
    ),
    agentBrowserDisplay,
    browserLauncher: new NodeSessionBrowserLauncher(
      new BrowserProfileStore(paths.home),
      browserWorkerProgram(),
      // Only the SOURCE worker needs a runtime: it runs through Node, whose WebSocket stack completes
      // Chrome's CDP upgrade where Bun 1.3's node:http shim does not. The compiled worker carries its own
      // fix (scripts/release/compile-executable.ts) and runs directly.
      Bun.which('node') ?? process.execPath,
      process.env,
      browserTransport.connectWorker,
      {
        // Read at every launch, so a switch applies the next time the browser starts. An unreadable
        // configuration launches headless rather than not at all.
        mode: async () => (await declaredAccountModel())?.machine.browserMode ?? 'headless',
        // Read at every launch too, but a proxy the owner asked for is never dropped quietly: a secret the vault
        // does not hold refuses the launch (resolveBrowserProxy) rather than sending traffic around the proxy.
        proxy: async () => {
          const setting = (await declaredAccountModel())?.machine.browserProxy;
          return setting === undefined ? undefined : resolveBrowserProxy(setting, await secretVault.values());
        },
        display: agentBrowserDisplay,
      },
    ),
    relayDirectory: new HostedRelayDirectory(environment.relayDirectoryOrigin()),
    tunnelService: new HostedTunnelService(environment.relayDirectoryOrigin()),
    cloudflared: new CloudflaredLocator(process.env),
    tunnelEntry: {
      write: async entry => await daemonConfigMutations.runExclusive(() => daemonConfigStore.writeTunnelEntry(entry)),
    },
    createTunnelCarrier: input => {
      const directoryOrigin = environment.relayDirectoryOrigin();
      return new TunnelCarrier({
        ...input,
        discoveryOrigin: directoryOrigin === undefined ? undefined : tunnelServiceOrigin(directoryOrigin),
        // THAT a tunnel is held, and where from — never its connector token, which stays in memory.
        holding: new FileTunnelHolding(join(paths.state, 'tunnel.json')),
        // The key PAIRING minted, so the fingerprint the service records is the one every device pins.
        identity: async () =>
          await readDaemonRelayIdentity(stateFiles, paths.daemonIdentity, new WebCryptoRelayIdentityKeys()),
        crypto: new WebCryptoRelayCrypto(),
        provisioner: origin => new HostedTunnelProvisioner(origin),
        // An allowlist of the daemon's environment, never all of it: see `connectorBaseEnvironment`.
        processes: new BunConnectorProcesses(connectorBaseEnvironment(process.env)),
        scheduler: {
          after: (milliseconds, action) => {
            const handle = setTimeout(action, milliseconds);
            return { cancel: () => clearTimeout(handle) };
          },
        },
        random: Math.random,
      });
    },
    webrtcEngine: new NodeDataChannelEngine(),
    probeWorkers: async () => [
      await probeBundledWorker('analytics-fold'),
      await probeBundledWorker('session'),
      await probeBundledWorker('housekeeping'),
      await probeBundledWorker('session-index'),
      await probeBundledWorker('analytics-index'),
      await probeBundledWorker('transcript-parse'),
      { name: 'pdf-decrypt', ...(await probePdfDecryptWorker()) },
    ],
    createDirectCarrier: async (dispatch, sockets, devices, pairing) => {
      const identity = await readDaemonRelayIdentity(
        stateFiles,
        paths.daemonIdentity,
        new WebCryptoRelayIdentityKeys(),
      );
      if (!identity.ok) return { refusal: identity.reason };
      const sessionDependencies = {
        crypto: new WebCryptoRelayCrypto(),
        identity: identity.identity,
        dispatch,
        sockets,
        devices,
        pairing,
        scheduler: {
          after: (milliseconds: number, action: () => void) => {
            const handle = setTimeout(action, milliseconds);
            return { cancel: () => clearTimeout(handle) };
          },
        },
        clock: { now: () => Date.now() },
        lease: timings.lease,
        connections: deviceConnections,
        // Only a session that arrived through the tunnel listener reports here (§15).
        sessionLog: tunnelSessionLog(bootNotices),
      };
      return {
        route: directCarrierSocketRoute(sessionDependencies),
        openSession: (arrival, downstream, release) =>
          new DirectSession(sessionDependencies, arrival, downstream, release),
      };
    },
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
            connections: deviceConnections,
            lease: timings.lease,
            log: line => bootNotices.state(line),
          }),
        })),
      };
    },
    browserLogin: createBrowserLoginWorld(paths, async () => await closeAgentBrowsers()),
    fileEvents,
    tmuxControl: tmux,
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
      stepUp,
      security,
      carriers,
      tunnel,
      webrtc,
      harnessDiscovery,
      browserLauncher,
      sessionWorkers,
      agendaConfig,
      delivery,
    ) => {
      // Handed to `harnessBinary` above, which cannot be given it at construction: the declaration is
      // read from the configuration this boot loaded, and the adapters are built before that happens.
      // Assigned rather than copied, so a renewal resolves `claude` through the SAME rule the boot
      // milestone and the doctor report already published — never a second detector.
      harnessPolicy = harnessDiscovery;
      // ONE durable ledger and ONE per-session queue for BOTH answer execution and monitor
      // reprojection. Observation never waits behind a live drive: that drive owns the freshest
      // state, and a later read/tick will project it after the key becomes idle. After a restart
      // there is no holder, so stranded evidence honestly becomes quarantine.
      const answerLedger = new FileAnswerLedger(
        id => createSessionPaths(paths, id).directory,
        clock,
        // Late-bound: a session's worker decides its question from the receipts, so it hears of each one.
        id => {
          void sessionObserver.answersChanged(id).catch(() => undefined);
        },
      );
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
      //
      // THE SESSION OBSERVER (docs/design/session-workers.md, stage 3a). What the turn watcher, the
      // monitor's question pass, this read path and the Warden's liveness tick each derived about a live
      // session is one pure fold now, and everything it derives is written by ONE applier through this
      // storage's locked path — the session lock, the index, the journal and its listeners unchanged. The
      // inline host runs the fold here, on the timers that already exist; a worker host replaces it in
      // stage 3b. Storage tells it every state it writes, so the 2 s turn tick no longer re-reads every
      // session's document to learn fields this daemon wrote itself.
      //
      // LATE-BOUND, the pane reader and the operator reads: both are built further down this root, and
      // nothing asks the observer anything until the daemon serves.
      const paneProcesses = new PaneProcessInventory(
        launchTmuxCommands,
        // One liveness tick asks about every working ferret in turn. Where `ps` is how the tree is read
        // (no procfs), one table answers the whole tick instead of one `ps` per ferret.
        new BunProcessProbe(Bun.which('ps') ?? undefined, { tableTtlMs: 10_000 }),
        { binaryName: CLIENT_NAME, servers: new ProjectMcpServers() },
      );
      // The ONE writer of everything the observer derives, on whichever host it runs.
      const observationApplier = new SessionObservationApplier(storage, answerLedger, new KeyedSerialExecutor());
      const observerFold = new SessionObserver(text => createHash('sha256').update(text, 'utf8').digest('hex'));
      const observerTranscripts = createTranscriptFileResolver(storage);
      const inlineObserver = new InlineObserverHost(
        {
          storage,
          questionRoster: () =>
            storage
              .listSessions()
              .filter(session => session.status === undefined || !ENDED_SESSION_STATUSES.has(session.status))
              .map(session => session.id),
          tail: createSessionTranscriptTail(storage),
          pane: async id => await turnPorts.pane(id),
          answers: answerLedger,
          // Claude's hook record of the question it is asking, which its transcript holds back until the form
          // is answered (lib/session/question/asked.ts). Bound to the transcript the resolver proves.
          asked: async id =>
            await readAskedQuestion(
              createSessionPaths(paths, id).questionAsked,
              await observerTranscripts.file(id).catch(() => undefined),
            ),
          answerSerial,
          applier: observationApplier,
          liveness: {
            screen: async id => await operatorReads.snapshot(id, true, 'screen'),
            transcript: async (id, lines) => await operatorReads.logs(id, lines),
            processes: async tmuxSession => await paneProcesses.collect(tmuxSession),
          },
          clock,
          yieldToLoop: () => new Promise(resolve => setImmediate(resolve)),
          paneState: async id => await turnPorts.paneState(id),
          sendEvidence: { read: async (id, since) => await inlineSendEvidence.read(id, since) },
          every: (intervalMs, tick) => {
            const timer = setInterval(tick, intervalMs);
            timer.unref();
            return () => clearInterval(timer);
          },
        },
        observerFold,
      );
      // ONE THREAD PER RUNNING SESSION (docs/design/session-workers.md): every running session is observed on
      // its own worker, through its own attached observe-only tmux client on the daemon's server, and only when
      // something happened; this thread still writes every patch. The inline host above observes a session
      // only while it has no worker — starting, backing off, or after its worker crashed five times.
      const unrefTimer = (delayMs: number, run: () => void): (() => void) => {
        const timer = setTimeout(run, delayMs);
        timer.unref();
        return () => clearTimeout(timer);
      };
      const sessionWorkerSupervisor = new WorkerSupervisor(
        {
          spawn: () => new LoadSafeWorker(bundledWorkerUrl('session'), { type: 'module' }),
          nowMs: () => Date.now(),
          schedule: unrefTimer,
          notice: (_session, message) => bootNotices.state(message),
          // Late-bound to the host below, which is the one writer of what a worker found.
          observed: (session, patches, transcript) => sessionObserver.observed(session, patches, transcript),
          liveness: (session, liveness) => sessionObserver.livenessChanged(session, liveness),
          changed: () => sessionObserver.poke(),
          // A pane its worker saw die (or can no longer watch) goes back to the self-check's exit pass, which
          // settles it within 30 s as it always has — or at once, only when the owner turned that on (§8 Q2).
          exited: session => {
            watchedPanes.exited(session);
            if (sessionWorkers.fastExit) void health.settleExitOf(session).catch(() => undefined);
          },
          // A worker's own children and its look time, which no instrument on this thread can see.
          report: ({ kind, lookMs, children }) => {
            if (!profilerProbe.recording) return;
            // A look the worker chose to make, or an answer it gave because this thread asked.
            profilerProbe.activity(kind === 'look' ? 'session worker look' : 'session worker answer', lookMs);
            for (const child of children) {
              const command = commandLabel(child.argv);
              profilerProbe.childStarted(command, false, 'session worker');
              profilerProbe.childExited(command, child.wallMs);
            }
          },
        },
        { ...DEFAULT_WORKER_SUPERVISOR_SETTINGS, cap: sessionWorkers.max },
      );
      // The pool as `fy daemon status` and every performance report show it.
      const sessionWorkerPool = (): SessionWorkerPool => ({
        enabled: true,
        ...sessionWorkerSupervisor.pool,
        sessionsPerThread: [...sessionWorkerSupervisor.pool.sessionsPerThread],
      });
      watchedPanes.hostedBy(id => sessionWorkerSupervisor.hosts(id as SessionId));
      const sessionObserver = new WorkerObserverHost({
        inline: inlineObserver,
        supervisor: sessionWorkerSupervisor,
        // The pane by the name the lifecycle record gives it, and the transcript the resolver proves: both
        // resolved here, so the worker never reads a document.
        binding: async id => {
          const config = jsonObject(await storage.readConfig(id).catch(() => undefined));
          const target = config?.tmuxSession;
          if (typeof target !== 'string' || !isControlAttachable(target)) return undefined;
          const file = await observerTranscripts.file(id).catch(() => undefined);
          const harness = config?.harness === 'codex' ? 'codex' : 'claude';
          return {
            tmux: { executable: tmuxExecutable, socket: tmuxSocket, target },
            ...(file === undefined ? {} : { transcript: { file, harness } }),
            ...(harness === 'claude'
              ? { questionAsked: createSessionPaths(paths, id as SessionId).questionAsked }
              : {}),
          };
        },
        applier: observationApplier,
        answerSerial,
        answers: answerLedger,
        files: fileEvents,
        observer: observerFold,
        liveness: {
          redact: async text => await secretRedactor.redact(text),
          processes: async tmuxSession => await paneProcesses.collect(tmuxSession),
        },
        clock,
        barrierMs: 3_000,
        stat: async file => {
          const info = await stat(file);
          return { size: info.size, mtimeMs: info.mtimeMs };
        },
        schedule: unrefTimer,
        activity: async work => await activities.run('turn watcher', work),
      });
      // Ordinary reads contain projection damage per session: a broken answer ledger must not take
      // the whole roster down. The monitor's pass calls the projector raw so it can report the exact
      // failing session instead of silently flattening missing evidence.
      const sessions = createSessionDirectorySubsystem(paths, storage, id =>
        sessionObserver.project(id).catch(() => undefined),
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
      // The ONE resolver for this daemon's attachment tree: the store's originals adapter and the fork's
      // copier both take it, so neither can address a directory the other never reads.
      const attachmentOriginals = (id: string): string => attachmentDirectory(paths.state, attachmentsDaemonId, id);
      const attachmentStore = new SessionAttachmentStore({
        daemonId: attachmentsDaemonId,
        originals: new FileAttachmentOriginals(attachmentOriginals),
        decrypt: decryptPdfInMemory,
        // An unlocked plaintext nobody reads again is still zeroed at its expiry, not at process exit.
        // Unref'd, so a pending eviction never holds the daemon open.
        scheduleEviction: (delayMs, evict) => {
          setTimeout(evict, delayMs).unref();
        },
      });
      // A session that is gone, or is stopped through the control route, has its plaintext zeroed.
      const sessionAttachments = sessionScopedAttachments(
        attachmentStore,
        async id => (await sessions.get(id)) !== undefined,
      );
      // ONE resume service for this opened storage, shared by the revive and the migration: its
      // executor and its launch gate are what stop two relaunches of one session racing, and a
      // second service would give each caller a private copy of both. See the revive's own header.
      const resume = createSessionResume(
        storage,
        reviver,
        createResumeAnswerAgenda(storage, answerLedger),
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
      const sendRepository = new StorageSendRepository(storage, clock);
      const sendLedger = new FileSendLedger(id => createSessionPaths(paths, id).directory, clock);
      const sendTerminal = new TmuxSendTerminal(
        launchTmux,
        // PARSED, not asserted: a send types into a real terminal, so a configuration document
        // that no longer validates must refuse rather than address whatever pane it names.
        async id =>
          SessionLifecycleConfigSchema.parse(lifecycleConfigDocument(await storage.readConfig(id))).tmuxSession,
        new TmuxPaneDelivery(launchTmux, milliseconds => Bun.sleep(milliseconds)),
        new TmuxPaneQueue(launchTmux, milliseconds => Bun.sleep(milliseconds)),
        milliseconds => Bun.sleep(milliseconds),
      );
      const sendTranscripts = createTranscriptReader(storage);
      /**
       * Where each send WENT. Built before the send service, which tells it about every transport, and
       * handed the service back through two late-bound ports — a re-attempt and a failure notice are
       * both sends — so neither needs the other at construction.
       */
      const inlineSendEvidence = new TranscriptSendEvidence(async sessionId => {
        const id = tryParseSessionId(sessionId);
        if (id === undefined) return undefined;
        const config = SessionConfigSchema.safeParse(await storage.readConfig(id).catch(() => undefined));
        return config.success ? { sessionId, harness: config.data.harness } : undefined;
      }, sendTranscripts);
      // One queue for the tracker's looks AND the re-proof's corrections, so the two never write one ledger at once.
      const sendTrackerSerial = new KeyedSerialExecutor();
      const sendEvidence: SendEvidenceSource = {
        // A running session's worker reads its own transcript; the rest are read here, as before.
        read: async (id, since) => await sessionObserver.sendEvidence(id, since),
      };
      const sendTracker = new SendTracker(
        {
          ledger: sendLedger,
          evidence: sendEvidence,
          terminal: sendTerminal,
          repository: sendRepository,
          attempts: {
            reattempt: async (id, sendId) => await sends.reattempt(id, sendId, { by: 'daemon' }),
            resubmit: async (id, sendId) => await sends.resubmit(id, sendId),
          },
          notifier: {
            notify: async (sender, recipient, record) => await sendNotices.notify(sender, recipient, record),
          },
          scheduler: new TimerSendScheduler(),
          roster: { sessions: () => storage.listSessions().map(session => session.id) },
          serial: sendTrackerSerial,
          clock,
        },
        defaultSendTrackerSettings,
      );
      // The old "not delivered" rows, re-proved once against each recipient's transcript (lib/session/send/reproof.ts).
      const sendReproof = new LegacySendReproof({
        ledger: sendLedger,
        evidence: sendEvidence,
        repository: sendRepository,
        roster: { sessions: () => storage.listSessions().map(session => session.id) },
        serial: sendTrackerSerial,
        clock,
        marker: new FileSendReproofMarker(join(paths.home, 'send-reproof-migration.json')),
        pause: async () => await new Promise<void>(resolve => setTimeout(resolve, 0)),
        log: line => process.stderr.write(`${line}\n`),
      });
      const sendTurns = new FileSendTurnStore(resumeTurns, id => createSessionPaths(paths, id).directory);
      const sends: SessionSendService = new SessionSendService(
        {
          repository: sendRepository,
          ledger: sendLedger,
          terminal: sendTerminal,
          turns: sendTurns,
          channel: new AutoTitlingSendChannel(
            new FileSendChannel(id => createSessionPaths(paths, id).directory),
            storage,
          ),
          gate: launchGate,
          reviver: new ResumeSendReviver(resume),
          peerWaits: signals,
          // Its own queue: a send holds its lock across proving a prompt landed, and must not make
          // every unrelated document write in the process wait behind a live terminal.
          serial: new KeyedSerialExecutor(),
          clock,
          tracking: sendTracker,
        },
        // The receiving agent is told the CLI a human types, not this daemon — `fyd send` is not a
        // command, exactly as the harness quirk service already reasons about `fyd resume`.
        { ...defaultSessionSendSettings, clientName: CLIENT_NAME },
      );
      const sendNotices = new AgentSendFailureNotifier(sends, sendRepository, CLIENT_NAME);
      /**
       * The durable message queue (docs/message-delivery.md § The durable queue) and its one deliverer.
       * The queue's lock is shared by everything that changes it — an edit must not land on a message the
       * deliverer has just started typing — and is never the send path's, which the hand-over takes.
       * The deliverer looks at a session when its state document changes, and once at boot for whatever a
       * restart left open; a session with nothing open costs nothing.
       */
      const queueSerial = new KeyedSerialExecutor();
      const queueStore = new FileSessionQueueStore(id => createSessionPaths(paths, id).directory);
      const sessionQueue = new SessionQueueService({ store: queueStore, clock, serial: queueSerial });
      const deliveryView = new SendPathDeliveryView(sendRepository, sendTerminal, launchGate);
      const queueDeliverer = new QueueDeliverer({
        store: queueStore,
        serial: queueSerial,
        clock,
        scheduler: new TimerSendScheduler(),
        view: async id => await deliveryView.view(id),
        transport: new SendPathQueueTransport(sends, sendLedger),
        sessions: () => storage.listSessions().map(session => session.id),
        sleep: async milliseconds => await Bun.sleep(milliseconds),
      });
      storage.subscribeStates(id => void queueDeliverer.changed(id).catch(() => undefined));
      /**
       * What every producer inside this daemon sends through: with the queue on, its message is enqueued and
       * the deliverer types it — the Warden, the board, the declared-wait watcher as the daemon's, the owner's
       * agenda answers as the owner's. Off, the direct send path, as before. The deliverer itself, a revive's
       * release and the send route keep the direct path: each IS a step of delivery, not a producer.
       */
      const queueingPorts = {
        queue: sessionQueue,
        deliverer: queueDeliverer,
        direct: sends,
        target: async (id: SessionId) => await sendRepository.read(id),
        ledger: sendLedger,
        clock,
        sleep: async (milliseconds: number) => await Bun.sleep(milliseconds),
      };
      // One front per producer, so the app can say which part of Ferretry a message came from — as a sender
      // chip, never as text in the message.
      const producerSends = (feature: string) =>
        delivery.queue ? new QueueingSends(queueingPorts, 'daemon', feature) : sends;
      const boardSends = producerSends('Board');
      const agendaNudgeSends = producerSends('Agenda');
      const boardOwnerSends = delivery.queue ? new QueueingSends(queueingPorts, 'human', 'Board') : sends;
      const answerSends = delivery.queue ? new QueueingSends(queueingPorts, 'human', 'Agenda') : sends;
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
          nudge: new SendMonitorNudge(producerSends('Monitor')),
          // The session observer's question part over every live session, one at a time — see
          // `InlineObserverHost.questions` for why it hands the loop back between them.
          questions: { reconcile: async () => await sessionObserver.questions() },
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
      // The board's projects and their lanes (U3), built before the board that reads them. A proposal is raised
      // on the proposing ferret's agenda, and the owner's Accept confirms it (in the agenda's change fanout).
      // The agenda and the board are read lazily: both are built after this.
      const laneSets = new LaneSetService(
        new FileLaneSetStore(join(paths.home, 'board', 'lanes')),
        { projects: async () => await catalogs.projects() },
        new SessionProjects(
          new StorageSessionFacts(storage),
          { projects: async () => await catalogs.projects() },
          new GitRepositoryProbe(),
          [...COMMON_SCRATCH_ROOTS, tmpdir()],
        ),
        new AgendaLaneAgenda({ raise: async (...parameters) => await agenda.raise(...parameters) }),
        // A lane edit that removed lanes moves their cards to the lanes it named, in the board store.
        {
          relocate: async (projectId, moves, reason) => {
            await boardWorld.board.relocate(projectId, moves, reason);
          },
        },
      );
      // BEFORE session control and Pack, which make a card with every start that has a brief. The agenda link
      // reads the agenda service lazily: it is built further down, and a board is only read once requests flow.
      // "Last touched" is judged from the session roster with the Warden's liveness ledger laid over it; the
      // ledger is published when the Warden builds its monitor, further down, and reads nothing until then.
      const wardenLedgers: { read: LivenessLedgerReader } = { read: () => undefined };
      const boardSessions = new StorageSessionRoster(storage, sessionId => wardenLedgers.read(sessionId));
      const boardWorld = createBoardWorld(
        paths,
        stateFiles,
        storage,
        clock,
        () => attachmentDaemonId,
        laneSets,
        boardSends,
        boardOwnerSends,
        async sessionId => {
          const listed = await agenda.list(sessionId);
          if (!listed.ok) throw new Error(listed.error.message);
          return listed.value.items;
        },
        CLIENT_NAME,
        boardSessions,
        { register: async request => await catalogs.registerProject(request) },
        async () => (await daemonConfigStore.peek().catch(() => undefined))?.config.projectRoots ?? [],
        userHome,
        new StoreBoardAttachments(attachmentStore),
      );
      // The GitHub watcher that moves the board's cards on PR facts (board-design.md §3.1): it runs the host's
      // own `gh`, links the PRs a card's work opened, and nudges through the board's nudge path. Armed after
      // the bind with the other loops, and stopped with the daemon.
      const boardSessionFacts = new StorageSessionFacts(storage);
      const boardSubFerrets = new StorageSubFerretDirectory(storage);
      const boardCopies = new GitWorkingCopies();
      // The Unfiled board's cards that belong on a project's board are refiled there: by a linked PR's repository,
      // else by the folder the card's ferret works in (registering its repository by `ProjectAdoption`'s rules).
      // ONE instance, so the watcher's tick and the boot run never overlap.
      const unfiledRefiler = new UnfiledRefiler({
        board: boardWorld.board,
        sessions: new SessionBoardResolver(
          boardSessionFacts,
          new SessionProjects(
            boardSessionFacts,
            { projects: async () => await catalogs.projects() },
            new GitRepositoryProbe(),
            [...COMMON_SCRATCH_ROOTS, tmpdir()],
          ),
          boardWorld.adoption,
        ),
        projects: { projects: async () => await catalogs.projects() },
        copies: boardCopies,
        clock: { now: () => clock.now() },
        diagnostics: boardDiagnostics,
      });
      const boardGitHub = new GitHubWatcher({
        board: boardWorld.board,
        gh: new GhCliRunner(),
        copies: boardCopies,
        sessions: { cwdOf: async sessionId => (await boardSessionFacts.read(sessionId))?.cwd ?? null },
        projects: { projects: async () => await catalogs.projects() },
        transcripts: createSessionTranscriptTail(storage),
        // The board's nudge path (U5): the message as it is, from "Ferretry · Board" as metadata.
        nudges: {
          send: async (card, message) => {
            const sessionId = await nudgeTarget(boardSubFerrets, card);
            await boardSends.send({ id: parseSessionId(sessionId), sendId: crypto.randomUUID(), message });
          },
        },
        timers: {
          after: (ms, run) => {
            const handle = setTimeout(asActivity(activities, 'board github watch', run), ms);
            return () => clearTimeout(handle);
          },
        },
        clock: { now: () => clock.now(), random: () => Math.random() },
        diagnostics: boardDiagnostics,
        unfiled: unfiledRefiler,
        version: daemonVersion,
      });
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
      // A stopped session's browser pages close, and its incognito contexts are discarded. Assigned once
      // the browser service below exists; a stop before then has no pages to close.
      let releaseBrowserSession: (sessionId: string) => Promise<void> = async () => undefined;
      // A new ferret's passive-learning default, assigned once the learning subsystem below exists.
      let adoptLearning: (sessionId: SessionId) => Promise<void> = async () => undefined;
      // A new ferret's agenda-mode default (docs/agenda.md), assigned once the agenda switch below exists.
      let adoptAgenda: (sessionId: SessionId, eligible: boolean) => Promise<void> = async () => undefined;
      // Pack mode (docs/pack-mode.md): the load in effect, which the watcher replaces the moment a file changes
      // and a write through the daemon replaces before it answers — so a saved pack.yaml applies to the next
      // start. Never a load of its own: every running ferret's view builds a relaunch environment, which reads
      // this, and a load rescans and reparses the whole configuration tree.
      const packConfig = async (): Promise<PackConfig> => (await configFiles.inEffect()).evaluation.effective.pack;
      const packTree = createPackTree(sessions);
      // The routing line comes from Pack's service, composed further down; until then a launch carries none.
      let packRouting = async (): Promise<string | undefined> => undefined;
      const packHooks = createSessionPackHooks(
        packTree,
        sessions,
        sessionEnvironments,
        sessionMutations,
        packConfig,
        async () => await packRouting(),
      );
      launchSwitchDefaults = async id => ({
        ...(await packHooks.launchDefault(id)),
        ...(await agendaLaunchDefault(sessions, id)),
      });
      // A start records Pack mode's switch and the machine's agenda default on the new ferret before its first launch.
      const startHooks: SessionPackHooks = {
        ...packHooks,
        adopt: async (id, eligible, parent) => {
          await packHooks.adopt(id, eligible, parent);
          await adoptAgenda(id, eligible).catch(() => undefined);
        },
      };
      // ONE claim surface over the ledger for the start and the rename, so both take names through the
      // same allocator and the same file.
      const nameClaims = createCallsignClaims(storage, stateFiles, paths, callsignClaims);
      // System sessions (the Learning miner, Pack clean-up) take ids of their own, never a pool name.
      const systemCallsigns = new SystemCallsignIssuer({
        counters: new FileSystemCallsignCounters(join(paths.state, 'system-callsigns.json'), stateFiles),
        held: async () => (await liveCallsigns(storage)).map(claim => claim.callsign),
        serial: callsignClaims,
      });
      const sessionControl = releasingAttachmentsOnStop(
        releasingAttachmentsOnStop(
          createSessionControlSubsystem(
            storage,
            sessions,
            createSessionLifecycle,
            planner,
            launcher,
            accounts,
            executables,
            sessionIds,
            nameClaims,
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
            transcriptProvenance,
            new NodeWorkingDirectoryResolver(),
            id => createSessionPaths(paths, id).directory,
            sessionRuntime,
            // The stamper the world already constructed, now actually called. Before this it was a field
            // nothing dereferenced: a shield the fork wrote and no ordinary start ever did.
            spawnProvenance,
            clock,
            async () => {
              const model = await declaredAccountModel();
              return model === undefined ? undefined : resolveDefaultRuntime(model);
            },
            async id => await adoptLearning(id),
            id => handoffFolders(createSessionPaths(paths, id).directory, attachmentOriginals(id)),
            async (executable, harness) => await launchSettings.digest(executable, harness),
            startHooks,
            {
              fixedSettings: async (executable, harness) => await launchSettings.fixedSettings(executable, harness),
              codexChoices: async (executable, cwd) => await codexRuntimeModels.get(executable, cwd),
            },
            boardWorld.cards,
          ),
          attachmentStore,
        ),
        {
          releaseSession: sessionId => {
            void releaseBrowserSession(sessionId).catch(() => undefined);
          },
        },
      );
      /**
       * The owner's existing conversations, found in Ferretry's shared history FIRST (where every
       * runtime already sees them, and what Continue lists) and then in the CLI's own home on this
       * computer, as the daemon inherited it (which only importing lists). Read through the same
       * parsers managed sessions use; adopted through the same start machinery. A transcript's hand-off
       * pointer is read back only from a session's own folder, or as an agent coordinator's turn file
       * (`~/.<coordinator>/<agent>/turns/turn-NNN.md`, kteam's layout).
       */
      const conversationFiles = new NodeConversationFiles();
      const conversationImport = new ConversationImportService(
        conversationFiles,
        [
          { harness: 'claude', home: sharedHistoryPoolDirectory(paths.fleet, 'claude'), source: 'ferretry' },
          { harness: 'codex', home: sharedHistoryPoolDirectory(paths.fleet, 'codex'), source: 'ferretry' },
          ...computerConversationRoots({
            claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
            codexHome: process.env.CODEX_HOME,
            userHome,
          }),
        ],
        // Read and described on the transcript worker, which was told the same hand-off scope.
        new WorkerConversationDescriber(
          transcriptParseWorker,
          new FileConversationDescriber(conversationFiles, pacedTranscriptParsers, conversationHandoffScope),
        ),
        new StorageConversationOwners(storage),
        createConversationAdopter(
          storage,
          sessions,
          createSessionLifecycle,
          planner,
          launcher,
          accounts,
          executables,
          sessionIds,
          nameClaims,
          transcriptProvenance,
          new NodeWorkingDirectoryResolver(),
          spawnProvenance,
          clock,
          // An adopted conversation is a top-level ferret: told about Pack mode like any other new one.
          async id => {
            await packHooks.adopt(id, true, undefined).catch(() => undefined);
            await adoptAgenda(id, true).catch(() => undefined);
            await adoptLearning(id);
          },
          id => handoffFolders(createSessionPaths(paths, id).directory, attachmentOriginals(id)),
          new NodeConversationLinker(),
        ),
        new AccountModelConversationListPolicy(declaredAccountModel),
      );
      const wardenPaths = createWardenPaths(paths.home);
      const notifications = new NotificationService({
        ledger: new FileNotificationDeliveryLedger(paths, stateFiles),
        sessions: {
          describe: async id => {
            const view = await sessions.get(id);
            return view === undefined
              ? undefined
              : {
                  name: agentSpokenName(view.config),
                  title: view.config.name,
                  interactive: view.config.mode === 'interactive',
                };
          },
        },
        push,
        serial: new KeyedSerialExecutor(),
        clock,
      });
      // ONE agenda service for this opened store, shared by the route a person answers on and by
      // the warden sweep that raises and clears its own escalations. Two would each hold their own
      // idea of what a session is waiting for.
      // The ledger repository is handed raw ids from the transport, so the id is parsed here rather than
      // asserted: an id the layout would not accept must never become a directory path.
      // The agenda files move to their agenda names in the background, and the repositories below hold every read
      // and write until it settles, so no write can land between the migration's read and its copy. Total: it never
      // rejects, and a failed session keeps its old file (still read) and is tried again next start.
      const agendaFilesMigrated = migrateAgendaFiles(
        storage.listSessions().map(session => session.id),
        {
          marker: new FileAgendaFilesMigrationMarker(join(paths.home, 'agenda-files-migration.json')),
          files: new FileAgendaFileStore(id => createSessionPaths(paths, parseSessionId(id)).directory),
          now: () => new Date(clock.now()).toISOString(),
          log: line => process.stderr.write(`${line}\n`),
        },
      );
      const agendaBoards = new FileAgendaLedgerRepository(
        id => createSessionPaths(paths, parseSessionId(id)).directory,
        undefined,
        agendaFilesMigrated,
      );
      // Released and To test are one lane now: every stored set that still has both is folded into one at boot,
      // its cards moved with it, and the owner is asked nothing. A `quick` set from before To test gains it the same
      // way. Then the Unfiled cards that belong on a project's board are refiled there (`UnfiledRefiler`), so a
      // card stuck since before projects registered themselves moves without waiting for the watcher. Each step is
      // idempotent, so every boot runs them, once the boot has settled and before the import below.
      unrefTimer(1000, () => {
        void laneSets
          .mergeReleaseLanes()
          .then(outcomes => {
            for (const outcome of outcomes) {
              process.stderr.write(
                outcome.merged
                  ? `board lanes: ${outcome.projectId} Released and To test merged (version ${String(outcome.version)})\n`
                  : `board lanes: ${outcome.projectId} could not merge Released and To test: ${outcome.problem}\n`,
              );
            }
          })
          .then(async () => await laneSets.addQuickToTestLanes())
          .then(outcomes => {
            for (const outcome of outcomes) {
              process.stderr.write(
                outcome.added
                  ? `board lanes: ${outcome.projectId} quick lanes gained To test (version ${String(outcome.version)})\n`
                  : `board lanes: ${outcome.projectId} could not add To test to its quick lanes: ${outcome.problem}\n`,
              );
            }
          })
          .then(async () => await unfiledRefiler.run())
          .catch(() => undefined);
      });
      // The one-time import of the old per-session task files onto the project boards. It shares the board's
      // store with the board service (one id counter), proposes lanes through the lane service above, and
      // points the open agenda items at their cards. Total: a bad file is reported, never a failed start.
      const boardImporter = new BoardImporter({
        tasks: new FileLegacyTaskSource(
          () => storage.listSessions().map(session => session.id),
          id => join(createSessionPaths(paths, parseSessionId(id)).directory, 'tasks.json'),
        ),
        store: boardWorld.store,
        projects: new LaneSetImportProjects(laneSets, new GitProjectFacts()),
        sessions: new StorageImportSessions(
          () => storage.listSessions().map(session => session.id),
          async () => await assigneeCandidates(storage),
        ),
        agenda: new AgendaImportAgenda(agendaBoards, () => new Date(clock.now()).toISOString()),
        marker: new FileBoardImportMarker(join(paths.home, 'board-import.json')),
        clock: { now: () => new Date(clock.now()).toISOString() },
        machineId: () => attachmentDaemonId,
      });
      unrefTimer(2000, () => {
        void boardImporter
          .run()
          .then(summary => {
            if (summary.skipped) return;
            const said = `board import: ${summary.imported} imported, ${summary.alreadyImported} already there, ${summary.linkedAsks} asks linked, ${summary.problems.length} problems`;
            process.stderr.write(`${said}\n`);
            for (const problem of summary.problems) {
              process.stderr.write(
                `board import: ${problem.sessionId ?? '-'} ${problem.taskId ?? ''} ${problem.detail}\n`,
              );
            }
          })
          .catch(() => undefined);
      });
      // Each ferret's held answers (docs/agenda.md § Delivery). The send is awaited by the batcher, outside
      // its per-session lock: it may wait for a launch or revive a stopped ferret, and the owner's next answer
      // must not wait on that. The send ledger keeps one message per batch send id, and is the one witness of
      // whether it arrived; an answer that did not is reopened on the board, built just below (read lazily).
      const agendaReplies = new AgendaReplyBatcher(
        new FileAgendaOutboxRepository(
          id => createSessionPaths(paths, parseSessionId(id)).directory,
          undefined,
          agendaFilesMigrated,
        ),
        new SendAgendaMessenger(answerSends),
        new KeyedAgendaReplyTimers(),
        new KeyedSerialExecutor(),
        { now: () => clock.now() },
        // With the queue on, an answer is not held for a batch, a working ferret or a draft: the queue orders
        // it, holds it for a draft and types it into an empty box mid-turn (&C38). Its receipt and reopen
        // still come from here.
        {
          settleMs: delivery.queue ? 0 : agendaConfig.replySettleSeconds * 1_000,
          capMs: delivery.queue ? 0 : agendaConfig.replyMaxWaitSeconds * 1_000,
          composerWaitMs: agendaConfig.replyComposerWaitSeconds * 1_000,
          receiptMs: agendaConfig.replyReceiptSeconds * 1_000,
        },
        // A batch that falls due while the ferret is mid-turn waits for the turn to end. Unreadable state
        // is not busy, so a damaged document never holds an answer.
        {
          busy: async sessionId => {
            if (delivery.queue) return false;
            const id = tryParseSessionId(sessionId);
            if (id === undefined) return false;
            const state = SessionStateSchema.safeParse(await storage.readState(id));
            return state.success && state.data.turnState === 'working';
          },
        },
        {
          composer: delivery.queue ? { state: async () => 'empty' as const } : new PaneAgendaComposer(sendTerminal),
          receipts: new LedgerAgendaReceipts(sendLedger),
          undelivered: new AgendaBoardUndelivered({
            undelivered: async (...parameters) => await agenda.undelivered(...parameters),
          }),
        },
      );
      // Answers held across a restart are delivered, in the background, once the daemon is up.
      void agendaReplies.resume(storage.listSessions().map(session => session.id)).catch(() => undefined);
      const agendaModes = new SessionConfigAgendaModes(sessions);
      const sessionStops = new StorageSessionStops(storage);
      const agendaProjection = new SessionAgendaProjection(
        agendaBoards,
        new StorageSessionAgendaState(storage),
        new KeyedSerialExecutor(),
        () => clock.now(),
        agendaModes,
        sessionStops,
      );
      // THE PHONE BUZZES ONLY when a ferret stops on the owner, when an item's deadline is near, or for a
      // notice with `ping` (docs/notifications.md); everything else only moves the Inbox badge.
      const agendaBuzz = new AgendaBuzz(
        agendaBoards,
        sessionStops,
        notifications,
        clock,
        agendaConfig.deadlineWarnHours,
      );
      // Boards that moved before summaries were kept (or while this daemon was down) are caught up once,
      // in the background: a list served before it finishes is only missing an unread mark.
      void agendaProjection.reconcile(storage.listSessions().map(session => session.id)).catch(() => undefined);
      // Hoisted so a board answer to a harness question is typed into the form by the SAME path the
      // Console's answer takes: one coordinator, one receipt ledger, one driver.
      const sessionAnswer = createSessionAnswerSubsystem(
        storage,
        sessions,
        launchTmux,
        clock,
        answerLedger,
        answerSerial,
        lastSnapshots,
      );
      const harnessAnswerDelivery = new HarnessPromptAnswerDelivery(
        new StorageHarnessQuestionAnswerer(storage, sessionAnswer),
        new StorageHarnessPromptJournal(storage),
        // Read lazily: the service is built just below, and this is only called after it commits.
        { raise: async (...parameters) => await agenda.raise(...parameters) },
      );
      const agenda = new AgendaService(
        agendaBoards,
        clock,
        {
          // A missing agenda.json is an empty board only for a session the
          // registry can prove exists. Session document damage propagates
          // rather than being flattened into "no attention".
          has: async id => (await sessions.get(id)) !== undefined,
        },
        agendaBuzz,
        new AgendaChangeFanout([
          // The session list's unread signal, kept true to the board.
          agendaProjection,
          // The owner's Accept on a lane proposal confirms those lanes; any other answer is ignored.
          new LaneProposalAcceptance(laneSets),
          // The owner's answer, told to the ferret that asked — through its outbox, which holds a burst of
          // answers for a few seconds and delivers them as ONE message.
          new AgendaReplyDelivery(agendaReplies, CLIENT_NAME),
          // A board that now leaves an idle ferret stopped on the owner, or an item whose deadline is near.
          agendaBuzz,
          // The owner's answer to a harness question, typed into its form. DETACHED: a drive watches the
          // pane for seconds, and the answer is already on the board.
          {
            changed: async (sessionId, change) => {
              void harnessAnswerDelivery.changed(sessionId, change).catch(() => undefined);
            },
          },
        ]),
        // An add that names no card belongs to the raising session's focus card (board-design.md §2.6) —
        // the CLI's, a harness question's and a Warden escalation's alike.
        new StorageSessionFocus(storage),
        new StorageSubFerretDirectory(storage),
      );
      // Off unless `attention.resurfaceAfterMinutes` is set: asks left in discussion that long surface themselves.
      if (agendaConfig.resurfaceAfterMinutes !== undefined) {
        new AgendaResurfacer(
          agendaBoards,
          agenda,
          () => storage.listSessions().map(session => session.id),
          new KeyedAgendaReplyTimers(),
          () => clock.now(),
          agendaConfig.resurfaceAfterMinutes,
        ).start();
      }
      // Always on: a snoozed item wakes when its time (or its deadline) comes, fresh on the owner's queue.
      new AgendaWaker(
        agendaBoards,
        agenda,
        () => storage.listSessions().map(session => session.id),
        new KeyedAgendaReplyTimers(),
        () => clock.now(),
      ).start();
      // A ferret that goes idle with an agenda item on the owner is STOPPED on them: pushed once for that stop,
      // and its summary says so. Learned from the fleet as it stands first, so a daemon that starts announces nobody.
      const turnChanges = new TurnChanges();
      armSessionTurnChanges(storage, turnChanges, async sessionId => {
        await agendaProjection.refresh(sessionId);
        await agendaBuzz.turnChanged(sessionId);
      });
      // An item whose `neededBy` is within `attention.deadlineWarnHours` is pushed once; the sweep finds the ones
      // whose time came while nothing else touched their board.
      const sweepDeadlines = asActivity(activities, 'agenda-deadlines', async () => {
        await agendaBuzz.sweep(storage.listSessions().map(session => session.id));
      });
      setInterval(sweepDeadlines, AGENDA_DEADLINE_SWEEP_MS).unref();
      setTimeout(sweepDeadlines, 30_000).unref();
      // The board's own sweep (`lib/board/sweep.ts`): each minute a stale card's ferret is nudged, and a dependent
      // card's assignee told it can go ahead, through the ordinary send path. Nobody is sent board news.
      const boardSweep = new BoardSweep({
        board: boardWorld.board,
        sessions: boardSessions,
        memory: new FileSweepMemory(join(paths.state, 'board'), stateFiles, boardDiagnostics),
        nudges: {
          send: async (card, message) => {
            await boardSends.send({
              id: parseSessionId(await nudgeTarget(boardSubFerrets, card)),
              sendId: crypto.randomUUID(),
              message,
            });
          },
        },
        clock,
        diagnostics: boardDiagnostics,
      });
      setInterval(
        asActivity(activities, 'board sweep', async () => await boardSweep.tick()),
        BOARD_SWEEP_INTERVAL_MS,
      ).unref();
      // Agenda mode: the switch (the session document and its launch variable, written together like Pack's and
      // hypermedia's) and the one-time migration that turns it on for every ferret that already had open items —
      // they ARE its agenda.
      const writeAgendaMode = async (reference: string, enabled: boolean, at: string): Promise<void> => {
        const id = parseSessionId(reference);
        await sessionMutations.run(`session:${id}`, async () => {
          await storage.updateConfig(id, current => ({
            ...(jsonObject(current) ?? {}),
            agenda: enabled,
            updatedAt: at,
          }));
          await sessionEnvironments.write(id, {
            ...(await sessionEnvironments.read(id)),
            [AGENDA_ENV]: enabled ? '1' : '0',
          });
        });
        await agendaProjection.refresh(id);
      };
      adoptAgenda = async (id, eligible) => {
        await adoptAgendaDefault(
          {
            machineDefault: async () => (await effectiveAccountModel())?.machine.agendaMode ?? true,
            recorded: async sessionId => {
              const recordedId = tryParseSessionId(sessionId);
              return recordedId === undefined ? undefined : (await sessions.get(recordedId))?.config.agenda;
            },
            enable: async sessionId => await writeAgendaMode(sessionId, true, new Date(clock.now()).toISOString()),
          },
          id,
          eligible,
        );
      };
      const agendaModeService = new SessionAgendaModeService({
        facts: async reference => {
          const id = tryParseSessionId(reference);
          const view = id === undefined ? undefined : await sessions.get(id);
          return view === undefined
            ? undefined
            : {
                enabled: sessionAgendaEnabled(view.config),
                running: !HYPERMEDIA_NOT_RUNNING.has(view.state.status),
              };
        },
        write: writeAgendaMode,
        now: () => new Date(clock.now()).toISOString(),
      });
      const sessionAgendaMode: SessionAgendaModeSubsystem = {
        get: async reference => await agendaModeService.get(reference),
        set: async (reference, enabled) => {
          const outcome = await agendaModeService.set(reference, enabled);
          const view = await sessions.get(parseSessionId(reference));
          if (view === undefined)
            throw new Error(`session ${reference} was switched but its documents do not satisfy the protocol`);
          return { view, outcome };
        },
      };
      void migrateToAgendaMode(
        storage.listSessions().map(session => session.id),
        {
          marker: new FileAgendaMigrationMarker(join(paths.home, 'agenda-mode-migration.json')),
          boards: agendaBoards,
          modes: {
            enabled: async sessionId => await agendaModes.enabled(sessionId),
            enable: async sessionId => await writeAgendaMode(sessionId, true, new Date(clock.now()).toISOString()),
          },
          now: () => clock.now(),
        },
      );
      // A harness parked on its own prompt waits on the owner, so it is an item on the board, raised and
      // cleared from the state documents storage writes — and caught up once at start, in the background.
      const harnessPrompts = new HarnessPromptAgenda(
        agenda,
        new KeyedSerialExecutor(),
        new StorageHarnessPromptStates(storage),
      );
      storage.subscribeStates((id, state) => void harnessPrompts.stateWritten(id, state));
      void harnessPrompts.reconcile(storage.listSessions().map(session => session.id)).catch(() => undefined);
      // The turn-end check (docs/agenda.md, nudge-once): a reply that asks the owner to act,
      // from a turn that raised no item for it, gets one nudge. Read after the transcript has settled, since
      // the turn's end can be seen on the pane before its last words reach the file; a listener must never
      // throw into the journal's append path, and a check that cannot read says nothing.
      const nudgeSessions = new StorageAgendaNudgeSessions(storage, {
        read: async sessionId => await agendaModes.enabled(sessionId),
      });
      const attentionNudge = new AgendaTurnNudge(
        {
          enabled: async () => agendaNudgeEnabled((await effectiveAccountModel())?.machine ?? { attentionNudge: true }),
          subject: async sessionId => await nudgeSessions.subject(sessionId),
          tail: async (sessionId, limit) => {
            const subject = await nudgeSessions.subject(sessionId);
            return subject === undefined
              ? []
              : await sendTranscripts.tail({ sessionId, harness: subject.harness }, limit);
          },
          send: async (sessionId, sendId, message) => {
            const id = tryParseSessionId(sessionId);
            if (id !== undefined) await agendaNudgeSends.send({ id, sendId, message });
          },
          record: async (sessionId, asks) => await nudgeSessions.record(sessionId, asks),
        },
        CLIENT_NAME,
      );
      armAgendaNudge(storage, attentionNudge, AGENDA_NUDGE_SETTLE_MS, (run, delayMs) => {
        setTimeout(run, delayMs).unref();
      });
      // The board's turn-end check (board-design.md §3.4): a turn that edited, committed, pushed, started a
      // sub-ferret or opened a PR while the session had no open card gets one nudge an hour. Armed on the same
      // settled turn end as the agenda check, through the same one-check-per-session listener.
      const boardFocus = new StorageSessionFocus(storage);
      const boardChecks = new JournalBoardChecks(storage);
      const boardTurnCheck = new BoardTurnCheck(
        {
          // A sub-ferret's card is made for it and its lead moves it: it has no card to be nudged about.
          readable: async sessionId =>
            (await nudgeSessions.subject(sessionId)) !== undefined && !(await isSubFerret(boardSubFerrets, sessionId)),
          tail: async (sessionId, limit) => {
            const subject = await nudgeSessions.subject(sessionId);
            return subject === undefined
              ? []
              : await sendTranscripts.tail({ sessionId, harness: subject.harness }, limit);
          },
          focus: boardFocus,
          card: async ref => await boardWorld.board.task(ref.id),
          send: async (sessionId, sendId, message) => {
            const id = tryParseSessionId(sessionId);
            if (id !== undefined) await boardSends.send({ id, sendId, message });
          },
          record: async (sessionId, seen) => await boardChecks.record(sessionId, seen),
          now: () => Date.parse(clock.now()),
        },
        CLIENT_NAME,
      );
      armAgendaNudge(storage, boardTurnCheck, AGENDA_NUDGE_SETTLE_MS, (run, delayMs) => {
        setTimeout(run, delayMs).unref();
      });
      // ONE ingestion service for this opened store, shared by the loop that writes rows and the route
      // that reads them. Two would each hold their own account of whether a pass is in flight, and the
      // read would report `refreshing: false` while the loop was mid-pass.
      // The model catalogs in effect, for their list prices. Read lazily: the catalog service is built
      // below, and nothing prices a session before the subsystems mount.
      const pricedModelCatalogs = async () => await modelCatalogService.catalogs();
      // Read and folded on a worker thread: the event loop only resolves which file to read. Held here
      // so a performance profile can sample how many folds the thread holds.
      const transcriptFolds = new WorkerTranscriptFolds(
        (
          resolver => async (sessionId: string) =>
            await resolver.file(sessionId)
        )(createTranscriptFileResolver(storage)),
      );
      const analyticsIngestion = createAnalyticsIngestion(
        storage,
        analyticsStore,
        daemonConfigStore,
        pricedModelCatalogs,
        createAnalyticsTranscriptEvidence(storage),
        transcriptFolds,
        clock,
        activities,
      );
      // A session that ends — or a revived one the index still holds — is what moves analytics, and
      // storage says so as it writes (docs/design/housekeeping-worker.md §4 PR 4). For as long as the
      // storage is open: closing it drops every listener, this one included.
      storage.subscribeStates((id, state) => analyticsIngestion.stateWritten(id, state));
      const analyticsPricing = new AnalyticsPricingService(
        // The operator's rates: a write through here re-prices what it moved at the next pass.
        {
          readPricing: async () => await daemonConfigStore.readPricing(),
          writePricing: async input => {
            const written = await daemonConfigStore.writePricing(input);
            analyticsIngestion.pricingChanged();
            return written;
          },
        },
        new HttpAnalyticsPricingFeed(),
        daemonConfigMutations,
        clock,
        { next: () => crypto.randomUUID() },
        { modelCatalogRates: async () => modelCatalogPricingRates(await pricedModelCatalogs()) },
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
        conversationFiles: new FileConversationFiles(codexRollouts),
        conversionCheck: new CliConversionCheck(),
        harnessVersion: new CliHarnessVersion(),
        rolloutFormat: new CliRolloutFormatProbe(),
        // The SAME discovery a start's readiness check and the doctor use, so the CLI a conversion is
        // validated against is the one this host would launch.
        locateHarness: kind => {
          const located = locateHarnessCommand(kind, harnessDiscovery, executables);
          return located.outcome === 'located' ? located.path : undefined;
        },
        conversationId: () => crypto.randomUUID(),
        sessionDirectory: id => createSessionPaths(paths, id).directory,
        readableHandoffs: id => handoffFolders(createSessionPaths(paths, id).directory, attachmentOriginals(id)),
        // Its own queue: a migration holds its lock across a pane kill and a relaunch, and must not
        // make every unrelated document write in the process wait behind it.
        serial: new KeyedSerialExecutor(),
        launch: createSessionLaunch(storage),
      });
      // What a launch now would say to a ferret, against what it was launched with: the very renderer a relaunch
      // uses, over the very environment a relaunch builds, so "outdated" cannot disagree with what a restart fixes.
      const outdatedFor = async (id: string): Promise<ReturnType<typeof outdatedSections>> => {
        const parsed = tryParseSessionId(id);
        if (parsed === undefined) return [];
        const state = SessionStateSchema.safeParse(await storage.readState(parsed));
        if (!state.success) return [];
        return outdatedSections(
          state.data.launchInstructions,
          launchInstructions(CLIENT_NAME, await launchEnvironments.read(parsed)),
        );
      };
      // A restart is the same-login migrate with the conversation resumed and NEVER forced: the in-flight gate
      // is the one a person's Restart meets, and a ferret it refuses is queued until it is idle.
      // The revision is what the in-flight gate reads of the ferret's own record, so a refused restart is asked
      // again as soon as any of it moves rather than on every tick of the drain.
      const restartSubject = (view: SessionView): RestartSubject => ({
        id: view.config.id,
        name: view.config.name,
        running: !DORMANT_AGENT_STATUSES.has(view.state.status),
        idle: view.state.turnState === 'your-turn' || view.state.waiting !== undefined,
        revision: JSON.stringify([
          view.state.status,
          view.state.turn,
          view.state.turnState ?? null,
          view.state.waiting ?? null,
          view.state.openTools ?? [],
          view.state.subprocessSince ?? null,
        ]),
      });
      const sessionRestartService = new RestartService({
        subjects: async () => (await sessions.list()).map(restartSubject),
        // ONE session, never the list: the drain runs on a 10 s tick, and the list projects every session.
        subject: async id => {
          const view = await sessions.get(id).catch(() => undefined);
          return view === undefined ? undefined : restartSubject(view);
        },
        outdated: outdatedFor,
        restart: async id => {
          const view = await sessions.get(id);
          if (view === undefined) throw new Error(`no session ${id}`);
          await sessionMigrate
            .migrate(id, { agent: view.config.agent, allowContextDowngrade: false, forceInflight: false })
            .catch((error: unknown) => {
              if (error instanceof SessionMigrateError && error.failure === 'refused')
                throw new RestartBusy(error.message);
              throw error;
            });
        },
        gaveUp: async (id, reason) => {
          await storage.append(parseSessionId(id), 'session.restart_abandoned', { reason });
        },
        queue: new FileRestartQueue(paths.state),
        now: () => new Date(clock.now()).toISOString(),
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
        // The resolver the store's originals adapter was built from, never a plausible-looking
        // directory beside the session.
        attachmentOriginals,
        transcriptSources,
        gateway,
        accounts: async agent => await resolveStartAccount(accounts, agent, executables, CLIENT_NAME),
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
      // Remembering which receipts are open, so the reconciler reads them all only at boot and on its
      // backstop, rather than every session directory every fifteen seconds.
      const handoverReceipts = new RememberedHandoverReceipts(new FileHandoverReceiptStore(paths.sessions));
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
      /**
       * The account model's credentials: status, usage and Check now (docs/design/account-model.md §7).
       *
       * Its heads live in memory, so a restart reads every login locally again. The usage pass below
       * observes it with FREE reads only; the one Codex refresh is Check now, which a person presses.
       */
      let credentialUsageIntervalMs = usageRefreshMs(undefined);
      void declaredUsageRefreshMs().then(intervalMs => {
        credentialUsageIntervalMs = intervalMs;
      });
      // THE HOUSEKEEPING WORKER (docs/design/housekeeping-worker.md §2): every credential store read, every
      // free usage read with its token, every passive usage read runs as a job on its own thread — or on
      // this one when `housekeeping.enabled` is false, or after the thread kept crashing — and only facts
      // come back. The token of a login is read, used and dropped inside one job, so it never exists in
      // this heap. `FY_USAGE_PROBE_ORIGIN` moves the free reads to a fake usage server on this machine (the
      // idle bench, the CI budget); anything but a loopback origin is refused, so a token only ever reaches
      // its provider or this host.
      const housekeepingJobs =
        housekeepingEnabled === false
          ? inlineHousekeeping
          : new WorkerHousekeepingJobs({
              settings: housekeepingSettings,
              inline: inlineHousekeeping,
              probe: profilerProbe,
              activity: () => activities.current(),
              // Kept while the fleet refresh recurs, so each pass does not start a fresh thread.
              idleMs: () => credentialUsageIntervalMs + 30_000,
              retired: () =>
                bootNotices.state(
                  'the housekeeping worker kept failing, so credential and usage reads run on the main thread until the daemon restarts',
                ),
              now: () => millisecondClock.now(),
            });
      // Codex discovery's walks go to the same thread from here on.
      discoveryJobs = housekeepingJobs;
      // THE FLEET READING (housekeeping-worker.md §3): every input of a credential's row watched through the
      // file-event hub and read only when it changes — its store file, its statusLine `usage.json` (renamed
      // into place every few seconds while a session runs: ONE passive job, never a pass), its attributed
      // rollouts — and the fleet refresh armed only for the moment a credential's active free read falls due.
      const passiveUsageFiles = new FilePassiveUsageStore(paths.fleet);
      const fleetReading = new FleetReading({
        credentials: async () =>
          (await fleetCredentialCatalog.entries()).entries.flatMap(entry =>
            entry.resolution.store === 'environment' || 'unavailable' in entry.resolution
              ? []
              : [{ id: entry.id, resolution: entry.resolution, usedBy: entry.usedBy }],
          ),
        // Every session's (runtime, transcript), read ONCE per change and shared by every login that asks:
        // read per login per look, ~600 configs × 7 Codex logins held the main thread. The stamp moves on
        // every config this daemon writes and on a session added or removed; an edit made by hand is
        // read within the roster's age bound.
        roster: new SessionRoster({
          stamp: () => `${String(storage.configWrites())}:${String(storage.listSessions().length)}`,
          read: async () =>
            (
              await Promise.all(
                storage.listSessions().map(async session => {
                  const config = SessionConfigSchema.safeParse(
                    // As fresh as the last file event.
                    await storage.readConfig(session.id, 'heard').catch(() => undefined),
                  );
                  return config.success ? [{ agent: config.data.agent, transcript: config.data.transcript }] : [];
                }),
              )
            ).flat(),
          now: () => millisecondClock.now(),
          maxAgeMs: SESSION_ROSTER_MAX_AGE_MS,
        }),
        jobs: housekeepingJobs,
        watch: (path, listener) => fileEvents.subscribe(path, () => listener()),
        passiveFile: id => passiveUsageFiles.path(id),
        refreshLocal: async resolution => {
          await credentialPorts.local(resolution);
        },
        stamp: credentialFileStamp,
        now: () => millisecondClock.now(),
        intervalMs: () => credentialUsageIntervalMs,
        pollsFeed: () => usageCollector,
        timers: {
          // Fired outside every activity: the timer is armed by the pass before, and would otherwise
          // count the next pass inside it.
          setTimeout: (callback, ms) => {
            const handle = setTimeout(() => activities.outside(callback), ms);
            handle.unref?.();
            return handle;
          },
          clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
        },
      });
      // Each credential's store, read as rarely as its facts allow (housekeeping-worker.md §4 PR 1): a file
      // store's facts are kept while its stamp holds — the fleet reading's watch generation while that is
      // live, so an unchanged store costs no system call — a macOS keychain item's for one usage interval,
      // and a free read refreshes them for nothing. The kept facts stay HERE; only a changed store is a job.
      const credentialPorts = new WorkerCredentialPorts({
        jobs: housekeepingJobs,
        stamp: async path => await fleetReading.stamp(path),
        keychain: process.platform === 'darwin',
        keychainFreshMs: () => credentialUsageIntervalMs,
        now: () => millisecondClock.now(),
        cache: new Map(),
      });
      // A login's display email for the credentials list: a Codex one from the kept facts above, a Claude
      // one parsed from its account file only once that file's stamp moved.
      const credentialEmails = new CredentialEmailReader({
        codexFacts: async resolution => await credentialPorts.local(resolution),
        stamp: credentialFileStamp,
        kept: new Map(),
      });
      const credentialStatus = new CredentialStatusService({
        local: async (resolution, options) => await credentialPorts.local(resolution, options),
        passiveUsage: async subject => await fleetReading.passiveUsage(subject),
        activeUsage: async resolution => await credentialPorts.activeUsage(resolution),
        refresh: new ProcessFleetTokenRefreshPort({
          spawn: spawnFleetTokenRefreshProcess,
          environment: process.env,
          which: harnessBinary,
        }),
        heads: new InMemoryCredentialStatusStore(),
        now: () => millisecondClock.now(),
        get usageIntervalMs() {
          return credentialUsageIntervalMs;
        },
      });
      // Environment logins (docs/provider-presets.md): the built-in provider presets with this machine's
      // own preset files laid over them, and a Test that spends a login's key once through the outbound
      // holder above — never handed a value, and only to where the login itself sends that key.
      const providerPresets = new ProviderPresetService(
        { presets: async () => (await configFiles.inEffect()).evaluation.effective.presets },
        undefined,
        async () => await modelCatalogService.catalogs(),
      );
      // The model catalog Ferretry publishes with the hosted app (docs/model-catalog.md § Live updates):
      // a one-file version check, at most every six hours when something reads the catalogs, and the
      // full catalog only when the version differs — checked against the hosted app's signed release
      // list with the key compiled into this build. `FY_MODEL_CATALOG=off` follows none; the origin can
      // be pointed elsewhere with `FY_MODEL_CATALOG_ORIGIN`.
      const modelCatalogOrigin = process.env.FY_MODEL_CATALOG_ORIGIN?.trim() || HOSTED_APP_ORIGIN;
      const publishedModelCatalog = new PublishedModelCatalogService({
        ...(process.env.FY_MODEL_CATALOG === 'off' ? {} : { fetch: new HostedModelCatalog(modelCatalogOrigin) }),
        cache: new FileModelCatalogCache(stateFiles, join(paths.state, 'model-catalog.json')),
        publicKeyPem: HOSTED_APP_RELEASE_KEY,
        nowMs: () => millisecondClock.now(),
        // A newer catalog moves what every runtime offers now, not at the next change somebody makes —
        // and the list prices analytics reads.
        onUpdated: async () => {
          analyticsIngestion.pricingChanged();
          await fleetCatalog.republish().catch(() => undefined);
        },
      });
      // Model catalogs (docs/model-catalog.md): this build's, the published one over them, then this
      // machine's own config/models/<id>.yaml over both. What every runtime on a login offers and pins.
      const modelCatalogService = new ModelCatalogService({
        files: async () => (await configFiles.inEffect()).evaluation.effective.modelCatalogs,
        published: async () => {
          publishedModelCatalog.refreshIfDue();
          return await publishedModelCatalog.catalogs();
        },
        presets: async () => await providerPresets.presets(),
        ollama: () => localModels.snapshot(),
      });
      // The models Ollama has installed on this machine (docs/model-catalog.md § Local models): read at
      // boot and whenever a person opens Settings or a login's setup — never on a timer — through the
      // same keyless, loopback-only read a login Test makes. A different set moves what runtimes offer.
      const keylessProbe = new AuthorizedProviderProbe(outboundAuthorizer, new FetchEnhancementTransport());
      const localModels = new LocalModelsService({
        probe: keylessProbe,
        address: process.env.OLLAMA_HOST,
        enabled: process.env.FY_LOCAL_MODELS !== 'off',
        suggested: async () => suggestedOllamaModel(await modelCatalogService.catalogs()),
        now: () => clock.now(),
        onChanged: async () => {
          analyticsIngestion.pricingChanged();
          await fleetCatalog.republish().catch(() => undefined);
        },
      });
      const providerProbe = new ProviderProbeService({
        probe: keylessProbe,
        clock: { monotonicMs: () => speedupStopwatch.monotonicMs(), now: () => clock.now() },
      });
      // Provider quotas for environment logins (docs/provider-quotas.md): read through the SAME outbound
      // holder, only when somebody watches, at most once a minute per login, and never inference. The
      // fallback is what this machine's own sessions on the login cost, from the analytics index.
      const quotaReader = new ProviderQuotaService({
        logins: async () => {
          const [{ entries }, presets, manifest] = await Promise.all([
            fleetCredentialCatalog.entries(),
            providerPresets.presets(),
            publishedManifest(),
          ]);
          const runtimes = manifest === undefined ? [] : manifestRuntimes(manifest);
          return entries
            .filter(entry => entry.credential.store === 'environment')
            .map(entry => ({
              id: entry.id,
              credential: entry.credential,
              preset: presets.find(preset => preset.id === entry.credential.preset),
              agents: runtimes
                .filter(runtime => runtime.credential === entry.id)
                .map(runtime => wrapperNameOf(runtime.wrapper)),
            }));
        },
        authorizer: outboundAuthorizer,
        spend: new AnalyticsTranscriptSpend(analyticsIngestion),
        clock: { nowMs: () => millisecondClock.now() },
      });
      providerQuota = quotaReader;
      const fleetCredentials = createFleetCredentialsSubsystem({
        catalog: fleetCredentialCatalog,
        status: credentialStatus,
        email: async source => await credentialEmails.email(source),
        machineName: () => hostname(),
        locate: locateHarness,
        run: async spec => await runCredentialHarness(spec),
        baseEnvironment: () => sanitizeHarnessEnv(process.env),
        environment: {
          catalog: async () => await providerPresets.catalog(),
          presets: async () => await providerPresets.presets(),
          // Names only, from the store's listing. A store that cannot be listed is not an empty one.
          secretNames: async () =>
            await secrets.directory.list().then(
              listed => new Set(listed.map(secret => secret.name)),
              () => undefined,
            ),
          test: async (subject, consent) => await providerProbe.test(subject, consent),
        },
        providerQuota: quotaReader,
        // One list answers every reader for a moment: the runtime catalogue, a start's readiness check and
        // the usage feed each asked for it on their own, and each list reads every login's status.
        listCache: { now: () => millisecondClock.now(), freshMs: CREDENTIAL_LIST_FRESH_MS },
      });
      // Every session's status for the catalogue's running count, read once and then kept current from the
      // storage's own state feed: read per catalogue, ~600 state documents parsed for every runtimes view and
      // every Pack routing line held the main thread. A hand edit is read within the tally's age bound.
      const sessionStatusTally = new SessionStatusTally({
        read: async () =>
          new Map(
            (
              await Promise.all(
                storage.listSessions().map(async session => {
                  const status = sessionStatusOf(await storage.readState(session.id).catch(() => undefined));
                  return status === undefined ? [] : [[session.id, status] as const];
                }),
              )
            ).flat(),
          ),
        now: () => millisecondClock.now(),
        maxAgeMs: SESSION_STATUS_TALLY_MAX_AGE_MS,
      });
      storage.subscribeStates((id, state) => sessionStatusTally.heard(id, sessionStatusOf(state)));
      // The account model's catalogue and its setup share ONE set of collaborators, so the two read and
      // write one machine the same way (docs/design/account-model.md §7).
      const fleetCatalogDeps = {
        ...fileFleetCatalogDeps({
          paths,
          userHome,
          ...(credentialHostCodexHome === undefined ? {} : { hostCodexHome: credentialHostCodexHome }),
          sessionStatuses: async () => await sessionStatusTally.statuses(),
          sessionRecords: new RuntimeSessionRecords(storage),
          credentials: fleetCredentials,
          locate: locateHarness,
          machineName: () => hostname(),
          clientName: CLIENT_NAME,
          config: configFiles,
          configDirectory: paths.config,
        }),
        modelCatalogs: async () => await modelCatalogService.sources(),
        publishedManifest: async () => await publishedManifest(),
        lastAutoResume: async () => await autoResumeSummary.read(),
      };
      /**
       * First-run import, Import again, tool install, and the Clone export and import
       * (docs/design/account-model.md §4.3, §4.7). A package manager runs only inside an install
       * a person asked for; nothing here runs on a timer.
       */
      // A host attach is authorized by the durable pane registration, never by the session name.
      // The observer reads the same private tmux server the launch registered, and the service
      // compares pane id, pid and process-start incarnation before revealing its socket path.
      const sessionAttach = new SessionAttachService(
        paths.home,
        join(paths.home, 'tmux.sock'),
        {
          list: async daemonId =>
            await new DurableTerminalPaneStore(storage, stateFiles, paths).registrations(daemonId),
        },
        new ExactTmuxPaneReaper(launchTmux),
      );
      const fleetSetup = createFleetSetupSubsystem(
        fileFleetSetupDeps({
          catalog: fleetCatalogDeps,
          ...(process.env.CLAUDE_CONFIG_DIR === undefined ? {} : { claudeConfigDir: process.env.CLAUDE_CONFIG_DIR }),
          ...(process.env.CODEX_HOME === undefined ? {} : { codexHome: process.env.CODEX_HOME }),
          credentials: harnessCredentials,
          tools: new ToolInstallService({
            platform: process.platform,
            executables,
            locate: kind => locateHarnessCommand(kind, harnessDiscovery, executables),
            run: runPackageInstall,
            environment: process.env,
          }),
          secrets: secrets.directory,
        }),
      );
      // SETTLED: the feed caches this list for an interval, so a login being read right now is listed
      // with its last known word rather than a "Checking" that would outlive the read.
      credentialList = async () => await fleetCredentials.list({ settled: true });
      paneLimits = async () => await storagePaneLimits(storage, Date.now());
      const terminalSubsystem = createTerminalSubsystem(storage, terminals, { now: () => Date.now() });
      // A session browser nobody watches or drives stops after this long, so a forgotten one does not
      // hold the one shared profile away from every other session.
      const browserService = new BrowserSessionService(sessions, browserLauncher, () => Date.now(), {
        timeoutMs: 15 * 60_000,
        after: (milliseconds, action) => {
          const timer = setTimeout(action, milliseconds);
          return { cancel: () => clearTimeout(timer) };
        },
      });
      const agentControl = new AccountModelAgentControlPolicy(declaredAccountModel);
      closeAgentBrowsers = async () => await browserService.closeAll();
      releaseBrowserSession = async sessionId => await browserService.releaseSession(sessionId);
      const browserHost: MountedSubsystems['browser'] = {
        ...browserService,
        status: browserService.status.bind(browserService),
        act: browserService.act.bind(browserService),
        attachViewer: browserService.attachViewer.bind(browserService),
        dispatchHumanInput: browserService.dispatchHumanInput.bind(browserService),
        releaseSession: browserService.releaseSession.bind(browserService),
        openPage: browserService.openPage.bind(browserService),
        actOnPage: browserService.actOnPage.bind(browserService),
        closePage: browserService.closePage.bind(browserService),
        closeAll: browserService.closeAll.bind(browserService),
        stream: async (sessionId, downstream) => {
          let viewer: BrowserViewerStream | undefined;
          return {
            open: async () => {
              viewer = await BrowserViewerStream.connect(browserService, sessionId, downstream, new SystemFrameClock());
            },
            fromClient: frame => viewer?.fromClient(frame),
            close: () => viewer?.close(),
          };
        },
      };
      // Hoisted so the Warden reads the same redacted transcript and screen an operator does: the evidence
      // its Jev guard is shown passes the same scrubbing as every other read of a ferret.
      // The three operator reads, each over the evidence that actually holds the answer: the durable
      // journal this storage opened, the pane the lifecycle document names, and the transcript the
      // start proved is this session's.
      //
      // EVERY ONE IS KEYED BY SESSION ID THROUGH THIS DAEMON'S OWN STATE HOME. The journal is a file
      // under it, the pane address is read from the document beside that file, and the tmux server is
      // this daemon's private socket — so a session with the same name under another daemon cannot be
      // captured here, which is the failure a `fy stream` attaching to the wrong pane would be.
      const operatorReads = new OperatorReadService(
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
          capture: async (sessionId, scope) => {
            const id = tryParseSessionId(sessionId);
            if (id === undefined) return undefined;
            // PARSED for the reason every other terminal address is: a document that no longer
            // validates must leave the session with no pane rather than address whatever it names.
            const lifecycle = SessionLifecycleConfigSchema.safeParse(
              lifecycleConfigDocument(await storage.readConfig(id).catch(() => undefined)),
            );
            if (!lifecycle.success) return undefined;
            // Only the frame the scope asks for: the scrollback is tens of kilobytes on a long session,
            // and a `screen` reader would have had it captured and thrown away.
            const state = await launchTmux.state(lifecycle.data.tmuxSession, { history: scope !== 'screen' });
            // The scrollback by default: an operator reading a snapshot is catching up on what
            // happened, and the visible 24 lines are whatever the harness last redrew. `screen` is for
            // a poller that reads only the frame's last lines, and costs a fraction of the bytes.
            return { alive: state.alive, dead: state.dead, text: paneTextFor(state, scope) };
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
      );
      // Lessons: the review board, passive suggestions, Apply and the explicit scan. A new ferret's
      // passive default is recorded through it, and a running one is re-instructed with a queued send.
      const learning = createLearningSubsystem({
        paths,
        files: stateFiles,
        clock,
        serial: learningBoard,
        sessions,
        transcripts: createTranscriptReader(storage),
        sessionControl: withSystemCallsign(sessionControl, systemCallsigns, 'learning'),
        config: () => configFiles.current().evaluation.effective.learning,
        configFiles,
        identities: agentIdentities(storage),
        mergeEnvironment: async (sessionId, variables) => {
          const id = tryParseSessionId(sessionId);
          if (id === undefined) return;
          await sessionMutations.run(`session:${id}`, async () => {
            await sessionEnvironments.write(id, { ...(await sessionEnvironments.read(id)), ...variables });
          });
        },
        send: async (sessionId, message, sendId) => {
          const id = tryParseSessionId(sessionId);
          if (id === undefined) throw new Error(`${JSON.stringify(sessionId)} is not a usable session id`);
          await producerSends('Lessons').send({ id, sendId, message });
        },
        userHome,
        pricing: async () => {
          const read = await daemonConfigStore.readPricing();
          return effectiveAnalyticsPricing(
            read.kind === 'unavailable' ? [] : read.configuration.catalog,
            await modelCatalogService.catalogs(),
          );
        },
      });
      adoptLearning = async id => {
        await learning.transaction(async () => await learning.lessons.adopt(id));
      };
      // The live pane, read through the SAME tmux server the launch path addresses: the session observer
      // reads its turn evidence through `turnPorts.pane`, and the live readout (`?live=1` on a session's
      // event stream) its frames through `turnPorts.paneState`, so the turn it times and the turn the
      // observer reports are one boundary. (Its roster and transcript halves are the pre-3a path, kept
      // as the reference the observer's parity suite holds the host to.)
      const transcriptFileOf = (() => {
        const resolver = createTranscriptFileResolver(storage);
        return async (id: SessionId) => await resolver.file(id);
      })();
      const turnPorts = new StorageTurnPorts(
        storage,
        createSessionTranscriptTail(storage),
        transcriptFileOf,
        launchTmux,
        clock,
      );
      const liveActivity = new StorageLiveActivitySource(
        {
          readState: async id => await storage.readState(id),
          // The worker's frame for a running session: no capture of its own every half second.
          paneState: async id => await sessionObserver.pane(id),
          transcriptFile: transcriptFileOf,
        },
        createSessionTranscriptTail(storage),
        clock,
        new FileCompactionHistory(stateFiles, join(paths.home, 'compaction-history.json')),
      );
      // The catalogue runs the setup service's import and clone as two of its reviewed changes.
      const fleetCatalog = new FleetCatalogService({
        ...fleetCatalogDeps,
        executors: fleetSetup.executors,
        presets: async () => await providerPresets.presets(),
      });
      // A login or runtime disabled `until` a time switches itself back on (docs/disabling.md): one timer,
      // set for the earliest `until`, republishes the fleet when it falls due. A load re-arms it.
      const disableExpiry = new DisableExpiryWatch({
        next: async () => await fleetCatalog.nextDisableExpiry(),
        now: () => Date.now(),
        republish: async () => {
          await fleetCatalog.republish();
        },
        setTimer: (run, ms) => {
          const handle = setTimeout(asActivity(activities, 'disable expiry', run), ms);
          handle.unref();
          return () => clearTimeout(handle);
        },
      });
      /**
       * Pack mode (docs/pack-mode.md): over the same runtimes, logins and catalogs every picker reads, and
       * the same session start every surface uses — so its limits, its callsigns and its launch are the
       * ones a plain start gets. Probes run the runtime's own wrapper with its login's launch environment,
       * found by the start's own resolution — the published absolute launcher, never a name on `PATH` — so
       * a probe that passes is a start that can launch.
       */
      // ONE probe cache for every start Pack mode makes — sub-ferrets and the guide builder alike.
      const packProbe = (() => {
        const cache = new ProbeCache(
          new CliPackProbe(
            {
              resolve: async wrapper =>
                (await resolveStartAccount(accounts, wrapper, executables, CLIENT_NAME)).executable,
            },
            accountLaunchEnvironment,
            bunProbeSpawn,
            Object.fromEntries(
              Object.entries(sanitizeHarnessEnv(process.env)).filter(
                (entry): entry is [string, string] => entry[1] !== undefined,
              ),
            ),
            () => performance.now(),
          ),
          () => Date.parse(clock.now()),
        );
        return async (request: PackProbeRequest, ttlMs: number) => await cache.probe(request, ttlMs);
      })();
      const packCatalogs = async () =>
        modelCatalogsView(await modelCatalogService.catalogs(), {
          origin: modelCatalogOrigin,
          enabled: publishedModelCatalog.enabled,
          ...(await publishedModelCatalog.status()),
        }).catalogs;
      const packService = new PackService({
        settings: async () => {
          const effective = (await configFiles.inEffect()).evaluation.effective;
          return {
            config: effective.pack,
            guideFile: effective.modelsGuide,
            jevUsdPerMillionInputTokens: effective.warden.guard.usdPerMillionInputTokens,
          };
        },
        catalogs: packCatalogs,
        facts: async () => {
          const [runtimes, credentials, machine] = await Promise.all([
            fleetCatalog.runtimes(),
            fleetCredentials.list(),
            fleetCatalog.machine(undefined),
          ]);
          // The start's own launcher resolution, per agent runtime: a runtime it would refuse is not ready.
          const unlaunchable = Object.fromEntries(
            (
              await Promise.all(
                runtimes.runtimes
                  .filter(runtime => runtime.agent)
                  .map(
                    async runtime =>
                      await resolveStartAccount(accounts, runtime.wrapper, executables, CLIENT_NAME).then(
                        () => [],
                        (error: unknown) => [[runtime.wrapper, error instanceof Error ? error.message : String(error)]],
                      ),
                  ),
              )
            ).flat(),
          );
          return {
            runtimes: runtimes.runtimes,
            credentials: credentials.credentials,
            tools: machine.tools,
            unlaunchable,
            paneLimits: limitedCredentials(
              await storagePaneLimits(storage, Date.now()),
              runtimes.runtimes.map(runtime => ({ agent: runtime.wrapper, credential: runtime.credential.id })),
            ),
            now: clock.now(),
          };
        },
        parent: async id => await packTree.parent(id),
        // A named folder is judged where it really is: `/tmp` is `/private/tmp` on macOS, and a link into a
        // temporary folder is still one. This machine's own TMPDIR and the runtime's temp folder count too.
        scratch: async cwd => {
          const real = (path: string): string => {
            try {
              return realpathSync(path);
            } catch {
              return path;
            }
          };
          const roots = [...COMMON_SCRATCH_ROOTS, tmpdir(), ...(process.env.TMPDIR ? [process.env.TMPDIR] : [])];
          return isScratchPath(real(cwd), [...roots, ...roots.map(real)]);
        },
        probe: packProbe,
        cards: boardWorld.cards,
        // Parsed here, so a field Pack leaves out takes the start schema's own default
        start: async (input, delegation) => {
          const request = StartSessionRequestSchema.parse(input);
          try {
            return await sessionControl.start(request, crypto.randomUUID(), JSON.stringify(request), delegation);
          } catch (error) {
            if (
              error instanceof SessionControlError &&
              (error.failure === 'limit_reached' || error.failure === 'depth_exceeded')
            )
              throw new PackStartRefused({ code: error.failure, message: error.message });
            throw error;
          }
        },
        jev: new JevPackRanker(outboundAuthorizer),
        spend: (() => {
          const ledger = new FilePackSpendLedger(stateFiles, join(paths.state, 'pack-jev-spend.json'), () =>
            clock.now().slice(0, 10),
          );
          return { today: async () => await ledger.spent(), record: async usd => await ledger.record(usd) };
        })(),
        bin: CLIENT_NAME,
        now: () => clock.now(),
      });
      // Derived once per configuration load and shared by every ferret: each running ferret's "outdated" mark
      // builds the environment a relaunch would, routing line included, and deriving it reads the fleet's
      // runtime catalogue, which reads every session's state (see `PackRoutingKeep`).
      const packRoutingKeep = new PackRoutingKeep({
        generation: async () => await configFiles.inEffect(),
        derive: async () => await packService.routingLine(),
        now: () => millisecondClock.now(),
        maxAgeMs: PACK_ROUTING_MAX_AGE_MS,
      });
      packRouting = async () => await packRoutingKeep.line();
      /**
       * Clean up (docs/pack-mode.md § Clean up): the routing prompt's ONE generator, a short-lived hidden ferret
       * started through the session start every surface uses and probed like any sub-ferret, and the writes of
       * what it rewrites through the configuration writer every editor uses.
       */
      const guidePath = configFilePath({ kind: 'modelsGuide' });
      const cleanUp = new CleanUpService({
        inventory: async () => await packService.inventory(),
        runtime: async name => {
          const runtime = (await fleetCatalog.runtimes()).runtimes.find(row => row.name === name && row.agent);
          return runtime === undefined
            ? undefined
            : { wrapper: runtime.wrapper, harness: runtime.harness, defaultModel: runtime.models?.default };
        },
        probeSettings: async () => (await configFiles.inEffect()).evaluation.effective.pack.probe,
        probe: packProbe,
        start: async request =>
          await withSystemCallsign(sessionControl, systemCallsigns, 'pack').start(
            request,
            crypto.randomUUID(),
            JSON.stringify(request),
          ),
        status: async reference => {
          const id = tryParseSessionId(reference);
          return id === undefined ? undefined : (await sessions.get(id))?.state.status;
        },
        stop: async (reference, reason) => {
          await sessionControl.stop(reference, reason);
        },
        runs: new FileCleanUpRunStore(stateFiles, join(paths.state, 'pack-guide'), async path => {
          await rm(path, { recursive: true, force: true });
        }),
        now: () => clock.now(),
        newId: () => crypto.randomUUID(),
        home: paths.home,
        bin: CLIENT_NAME,
      });
      const configText = async (path: ReturnType<typeof configFilePath>) => {
        const file = await configFiles.file(path);
        return { exists: file.exists, text: file.exists ? file.text : '', etag: file.etag };
      };
      const writeConfigText = async (path: ReturnType<typeof configFilePath>, text: string, etag: string) => {
        await configFiles.write(path, text, etag, false);
      };
      const guideFile = new GuideFileService({
        read: async () => await configText(guidePath),
        write: async (text, etag) => await writeConfigText(guidePath, text, etag),
        replaced: new FileReplacedGuide(stateFiles, join(paths.state, 'pack-guide-replaced.json')),
        now: () => clock.now(),
      });
      // ONCE: an old use-case guide (and the old builder preferences) become one routing prompt, the old files
      // kept in the state home. Every later start finds nothing to do. It never blocks the daemon's start.
      const packPath = configFilePath({ kind: 'pack' });
      void new RoutingMigration({
        readGuide: async () => await configText(guidePath),
        writeGuide: async (text, etag) => await writeConfigText(guidePath, text, etag),
        readPack: async () => await configText(packPath),
        writePack: async (text, etag) => await writeConfigText(packPath, text, etag),
        defaultPrompt: async () => await packService.defaultPrompt(),
        backup: async value => await new FileRoutingMigrationBackup(stateFiles, paths.state).write(value),
        now: () => clock.now(),
      })
        .run()
        .then(outcome => {
          if (outcome.outcome === 'migrated')
            process.stderr.write(
              `pack: the models guide is now one routing prompt${outcome.cut ? ' (cut to fit)' : ''}; the old files are kept at ${outcome.backup}\n`,
            );
        })
        .catch((error: unknown) => {
          process.stderr.write(
            `pack: the routing prompt migration did not run: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        });
      const sessionResumeSubsystem = createSessionResumeSubsystem(
        storage,
        sessions,
        resume,
        // The SAME stamper the start uses, so a create and a revive can never disagree about how
        // descent is decided; only the ancestry snapshot differs, and it is taken per relaunch.
        new SessionProvenanceRecorder(spawnProvenance, new StorageSessionProvenanceStore(storage), {
          snapshot: async () => await spawnAncestry(storage, sessions),
        }),
        // A message held while this session could not take input is delivered now that it is back.
        sends,
      );
      const mounted: Omit<MountedSubsystems, 'sessionMcp' | 'mcpInventory'> = {
        pack: {
          service: packService,
          routing: { cleanUp, file: guideFile },
          result: async reference => {
            const id = tryParseSessionId(reference);
            const view = id === undefined ? undefined : await sessions.get(id);
            if (id === undefined || view === undefined) return undefined;
            return await readSessionResult(
              view,
              async () => await stateFiles.readText(join(createSessionPaths(paths, id).directory, 'summary.md')),
            );
          },
          setSwitch: createSessionPackSwitch(
            storage,
            sessions,
            sessionEnvironments,
            sessionMutations,
            packTree,
            packConfig,
            clock,
          ),
        },
        health: createHealthSubsystem(health, scratch, sessionWorkerPool, ioPressure),
        performance: {
          profiles: new PerformanceProfiler({
            recorder: profilerProbe,
            gauges: new ProcessGauges(),
            workers: [
              { name: 'analytics-fold', inFlight: () => transcriptFolds.inFlight },
              { name: 'session-observer', inFlight: () => sessionWorkerSupervisor.inFlight },
              ...(housekeepingJobs instanceof WorkerHousekeepingJobs
                ? [{ name: HOUSEKEEPING_WORKER, inFlight: () => housekeepingJobs.inFlight }]
                : []),
            ],
            clock: millisecondClock,
            timers: {
              every: (intervalMs, tick) => {
                const handle = setInterval(tick, intervalMs);
                return () => clearInterval(handle);
              },
              after: (delayMs, fire) => {
                const handle = setTimeout(fire, delayMs);
                return () => clearTimeout(handle);
              },
            },
            context: {
              daemon: {
                version: daemonVersion,
                platform: process.platform,
                arch: process.arch,
                runtime: `bun ${Bun.version}`,
              },
              uptimeSeconds: () => process.uptime(),
              sampleIntervalMs: sampleIntervalMs(STARTED_SAMPLE_INTERVAL),
              sessionWorkers: sessionWorkerPool,
              fleet: async () => {
                const sessions = storage.listSessions();
                return {
                  sessions: sessions.length,
                  running: sessions.filter(session => session.status === 'running').length,
                };
              },
              limitations: () => [
                'File operations count only calls through the daemon’s state-home port; a direct node:fs call shows in the CPU profile (as openSync, statSync, …) and in --trace-syscalls, not in that table.',
                ...(process.platform === 'linux'
                  ? []
                  : ['System-call counts and children’s CPU are read from /proc and exist on Linux only.']),
                ...(stackSamplerEnabled(process.env[STACK_SAMPLER_VARIABLE])
                  ? []
                  : ['The stack sampler is switched off (FYD_STACK_SAMPLER=0), so the CPU profile is empty.']),
                housekeepingBackstopLimitation(),
                ...polledDirectoryLimitations(
                  fileEvents.fallbacks(),
                  { home: userHome, stateHome: paths.home },
                  FILE_EVENT_POLL_MS,
                ),
              ],
            },
            budgets: IDLE_DAEMON_BUDGETS,
            newId: () => crypto.randomUUID(),
          }),
          probe: profilerProbe,
          clock: millisecondClock,
        },
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
              tmuxRelease: await new TmuxReleaseReader(tmuxExecutable, tmux).read(),
            });
          },
        },
        // The security log's read route, and the sink the audited route table records into. A device's
        // name is read from the same grant store pairing keeps, so a record names what the list shows.
        audit: {
          log: auditLog,
          recent: async (limit, keptOffset) => await auditLog.recent(limit, keptOffset),
          flush: async () => await auditLog.flush(),
          failures: auditFailures,
          deviceName: async deviceId => (await pairing.devices()).find(device => device.id === deviceId)?.name,
        },
        pairing,
        push,
        stepUp,
        security,
        carriers,
        tunnel,
        webrtc,
        harnessLogin,
        mcpOAuth,
        // The logins list is a WATCHER: somebody has it on screen, so the environment logins' provider
        // quotas that are due are read first (at most once a minute each). The usage feed's unattended
        // refresh reads `fleetCredentials.list` directly, which never asks a provider anything.
        fleetCredentials: {
          check: fleetCredentials.check.bind(fleetCredentials),
          test: fleetCredentials.test.bind(fleetCredentials),
          presets: fleetCredentials.presets.bind(fleetCredentials),
          list: async () => {
            await quotaReader.watch();
            return await fleetCredentials.list();
          },
        },
        fleetCatalog,
        // Unit M's rebase target: the same single reader every other in-process consumer of this
        // document shares, so this never disagrees with what the catalogue or a start just read.
        agentControl,
        fleetSetup,
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
        conversationImport,
        // This owns no cache and no provider policy: the daemon usage feed already owns those. One
        // service per opened state home serializes only this daemon's timer ticks, so a slow read in
        // another daemon can neither join nor delay it. It is deliberately NOT handed the fleet: the
        // health probe launches a wrapper and spends a real billable turn per account, which a timer
        // must never do. Health belongs where a person chose it.
        fleetRefresh: new FleetRefreshService({
          usage: unattendedUsageFeed(usage),
          credentials: fleetCredentials,
          schedule: fleetReading,
        }),
        notifications,
        attention: agenda,
        agendaReplies,
        agendaClearer: new AgendaAgentClearer(new StorageAgentSessions(storage), agendaBoards, agenda),
        pins: new PinService(
          new FilePinSessionDirectory(paths, stateFiles),
          // Its own queue: a pin mutation must not serialize behind storage-wide or session work.
          new FilePinRepository(paths, stateFiles, new KeyedSerialExecutor(), clock),
          clock,
          // A pin id is a protocol UUID, so it is minted as one rather than derived from a counter the
          // next process would restart.
          { next: () => crypto.randomUUID() },
        ),
        sessions: withContext(
          withOutdated(sessions, { outdated: outdatedFor, now: () => Date.parse(clock.now()), ttlMs: 5_000 }),
          {
            // The window the account's catalog declares for each session's model, read once per roster.
            declared: async () => {
              const fleet = await accounts.accounts();
              return view => {
                const account = findAccountByAgent(fleet, view.config.agent);
                const model = view.config.model ?? view.config.modelHint;
                return account === undefined || model === undefined
                  ? undefined
                  : declaredModel(account, model)?.context;
              };
            },
            overrides: contextWindowOverrides,
            now: () => Date.parse(clock.now()),
            ttlMs: 30_000,
          },
        ),
        // A name in any `:sessionId` is resolved over the same candidates the send and signal domains read,
        // so a route, the attribution on a message and a declared wait agree on which agent a name means.
        sessionAddresses: {
          has: reference => {
            const id = tryParseSessionId(reference);
            return id !== undefined && storage.findSession(id) !== undefined;
          },
          candidates: async () => await sessionAddressCandidates(storage),
        },
        catalogs,
        boardProjects: laneSets,
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
        sessionResume: sessionResumeSubsystem,
        sendTracking: sendTracker,
        sendReproof,
        queueDelivery: queueDeliverer,
        sessionSend: createSessionSendSubsystem(
          storage,
          sessions,
          sends,
          sendLedger,
          sessionQueue,
          queueDeliverer,
          delivery.queue,
          sendTracker,
          async (sessionId, attachmentIds) => {
            // Each copy sits beside its stored original, under the file's own name, written once: the
            // store's download re-verifies the bytes against the manifest digest before they are copied.
            const delivered: DeliveredAttachment[] = [];
            for (const attachmentId of attachmentIds) {
              const { attachment, bytes } = await attachmentStore.download(sessionId, attachmentId);
              const path = join(attachmentOriginals(sessionId), attachmentId, deliveredFilename(attachment.filename));
              if (!existsSync(path)) {
                await Bun.write(path, bytes);
                chmodSync(path, 0o600);
              }
              delivered.push({ path, mime: attachment.mime });
            }
            return delivered;
          },
          // The person's words behind a pointer the transcript records, read from the very document the
          // send (or the start, or the revive) wrote.
          async (sessionId, name) => {
            const document = await sendTurns.readHandoff(sessionId, name);
            return document === undefined
              ? undefined
              : handoffView(
                  name,
                  document,
                  {
                    reminder: defaultSessionResumeSettings.turnProtocolReminder,
                    attachmentRoot: attachmentOriginals(sessionId),
                  },
                  await sendTurns.readHandoffAuthor(sessionId, name),
                );
          },
          new AgendaConversation(agenda),
          new InstructionRefresh({
            sections: subFerret => ALWAYS_ON_SECTIONS(CLIENT_NAME, subFerret),
            // Its own message in the session's queue, right behind the owner's that triggered it. Sent as the
            // person's (`human`) so it is typed into an interactive session too, as it always was; WHO it is
            // from is the `by` — Ferretry · Instructions, with the sections it restates — never text in it.
            // Only durable here, not handed over: the owner's send this follows answers without waiting.
            queue: async (sessionId, digest, note, sections) => {
              const id = tryParseSessionId(sessionId);
              if (id === undefined) throw new Error(`${JSON.stringify(sessionId)} is not a usable session id`);
              if (!delivery.queue) return await agendaReplies.add(sessionId, instructionsReplyKey(digest), note);
              await sessionQueue.enqueue(id, {
                id: `instructions-${digest}`,
                sender: 'human',
                by: { kind: 'ferretry', feature: INSTRUCTIONS_FEATURE, sections: [...sections] },
                text: note,
              });
              void queueDeliverer.enqueued(id).catch(() => undefined);
            },
            recorded: async sessionId => {
              const id = tryParseSessionId(sessionId);
              if (id === undefined) return undefined;
              const state = SessionStateSchema.safeParse(await storage.readState(id));
              return state.success ? state.data.launchInstructions : undefined;
            },
            record: async (sessionId, update) => {
              const id = tryParseSessionId(sessionId);
              if (id === undefined) return;
              await storage.updateState(id, current => {
                const state = SessionStateSchema.safeParse(current);
                const next = state.success ? update(state.data.launchInstructions) : undefined;
                return next === undefined
                  ? current
                  : { ...(current as Record<string, unknown>), launchInstructions: next };
              });
            },
          }),
        ),
        sessionAnswer,
        sessionAttachments,
        sessionSignal: createSessionSignalSubsystem(storage, sessions, signals, boardWorld.cards),
        sessionRename: createSessionRenameSubsystem(storage, sessions, nameClaims, clock),
        sessionAgendaMode,
        sessionHypermedia: createSessionHypermediaSubsystem(
          storage,
          sessions,
          sessionEnvironments,
          sessionMutations,
          clock,
        ),
        sessionRuntime,
        // The record lives in this daemon's own state home, beside the lock and the index it was
        // opened with. Two daemons on one host have two homes and therefore two records, so neither
        // can overwrite the other's account of its own loop.
        monitor: new MonitorTickRunner(monitor, join(paths.home, 'monitor.json'), defaultSessionMonitorSettings),
        observer: sessionObserver,
        sessionMigrate,
        sessionRestart: sessionRestartService,
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
            const handle = setInterval(asActivity(activities, 'handover reconcile', tick), intervalMs);
            return () => clearInterval(handle);
          },
        }),
        legacyTasks: { now: () => clock.now() },
        board: {
          board: async query => await boardWorld.board.board(query),
          task: async id => await boardWorld.board.task(id),
          taskByLegacyRef: async legacyRef => await boardWorld.board.taskByLegacyRef(legacyRef),
          create: async (request, caller) => await boardWorld.board.create(request, caller),
          act: async (id, request, caller) => await boardWorld.board.act(id, request, caller),
          skip: async (request, caller) => await boardWorld.board.skip(request, caller),
          importLegacy: async options => await boardImporter.run({ dryRun: options.dryRun, force: true }),
        },
        boardGitHub,
        analytics: createAnalyticsSubsystem(analyticsIngestion, () => analyticsMachineName ?? hostname()),
        analyticsPricing,
        analyticsIngest: analyticsIngestion,
        terminals: terminalSubsystem,
        browserLogin,
        browser: browserHost,
        browserProxy: {
          tester: new BrowserProxyTester({
            saved: async () => (await declaredAccountModel())?.machine.browserProxy,
            secrets: async () => await secretVault.values(),
            probe: new TunnelProxyProbe(),
            now: () => performance.now(),
          }),
          state: () => browserService.overview(),
        },
        agentTools: createAgentToolsSubsystem({
          storage,
          terminals: terminalSubsystem,
          browser: browserHost,
          audit: auditLog,
          policy: agentControl,
          redactor: secretRedactor,
        }),
        configFiles: createConfigFilesSubsystem({
          activities,
          service: configFiles,
          events: {
            directories: async () => await configDirectory.directories(),
            subscribeDirectory: (path, listener) => fileEvents.subscribeDirectory(path, listener),
          },
          agentControl,
          identities: agentIdentities(storage),
          notices: bootNotices,
          // A build with newer built-in model catalogs, or a config/models/ file edited, moves every
          // runtime's models, defaults and tier pins now rather than at the next change somebody makes.
          // No configuration file is written, and an identical manifest is left alone.
          afterLoad: async () => {
            // A config/models/ file prices models too.
            analyticsIngestion.pricingChanged();
            // Credentials the edit added or removed open or close their watches.
            await fleetReading.configLoaded();
            await fleetCatalog.republish().then(
              outcome => {
                if (outcome === 'applied')
                  bootNotices.state('model catalogs moved what runtimes offer; fleet republished');
              },
              (error: unknown) =>
                bootNotices.state(
                  `could not republish the fleet for its model catalogs: ${error instanceof Error ? error.message : String(error)}`,
                ),
            );
            await disableExpiry.rearm();
          },
        }),
        names: createNameSubsystem(storage),
        learning,
        recommend: createRecommendSubsystem(advisorOver, usage),
        sttEnhancement,
        // Names-only status over the store's listing, and a Test that spends a key once through the
        // outbound holder above. Jev's Test goes through the same guard the Warden will use.
        // The model catalogs in effect, and the published one this machine follows (docs/model-catalog.md).
        models: {
          view: async () =>
            modelCatalogsView(await modelCatalogService.catalogs(), {
              origin: modelCatalogOrigin,
              enabled: publishedModelCatalog.enabled,
              ...(await publishedModelCatalog.status()),
            }),
          refresh: async () => await publishedModelCatalog.refresh(true),
          refreshLocal: async () => await localModels.refresh(),
        },
        speedups: new SpeedupsService({
          authorizer: outboundAuthorizer,
          secrets: secrets.directory,
          ledger: new FileSpeedupTestLedger(stateFiles, join(paths.state, 'speedups.json')),
          clock: { monotonicMs: () => speedupStopwatch.monotonicMs(), now: () => clock.now() },
          guard: new JevTriageGuard(outboundAuthorizer, speedupStopwatch),
        }),
        // Updating this daemon (docs/updating.md): its install facts, the latest release from GitHub at
        // boot and at most every six hours, and `fy daemon update` started detached beside this daemon.
        daemonUpdate: (() => {
          const directory = join(paths.state, 'update');
          const launched = isAbsolute(process.argv0) ? process.argv0 : process.execPath;
          return new DaemonUpdateService(
            {
              current: daemonVersion,
              product: productName,
              clientName: CLIENT_NAME,
              install: new HostInstallFacts({
                product: productName,
                argv0: process.argv0,
                execPath: process.execPath,
                main: Bun.main,
                homeDirectory: userHome,
                platform: process.platform,
                workingDirectory: process.cwd(),
                which: name => Bun.which(name) ?? undefined,
              }),
              releases: new GitHubLatestRelease(productName, { userAgent: `${DAEMON_NAME}/${daemonVersion}` }),
              documents: new FileUpdateDocuments(stateFiles, directory),
              launcher: new CliUpdateLauncher({
                client: join(dirname(launched), CLIENT_NAME),
                stateHome: paths.home,
                files: stateFiles,
                directory,
                environment: process.env,
              }),
              activity: {
                midTurn: async () => await sessionObserver.midTurn(),
              },
              clock: millisecondClock,
              // A source run has no release to compare with, and an operator or a suite can switch it off.
              checks: Bun.main.startsWith('/$bunfs/') && process.env.FY_UPDATE_CHECK !== 'off',
            },
            {
              every: (intervalMs, tick) => {
                const handle = setInterval(asActivity(activities, 'update check', tick), intervalMs);
                return () => clearInterval(handle);
              },
            },
          );
        })(),
        // Updating this machine's `claude` and `codex` (docs/updating.md › "Updating Claude Code and Codex"):
        // the file a runtime launches comes from the ONE harness resolution rule, its install facts are read
        // exactly as this daemon's own are, and npm is asked for the newest only when somebody looks.
        harnessUpdate: new HarnessUpdateService({
          product: productName,
          homeDirectory: userHome,
          locate: kind => locateHarnessCommand(kind, harnessDiscovery, executables),
          facts: new HostHarnessFacts({ homeDirectory: userHome, platform: process.platform }),
          probe: new HostHarnessProbe(runPackageInstall, process.env),
          latest: new NpmHarnessLatest({ userAgent: `${DAEMON_NAME}/${daemonVersion}` }),
          executables,
          run: runPackageInstall,
          environment: process.env,
          clock: millisecondClock,
          checks: process.env.FY_UPDATE_CHECK !== 'off',
        }),
        // Constructed here rather than injected: the pinner opens nothing until a request arrives, and
        // the Git reader is the same hardened runner the worktree gateway already uses. Both are
        // stateless, so one instance serves every session.
        sessionFilesystem: new SessionFilesystem(sessionRootPinner(), new RunnerSessionGit(new BunGitRunner())),
        // Derived from the session id alone — a caller asks for `scope=media`, never for a directory.
        sessionMediaRoot: id => createSessionPaths(paths, parseSessionId(id)).media,
        scratchGc,
        // Constructed here: the service holds only a rate window, and the launcher starts nothing until a
        // loopback caller asks.
        systemOpen: new OpenUrlService({
          launcher: new BunDetachedLauncher(),
          audit: auditLog,
          nowMs: () => millisecondClock.now(),
          platform: process.platform,
        }),
        secrets,
        warden: createWardenSubsystem({
          machineName: () => analyticsMachineName ?? hostname(),
          ledgers: wardenLedgers,
          // The board as the Warden reads it: every card with its derived activity (the orphans), and the card
          // a session works on (what a ferret it starts again carries on). Each read is total.
          board: {
            read: async () => await boardWorld.board.sweepBoard().catch(() => undefined),
            focusCard: async sessionId => {
              const ref = await boardWorld.focus.focusOf(sessionId).catch(() => null);
              if (ref === null || (ref.machineId !== undefined && ref.machineId !== attachmentDaemonId))
                return undefined;
              const found = await boardWorld.board.task(ref.id).catch(() => undefined);
              return found === undefined ? undefined : { task: found.task, laneSet: found.laneSet };
            },
          },
          activities,
          sessions,
          documents: createSessionDirectorySubsystem(paths, storage),
          control: sessionControl,
          attention: agenda,
          usage,
          accounts,
          defaultRuntime: async () => {
            const model = await declaredAccountModel();
            return model === undefined ? undefined : resolveDefaultRuntime(model);
          },
          files: wardenFiles,
          // The SAME reader `world.wardenReports` builds, over the same directory: the verdict list
          // and the sweep's own "was this target cleared" read must agree about what a report says.
          reportsReader: new WardenReportReader(wardenFiles, wardenPaths.reports),
          wardenRoot: wardenPaths.root,
          reportsDirectory: wardenPaths.reports,
          jevChecksDirectory: wardenPaths.jevChecks,
          supervision: wardenSupervision,
          config: configFiles,
          reads: operatorReads,
          redactor: secretRedactor,
          // The SAME outbound holder and stopwatch the Speed-ups Test uses: the Warden spends the Jev key
          // only through it, with the endpoint, model and price `warden.yaml` names.
          guard: settings =>
            new JevTriageGuard(outboundAuthorizer, speedupStopwatch, {
              model: settings.model,
              ...(settings.endpoint === undefined ? {} : { endpoint: settings.endpoint }),
              usdPerMillionInputTokens: settings.usdPerMillionInputTokens,
            }),
          sends: producerSends('Warden'),
          resume,
          revive: {
            events: {
              read: async sessionId => {
                const id = parseSessionId(sessionId);
                const last = storage.findSession(id)?.lastSequence ?? 0;
                // The last page is enough: only the LAST terminal event decides.
                const page = await storage.replay(id, Math.max(0, last - 200), 200).catch(() => undefined);
                return page?.events ?? [];
              },
              emit: async (sessionId, type, data) => {
                await storage.append(parseSessionId(sessionId), type, data as JsonValue).catch(() => undefined);
              },
            },
            // The refusal word is the resume service's own failure name; anything else is just "error".
            resume: async (sessionId, message) => {
              try {
                await sessionResumeSubsystem.resume(sessionId, 'warden', message, {
                  automatic: true,
                  dedupeSharedRecoveryScope: false,
                  expectedStatus: 'failed',
                  humanOperator: false,
                });
                return { ok: true };
              } catch (error) {
                return {
                  ok: false,
                  reason: error instanceof SessionResumeError ? error.failure : 'error',
                };
              }
            },
            // "Answers" means tmux ran and said something definite: a listing, or a clean "no server" (a
            // revive starts one). A hang, a crash message or a thrown spawn is "not yet".
            tmuxReady: async () => {
              const result = await launchTmuxCommands
                .execute(['list-sessions', '-F', '#{session_name}'])
                .catch(() => undefined);
              return result !== undefined && (result.code === 0 || isTmuxServerAbsent(result.stderr));
            },
            sleep: async milliseconds => await Bun.sleep(milliseconds),
          },
          migrate: sessionMigrate,
          analytics: analyticsIngestion,
          events: listener => storage.subscribeEvents(listener),
          livenessSample: async target => await sessionObserver.liveness(target),
          // The pane's tree is read AGAIN here, at the moment of closing, and only the top-level browsers
          // the classifier finds under THIS pane are signalled: a sweep's older look can never close
          // anything else, and the ferret itself is never touched.
          closeLeftoverBrowsers: async sessionId => {
            const observed = await paneProcesses.collect(
              sessionTmuxName(parseSessionId(sessionId), defaultSessionLifecycleSettings),
            );
            if (observed.kind !== 'observed') throw new Error(observed.reason);
            const view = classifyPaneProcesses(observed.processes);
            // A command started since the sweep looked (a new turn) may be using that browser: leave it.
            if (view.toolCommands.length > 0) return 0;
            let closed = 0;
            for (const browser of view.leftoverBrowsers) {
              try {
                process.kill(browser.pid, 'SIGTERM');
                closed += 1;
              } catch (error) {
                // Gone between the look and the signal is already closed; anything else is a real refusal.
                if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
              }
            }
            return closed;
          },
        }),
        sessionReads: operatorReads,
        transcriptImages: createTranscriptImageReader(storage),
        sessionAttach,
        // The Console types into the pane the attach proof names, on the same private tmux server.
        sessionConsole: new SessionConsoleService(sessionAttach, launchTmuxCommands),
        // The Processes tab walks the pane that same attach proof names — that subtree and nothing else —
        // and scrubs every command line and every byte of output with the vault redactor, failing closed.
        sessionProcesses: new SessionProcessService({
          panes: sessionAttach,
          tree: processTreeFor(),
          provenance: new HarnessProcessProvenance(CLIENT_NAME, new ProjectMcpServers()),
          files: new RegularOutputFile(),
          signals: new SigtermProcessSignal(),
          transcript: createSessionTranscriptTail(storage),
          redactor: secretRedactor,
          history: new ProcessHistory(),
          clock: { nowMs: () => Date.now() },
          refusedOutputRoots: [paths.home],
        }),
        // A permission answer re-reads and types into that same proved pane, and nothing else.
        sessionPermission: (() => {
          const typing = new SessionConsoleService(sessionAttach, launchTmuxCommands);
          const capture = new ProvedPaneCapture(sessionAttach, launchTmuxCommands);
          return new SessionPermissionService(
            {
              capture: async id => await capture.capture(id),
              write: async (id, bytes) => await typing.write(id, bytes),
            },
            milliseconds => Bun.sleep(milliseconds),
          );
        })(),
        // A dialog answer does the same, on the same proved pane.
        sessionDialog: (() => {
          const typing = new SessionConsoleService(sessionAttach, launchTmuxCommands);
          const capture = new ProvedPaneCapture(sessionAttach, launchTmuxCommands);
          return new SessionDialogService(
            {
              capture: async id => await capture.capture(id),
              write: async (id, bytes) => await typing.write(id, bytes),
            },
            milliseconds => Bun.sleep(milliseconds),
          );
        })(),
        configChanges: {
          handler: downstream => configChangeStream.handler(downstream),
          announce: kinds => configChanges.announce(kinds),
        },
        // ONE feed over ONE opened storage: live listeners cannot see another daemon's appends, and
        // the fleet backfill refuses if any indexed session has lost the journal its marker owes.
        // Feeds opening together share ONE queued backlog pass, a feed that closes stops waiting, and
        // the pass yields to session writes until it runs (`SharedFleetBacklog`, `fleetBacklog`).
        fleetEvents: new FleetEventStreamService(
          ((): FleetEventSource => {
            const backlogs = new SharedFleetBacklog(storage);
            return {
              replay: async (sessionId, afterSequence, limit, signal) => {
                signal.throwIfAborted();
                const page = await storage.replay(parseSessionId(sessionId), afterSequence, limit);
                signal.throwIfAborted();
                return page.events;
              },
              fleetBacklog: async (limit, signal) => await backlogs.backlog(limit, signal),
              subscribe: listener => storage.subscribeEvents(listener),
            };
          })(),
          {
            after: (milliseconds, action) => {
              const timer = setTimeout(action, milliseconds);
              return { cancel: () => clearTimeout(timer) };
            },
          },
          liveActivity,
          // `?transcript=1`: the proved transcript, heard through the one hub every other watcher shares.
          new FileTranscriptChanges({
            file: async sessionId => {
              const id = tryParseSessionId(sessionId);
              return id === undefined ? undefined : await transcriptFileOf(id);
            },
            stat: async file =>
              await stat(file).then(
                found => ({ size: found.size, mtimeMs: found.mtimeMs }),
                () => undefined,
              ),
            files: fileEvents,
            clock,
          }),
        ),
        // Built above, and the same instance the fleet mount confirms a change through. See its
        // definition for why one instance rather than two.
        grants,
        // One device's own grants (B5): the pairing service holds them, the daemon-wide answer is the
        // other half of `effective`, and a change reaches open streams and the grant journal.
        deviceGrants: new DeviceGrantService({
          devices: pairing,
          daemonWide: () => grants.enforced(),
          audit: new JournalGrantAudit(paths.grantAudit, stateFiles),
          clock: new SystemGrantClock(),
          clientName: CLIENT_NAME,
          changed: () => deviceConnections.recheckAll(),
        }),
      };
      return {
        ...mounted,
        // Built after the rest because it reads three of them: the session directory, and the project
        // catalogue and worktree service that say which folders are KNOWN roots a project write may use.
        // The fleet half goes through the very catalogue service Settings applies reviewed changes with.
        sessionMcp: createSessionMcpSubsystem({
          sessions: mounted.sessions,
          projectRoots: knownProjectRoots(mounted.catalogs, mounted.worktrees),
          files: new FileMcpProjectFiles(),
          fleet: mounted.fleetCatalog,
        }),
        mcpInventory: (() => {
          mcpFolderSources.known = mcpInventoryFolders(mounted.catalogs, mounted.worktrees);
          mcpFolderSources.ferrets = async () => (await mounted.sessions.list()).map(view => view.config.cwd);
          const inventory = new McpInventoryService({
            accounts: mcpAccounts,
            components: async () =>
              (await mounted.fleetCatalog.components()).kinds
                .filter(group => group.kind === 'mcp')
                .flatMap(group => group.components)
                .map(component => ({
                  name: component.name,
                  runtimes: component.usedBy.runtimes,
                  ...(component.detail.kind === 'mcp' && component.detail.auth === 'oauth'
                    ? { auth: 'oauth' as const }
                    : {}),
                })),
            folders: mcpFolders,
            connections: async () => await mcpOAuth.connections(),
            documents: mcpDocuments,
            sessions: mounted.sessions,
          });
          return {
            inventory,
            check: new McpCheckService({
              inventory,
              probe: new TransportMcpProbe(),
              launchEnvironment: async runtime => {
                const account = (await mcpAccounts()).find(candidate => candidate.runtime === runtime);
                return account === undefined ? {} : await accountLaunchEnvironment.forWrapper(account.wrapper);
              },
              baseEnvironment: () => mcpCheckBaseEnvironment(process.env),
              bearer: async (subject, url) => {
                const names = mcpOAuthSecretNames(subject, url);
                await mcpOAuth.refreshForLaunch([names.access]);
                return (await secretVault.values()).get(names.access);
              },
              redactor: secretRedactor,
              now: () => millisecondClock.now(),
            }),
          };
        })(),
      };
    },
    credentials: new StateApiCredentials(paths, stateFiles),
    clock: millisecondClock,
    sttEnhancement: new SttEnhancementService(outboundAuthorizer, speedupStopwatch, {
      cleanup: () => configFiles.current().evaluation.effective.voice.postProcessing,
      // One line per call, sizes and reasons only: the report type has no field a transcript could ride in.
      report: report =>
        process.stdout.write(
          `${JSON.stringify({ at: new Date().toISOString(), type: 'stt.enhance', data: report })}\n`,
        ),
    }),
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
  /**
   * The loop's own heartbeat, armed BEFORE anything that could block it.
   *
   * The lag meter names every stall in the journal with the work that was running, and the watchdog —
   * on its own thread — ends a process whose loop has stopped altogether, so its service manager can
   * replace it. Both exist because a real daemon sat alive and silent for minutes at a time and nothing
   * inside or outside it could say why (see `lib/runtime/liveness.ts`).
   */
  const activities = world.boot.activities;
  const progress = world.boot.beginProgress();
  const ioPressure = world.boot.ioPressure ?? NO_IO_PRESSURE;
  const stopIoPressure = world.boot.ioPressure?.start();
  const meter = new EventLoopLagMeter(
    world.clock,
    activities,
    DEFAULT_EVENT_LOOP_LAG_POLICY,
    stall => {
      world.notices.state(describeLoopStall(stall));
      world.boot.performance?.stall(stall);
    },
    teeStackSampler(
      (await world.boot.stackSampler?.()) ?? NO_STACK_SAMPLER,
      world.boot.performance ?? NO_PERFORMANCE_PROBE,
    ),
    ioPressure,
  );
  const watchdog = world.boot.watchdogLimitMs > 0 ? world.boot.watchdog(world.boot.watchdogLimitMs) : NO_WATCHDOG;
  const lagTicks = setInterval(() => {
    meter.tick();
    if (world.boot.performance?.recording === true) world.boot.performance.loopTick(meter.view().lagMs);
    watchdog.beat(activities.inFlight());
  }, DEFAULT_EVENT_LOOP_LAG_POLICY.intervalMs);
  // Every child this daemon starts is counted by program and subcommand while a profile records. It is
  // released with the heartbeat: both observe the whole process, and both are armed before anything else.
  const uncountChildren =
    world.boot.performance === undefined
      ? () => undefined
      : instrumentChildProcesses(world.boot.performance, world.clock, Bun, () => activities.current());
  cleanups.push(() => {
    clearInterval(lagTicks);
    stopIoPressure?.();
    watchdog.stop();
    uncountChildren();
  });
  // The shared tmux control client, ended and WAITED OUT before anything else is released: a client left
  // to notice this process's exit is still on its server after the process has gone (see `stop`). Any
  // tmux command a later cleanup sends takes a process of its own, as it does whenever no client is there.
  cleanups.push(async () => {
    await world.tmuxControl.stop();
  });
  const liveness: DaemonLivenessSource = {
    pid: process.pid,
    boot: () => progress.snapshot(),
    loop: () => meter.view(),
  };

  // Registered for release immediately: an exception from anything below must not leave the lock
  // behind, because a stale lock fails the NEXT start for a reason unrelated to what broke.
  progress.enter('opening the state home');
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
  // Live sockets end BEFORE storage closes, and cleanups run in registration order. A terminal stream
  // polls the pane through the lifecycle service, which reads storage: closed first, a poll in flight
  // fails and the viewer is told 1011 "terminal redraw failed" instead of the 1000 "daemon shutting
  // down" it is owed. The host does not exist yet, so this is bound once it does.
  let closeLiveSockets: () => void = () => {};
  cleanups.push(() => {
    closeLiveSockets();
    return opened.storage.close();
  });
  world.notices.step('state home opened', opened.paths.home);

  progress.enter('loading configuration');
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
  progress.enter('choosing the address');
  const decided = await decideAddress(world, loaded);
  if ('exitCode' in decided) {
    world.notices.state(decided.message);
    return decided.exitCode;
  }
  const decidedConfig = decided.config;
  // Read ONCE for this boot and handed to every surface that reports a harness, so the milestone
  // below and the doctor route this daemon serves cannot disagree about which `claude` is here.
  const harnessDiscovery = harnessDeclarations(decidedConfig, world.userHome);
  for (const key of supersededCarrierKeys({ rawDocument: peeked.document ?? {}, carriers: decidedConfig.carriers })) {
    world.notices.state(
      `the legacy "${key}" key in ${world.config.path} is superseded by its explicit carriers entry and has no effect`,
    );
  }
  // Recorded exactly when THIS BOOT chose the address, which is the only case where the document
  // does not already say it: a recorded port is already written, and a port named on the command
  // line was said about this run only and must not be turned into a claim on disk behind the
  // operator's back. Recording is what makes choosing safe — the next boot binds this or refuses.
  const portComesFromBind = choosesPortAtBind(decidedConfig);
  if (!loaded.portIsRecorded && !portComesFromBind) {
    await world.config.record(decidedConfig.port);
    world.notices.step('address recorded', `${world.config.path} now claims port ${String(decidedConfig.port)}`);
  }
  // Stated rather than refused: advertising an address other than the bound one is a real deployment
  // (a proxy, a tunnel), and it is also what a home written before derived values stopped being
  // persisted looks like. Either way the operator is the one who can tell which, so say it.
  if (advertisesForeignAddress(decidedConfig))
    world.notices.state(foreignAdvertisementNotice(decidedConfig.bindUrl, decidedConfig.publicUrl, world.config.path));
  /**
   * The address is bound HERE — as soon as it is decided, and before every step that can take time.
   *
   * It used to be bound last, after the pairing identity, the analytics index, every subsystem, the
   * grants and a full first self-check: on a real fleet that was twenty seconds of a closed port every
   * boot, and indefinitely when one step stalled, with nothing outside the process able to tell that
   * from a crash. The staged surface answers `/healthz` with the step in progress from this moment on
   * and refuses every other route with a 503 naming it, until the boot mounts the real dispatchers below.
   *
   * The address is still bound with the same retry, refused in the same words, and served with the same
   * CORS origins and loopback rule — all of which depend only on the configuration decided above. The
   * bind retry is because the common restart is "the outgoing daemon is still draining its socket" —
   * kteam's own supervisor hit that window routinely and reported a permanent failure for a condition
   * that clears in a second.
   */
  const startedAtMs = world.clock.now();
  const surface = new StagedApiSurface(world.clock, startedAtMs, liveness);
  progress.enter('binding the address');
  let server: ApiServerHandle;
  // Read on every request, so an OS-chosen port can correct the list once the bind has told it.
  let originsAdmitted = browserOrigins(decidedConfig);
  try {
    server = await world.boot.binder.bind(
      async () =>
        await world.api.listen(
          {
            http: surface.http,
            sockets: surface.sockets,
            get corsOrigins() {
              return originsAdmitted;
            },
          },
          {
            host: decidedConfig.host,
            port: decidedConfig.port,
            // A loopback peer is privileged only on a loopback-only direct bind. A wildcard bind
            // can still have a local reverse proxy forwarding a remote browser, so Bun's immediate
            // peer is never enough proof there — even when its public URL is the pairing remedy.
            directLoopbackIsPrivileged: mayTrustDirectLoopback(decidedConfig),
          },
        ),
    );
  } catch (error) {
    // A REFUSAL, not a crash. The address was probed and looked free, so arriving here means the
    // host will not let this daemon listen there — a privileged port, a host name that resolves to
    // no local interface, or something that took the address in the interval. All three are the
    // operator's to resolve, and a stack trace about a socket says none of it. The exit is non-zero,
    // so a service manager never mistakes a daemon that could not bind for one that is serving.
    const refusal = refuseUnbindableAddress(
      decidedConfig.bindUrl,
      error instanceof Error ? error.message : String(error),
      world.config.path,
    );
    world.notices.state(refusal.message);
    return refusal.exitCode;
  }
  // Sockets are closed by the cleanup registered ahead of storage (see `closeLiveSockets`); the host
  // stops after, so a live terminal stream's redraw timer is told it is over while its socket exists.
  closeLiveSockets = () => server.closeSockets();
  cleanups.push(() => server.stop());
  // Everything below reads the address the socket really has. For an OS-chosen port that is the first
  // moment it exists, and writing it down here is what lets whoever started this daemon find it.
  const config = portComesFromBind ? configuredAt(decidedConfig, server.port) : decidedConfig;
  if (portComesFromBind) {
    originsAdmitted = browserOrigins(config);
    await world.config.record(config.port);
    world.notices.step('address recorded', `${world.config.path} now claims port ${String(config.port)}`);
  }
  world.notices.step('listening', `${config.bindUrl} — answering /healthz while the boot continues`);
  /**
   * The runtime relay advertisement is read ONCE, here, before either consumer receives the set.
   * Construction below receives these sources rather than the directory, so no second read can hide
   * inside a carrier factory. A duplicate that only becomes visible after discovery is a boot
   * refusal: silently dropping one entry would choose between the operator's relay and the hosted
   * one on their behalf, and that choice would change when the directory changes.
   */
  progress.enter('reading the relay advertisement');
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
  // ONE OWNER, read by pairing redemption and `GET /v1/carriers` alike. Direct and relays are fixed
  // for this boot; the tunnel joins it while its connector is registered and leaves when it is not.
  const carriers = new PublishedCarrierSet(
    directCarrier.kind === 'published' ? directCarrier.url : undefined,
    relaySources,
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
  progress.enter('checking agent harnesses');
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
  if (!harnesses.ready) world.notices.state(harnessAbsentWarning(harnesses, CLIENT_NAME));
  // The two retired daemon.json keys that are tolerated rather than refused: each said once, every boot
  // it is still there, so the operator can delete it.
  if (config.retiredAccountModel) world.notices.state(RETIRED_ACCOUNT_MODEL_NOTICE);
  if (config.retiredFleetBlock) world.notices.state(RETIRED_FLEET_BLOCK_NOTICE);
  const agendaNotice = agendaBlockNotice(config.agendaSpelling);
  if (agendaNotice !== undefined) world.notices.state(agendaNotice);
  if (config.sessionWorkers.enabled === false) world.notices.state(RETIRED_SESSION_WORKERS_SWITCH_NOTICE);

  progress.enter('opening the usage feed');
  const usage = await world.createUsageFeed(config);
  progress.enter('opening the pairing identity');
  const pairing = await world.createPairing(config, world.clock, carriers, discoverableRelayUrl(relaySources));
  world.notices.step('pairing identity opened');
  if (pairing.securityNotice !== undefined) world.notices.state(pairing.securityNotice);
  if (pairing.unlockNotice !== undefined) world.notices.state(pairing.unlockNotice);
  // NO COMPATIBILITY, SAID ONCE. A `devices.json` from before device keys held bearer-token grants
  // nothing can accept any more; the repository dropped them, and the operator is told how many
  // devices have to pair again rather than discovering it one phone at a time.
  if (pairing.droppedBearerGrants > 0)
    world.notices.state(
      `${pairing.droppedBearerGrants} paired device${pairing.droppedBearerGrants === 1 ? '' : 's'} from before device keys ${pairing.droppedBearerGrants === 1 ? 'was' : 'were'} removed; pair ${pairing.droppedBearerGrants === 1 ? 'it' : 'them'} again with \`${CLIENT_NAME} pair\``,
    );
  const idleExpired = await pairing.subsystem.expireIdleDevices();
  if (idleExpired > 0)
    world.notices.state(
      `${idleExpired} paired device${idleExpired === 1 ? '' : 's'} unused for ${pairing.security.current().idleExpiryDays} days ${idleExpired === 1 ? 'was' : 'were'} removed`,
    );
  progress.enter('loading API credentials');
  /** Which key a session must prove, answered by the pairing state machine that owns the grants. */
  const sessionDevices: RelayDeviceDirectory = {
    deviceKey: async deviceId => await pairing.subsystem.deviceKey(deviceId),
    seen: deviceId => pairing.subsystem.seen(deviceId),
    rotateBy: deviceId => pairing.stepUp.rotateBy(deviceId),
  };
  const base = {
    credentials: {
      ...(await world.credentials.load()),
      devices: {
        has: (deviceId: string) => pairing.credentials.get(deviceId) !== undefined,
        grants: (deviceId: string) => pairing.credentials.get(deviceId)?.grants,
      },
    },
    usage,
    clock: world.clock,
    startedAtMs,
    liveness,
  };
  // `healthIntervalSeconds` was declared in `config/daemon.json` and read by nothing, because no
  // self-check ran to have a cadence. It is the operator's number now — and the wedge threshold moves
  // WITH it, because "the event loop stopped running" means three missed ticks rather than a fixed
  // three minutes. One settings object serves the service, its consistency pass and the timer below,
  // so the period the daemon fires on cannot drift from the period the detector measures against.
  const healthSettings = sessionHealthSettingsAt(config.healthIntervalSeconds * 1_000);
  const health = world.createSessionHealth(opened.storage, healthSettings, meter);
  const projects = new FileProjectCatalog(join(opened.paths.state, 'projects.json'));
  /**
   * A ferret runs against its runtime's own home under `fleet/homes`, not the daemon's, so the skills a ferret
   * sees are read from the manifest's home for that wrapper. A manifest that is missing or unreadable is "no
   * fleet account", which falls back to the daemon's home rather than refusing a skills list.
   */
  const runtimeHomes = async (): Promise<readonly SkillRuntimeHome[]> => {
    const manifest = await readFleetManifest(opened.fileSystem, opened.paths.fleetManifest).catch(() => undefined);
    if (manifest === undefined) return [];
    return manifest.accounts.map(account => ({
      harness: account.kind,
      home: account.home,
      runtimes: [
        wrapperNameOf(account.wrapper),
        ...manifestRuntimes(manifest)
          .filter(runtime => runtime.id === account.id)
          .map(runtime => wrapperNameOf(runtime.wrapper)),
      ].filter((name, index, names) => names.indexOf(name) === index),
    }));
  };
  const skillsInventory = new SkillsInventoryService({
    files: new NodeSkillFiles(),
    homes: runtimeHomes,
    projects: async () => (await projects.projects()).map(({ id, name, path }) => ({ id, name, path })),
    fleetDirectory: opened.paths.fleet,
    assetsDirectory: join(opened.paths.fleet, 'assets'),
    userHome: world.userHome,
  });
  const skills = new NodeCatalog({
    home: world.userHome,
    runtimeHome: async session => {
      const name = wrapperNameOf(session.config.agent);
      return (await runtimeHomes()).find(
        entry => entry.harness === session.config.harness && entry.runtimes.includes(name),
      )?.home;
    },
  });
  const catalogs = {
    projects: () => projects.projects(),
    registerProject: (request: RegisterProjectRequest) => projects.register(request),
    skills: (session: SessionView) => skills.skills(session),
    skillsInventory: () => skillsInventory.machine(),
    sessionSkillsInventory: (session: SessionView) => skillsInventory.session(session),
    skillFile: async (path: string, session?: SessionView) =>
      await skillsInventory.file(path, [
        ...(await skillsInventory.machinePaths()),
        ...(session === undefined ? [] : (await skillsInventory.session(session)).skills),
      ]),
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
  progress.enter('opening the analytics index');
  const analyticsStore = await world.analyticsIndexes.open(opened.paths, opened.fileSystem);
  cleanups.push(() => analyticsStore.store.close());
  world.notices.step('analytics index opened', analyticsStore.rebuildRequired ? 'a rebuild is required' : undefined);
  progress.enter('building the WebRTC carrier');
  /**
   * THE PEER-TO-PEER CARRIER (`docs/relay-protocol.md` §16), decided once and built before the subsystems
   * because its signalling is a mounted route.
   *
   * Its SESSIONS are the direct carrier's, and the direct carrier needs the dispatcher this boot builds
   * after the subsystems — so the carrier reads its session factory through a binding assigned once the
   * direct carrier exists. Nothing reads it before then: a session opens only on a data channel, and a
   * data channel exists only after an offer this daemon answered while serving. A daemon whose direct
   * carrier is refused has no identity to sign a handshake with, so a channel is closed at once.
   *
   * THE BOOT ASKS THE ENGINE NOTHING. Proving it here loaded a native library on the startup path (0.4 s
   * on a Mac) and left one thread per core running for the daemon's life with no phone in sight; the first
   * offer starts it instead, `fyd --check` still proves it, and an engine that will not start is the same
   * `webrtc_unavailable` answer a device was told before.
   */
  let openWebRtcSession: WebRtcSessionFactory | undefined;
  const webrtcAvailability: WebRtcAvailability = config.webrtc.enabled
    ? { kind: 'ready' }
    : {
        kind: 'refused',
        code: 'webrtc_disabled',
        reason: `peer-to-peer connections are switched off in ${world.config.path}`,
      };
  world.notices.step('webrtc', config.webrtc.enabled ? WEBRTC_ENGINE_ON_DEMAND : 'switched off in the configuration');
  const webrtc = new WebRtcCarrier({
    availability: webrtcAvailability,
    engine: world.webrtcEngine,
    iceServers: config.webrtc.iceServers,
    sessions: (arrival, downstream, release) => openWebRtcSession?.(arrival, downstream, release),
    scheduler: {
      after: (milliseconds, action) => {
        const handle = setTimeout(action, milliseconds);
        return { cancel: () => clearTimeout(handle) };
      },
    },
    peerId: () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url'),
  });
  cleanups.push(() => webrtc.close());
  /**
   * THE TUNNEL SWITCH (`docs/relay-protocol.md` §15), built before the subsystems because
   * `/v1/tunnel` is a mounted route, and started below, after the relays. The tunnel is opt-in: a
   * document that names no tunnel implies one switched off, and `fy daemon tunnel on` or a paired
   * device's `PUT /v1/tunnel` turns it on without a restart.
   */
  const tunnel = new TunnelCarrierSwitch({
    entry: config.carrierSet.tunnel,
    explicit: declaresTunnelCarrier(config.carriers),
    store: world.tunnelEntry,
  });
  // Registered before anything can start it: the listener and the child it may take must be released
  // whether the boot completes or not.
  cleanups.push(async () => await tunnel.stop());
  progress.enter('mounting subsystems');
  // Built here rather than inside `createSubsystems` because it needs the storage this boot opened,
  // and threading it through the same seam as the other host adapters is what lets a test replace
  // the one thing a revive cannot do twice on a developer's machine: kill and respawn a real pane. The
  // boot's interrupted-launch pass asks the same launcher whether a pane is there.
  const reviver = world.createResumeLauncher(
    opened.storage,
    async id => await world.createSessionLaunch(opened.storage).relaunch(id),
  );
  const createdSubsystems = world.createSubsystems(
    opened.storage,
    world.terminalRuntime,
    usage,
    health,
    world.sessionLauncher,
    reviver,
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
    pairing.stepUp,
    pairing.security,
    carriers,
    tunnel,
    webrtc,
    harnessDiscovery,
    world.browserLauncher,
    config.sessionWorkers,
    config.attention,
    config.delivery,
  );
  // The older wire names (`legacy: true` routes) are counted into `<home>/legacy-wire-use.json` and shown on
  // `GET /v1/health`, so the release that removes them can wait for a quiet fortnight. A file that cannot be
  // read starts the counter again; nothing here can fail a request or the boot.
  const legacyWireDiagnostics = { warn: (message: string) => world.notices.state(message) };
  const legacyWire = new LegacyWireUseCounter(
    new FileLegacyWireUseStore(join(opened.paths.home, 'legacy-wire-use.json'), legacyWireDiagnostics),
    systemLegacyWireTimers,
    legacyWireDiagnostics,
  );
  await legacyWire.load();
  cleanups.push(async () => await legacyWire.flush());
  const subsystems: typeof createdSubsystems = {
    ...createdSubsystems,
    health: { ...createdSubsystems.health, legacyWire: () => legacyWire.snapshot() },
    legacyWire,
  };
  // Registered BEFORE the address is bound, like every other acquisition: from here on the daemon can
  // be asked to put an X server, a Chrome and a VNC listener on this host, and whatever it took must
  // be released whether the boot completes or fails part-way.
  cleanups.push(() => world.browserLogin.close());
  cleanups.push(() => world.agentBrowserDisplay.close());
  cleanups.push(() => world.fileEvents.close());
  // A harness sign-in is a child this daemon launched, and a pending `codex login` holds this host's
  // `localhost:1455` while it lives. It ends with the daemon, or the next Codex sign-in finds the port
  // taken by a flow nobody can see any more.
  cleanups.push(async () => await subsystems.harnessLogin.shutdown());
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
   * The grants, read BEFORE the address is bound.
   *
   * A DAEMON THAT CANNOT SAY WHAT IT IS ALLOWED TO DO DOES NOT SERVE. A grant document this boot
   * cannot read as a complete decision is not "everything is allowed" — it is damage, and starting
   * anyway would leave every remote caller refused by a daemon that never said why. The throw is
   * caught by `execute`, which reports it and exits non-zero, so the operator is told which document
   * to repair instead of discovering it as a UI that stopped working.
   */
  progress.enter('reading capability grants');
  await subsystems.grants.refresh();
  world.notices.step('capability grants read');
  // The operator password is gone; a passkey step-up from the paired device replaced it. A verifier an
  // older daemon left behind gates nothing now, so it is deleted rather than left looking like a lock —
  // and said ONCE, so an operator who remembers setting a password learns where it went.
  if (await retireOperatorPassword(opened.paths.retiredOperatorPassword, opened.fileSystem))
    world.notices.step(
      'operator password retired',
      'deleted state/operator-password.json — a passkey confirmation from the paired device replaced it',
    );
  progress.enter('first self-check (reconciling the session index)');
  await health.selfCheck().catch(() => undefined);
  // Launches the previous process had in flight died with it. Settled here, before anything serves and
  // so before anything in this process can be launching: a record left `starting` is otherwise stuck
  // for good. A pass that cannot run leaves them as they were, which the next boot looks at again.
  progress.enter('settling launches a restart interrupted');
  const interrupted = await world.reconcileInterruptedLaunches(opened.storage, reviver).catch(() => undefined);
  if (interrupted !== undefined && interrupted.failed.length > 0)
    world.notices.state(
      `${String(interrupted.failed.length)} launch${interrupted.failed.length === 1 ? '' : 'es'} interrupted by the restart ` +
        `recorded as failed — resume or stop: ${interrupted.failed.join(', ')}`,
    );
  // Written down BEFORE anything is attempted: the host can go down again mid-pass, and what is owed
  // must survive that. Nothing is resumed yet — the daemon is not serving.
  const autoResume = world.createAutoResume(opened.storage, async (id, message) => {
    await subsystems.sessionResume.resume(id, 'daemon', message, {
      automatic: true,
      dedupeSharedRecoveryScope: false,
      expectedStatus: 'failed',
      humanOperator: false,
    });
  });
  await autoResume.recordBootExits().catch(() => undefined);
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
  //
  // The DIRECT carrier is one more socket route on that table: a browser that can reach this address
  // opens its sessions here, and each one runs the same link a rendezvous socket runs. Without the
  // identity there is nothing to sign a handshake with, so no device can reach this daemon directly —
  // which is said out loud rather than left to look like a network fault.
  const direct = await world.createDirectCarrier(
    async request => await dispatcher.dispatch(request),
    {
      upgrade: async request => await socketDispatcher.upgrade(request),
      reauthorize: request => socketDispatcher.reauthorize(request),
    },
    sessionDevices,
    pairing.subsystem,
  );
  if ('refusal' in direct) world.notices.state(`direct sessions unavailable — ${direct.refusal}`);
  else openWebRtcSession = direct.openSession;
  const socketDispatcher = createMountedSocketDispatcher(base, subsystems, 'route' in direct ? [direct.route] : []);
  // Every route is served from here on, on the address bound at the top of this boot. Before this
  // line the staged surface answered `/healthz` alone; after it, every request reaches the very
  // dispatchers a direct bind would have served.
  surface.mount(dispatcher, socketDispatcher);
  progress.serving();
  world.notices.step('serving', 'every route is mounted');
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
    {
      upgrade: async request => await socketDispatcher.upgrade(request),
      reauthorize: request => socketDispatcher.reauthorize(request),
    },
    sessionDevices,
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
  /**
   * THE HOSTED TUNNEL (`docs/relay-protocol.md` §15), after the bind and the relays, for the reason
   * the relays wait for the bind: a boot that hands over to an incumbent must not first take a tunnel.
   *
   * ITS LISTENER IS NOT THIS DAEMON'S API LISTENER. `cloudflared` forwards from this host, so every
   * arrival through it comes from loopback; the tunnel therefore points at a second listener on
   * `127.0.0.1:0` that serves only this daemon's session route and stamps every arrival remote. The
   * route is its OWN instance of the direct carrier's, so tunnel arrivals are admitted against their
   * own bounds — keyed by `CF-Connecting-IP` — rather than sharing a budget with the network's.
   *
   * IT NEVER HOLDS THE BOOT UP AND NEVER FAILS IT. Provisioning talks to a service off this machine;
   * it runs behind `start`, and every failure is a sentence and a carrier that is simply off.
   *
   * THE SWITCH BUILDS ONE CARRIER PER ENTRY: this one now, and a new one each time the tunnel is
   * switched while the daemon runs, each with its own listener.
   */
  tunnel.start((entry, explicit) =>
    world.createTunnelCarrier({
      entry,
      explicit,
      cloudflared: world.cloudflared,
      service: world.tunnelService,
      openListener: async () => {
        const route = await world.createDirectCarrier(
          async request => await dispatcher.dispatch(request),
          {
            upgrade: async request => await socketDispatcher.upgrade(request),
            reauthorize: request => socketDispatcher.reauthorize(request),
          },
          sessionDevices,
          pairing.subsystem,
        );
        if ('refusal' in route) throw new Error(`there is no session route to serve — ${route.refusal}`);
        const listener = await world.api.listen(
          tunnelListenerSurface({
            route: route.route,
            credentials: base.credentials,
            guard: subsystems.grants,
            corsOrigins: browserOrigins(config),
          }),
          { host: '127.0.0.1', port: 0, directLoopbackIsPrivileged: false, remotePeer: tunnelPeer },
        );
        return {
          port: listener.port,
          close: async () => {
            listener.closeSockets();
            await listener.stop();
          },
        };
      },
      publish: url => carriers.tunnel(url),
      notices: world.notices,
    }),
  );
  // The self-check tick, armed only once the daemon is actually serving. Its cadence IS the number
  // the wedge detector measures lateness against, so it comes from the same settings object the
  // service reasons with rather than a constant here — a timer that fired on a different period
  // would make every on-time tick look late.
  //
  // Errors are swallowed rather than propagated: an unhandled rejection from a background timer
  // takes down a daemon whose fleet is fine, and the failure is already visible as the next tick's
  // freshness. The handle is registered for cancellation like every other acquisition, so a stopped
  // daemon does not leave a timer firing at closed storage.
  /**
   * The housekeeping lane: analytics ingestion, the fleet refresh, the terminal reaper and quota
   * failover, run one at a time and only once the lane opens, `backgroundDelayMs` after serving.
   *
   * Every one of them used to fire at boot on its own timer, all at once, while the daemon was trying to
   * answer its first requests — on a large Mac fleet the loop stalled until it answered nothing at all.
   * None of them is needed to serve, so they wait, and then they take turns (see `BackgroundLane`).
   */
  const lane = new BackgroundLane(activities, () => new Promise(resolve => setImmediate(resolve)));
  const laneOpens = setTimeout(() => lane.open(), world.boot.backgroundDelayMs);
  cleanups.push(() => {
    clearTimeout(laneOpens);
    lane.close();
  });
  const ticks = setInterval(() => {
    // `tick` runs as the `self-check` activity, and skips — never overlaps — a check still running.
    void health.tick().catch(() => undefined);
  }, healthSettings.selfCheckIntervalMs);
  cleanups.push(() => clearInterval(ticks));
  // After the daemon is serving, never before: a revive that raced the boot would be a launch the
  // person's first request has to wait behind. Staggered inside the service; a failure is journalled
  // per session, so nothing here needs to surface it.
  void activities.run('auto-resume', () => autoResume.run()).catch(() => undefined);
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
  // AWAITED, so the first tick's reprojection of each session's question state has finished before the
  // turn watcher below starts writing turn state over the same documents — the order every boot before
  // 4.66.0 had. Unawaited, the two started together, and on CI a session read just after an unconfirmed
  // answer came back without its `needsHuman` attention. It is cheap now: it reads only live sessions,
  // one at a time, and every transcript parse yields to the loop.
  progress.enter('declared-wait watcher');
  await activities.run('declared-wait watcher', () => subsystems.monitor.run()).catch(() => undefined);
  const waitTicks = setInterval(
    () => void activities.run('declared-wait watcher', () => subsystems.monitor.run()),
    subsystems.monitor.intervalMs,
  );
  // Whose turn it is. No tick: each running session's worker looks when its pane draws or its transcript
  // changes, and this thread reconciles which session has a worker when something changes — observing on a
  // 2 s cadence only a session no worker has. Spends no tokens.
  subsystems.observer.arm();
  cleanups.push(async () => {
    // The session workers, and the tmux clients they hold, end with the observer — the clients WAITED
    // OUT, as the shared one is: a client left to notice this process's exit is still on its server
    // after the process has gone.
    await subsystems.observer.close();
  });
  cleanups.push(async () => {
    clearInterval(waitTicks);
    await subsystems.monitor.close();
  });
  // Queued restarts: a busy ferret is restarted at its next idle moment, so the queue is looked at on a short tick.
  // Nothing happens when it is empty, and the tick never forces: the in-flight gate decides every time.
  const restartTicks = setInterval(() => {
    void activities.run('restart queue', async () => await subsystems.sessionRestart.drain()).catch(() => undefined);
  }, 10_000);
  restartTicks.unref?.();
  cleanups.push(() => clearInterval(restartTicks));
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
      lane.submit('quota failover', () => subsystems.quotaFailover.run());
    }, failoverIntervalMs);
    cleanups.push(() => clearInterval(failoverTicks));
  }
  /**
   * The unattended fleet evidence pass.
   *
   * It is mounted rather than folded into a route because the point is that `/usage` is already
   * current before a browser or a person requests it. The tick drives the established feed only:
   * `CachedUsageFeed` owns quota caching, shared in-flight work and last-good retention. This loop
   * invents neither a cache nor an error result, so a failed read cannot replace good data with an
   * empty fleet.
   *
   * IT NEVER CHECKS A LOGIN, AND IT MUST NOT BE MADE TO. A login's status is read from what is already
   * stored, and Check now runs only when a person presses it — see the note on `FleetRefreshService`.
   * Spending on an answer nobody requested is the whole defect this pass no longer has.
   *
   * ONE CONFIGURATION NAME chooses the cadence. `usage.interval` is the fleet declaration that
   * builds the usage feed's freshness policy too. A daemon without a fleet configuration has made
   * no cadence choice, so `usageRefreshMs(undefined)` supplies the conservative shared default.
   *
   * ARMED BY THE FLEET READING, NOT A FIXED TIMER (docs/design/housekeeping-worker.md §3.2): at once,
   * then for the moment a credential's active free read falls due — its newest measured passive reading
   * one interval old, the very rule the fixed timer applied — and never because another input changed,
   * which arrives as an event instead. A login whose session is running writes a passive reading every
   * few seconds, so it is never due; an idle one is read once an interval, as before. Each pass is
   * queued for the housekeeping lane, so the first runs once the lane opens rather than at boot.
   */
  cleanups.push(
    await subsystems.fleetRefresh.arm(() => {
      lane.submit('fleet refresh', () => subsystems.fleetRefresh.run());
    }),
  );
  /**
   * The analytics ingestion sweep.
   *
   * THE FIRST PASS IS QUEUED AT BOOT, to run when the housekeeping lane opens, and it is a REBUILD when the store reported that nothing survived
   * being opened — a schema this daemon does not recognise, or a file naming another state home. A
   * daemon that has just restarted is also exactly when the store is most likely to be behind: every
   * session that ended while the process was down went uningested, and the sweep is what catches up.
   *
   * THE PASS IS A SWEEP, and correctness does not depend on when it runs. What decides whether a session
   * is ingested is the durable terminal-state gate, so a session is ingested by whichever pass follows
   * its end with exactly the same result. A cheap pass is the common case: a session already ingested
   * with a proven total has its transcript read once, ever.
   *
   * IT RUNS ON EVENTS, NOT A MINUTE TIMER (docs/design/housekeeping-worker.md §4 PR 4): half a minute
   * after a session ends or a revived one changes what the index holds, soon after the rates may have
   * moved, a minute after a pass that stopped at its read cap — and on a fifteen-minute backstop for
   * what has no event (`ANALYTICS_BACKSTOP_MS`).
   *
   * Errors are swallowed for the reason every other background timer swallows its own: an unhandled
   * rejection from a timer takes down a daemon whose fleet is fine. A pass that could not run leaves
   * the index reporting what it does hold, which is the honest reading.
   *
   * NOT AWAITED. A rebuild over a large fleet reads every finished transcript again, and awaiting it
   * here held back the configuration watcher, the warden, the handover reconciler and the update check
   * behind it — for as long as the rebuild took. Passes are serialized by the service itself, so the
   * timer below queues behind this one rather than racing it, and the analytics view already reports
   * `refreshing` while a pass is outstanding.
   */
  lane.submit(analyticsStore.rebuildRequired ? 'analytics rebuild' : 'analytics ingest', () =>
    analyticsStore.rebuildRequired ? subsystems.analyticsIngest.rebuild() : subsystems.analyticsIngest.ingest(),
  );
  cleanups.push(
    subsystems.analyticsIngest.arm(() => {
      lane.submit('analytics ingest', () => subsystems.analyticsIngest.ingest());
    }),
  );
  // The registry, durable session reader, exact observer and exact reaper the earlier increment
  // stubbed. Identity is re-checked at the moment of the kill, not at planning time.
  //
  // REAPED WHEN A PANE BECOMES REAPABLE, not every 5 s: a pane is reapable once its session is in a terminal
  // status, which this daemon learns the moment it writes one (or journals `session.exited`). A sweep runs
  // a second after that, on the lane, and a slow backstop catches anything else (a session finished while
  // the daemon was down, a write another path made).
  const terminalReaper = world.createTerminalReaper(opened.storage);
  const reapNow = (): void => lane.submit('terminal reaper', () => terminalReaper.sweep());
  let reapSoon: ReturnType<typeof setTimeout> | undefined;
  const reapAfterChange = (): void => {
    if (reapSoon !== undefined) return;
    reapSoon = setTimeout(() => {
      reapSoon = undefined;
      reapNow();
    }, TERMINAL_REAP_SETTLE_MS);
    reapSoon.unref();
  };
  const unsubscribeReapStates = opened.storage.subscribeStates((_id, state) => {
    if (isReapTerminalStatus(jsonObject(state)?.status)) reapAfterChange();
  });
  const unsubscribeReapEvents = opened.storage.subscribeEvents(event => {
    if (event.type === 'session.exited') reapAfterChange();
  });
  reapNow();
  const terminalReapTicks = setInterval(reapNow, TERMINAL_REAP_BACKSTOP_MS);
  cleanups.push(() => {
    clearInterval(terminalReapTicks);
    if (reapSoon !== undefined) clearTimeout(reapSoon);
    unsubscribeReapStates();
    unsubscribeReapEvents();
  });
  // The security log's fold windows close on this tick too, not only on the next record like them: a
  // burst that STOPS must still be written down with its count. Writes a line at most; spawns nothing.
  const auditFlushTicks = setInterval(() => {
    void activities.run('audit flush', () => subsystems.audit.flush()).catch(() => undefined);
  }, AUDIT_FOLD_WINDOW_MS);
  cleanups.push(() => {
    clearInterval(auditFlushTicks);
  });
  // The warden sweep, armed only once the daemon is actually serving — like the self-check above, and
  // for the same reason: a sweep spawns sessions, and it must not race the bind it would report on.
  //
  // It arms LAST because arming fires a boot sweep, and that sweep reads the fleet and may spawn. The
  // disarm is registered like every other acquisition, so a stopped daemon does not leave a timer
  // firing at closed storage. A failure to arm is swallowed for the reason the ticks swallow theirs:
  // a daemon whose fleet is fine must not fail to serve because its supervisor could not start, and
  // the absence is already visible as `wardenTimerArmed: false` on its own health report.
  // The configuration files: first load, editors' schemas, and the watcher (docs/config-files.md).
  progress.enter('arming the configuration watcher');
  cleanups.push(await subsystems.configFiles.arm());
  // Which models Ollama has installed, read once now that the fleet can be republished with them.
  void subsystems.models.refreshLocal().catch(() => undefined);
  /**
   * NOT AWAITED. Arming reads the warden's settings through the configuration service's queue, and on a
   * real Mac whose loop was stalling every few seconds that read took longer than seventeen minutes — the
   * boot sat on "arming the warden" the whole time and never reached ready. Nothing after this line needs
   * the warden, and `wardenTimerArmed` on the health report already says whether it has armed yet. A
   * disarm that arrives after shutdown began is run at once rather than registered too late to be.
   */
  progress.enter('arming the warden');
  let releasing = false;
  cleanups.push(() => {
    releasing = true;
  });
  void subsystems.warden
    .arm()
    .then(disarm => {
      if (releasing) disarm();
      else cleanups.push(disarm);
    })
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
  // The board's GitHub watcher: its first look comes shortly after the bind, then about every half
  // minute; a host without `gh`, or signed out of it, is told once and looked at again later.
  cleanups.push(subsystems.boardGitHub.arm());
  /**
   * The update check, armed after the bind: it asks GitHub once now and then at most every six hours,
   * and moves an update waiting for idle (or an opted-in automatic one) on. A failed check never fails
   * a boot — it is reported on the update view instead.
   */
  cleanups.push(subsystems.daemonUpdate.arm());
  // A state write is how a turn ends, so it is when an update waiting for idle looks again.
  cleanups.push(opened.storage.subscribeStates(() => subsystems.daemonUpdate.activityChanged()));
  /**
   * The send tracker, armed after the bind like every loop that can type into a pane: a send proven
   * absent is re-attempted. Arming re-derives every in-flight send from its transcript — a restart
   * re-types nothing it cannot prove absent — and the disarm cancels the one pending look per session.
   */
  cleanups.push(subsystems.sendTracking.arm());
  // Re-proves the pre-queue "not delivered" rows once, one session at a time, behind the tracker's lock.
  void subsystems.sendReproof.run().catch(() => undefined);
  cleanups.push(() => subsystems.sendReproof.stop());
  // The queue's deliverer looks once at every session for what a restart left open. Its stop is the FIRST
  // thing a shutdown does: a send answers once its message is on disk, so one sent just before a stop is
  // being typed while the daemon goes down, and the tmux client it types through is released below.
  void subsystems.queueDelivery.arm().catch(() => undefined);
  cleanups.unshift(async () => await subsystems.queueDelivery.stop());
  // The line an operator greps for. Everything above it is a step that can stall; a log that reaches
  // here and stops is a daemon that is serving, which is a completely different report from one that
  // stops at "state home opened" — and before any of this existed the two were the same empty file.
  progress.finish();
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
    harnessDeclarations(config, world.userHome),
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
    // The same socket the boot serves (`paths.home/tmux.sock`); a check never starts a server on it.
    tmuxRelease: await (async () => {
      try {
        const executable = Bun.which('tmux') ?? FALLBACK_TMUX;
        const server = new BunTmuxProcess(executable, join(world.stateHome.path, 'tmux.sock'));
        return await new TmuxReleaseReader(executable, server).read();
      } catch {
        return undefined;
      }
    })(),
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
   * IT READS, IT DOES NOT CREATE: the posture is a function of the document already read, so a query
   * stays a query and there is no second source to drift.
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
    // The tunnel, read through the boot's own order: the locator first, the service only when there is
    // a `cloudflared` to run — so this command makes no request a boot would not.
    const tunnelEntry = config.carrierSet.tunnel;
    const tunnelLocation = tunnelEntry.enabled ? world.cloudflared.locate() : undefined;
    const tunnelAvailability = tunnelLocation?.kind === 'found' ? await world.tunnelService.read() : undefined;
    say(
      describeTunnelPosture({
        entry: tunnelEntry,
        explicit: declaresTunnelCarrier(config.carriers),
        configFile: world.config.path,
        location: tunnelLocation,
        availability: tunnelAvailability,
      }),
    );
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
  // The peer-to-peer engine, beside the carriers it will join. Proved rather than assumed — a native
  // library is the one dependency a build machine can have and a host can lack — and it never changes
  // the exit code: a daemon without it starts, and devices reach it directly or through the relay.
  if (config.webrtc.enabled) {
    const webrtcEngine = await world.webrtcEngine.selfTest();
    say(`webrtc       ${describeWebRtcEngine(webrtcEngine)}`);
  } else {
    say(
      `webrtc       switched off in ${world.config.path} — devices reach this daemon directly or through the relay instead`,
    );
  }
  // The worker threads this binary carries, each started for real. Like the engine above it never changes
  // the exit code: the daemon serves without them, but the feature each one runs does not work.
  const workerProbes = await world.probeWorkers();
  say(`workers      ${describeWorkerProbes(workerProbes)}`);
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
      carrier: carrierForGrants,
    }))
      say(line);
  }
  const checkExitCode = Math.max(doctor.ready ? 0 : 1, carrierExitCode);
  if (choosesPortAtBind(config)) {
    say('address      the operating system will assign the port when this daemon starts, and it is then recorded');
    return checkExitCode;
  }
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
  // A boot listens for SIGINT/SIGTERM from its first instant: interrupted before it serves, it releases
  // what it has acquired — including what the still-running boot registers until the very moment it
  // exits — and exits; once serving, the signal ends the wait below as always.
  const gate =
    answer.kind === 'boot'
      ? terminationGate(
          async () => {
            notices.state('stopping during boot — releasing what this boot acquired so far');
            await releaseAcquired(cleanups);
          },
          code => process.exit(code),
          process,
          () => cleanups.length > 0,
        )
      : undefined;
  try {
    const world = {
      ...buildWorld(answer.overrides, { userHome: resolveUserHome() }),
      notices,
      ...(gate === undefined ? {} : { untilShutdown: () => gate.untilShutdown() }),
    };
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
  // The engine options the service definition hands this process (`BUN_JSC_*`: the stack sampler's
  // interval, the collector's marker threads) were read when the VM started. They are this process's
  // alone: dropped here, before anything is spawned, so an agent — Claude Code runs on Bun too — starts
  // on its own engine's defaults rather than on a daemon's tuning.
  for (const name of Object.keys(process.env)) if (name.startsWith('BUN_JSC_')) delete process.env[name];
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
