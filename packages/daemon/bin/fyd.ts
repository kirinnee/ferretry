#!/usr/bin/env bun
import { join } from 'node:path';
import {
  type LearningConfig,
  SessionConfigSchema,
  SessionStateSchema,
  type SessionView,
  TERMINAL_MAX_GLOBAL,
  TERMINAL_MAX_PER_SESSION,
} from '@ferretry/protocol';
import pkg from '../package.json' with { type: 'json' };
import {
  BrowserWorkerClient,
  BunApiServer,
  BunProcessProbe,
  BunCommandRunner,
  BunSqliteIndexFactory,
  CachedUsageFeed,
  CommandUsageSource,
  DaemonBinder,
  DaemonHealthProbe,
  DaemonReadinessWaiter,
  DaemonStorageFactory,
  DaemonSecretsLoader,
  StateHomeLockedError,
  type OpenedDaemonStorage,
  BunSecretShell,
  daemonSecretSourceProgram,
  FileDaemonConfig,
  FileRoutingCatalog,
  HttpUsageSource,
  KeyedSerialExecutor,
  ManifestAccountInventory,
  RuntimeEnvironment,
  SocketViewerDownstream,
  PaneProcessInventory,
  TmuxPaneSnapshot,
  SqliteHomeLockFactory,
  StateApiCredentials,
  StateFileSystemFactory,
  StateHomeLayout,
  StateFileSystem,
  SystemClock,
  SystemFrameClock,
  type ViewerSocket,
  type WorkerClientOptions,
} from '../src/adapters/index.ts';
import { FileAttentionLedgerRepository } from '../src/adapters/attention/file-attention-ledger-repository.ts';
import { FileLearningStore } from '../src/adapters/learning/index.ts';
import { FilePinRepository, FilePinSessionDirectory } from '../src/adapters/pins/index.ts';
import { BunGitRunner } from '../src/adapters/git/index.ts';
import { NodeTranscriptSource } from '../src/adapters/transcript/index.ts';
import {
  GitWorktreeGateway,
  ManagedWorktreeAdapter,
  NodeWorktreeFileSystem,
  SystemWorktreeClock,
  WorktreeOperationQueue,
} from '../src/adapters/worktrees/index.ts';
import { NodeWardenReportFileSystem, WardenReportReader } from '../src/adapters/warden/index.ts';
import {
  FileSessionTaskStore,
  NodeWorkingDirectoryResolver,
  StorageSessionLifecycleRepository,
  TimeSessionIdFactory,
  TmuxSessionLifecycleLauncher,
} from '../src/adapters/session/lifecycle/index.ts';
import { TmuxCodexPickerPane } from '../src/adapters/session/harness/index.ts';
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
  ManagedTerminalService,
  TerminalRuntimeError,
  TerminalServiceError,
  TerminalStreamBridge,
  TmuxTerminalRuntime,
  type TerminalStreamScheduler,
} from '../src/adapters/terminal/index.ts';
import { BunTmuxProcess } from '../src/adapters/tmux/index.ts';
import {
  FileTaskStore,
  KeyedSerialExecutor as TaskBoardSerialExecutor,
  TaskRecordService,
} from '../src/adapters/tasks/index.ts';
import type { DaemonStorage } from '../src/adapters/storage/session-storage.ts';
import {
  AttentionService,
  BrowserViewerStream,
  EXIT_ALREADY_RUNNING,
  createMountedDispatcher,
  createMountedSocketDispatcher,
  PinService,
  SessionPlanner,
  TeamAdvisor,
  createFoundationPaths,
  createSessionPaths,
  createWardenPaths,
  defaultSessionLifecycleSettings,
  defaultStartWaitPolicy,
  packageRole,
  parseSessionId,
  resolveStateHome,
  SelfRestartCoordinator,
  SessionHealthService,
  SessionLifecycleConfigSchema,
  RecommendError,
  type RecommendSubsystem,
  type RoutingCatalogPort,
  SessionReadError,
  type SessionDirectorySubsystem,
  TaskError,
  tryParseSessionId,
  type AnalyticsSubsystem,
  type AssigneeObservation,
  type DaemonHealthSubsystem,
  type FinishedAnalyticsSession,
  type FoundationPaths,
  type LearningSubsystem,
  type ScratchReclamation,
  type TaskSubsystem,
  TerminalMountError,
  type TerminalRuntimePort,
  type TerminalSessionResolver,
  type TerminalSubsystem,
  type NameClaim,
  type NameSubsystem,
  normalizeCallsign,
  CALLSIGN_WINDOW_MS,
  SessionLifecycleService,
  SessionResumeService,
  sessionHealthSettingsAt,
  type SessionHealthSettings,
  defaultSessionResumeSettings,
  CodexPickerCleanup,
  HarnessQuirkService,
  SessionProvenanceStamper,
  TmuxController,
  type BrowserViewerHost,
  MigrationPreflight,
  usageProbeCommand,
  type ApiServerHandle,
  type ApiServerPort,
  type DaemonConfig,
  type DaemonReadinessPorts,
  type MillisecondClockPort,
  type MountedSubsystems,
  type SessionId,
  type UsageFeedPort,
  ClaudeTranscriptParser,
  CodexTranscriptParser,
  searchTranscript,
  type TranscriptEvent,
  type TranscriptSearchMatch,
  type TranscriptSearchOptions,
  type TranscriptSource,
} from '../src/lib/index.ts';

