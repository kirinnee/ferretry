#!/usr/bin/env bun
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import {
  buildFleetHealthCollector,
  buildFleetIdentities,
  buildFleetScaffold,
  buildFleetUsageCollector,
  defaultFleetHarness,
  FleetIdentityService,
  FleetLoginService,
  FleetPlan,
  SharedHistoryMigration,
} from '@ferretry/fleet';
import {
  AnthropicUsageProbe,
  FileFleetConfigSource,
  FileFleetProvisioner,
  FileFleetScaffolder,
  FileSharedHistoryFileSystem,
  fetchQuota,
  PlatformFleetCredentialStore,
  ProcessFleetHealthProbe,
  ProcessFleetLoginPort,
  readFleetWrapperScript,
  runFleetHealthProcess,
  SpawnCredentialCommand,
  spawnFleetLoginProcess,
  whichHarnessBinary,
} from '@ferretry/fleet/adapters';
import type { AnalyticsResponse, IFyApiClient, SessionView } from '@ferretry/protocol';
import { FyApiClient } from '@ferretry/protocol/client';
import { Command } from 'commander';
import type { z } from 'zod';
// The root manifest is the single source for the PRODUCT name; this package's own name is the BINARY.
import root from '../../../package.json' with { type: 'json' };
import pkg from '../package.json' with { type: 'json' };
import { FileScreenshotWriter } from '../src/adapters/browser/screenshot-writer';
import { readDaemonToken } from '../src/adapters/daemon/api-token';
import { SystemMillisecondClock } from '../src/adapters/daemon/clock';
import { readDaemonConfigDocument } from '../src/adapters/daemon/daemon-config-file';
import { type HealthApiClient, ProtocolDaemonHealth } from '../src/adapters/daemon/health';
import { TailDaemonLog } from '../src/adapters/daemon/log-stream';
import { NixStoreGcRoot } from '../src/adapters/daemon/nix-gc-root';
import { BunDaemonProcess } from '../src/adapters/daemon/process';
import { FileServiceStore } from '../src/adapters/daemon/service-files';
import { FileDaemonSnapshotStore } from '../src/adapters/daemon/snapshot-store';
import { SystemFleetClock } from '../src/adapters/fleet/clock';
import { FileFleetManifestSource } from '../src/adapters/fleet/manifest-file';
import { SystemUsageClock } from '../src/adapters/fleet/usage-probe';
import { StdinOperatorPassword } from '../src/adapters/grants/stdin-operator-password';
import { desktopBrowserOpener } from '../src/adapters/pair/browser-opener';
import { QrCodeTerminal } from '../src/adapters/pair/qr-terminal';
import { PlainScreen, ProcessTerminalSize } from '../src/adapters/pair/screen';
import { FileMarkerProbe, SystemPollClock } from '../src/adapters/reads/system-poller';
import { BunTmuxAttachProcess, ExactTmuxAttacher } from '../src/adapters/reads/tmux-attacher';
import { SecretConsoleOutput } from '../src/adapters/secrets/secret-output';
import { StdinSecretValue } from '../src/adapters/secrets/stdin-secret-value';
import { createFyClientConnector, FySessionApi, SessionFiles, SystemClock } from '../src/adapters/session/index.ts';
import { BunTextFileReader } from '../src/adapters/tasks/bun-text-file-reader';
import { FyTaskBoardGateway } from '../src/adapters/tasks/fy-task-board-gateway';
import { FyTaskGateway } from '../src/adapters/tasks/fy-task-gateway';
import { registerTaskBoardCommands } from '../src/adapters/tasks/task-board-commands';
import { registerTaskCommands } from '../src/adapters/tasks/task-commands';
import { environmentBoardCredentials, environmentSessionId } from '../src/adapters/tasks/task-environment';
import { ConsoleIo, type ICliIo } from '../src/adapters/terminal/console-io';
import { InquirerPrompt, type IPrompt } from '../src/adapters/terminal/prompt';
import { type ISpinner, OraSpinner } from '../src/adapters/terminal/spinner';
import { registerAnalyticsCommands } from '../src/lib/analytics/commands';
import { AnalyticsController } from '../src/lib/analytics/controller';
import { registerAttentionCommands } from '../src/lib/attention/commands';
import { AttentionController } from '../src/lib/attention/controller';
import { ProtocolAttentionGateway } from '../src/lib/attention/gateway';
import { BrowserController, registerBrowserCommands } from '../src/lib/browser';
import { isLocalDaemonUrl, resolveDaemonUrl } from '../src/lib/daemon/address';
import { registerDaemonCommands } from '../src/lib/daemon/commands';
import { DaemonController } from '../src/lib/daemon/controller';
import { type DaemonLayout, resolveDaemonLayout, resolveDaemonStateHome } from '../src/lib/daemon/layout';
import type { IServiceDefinitionSupervisor } from '../src/lib/daemon/ports';
import { DirectSupervisor, LaunchdSupervisor, SystemdSupervisor } from '../src/lib/daemon/supervisor';
import { registerFilesystemCommands } from '../src/lib/filesystem/commands';
import { FilesystemController } from '../src/lib/filesystem/controller';
import { ProtocolFilesystemGateway } from '../src/lib/filesystem/gateway';
import { registerFleetCommands } from '../src/lib/fleet/commands';
import { FleetController } from '../src/lib/fleet/controller';
import { ProtocolFleetAuthorizationGateway, ProtocolRecommendationGateway } from '../src/lib/fleet/gateway';
import { defaultConfigPath, resolveFleetLayout } from '../src/lib/fleet/layout';
import { registerGrantCommands } from '../src/lib/grants/commands';
import { GrantController } from '../src/lib/grants/controller';
import { ProtocolGrantGateway } from '../src/lib/grants/gateway';
import { registerLearningCommands } from '../src/lib/learning/commands';
import { LearningController } from '../src/lib/learning/controller';
import { ProtocolLearningGateway } from '../src/lib/learning/gateway';
import { registerMigrationCommands } from '../src/lib/migration/commands';
import { MigrationController } from '../src/lib/migration/controller';
import { registerPairCommands } from '../src/lib/pair/commands';
import { PairController } from '../src/lib/pair/controller';
import { ProtocolPairingGateway } from '../src/lib/pair/gateway';
import { registerPinCommands } from '../src/lib/pins/commands';
import { PinController } from '../src/lib/pins/controller';
import { ProtocolPinGateway } from '../src/lib/pins/gateway';
import { registerReadsCommands } from '../src/lib/reads/commands';
import { ReadsController } from '../src/lib/reads/controller';
import { registerScratchCommands } from '../src/lib/scratch/commands';
import { ScratchController } from '../src/lib/scratch/controller';
import { registerSecretCommands } from '../src/lib/secrets/commands';
import { SecretController } from '../src/lib/secrets/controller';
import { ProtocolSecretGateway } from '../src/lib/secrets/gateway';
import {
  AnswerQuestionController,
  InterruptSessionController,
  ListSessionsController,
  ResumeSessionController,
  registerSessionCommands,
  SendMessageController,
  type SessionCommandDeps,
  type SessionEnvironment,
  SessionPresenter,
  SessionStatusController,
  SignalSessionController,
  StartSessionController,
  SuggestNamesController,
} from '../src/lib/session/index.ts';
import { BulkStopController, registerStopCommands } from '../src/lib/stop';
import { registerSttCommands } from '../src/lib/stt/commands';
import { SttController } from '../src/lib/stt/controller';
import { ProtocolSttGateway } from '../src/lib/stt/gateway';
import { assertSemver } from '../src/lib/version';
import { registerWorktreeCommands } from '../src/lib/worktrees/commands';
import { WorktreeController } from '../src/lib/worktrees/controller';
import { ProtocolWorktreeGateway } from '../src/lib/worktrees/gateway';

// Identity is single-sourced from package.json: the bin key names the binary, version feeds --version.
const BINARY_NAME = Object.keys(pkg.bin)[0] ?? pkg.name;
const PRODUCT_NAME = root.name;
const DESCRIPTION = 'Command-line client for the per-host agent daemon';

/** Scaffold: the commander program skeleton (identity + `--help`/`--version`), domain-free. */
export function createProgram(): Command {
  return new Command()
    .name(BINARY_NAME)
    .description(DESCRIPTION)
    .version(assertSemver(pkg.version), '-v, --version', 'print the CLI version')
    .showHelpAfterError();
}

/**
 * Ask the daemon binary for the one host diagnosis it owns.
 *
 * `fyd --check` already reads the effective state home, the address occupant, and the exact
 * launchability rule a session start uses. Delegating keeps `fy doctor` from growing a second,
 * inevitably divergent definition of a working host.
 */
function registerDoctorCommand(program: Command, environment: Record<string, string | undefined>): void {
  program
    .command('doctor')
    .description('check host dependencies and what each missing program prevents')
    .action(async () => {
      const daemon = `${BINARY_NAME}d`;
      const executable = Bun.which(daemon, { PATH: environment.PATH ?? '' });
      if (executable === null)
        throw new Error(
          `cannot find ${daemon} on PATH — install the daemon package before running ${BINARY_NAME} doctor`,
        );
      const child = Bun.spawn([executable, '--check'], { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
      process.exitCode = await child.exited;
    });
}

// ─── DOMAIN WIRING · the ONLY scaffold↔domain seam (grows with the product; SIT injects doubles here) ───
/** The adapters a CLI invocation needs; the SIT in-process driver injects captured/test doubles here. */
export interface CliWorld {
  readonly io: ICliIo;
  readonly spinner: ISpinner;
  readonly prompt: IPrompt;
  readonly interactive: boolean;
  /** The invocation directory, injected alongside the environment for hermetic in-process journeys. */
  readonly cwd: string;
  /** The invoking user's home directory, captured for hermetic state-home lookup. */
  readonly homeDirectory: string;
  /** The process environment, injected so tests never depend on the ambient one. */
  readonly environment: Record<string, string | undefined>;
}

/** The real production world: the shipped IO adapters. */
export function buildWorld(): CliWorld {
  const io = new ConsoleIo();
  return {
    io,
    spinner: new OraSpinner(),
    prompt: new InquirerPrompt(),
    interactive: io.interactive(),
    cwd: process.cwd(),
    homeDirectory: homedir(),
    environment: process.env,
  };
}

/**
 * Where this invocation should look for the daemon.
 *
 * READ EACH TIME rather than resolved once per invocation, because the answer can change while a
 * single command is running: `daemon start` spawns a daemon that decides its own port and records it,
 * and the poll that follows must see the record it wrote. The document read is one small local file.
 */
async function daemonBaseUrl(environment: Record<string, string | undefined>, stateHome: string): Promise<string> {
  const explicitUrl = environment.FY_URL?.trim() ?? '';
  // An operator who pinned an address has said where to look; nothing local may override that, and
  // this installation may not even have a state home to consult.
  if (explicitUrl !== '') return explicitUrl;
  return resolveDaemonUrl('', await readDaemonConfigDocument(`${stateHome}/config/daemon.json`));
}

/**
 * How the CLI finds the daemon, and which credential it may use to talk to it.
 *
 * WHERE: an explicit `FY_URL` first, then the address the local daemon recorded for itself, then the
 * well-known default. The middle step is what stops this client reporting a healthy daemon
 * unreachable — a daemon whose preferred port was taken binds another and writes the choice down,
 * and a client that assumed the default would never look at it.
 *
 * WHICH CREDENTIAL: decided from the URL, never from whether one was given. Testing "is `FY_URL`
 * set" classified a daemon on this very machine as remote and demanded `FY_TOKEN` for it, while the
 * owner-only token file that is exactly the right credential sat unread. A loopback daemon uses the
 * minted file; a genuinely remote one still must carry its own token, because a local admin
 * credential must never leave this machine.
 */
export async function daemonConnection(
  environment: Record<string, string | undefined>,
  homeDirectory: string,
): Promise<{
  baseUrl: string;
  token: string;
  version: string;
}> {
  const explicitToken = environment.FY_TOKEN?.trim() ?? '';
  const stateHome = resolveDaemonStateHome(homeDirectory, environment.FY_HOME);
  const baseUrl = await daemonBaseUrl(environment, stateHome);
  if (explicitToken === '' && !isLocalDaemonUrl(baseUrl)) {
    throw new Error(
      `FY_TOKEN is required when the daemon is not on this machine (${baseUrl}); local daemon credentials are never sent remotely`,
    );
  }
  const token = explicitToken === '' ? await readDaemonToken(`${stateHome}/api-token`) : explicitToken;
  return { baseUrl, token, version: assertSemver(pkg.version) };
}

/**
 * The one connection to the daemon, opened on first use and shared by every command group.
 *
 * Deferring the connection is what keeps `--help`, `--version` and a mistyped command working on a
 * host with no daemon and no token: nothing reaches the network until a command actually asks.
 */
function lazyDaemonConnection(
  environment: Record<string, string | undefined>,
  homeDirectory: string,
): () => Promise<IFyApiClient> {
  let connected: Promise<FyApiClient> | undefined;
  return (): Promise<FyApiClient> =>
    (connected ??= daemonConnection(environment, homeDirectory).then(options => FyApiClient.connect(options)));
}

/**
 * The slice of the daemon SDK the shared client exposes. Widening it is additive — a group that
 * needs one more call adds it here and no existing group changes — and every member stays deferred.
 */
type SharedDaemonClient = Pick<
  IFyApiClient,
  | 'request'
  | 'analytics'
  | 'list'
  | 'get'
  | 'stop'
  | 'migrate'
  | 'scratchPlan'
  | 'scratchSweep'
  | 'snapshot'
  | 'logs'
  | 'events'
  | 'history'
  | 'attachTarget'
  | 'stream'
>;

/** The deferred connection as the client object every command group is wired with. */
function lazyDaemonClient(client: () => Promise<IFyApiClient>): SharedDaemonClient {
  return {
    request: async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit, timeoutMs?: number): Promise<T> => {
      const ready = await client();
      return timeoutMs === undefined ? ready.request(path, schema, init) : ready.request(path, schema, init, timeoutMs);
    },
    analytics: async (query?: string): Promise<AnalyticsResponse> => (await client()).analytics(query),
    list: async (): Promise<SessionView[]> => (await client()).list(),
    get: async (id: string, signal?: AbortSignal): Promise<SessionView> => (await client()).get(id, signal),
    stop: async (id: string, reason?: string): Promise<SessionView> => (await client()).stop(id, reason),
    migrate: async (id, agent, model, allowContextDowngrade, requestId) =>
      (await client()).migrate(id, agent, model, allowContextDowngrade, requestId),
    scratchPlan: async (limit?: number) => (await client()).scratchPlan(limit),
    scratchSweep: async (force?: boolean) => (await client()).scratchSweep(force),
    snapshot: async (id: string) => (await client()).snapshot(id),
    logs: async (id: string, turn?: number) => (await client()).logs(id, turn),
    events: async (id: string, after?: number, limit?: number, signal?: AbortSignal) =>
      (await client()).events(id, after, limit, signal),
    history: async (id: string, after?: number, limit?: number) => (await client()).history(id, after, limit),
    attachTarget: async (id: string) => (await client()).attachTarget(id),
    stream: async (sessionId, after, onEvent, signal, onIdle) =>
      (await client()).stream(sessionId, after, onEvent, signal, onIdle),
  };
}

/**
 * `/v1/health` is a public route, but the typed client insists on a non-empty bearer token. The daemon
 * commands must be able to report whether the daemon is up BEFORE a token exists — that is exactly
 * the state a fresh `daemon install` leaves the host in — so an unauthenticated probe sends this
 * placeholder and the daemon ignores it.
 */
const UNAUTHENTICATED_PROBE_TOKEN = 'unauthenticated';

/**
 * A client for the public health route, which works with or without `FY_TOKEN`.
 *
 * THE ADDRESS IS RE-RESOLVED ON EVERY PROBE, and that is not a micro-optimisation in reverse — it is
 * required for a first start to work at all. `daemon start` probes, spawns the daemon, then polls
 * until it answers; the daemon decides its port DURING that window and writes the choice down. A
 * client that resolved once, before the spawn, would poll the address the daemon did not take and
 * report "did not become ready" against a daemon that came up perfectly. The connection is rebuilt
 * only when the answer actually changes, and building one costs nothing but an object.
 */
function lazyHealthClient(environment: Record<string, string | undefined>, stateHome: string): HealthApiClient {
  let connected: { readonly url: string; readonly client: Promise<FyApiClient> } | undefined;
  const token = environment.FY_TOKEN?.trim() ?? '';
  const client = async (): Promise<FyApiClient> => {
    const url = await daemonBaseUrl(environment, stateHome);
    if (connected === undefined || connected.url !== url) {
      connected = {
        url,
        client: FyApiClient.connect({
          baseUrl: url,
          token: token === '' ? UNAUTHENTICATED_PROBE_TOKEN : token,
          version: assertSemver(pkg.version),
        }),
      };
    }
    return await connected.client;
  };
  return {
    request: async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit, timeoutMs?: number): Promise<T> => {
      const ready = await client();
      return timeoutMs === undefined ? ready.request(path, schema, init) : ready.request(path, schema, init, timeoutMs);
    },
  };
}