// Identity is single-sourced from package.json, matching the CLI's composition root.
const DAEMON_NAME = Object.keys(pkg.bin ?? {})[0] ?? pkg.name;

/** The CLI a human drives. Named here rather than derived, because the daemon
 *  package cannot read the CLI package's `bin` without depending on it. */
const CLIENT_NAME = 'fy';

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
  readonly worktrees: ManagedWorktreeAdapter;
  readonly boot: {
    readonly probe: DaemonHealthProbe;
    readonly binder: DaemonBinder;
  };
  readonly createReadinessWaiter: (ports: DaemonReadinessPorts, daemonLog: string) => DaemonReadinessWaiter;
  readonly config: FileDaemonConfig;
  readonly secrets: DaemonSecretsLoader;
  /** The destructive-migration safety gate: it inventories in-flight work and refuses to migrate
   *  a session whose work cannot be shown to survive the relaunch. */
  readonly migratePreflight: MigrationPreflight;
  readonly createAttentionLedgerRepository: (
    sessionDirectory: (sessionId: string) => string,
  ) => FileAttentionLedgerRepository;
  /** Warden report access. The reports directory hangs off the state home,
   *  which is only known once storage has resolved it, so this is a factory
   *  rather than an instance. */
  readonly wardenReports: (stateDirectory: string) => WardenReportReader;
  readonly browserTransport: BrowserTransportWorld;
  /** Session lifecycle: create, launch, deliver turn one, stop. The authoritative store is only
   *  open once storage has resolved and locked the state home, so the service is built per opened
   *  storage rather than at process start. */
  readonly createSessionLifecycle: (storage: DaemonStorage) => SessionLifecycleService;
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
   * Reviving a stopped or dead session with its conversation intact: replace the terminal, hand the
   * agent its next turn, and refuse the revives that would destroy work rather than recover it.
   *
   * Its monitor control is `NoMonitorSupervision` for now — this daemon runs no per-session
   * monitors, so there is genuinely nothing to disarm before a revive or arm after one. The unit
   * that lands monitoring replaces it.
   */
  readonly createSessionResume: (storage: DaemonStorage) => SessionResumeService;
  /** The daemon-wide account-health feed: one snapshot shared by every session
   *  instead of one probe per session. Its sources are configured, so it is
   *  built once configuration has loaded. */
  readonly createUsageFeed: (config: DaemonConfig) => UsageFeedPort;
  /** Team recommendation over the published fleet manifest and the operator's
   *  routing catalog, reading account headroom from the feed above. */
  readonly createTeamAdvisor: (usage: UsageFeedPort) => TeamAdvisor;
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
  ) => MountedSubsystems;
  /** The bearer tokens the API accepts, minted into the state home on first boot. */
  readonly credentials: StateApiCredentials;
  /** Wall-clock milliseconds. Injected rather than read from `Date.now()` at the point of use so
   *  the uptime and freshness the API reports are drivable from a test. */
  readonly clock: MillisecondClockPort;
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
     * An assignee is matched against SESSION IDS only.
     *
     * Resolving a teammate NAME would mean reading every session's configuration on every list row,
     * and the daemon has no fleet directory mounted to index them. An assignee that names something
     * else is honestly unknown rather than guessed at.
     */
    observe: async assignee => {
      const id = tryParseSessionId(assignee);
      return id === undefined || storage.findSession(id) === undefined ? undefined : await observed(id);
    },
    now: () => clock.now(),
  };
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
function createSessionDirectorySubsystem(paths: FoundationPaths, storage: DaemonStorage): SessionDirectorySubsystem {
  /** The pair of documents for one indexed session, parsed, or `undefined` when either is unusable. */
  const view = async (id: SessionId): Promise<SessionView | undefined> => {
    const [rawConfig, rawState] = await Promise.all([storage.readConfig(id), storage.readState(id)]);
    const config = SessionConfigSchema.safeParse(rawConfig);
    const state = SessionStateSchema.safeParse(rawState);
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
 * The analytics read, over the same authoritative session documents the rest of the daemon serves.
 *
 * A session counts as FINISHED when its state document carries a finish instant. Deciding it from
 * the status enum instead would make a `stopped` session with no recorded finish look like a run of
 * zero length, and a duration of zero is a measurement rather than a gap.
 *
 * Both documents are PARSED, and a session whose pair does not parse is left out entirely rather
 * than contributed with holes: an analytics row assembled from a config the schema rejected is a row
 * whose provenance nobody can state.
 *
 * The pricing catalog is EMPTY, and deliberately so. Rates are operator doctrine, the daemon mounts
 * no source for them, and an empty catalog makes every cost `unpriced` with a reason — which is the
 * honest answer. A hardcoded table would price historical runs off numbers nobody in this deployment
 * agreed to; a zero would read as free.
 */
function createAnalyticsSubsystem(storage: DaemonStorage): AnalyticsSubsystem {
  const finishedRecord = async (id: SessionId): Promise<FinishedAnalyticsSession | undefined> => {
    const [rawConfig, rawState] = await Promise.all([storage.readConfig(id), storage.readState(id)]);
    const config = SessionConfigSchema.safeParse(rawConfig);
    const state = SessionStateSchema.safeParse(rawState);
    if (!config.success || !state.success || state.data.finishedAt === undefined) return undefined;
    return {
      id,
      agent: config.data.agent,
      // The SELECTED model only. `observedModel` is transcript evidence, and the record's own
      // contract forbids substituting it for what the operator asked for.
      selectedModel: config.data.model ?? null,
      contextWindow: state.data.contextWindow ?? null,
      harness: config.data.harness,
      mode: config.data.mode,
      status: state.data.status,
      label: config.data.label ?? null,
      cwd: config.data.cwd,
      parent: config.data.parent ?? null,
      createdAt: config.data.createdAt,
      startedAt: state.data.startedAt ?? null,
      finishedAt: state.data.finishedAt,
      // Time-to-first-output is transcript evidence the daemon does not index; a launch instant is
      // not an output, so reporting one here would mismeasure every session.
      firstOutputAt: null,
      turns: state.data.turn,
      contextEndPercent: state.data.contextPercent ?? null,
      stalled: state.data.status === 'stalled',
      failed: state.data.status === 'failed',
      migrated: config.data.migration !== undefined,
      completed: state.data.status === 'completed',
      // No per-session token totals are recorded anywhere the daemon can read. See the mount.
      usage: null,
    };
  };
  return {
    finished: async () => {
      const sessions = await Promise.all(storage.listSessions().map(session => finishedRecord(session.id)));
      return sessions.filter((session): session is FinishedAnalyticsSession => session !== undefined);
    },
    pricing: () => [],
  };
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
    create: async (sessionId, input) => await service.create(sessionId, input).catch(translate),
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
function createNameSubsystem(storage: DaemonStorage): NameSubsystem {
  return {
    claims: async () => {
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
    },
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
 * `enabled` is FALSE and is not configurable, because it is a fact about this build rather than a
 * setting: the daemon mounts the review surface and no miner, so there is nothing an operator could
 * switch on. Offering the flag in `config/daemon.json` would invite them to turn on a subsystem that
 * cannot come on, and `GET /v1/learning/status` would then report `enabled: true` beside a
 * `lastRunAt` that never moves. The remaining fields describe the cadence the miner will use when the
 * unit that mounts it lands, and become configuration in that same unit.
 */
const LEARNING_CONFIG = {
  enabled: false,
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
function createLearningSubsystem(
  paths: FoundationPaths,
  files: StateFileSystem,
  clock: SystemClock,
  serial: TaskBoardSerialExecutor,
): LearningSubsystem {
  return {
    store: new FileLearningStore(paths, files, clock),
    transaction: async work => await serial.run('learning', work),
    config: () => LEARNING_CONFIG,
    now: () => clock.now(),
  };
}

/**
 * Scratch reclamation this daemon does not perform.
 *
 * `enabled` is FALSE and is not configurable, for the same reason `LEARNING_CONFIG.enabled` is: it
 * is a fact about this build rather than a setting. No scratch garbage collector is mounted — the
 * `/v1/gc` route the CLI speaks is not served — so the two counters beside it are zero because
 * nothing reclaims, not because a reclaimer found nothing. The unit that mounts the collector
 * replaces this with the collector's own totals.
 */
const SCRATCH_UNMOUNTED: ScratchReclamation = {
  enabled: false,
  reclaimedSessions: 0,
  reclaimedBytes: 0,
};

/**
 * The daemon's own health, over the self-check `start` ticks.
 *
 * The process id is read HERE rather than in the route, because `src/lib` may not touch `process`:
 * a domain that read its own pid could not be driven from a test, and the whole point of the field
 * is that an operator can signal the process that is actually serving.
 */
function createHealthSubsystem(health: SessionHealthService): DaemonHealthSubsystem {
  return {
    report: async () => await health.report(),
    pid: process.pid,
    scratch: SCRATCH_UNMOUNTED,
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

/** Builds the production adapter set. Subsystem units extend this as they land. */
export function buildWorld(): DaemonWorld {
  const clock = new SystemClock();
  const environment = new RuntimeEnvironment();
  const paths = createFoundationPaths(resolveStateHome(environment.stateHomeInput()));
  const worktreeClock = new SystemWorktreeClock();
  const files = new NodeWorktreeFileSystem();
  const gateway = new GitWorktreeGateway(new BunGitRunner(), files, worktreeClock);
  const wardenFiles = new NodeWardenReportFileSystem();
  const tmux = new BunTmuxProcess(Bun.which('tmux') ?? FALLBACK_TMUX, join(paths.home, 'tmux.sock'));
  const stateFiles = new StateFileSystem(paths);
  // ONE executor for every task board in the process. The file store keys its transactions on the
  // snapshot path, so a single shared executor serializes writes PER BOARD; giving each store its own
  // would let two concurrent requests to the same board interleave read-modify-write and lose one.
  const taskBoards = new TaskBoardSerialExecutor();
  // Its own executor: a learning verdict must not queue behind a task board's transaction, and the
  // two snapshots share no file.
  const learningBoard = new TaskBoardSerialExecutor();
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
  /** One advisor per usage feed. The inventory and the catalog are the same for every caller; only
   *  how spent each account is depends on whether the caller asked for a live probe. */
  const advisorOver = (usage: UsageFeedPort): TeamAdvisor =>
    new TeamAdvisor(new ManifestAccountInventory(stateFiles, paths.fleetManifest), routing, usage);
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
    worktrees: new ManagedWorktreeAdapter(gateway, files, worktreeClock, new WorktreeOperationQueue()),
    boot: {
      probe: new DaemonHealthProbe({ fetch: (url, init) => fetch(url, init) }),
      binder: new DaemonBinder({ sleep: milliseconds => Bun.sleep(milliseconds) }, { now: () => Date.now() }),
    },
    createReadinessWaiter: (ports, daemonLog) => new DaemonReadinessWaiter(ports, daemonLog),
    config: new FileDaemonConfig(paths, stateFiles),
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
    createAttentionLedgerRepository: sessionDirectory => new FileAttentionLedgerRepository(sessionDirectory),
    wardenReports: stateDirectory => new WardenReportReader(wardenFiles, createWardenPaths(stateDirectory).reports),
    browserTransport: {
      connectWorker: options => BrowserWorkerClient.connect(options),
      openViewerStream: (host, sessionId, socket) =>
        BrowserViewerStream.connect(host, sessionId, new SocketViewerDownstream(socket), new SystemFrameClock()),
    },
    createSessionLifecycle: storage =>
      new SessionLifecycleService(
        {
          repository: new StorageSessionLifecycleRepository(storage),
          launcher: new TmuxSessionLifecycleLauncher(
            // A private absolute socket inside the state home is what keeps managed panes off any
            // tmux server the host already runs.
            new TmuxController(new BunTmuxProcess(resolveTmuxExecutable(), join(paths.home, 'tmux.sock'))),
            milliseconds => Bun.sleep(milliseconds),
          ),
          tasks: new FileSessionTaskStore(id => createSessionPaths(paths, id).directory),
          directories: new NodeWorkingDirectoryResolver(),
          ids: new TimeSessionIdFactory(),
          clock,
          // Its own queue: session mutations must not serialize behind storage-wide work.
          serial: new KeyedSerialExecutor(),
        },
        defaultSessionLifecycleSettings,
      ),
    createSessionHealth: (storage, settings) =>
      new SessionHealthService(
        {
          inventory: new StorageSessionHealthInventory(storage, {
            monitors: false,
            warden: false,
            monitored: () => false,
            sweepIntervalMs: 0,
            lastSweepAt: () => undefined,
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
    createSessionResume: storage =>
      new SessionResumeService(
        {
          repository: new StorageResumeRepository(storage),
          launcher: new TmuxResumeLauncher(
            new TmuxController(new BunTmuxProcess(resolveTmuxExecutable(), join(paths.home, 'tmux.sock'))),
            // Parsed, not asserted: a revive addresses a real terminal and runs a real command, so
            // a config that no longer validates must refuse rather than launch something else.
            async id => {
              const config = SessionLifecycleConfigSchema.parse(await storage.readConfig(id));
              return { tmuxSession: config.tmuxSession, cwd: config.cwd, command: config.command };
            },
            milliseconds => Bun.sleep(milliseconds),
          ),
          turns: new FileResumeTurnStore(id => createSessionPaths(paths, id).directory),
          monitors: new NoMonitorSupervision(),
          gate: new InMemoryLaunchGate(milliseconds => Bun.sleep(milliseconds)),
          // Its own queue: a revive must not serialize behind storage-wide work while it holds a
          // half-replaced terminal.
          serial: new KeyedSerialExecutor(),
        },
        defaultSessionResumeSettings,
      ),
    createUsageFeed: config => {
      // The collector endpoint first, then the command fallback for hosts where it is not
      // listening. Both are optional: a daemon configured with neither serves an empty fleet and
      // says so, rather than pretending every account is at zero.
      const command = usageProbeCommand(config.usage.fallbackCommand);
      return new CachedUsageFeed(
        [
          ...(config.usage.url === undefined ? [] : [new HttpUsageSource(config.usage.url)]),
          ...(command === undefined ? [] : [new CommandUsageSource(new BunCommandRunner(process.env), command)]),
        ],
        { refreshMs: config.usage.refreshSeconds * 1_000 },
      );
    },
    createTeamAdvisor: advisorOver,
    sessions: new SessionPlanner({
      startWait: defaultStartWaitPolicy,
      contextWindowOverrides: {},
      namePrefix: DAEMON_NAME,
      remoteControlPrefix: DAEMON_NAME,
    }),
    provenance: new SessionProvenanceStamper(clock),
    harness: new HarnessQuirkService(
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
    ),
    transcripts: {
      sources: [
        new NodeTranscriptSource(new ClaudeTranscriptParser()),
        new NodeTranscriptSource(new CodexTranscriptParser()),
      ],
      search: (events, query, options) => searchTranscript(events, query, options),
    },
    api: new BunApiServer(),
    // The daemon's OWN private socket, never the host's default: a terminal must not land on a tmux
    // server something else on this machine already runs.
    terminalRuntime: new TmuxTerminalRuntime(tmux, () => Date.now()),
    createSubsystems: (storage, terminals, usage, health) => ({
      health: createHealthSubsystem(health),
      attention: new AttentionService(
        // The ledger repository is handed raw ids from the transport, so the id is parsed here rather
        // than asserted: an id the layout would not accept must never become a directory path.
        new FileAttentionLedgerRepository(id => createSessionPaths(paths, parseSessionId(id)).directory),
        clock,
      ),
      pins: new PinService(
        new FilePinSessionDirectory(paths, stateFiles),
        // Its own queue: a pin mutation must not serialize behind storage-wide or session work.
        new FilePinRepository(paths, stateFiles, new KeyedSerialExecutor(), clock),
        clock,
        // A pin id is a protocol UUID, so it is minted as one rather than derived from a counter the
        // next process would restart.
        { next: () => crypto.randomUUID() },
      ),
      sessions: createSessionDirectorySubsystem(paths, storage),
      tasks: createTaskSubsystem(paths, storage, clock, taskBoards),
      analytics: createAnalyticsSubsystem(storage),
      terminals: createTerminalSubsystem(storage, terminals, { now: () => Date.now() }),
      names: createNameSubsystem(storage),
      learning: createLearningSubsystem(paths, stateFiles, clock, learningBoard),
      recommend: createRecommendSubsystem(advisorOver, usage),
    }),
    credentials: new StateApiCredentials(paths, stateFiles),
    clock: { now: () => Date.now() },
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
 * A held lifetime lock is then the same answer as a responder on the address — another daemon is
 * already serving — so both report `EXIT_ALREADY_RUNNING` rather than one of them surfacing as a
 * crash about SQLite.
 *
 * The socket comes last, and every acquisition registers its release as it is made rather than in
 * one block at the end, so a failure part-way through unwinds exactly what succeeded.
 */
export async function start(world: DaemonWorld, cleanups: Array<() => void | Promise<void>> = []): Promise<number> {
  if (world.role !== 'daemon') return 1;

  // Registered for release immediately: an exception from anything below must not leave the lock
  // behind, because a stale lock fails the NEXT start for a reason unrelated to what broke.
  let opened: OpenedDaemonStorage;
  try {
    opened = await world.storage.open();
  } catch (error) {
    if (error instanceof StateHomeLockedError) return EXIT_ALREADY_RUNNING;
    throw error;
  }
  cleanups.push(() => opened.storage.close());

  const config = await world.config.load();
  await world.secrets.load(config.secretsFile);
  if (await world.boot.probe.responds({ url: config.publicUrl })) return EXIT_ALREADY_RUNNING;

  const usage = world.createUsageFeed(config);
  const startedAtMs = world.clock.now();
  const base = { credentials: await world.credentials.load(), usage, clock: world.clock, startedAtMs };
  // `healthIntervalSeconds` was declared in `config/daemon.json` and read by nothing, because no
  // self-check ran to have a cadence. It is the operator's number now — and the wedge threshold moves
  // WITH it, because "the event loop stopped running" means three missed ticks rather than a fixed
  // three minutes. One settings object serves the service, its consistency pass and the timer below,
  // so the period the daemon fires on cannot drift from the period the detector measures against.
  const healthSettings = sessionHealthSettingsAt(config.healthIntervalSeconds * 1_000);
  const health = world.createSessionHealth(opened.storage, healthSettings);
  const subsystems = world.createSubsystems(opened.storage, world.terminalRuntime, usage, health);
  // The FIRST self-check runs before the address is bound, so the daemon's very first health answer
  // is a measurement rather than an empty ledger — a supervisor that probes the moment the port opens
  // must not be told "no self-check has ever run" by a daemon that is about to run one. It is also
  // the boot-time index reconciliation: `classifySelfCheckTick` forces the deep consistency pass on
  // the first tick precisely because boot is when the index is least likely to match the session
  // directories. A failure is swallowed for the same reason the ticks below swallow theirs — a
  // self-check that could not run is reported by the next one's freshness, and refusing to serve
  // because the daemon could not measure itself is strictly worse than serving and saying so.
  await health.selfCheck().catch(() => undefined);
  // The address comes from configuration, never a constant: a hardcoded port is how a daemon ends
  // up fighting whatever else the host already runs on it. The bind is retried because the common
  // restart is "the outgoing daemon is still draining its socket" — kteam's own supervisor hit that
  // window routinely and reported a permanent failure for a condition that clears in a second.
  //
  // BOTH halves of the surface are served by the one host, from the one credential set: the
  // request/response routes and the protocol switches that carry terminal streams.
  const server: ApiServerHandle = await world.boot.binder.bind(
    async () =>
      await world.api.listen(
        {
          http: createMountedDispatcher(base, subsystems),
          sockets: createMountedSocketDispatcher(base, subsystems),
        },
        { host: config.host, port: config.port },
      ),
  );
  // Sockets BEFORE the host, and both registered rather than relying on `stop` alone: a live
  // terminal stream holds a redraw timer armed against its socket, so the handler must be told the
  // stream is over while the socket it writes to still exists.
  cleanups.push(() => server.closeSockets());
  cleanups.push(() => server.stop());
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
  await world.untilShutdown();
  return 0;
}

async function execute(): Promise<number> {
  const cleanups: Array<() => void | Promise<void>> = [];
  try {
    return await start(buildWorld(), cleanups);
  } catch (error) {
    process.stderr.write(`${DAEMON_NAME}: ${error instanceof Error ? error.message : String(error)}\n`);
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

if (import.meta.main) {
  process.exit(await execute());
}