/**
 * Where the daemon executable lives. `systemd` requires an absolute `ExecStart`, so a bare name on
 * `PATH` is resolved here rather than written into a unit file that would fail to load with 203/EXEC.
 */
function resolveDaemonBinary(environment: Record<string, string | undefined>, daemonName: string): string {
  const pinned = environment.FY_DAEMON_BIN?.trim() ?? '';
  if (pinned !== '') return pinned;
  const found = Bun.which(daemonName, { PATH: environment.PATH ?? '' });
  if (found === null) {
    throw new Error(`cannot find ${daemonName} on PATH — install it or point FY_DAEMON_BIN at the executable`);
  }
  return found;
}

/**
 * Builds the daemon-control controller.
 *
 * Constructed lazily, per invocation: resolving the layout can fail (for example, on a nonsensical
 * `FY_HOME`) and that must surface as an error from `fy daemon …`, never as a CLI that cannot even
 * print `--help`. The live daemon executable is resolved later still, only if a snapshot build needs
 * it; retained snapshots remain operable after the source installation disappears.
 */
function buildDaemonController(environment: Record<string, string | undefined>, out: ICliIo): DaemonController {
  const daemonName = `${BINARY_NAME}d`;
  const layout: DaemonLayout = resolveDaemonLayout({
    platform: process.platform,
    homeDirectory: homedir(),
    stateHome: environment.FY_HOME,
    configHome: environment.XDG_CONFIG_HOME,
    stateDirectory: environment.XDG_STATE_HOME,
    userId: typeof process.getuid === 'function' ? process.getuid() : 0,
    daemonName,
    product: PRODUCT_NAME,
    searchPath: environment.PATH ?? '',
  });
  const processes = new BunDaemonProcess();
  const files = new FileServiceStore();
  const service: IServiceDefinitionSupervisor | undefined =
    layout.manager === 'systemd'
      ? new SystemdSupervisor(layout, processes, files)
      : layout.manager === 'launchd'
        ? new LaunchdSupervisor(layout, processes, files)
        : undefined;
  return new DaemonController({
    layout,
    service,
    direct: new DirectSupervisor(layout, processes, files),
    health: new ProtocolDaemonHealth(lazyHealthClient(environment, layout.stateHome)),
    logs: new TailDaemonLog(),
    nix: new NixStoreGcRoot(processes),
    snapshots: new FileDaemonSnapshotStore({
      root: layout.snapshotRoot,
      daemon: { product: layout.product, name: layout.daemonName },
      sourceBinary: () => resolveDaemonBinary(environment, daemonName),
    }),
    clock: new SystemMillisecondClock(),
    out,
  });
}

/**
 * What one command group needs to wire itself: the program to hang commands on, plus the
 * collaborators every group shares.
 */
export interface DomainWiring {
  readonly program: Command;
  readonly world: CliWorld;
  readonly client: SharedDaemonClient;
  readonly ownSessionId: string | undefined;
}

/**
 * One line per command group. **Append here; never rewrite another group's line.**
 *
 * This is a list rather than a function body for a mechanical reason: when each group appended its
 * own controller construction to a single `registerDomain`, every group conflicted with every other
 * group on that one function, and each merge needed a hand-resolved semantic rebase. As a list, a
 * new group is a one-line append — it merges the way a barrel does, by keeping both sides.
 */
const DOMAIN_REGISTRARS: ReadonlyArray<(wiring: DomainWiring) => void> = [
  ({ program, world, client, ownSessionId }) =>
    registerAttentionCommands(
      program,
      new AttentionController(new ProtocolAttentionGateway(client), world.io, ownSessionId),
    ),
  ({ program, world, client, ownSessionId }) =>
    registerPinCommands(program, new PinController(new ProtocolPinGateway(client), world.io, ownSessionId)),
  ({ program, world, client }) => registerAnalyticsCommands(program, new AnalyticsController(client, world.io)),
  ({ program, world, client }) =>
    registerSecretCommands(
      program,
      new SecretController(
        new ProtocolSecretGateway(client),
        new SecretConsoleOutput(world.io),
        new StdinSecretValue(),
        process.cwd(),
      ),
    ),
  ({ program, world, client }) =>
    registerFilesystemCommands(program, new FilesystemController(new ProtocolFilesystemGateway(client), world.io)),
  ({ program, world, client }) =>
    registerMigrationCommands(
      program,
      new MigrationController(client, new SessionPresenter(world.io, new SystemClock())),
    ),
  ({ program, world, client }) => registerScratchCommands(program, new ScratchController(client, world.io)),
  ({ program, world, ownSessionId }) => registerSessionCommands(program, sessionCommands(world, ownSessionId)),
  ({ program, world, client, ownSessionId }) =>
    registerTaskCommands(program, {
      gateway: new FyTaskGateway(client),
      io: world.io,
      files: new BunTextFileReader(),
      environmentSessionId: ownSessionId,
    }),
  ({ program, world, client }) =>
    registerTaskBoardCommands(program, {
      gateway: new FyTaskBoardGateway(client),
      io: world.io,
      credentials: environmentBoardCredentials(world.environment),
    }),
  ({ program, world, client, ownSessionId }) =>
    registerStopCommands(
      program,
      new BulkStopController(client, world.io, world.prompt, {
        interactive: world.interactive,
        ...(ownSessionId === undefined ? {} : { callerId: ownSessionId }),
        binaryName: BINARY_NAME,
      }),
    ),
  ({ program, world, client, ownSessionId }) =>
    registerBrowserCommands(
      program,
      new BrowserController(client, world.io, new FileScreenshotWriter(), {
        ...(ownSessionId === undefined ? {} : { selfSessionId: ownSessionId }),
      }),
    ),
  ({ program, world, client }) =>
    registerLearningCommands(program, new LearningController(new ProtocolLearningGateway(client), world.io)),
  ({ program, world, client }) =>
    registerSttCommands(program, new SttController(new ProtocolSttGateway(client), world.io)),
  ({ program, world, client }) =>
    registerWorktreeCommands(
      program,
      new WorktreeController(new ProtocolWorktreeGateway(client), world.io, world.prompt, world.interactive),
    ),
  ({ program, world, client }) => registerFleetCommands(program, buildFleetController(world, client)),
  // The operator reads. The marker probe takes the INVOCATION cwd rather than reading `process.cwd()`,
  // so a relative `--until-marker` resolves against the directory the human was in.
  ({ program, world, client }) =>
    registerReadsCommands(
      program,
      new ReadsController(
        client,
        world.io,
        new SystemPollClock(),
        new FileMarkerProbe(world.cwd),
        new ExactTmuxAttacher(new BunTmuxAttachProcess(), world.environment),
      ),
    ),
  // The daemon group is the one group that does NOT take the shared client: it manages a local
  // process, and it must answer "is the daemon up?" on a host that has no token yet.
  ({ program, world }) => registerDaemonCommands(program, () => buildDaemonController(world.environment, world.io)),
  // The grant verbs mount onto the group above and DO take the shared client, because unlike every
  // other daemon verb they change what the daemon serves rather than whether it is running. They are
  // registered after it for that reason: the group has to exist before verbs can be added to it.
  ({ program, world, client }) =>
    registerGrantCommands(
      program,
      () =>
        new GrantController({
          gateway: new ProtocolGrantGateway(client),
          passwords: new StdinOperatorPassword(),
          out: world.io,
          clientName: BINARY_NAME,
        }),
    ),
  // Pairing writes its screen through its own uncoloured writer rather than `world.io`: the screen is
  // mostly a QR, and tinting the one image the onboarding depends on is a risk with nothing to gain.
  ({ program, world, client }) =>
    registerPairCommands(
      program,
      new PairController({
        gateway: new ProtocolPairingGateway(client),
        screen: new PlainScreen(),
        progress: world.spinner,
        exit: world.io,
        clock: new SystemMillisecondClock(),
        qr: new QrCodeTerminal(),
        terminal: new ProcessTerminalSize(),
        browser: desktopBrowserOpener(),
        binaryName: BINARY_NAME,
      }),
    ),
];

/**
 * Builds the fleet controller.
 *
 * Provisioning is local, so this group is wired from `@ferretry/fleet` rather than the daemon — only
 * `recommend` takes the protocol client. The layout is resolved from the environment here and shared
 * by every verb, so `apply` and `usage` can never disagree about where the manifest lives.
 */
function buildFleetController(world: CliWorld, client: SharedDaemonClient): FleetController {
  const layout = resolveFleetLayout({
    stateHome: world.environment.FY_HOME,
    userHome: homedir(),
    product: PRODUCT_NAME,
  });
  const configured = world.environment.FY_FLEET_CONFIG?.trim() ?? '';
  const configPath = configured === '' ? defaultConfigPath(layout) : configured;
  const fleetWriteRoots = [layout.fleetDirectory, layout.userHome];
  // The one place allowed to read the platform and the environment: the store itself takes both as
  // values, which is what lets a test drive the macOS path on a host that is not macOS.
  const credentialStore = new PlatformFleetCredentialStore({
    platform: process.platform,
    command: new SpawnCredentialCommand(),
    now: () => Date.now(),
    keychainAccount: world.environment.USER ?? '',
  });
  const identityService = new FleetIdentityService(credentialStore);
  return new FleetController({
    config: new FileFleetConfigSource(configPath),
    manifests: new FileFleetManifestSource(layout.manifestPath),
    // Scaffolding seeds the configuration `apply` will actually read, so both take the same path.
    scaffolder: {
      scaffold: async options => {
        const firstAccount =
          options.firstAccount === 'detected'
            ? defaultFleetHarness(
                (['claude', 'codex'] as const).flatMap(kind =>
                  Bun.which(kind, { PATH: world.environment.PATH ?? '' }) === null
                    ? []
                    : [{ kind, launchable: [kind] }],
                ),
              )
            : options.firstAccount;
        if (options.firstAccount === 'detected' && firstAccount === undefined) {
          throw new Error(
            'no launchable Claude or Codex CLI was found on this host — install one, or choose explicitly with "fy fleet init --first-account=claude"',
          );
        }
        return await new FileFleetScaffolder([layout.fleetDirectory]).scaffold(
          buildFleetScaffold({
            layout,
            configPath,
            ids: { claude: randomUUID(), codex: randomUUID() },
            ...(firstAccount === undefined ? {} : { firstAccount }),
          }),
        );
      },
    },
    planner: {
      build: (config, generatedAt) => new FleetPlan().build(config, layout, generatedAt),
    },
    // Account/default homes may live under the user's home; history still names every exact home in
    // its request, and both adapters independently reject anything outside these declared roots.
    applier: new FileFleetProvisioner(
      fleetWriteRoots,
      new SharedHistoryMigration(new FileSharedHistoryFileSystem(fleetWriteRoots)),
    ),
    // Built per invocation from the loaded configuration, so `usage.concurrency`,
    // `usage.atLimitPercent` and `usage.timeout` are honoured instead of parsed and dropped. The
    // timeout goes to the probe rather than the collector because only the probe can actually cancel
    // a provider call; the daemon's fleet mount passes the same value at its own construction.
    // The same collector the daemon builds, from the same factory, over the same probe: two call
    // sites assembling their own is how `fy fleet usage` and GET /v1/fleet/usage come to disagree about
    // whether an account has quota left. The credential store is shared with login, so the token a
    // probe uses is the one a login wrote.
    usage: {
      forConfig: config =>
        buildFleetUsageCollector(
          config,
          new AnthropicUsageProbe({
            fetch: fetchQuota,
            timeoutMs: config.usage.timeout * 1_000,
            credentials: credentialStore,
          }),
          new SystemUsageClock(),
        ),
    },
    health: {
      forConfig: config =>
        buildFleetHealthCollector(
          config,
          new ProcessFleetHealthProbe({
            process: runFleetHealthProcess,
            cachePath: `${layout.fleetDirectory}/health-successes.json`,
          }),
          new SystemUsageClock(),
        ),
    },
    // One credential store for both verbs: `--status` reads through it and a login copies through it,
    // so what a report says a home holds is the same reading a copy decides on.
    identities: {
      identities: (config, manifest) => buildFleetIdentities(config, manifest),
      survey: async identities => await identityService.survey(identities),
    },
    logins: new FleetLoginService({
      identities: identityService,
      loginPort: new ProcessFleetLoginPort({
        spawn: spawnFleetLoginProcess,
        environment: world.environment,
        readWrapper: readFleetWrapperScript,
        which: whichHarnessBinary,
      }),
    }),
    clock: new SystemFleetClock(),
    recommendations: new ProtocolRecommendationGateway(client),
    // The same shared client, and therefore the same daemon this invocation already resolved: a
    // loopback daemon's owner-only token file, or the explicit FY_TOKEN a remote one demands. There
    // is no second selection mechanism and no registry that turns a name into a credential — FY_HOME
    // picks which local daemon, FY_URL plus FY_TOKEN picks a remote one, exactly as every other verb.
    authorizations: new ProtocolFleetAuthorizationGateway(client),
    out: world.io,
  });
}

/**
 * The session command group's collaborators.
 *
 * It builds its own client rather than taking the shared one because the session commands need the
 * whole typed surface, not the `request`/`analytics` subset the gateways above use, and because a
 * session call must identify itself (`x-ferretry-client`) and its pane (`x-ferretry-session-id`) so
 * the daemon attributes it to the right actor. Still lazy: no token is demanded until a session
 * command actually runs.
 */
function sessionCommands(world: CliWorld, ownSessionId: string | undefined): SessionCommandDeps {
  const cliEnvironment = world.environment;
  const environment: SessionEnvironment = {
    cwd: world.cwd,
    ...(ownSessionId === undefined ? {} : { callerSessionId: ownSessionId }),
    ...(cliEnvironment.FY_BOARD_CAPABILITY === undefined
      ? {}
      : { boardCapability: cliEnvironment.FY_BOARD_CAPABILITY }),
  };
  const api = new FySessionApi(
    createFyClientConnector({
      version: assertSemver(pkg.version),
      ...(cliEnvironment.FY_URL === undefined ? {} : { url: cliEnvironment.FY_URL }),
      ...(cliEnvironment.FY_TOKEN === undefined ? {} : { token: cliEnvironment.FY_TOKEN }),
      resolveLocalToken: () =>
        daemonConnection(cliEnvironment, world.homeDirectory).then(connection => connection.token),
      ...(ownSessionId === undefined ? {} : { sessionId: ownSessionId }),
    }),
  );
  const files = new SessionFiles();
  const presenter = new SessionPresenter(world.io, new SystemClock());

  return {
    presenter,
    start: new StartSessionController(api, files, presenter, environment),
    list: new ListSessionsController(api, presenter),
    status: new SessionStatusController(api, presenter),
    send: new SendMessageController(api, files, presenter, environment),
    answer: new AnswerQuestionController(api, presenter),
    names: new SuggestNamesController(api, presenter),
    interrupt: new InterruptSessionController(api, presenter),
    resume: new ResumeSessionController(api, presenter),
    signal: new SignalSessionController(api, presenter, environment),
  };
}

/** Route the product domain onto the program — one controller per command group. */
export function registerDomain(program: Command, world: CliWorld): void {
  // The injected environment, never the ambient one: an in-process journey must not inherit FY_*.
  const environment = world.environment;
  const wiring: DomainWiring = {
    program,
    world,
    client: lazyDaemonClient(lazyDaemonConnection(environment, world.homeDirectory)),
    // One reading of "which session am I", shared by every group: blank is absent, not an empty id.
    ownSessionId: environmentSessionId(environment),
  };
  registerDoctorCommand(program, environment);
  for (const register of DOMAIN_REGISTRARS) register(wiring);
}
// ─── END DOMAIN WIRING ────────────────────────────────────────────────────────────────────────

/** Composition root: build the program, wire the domain, run it, and release resources. */
async function execute(argv: string[]): Promise<void> {
  const program = createProgram();
  const bootstrapIo = new ConsoleIo();
  const cleanups: Array<() => Promise<void>> = [];

  try {
    const world = buildWorld();
    registerDomain(program, world);

    await program.parseAsync(argv);
  } catch (error) {
    bootstrapIo.error((error as Error).message);
    bootstrapIo.setExitCode(1);
  } finally {
    // A cleanup failure must not mask the command's own error + exit code.
    for (const cleanup of cleanups) {
      try {
        await cleanup();
      } catch (closeError) {
        bootstrapIo.error(`failed to release a resource cleanly: ${(closeError as Error).message}`);
      }
    }
  }
}

// Guard executable behavior: run only when invoked directly; the SIT in-process driver imports the factory.
if (import.meta.main) {
  await execute(process.argv);
}
