#!/usr/bin/env bun
import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fencedConversationLeaseStore, HostProcessStarts, resolveUserHome } from '@ferretry/fleet/adapters';
import {
  appOriginChoice,
  CONFIG_DIRECTORY_NAME,
  DAEMON_IDENTITY_PATH,
  type DaemonId,
  DaemonIdentityViewSchema,
  type DaemonRestartPatience,
  type IFyApiClient,
  readLoopbackFirewallMarker,
  SubtreeViewSchema,
} from '@ferretry/protocol';
import { FyApiClient } from '@ferretry/protocol/client';
import { sweepPairingRedirects } from '@ferretry/protocol/pairing-redirect-sweep';
import chalk from 'chalk';
import { Command } from 'commander';
import type { z } from 'zod';
// The root manifest is the single source for the PRODUCT name; this package's own name is the BINARY.
import { agentToolsClient, registerMcpGroup } from './mcp-group';
import { registerReadsGroup } from './reads-group';
import {
  BINARY_NAME,
  createProgram,
  type DaemonWiring,
  daemonBaseUrl,
  daemonConnection,
  type DaemonCredentialOptions,
  lazyDaemonClient,
  lazyDaemonConnection,
  PRODUCT_NAME,
  type SharedDaemonClient,
  UNAUTHENTICATED_PROBE_TOKEN,
  wireDaemon,
} from './wiring';

// The daemon package names the daemon binary, exactly as this package names the client one.
import daemonPkg from '../../daemon/package.json' with { type: 'json' };
import pkg from '../package.json' with { type: 'json' };
import { AgendaBriefInput } from '../src/adapters/agenda/brief-input';
import { BoardCardTies } from '../src/adapters/agenda/card-ties';
import { registerBoardCommands } from '../src/adapters/board/board-commands';
import { FyBoardGateway } from '../src/adapters/board/fy-board-gateway';
import { FyMergeGateGateway } from '../src/adapters/board/fy-merge-gate-gateway';
import { registerBoardImportCommand } from '../src/adapters/board-import/board-import-command';
import { FyBoardImportGateway } from '../src/adapters/board-import/fy-board-import-gateway';
import { FyLaneGateway } from '../src/adapters/board-lanes/fy-lane-gateway';
import { registerLaneCommands } from '../src/adapters/board-lanes/lane-commands';
import { BUNDLED_FIREWALL_FILES } from '../src/adapters/browser/firewall-files';
import { FileScreenshotWriter } from '../src/adapters/browser/screenshot-writer';
import { FileCatalogWriter } from '../src/adapters/catalog/export-file';
import { FsCatalogFileReader } from '../src/adapters/catalog-install/fs-catalog-file-reader';
import { FileConfigFiles } from '../src/adapters/config/files';
import { StdinConfigText } from '../src/adapters/config/stdin';
import { SystemMillisecondClock } from '../src/adapters/daemon/clock';
import { type HealthApiClient, ProtocolDaemonHealth } from '../src/adapters/daemon/health';
import { ProcIoPressureReader } from '../src/adapters/daemon/io-pressure';
import { FileDaemonLifecycleLock } from '../src/adapters/daemon/lifecycle-lock';
import { TailDaemonLog } from '../src/adapters/daemon/log-stream';
import { NixStoreGcRoot } from '../src/adapters/daemon/nix-gc-root';
import { BunDaemonProcess } from '../src/adapters/daemon/process';
import { HostProcessIncarnations } from '../src/adapters/daemon/process-incarnation';
import { ProtocolResetInventory } from '../src/adapters/daemon/reset-inventory';
import { FileResetTrees } from '../src/adapters/daemon/reset-trees';
import { FileDaemonRestartMarker, restartMarkerPath } from '../src/adapters/daemon/restart-marker';
import { privateRuntimeDirectory } from '../src/adapters/daemon/runtime-directory';
import { FileServiceStore } from '../src/adapters/daemon/service-files';
import { TmuxSessionTerminalServer } from '../src/adapters/daemon/session-terminals';
import { bunTracerHost, PlatformSyscallTracer } from '../src/adapters/daemon/syscall-tracer';
import { desktopBrowserOpener } from '../src/adapters/pair/browser-opener';
import { QrCodeTerminal } from '../src/adapters/pair/qr-terminal';
import { PlainScreen, ProcessTerminalSize } from '../src/adapters/pair/screen';
import { IntlLocalTime } from '../src/adapters/passkey/local-time';
import { openInBrowser } from '../src/adapters/plan/open-link';
import { FyProjectGateway } from '../src/adapters/projects/fy-project-gateway';
import { registerProjectCommands } from '../src/adapters/projects/project-commands';
import { SecretConsoleOutput } from '../src/adapters/secrets/secret-output';
import { StdinSecretValue } from '../src/adapters/secrets/stdin-secret-value';
import { createFyClientConnector, FySessionApi, SessionFiles, SystemClock } from '../src/adapters/session/index.ts';
import { FileStateHomeClaim } from '../src/adapters/state-home/claim-files';
import { createStatuslineController } from '../src/adapters/statusline/index.ts';
import { BunTextFileReader } from '../src/adapters/tasks/bun-text-file-reader';
import { registerTaskCommands } from '../src/adapters/tasks/task-commands';
import { ConsoleIo, type ICliIo } from '../src/adapters/terminal/console-io';
import { chooseProgress, processProgressHost } from '../src/adapters/terminal/progress-factory';
import { ProgressAwareIo } from '../src/adapters/terminal/progress-io';
import { InquirerPrompt, type IPrompt } from '../src/adapters/terminal/prompt';
import { type ISpinner, OraSpinner } from '../src/adapters/terminal/spinner';
import { FyTidyGateway } from '../src/adapters/tidy/fy-tidy-gateway';
import { HostInstallFacts } from '../src/adapters/update/install-facts';
import { GitHubLatestRelease } from '../src/adapters/update/latest-release';
import { CommandPackageManagers } from '../src/adapters/update/package-managers';
import { StandaloneRelease } from '../src/adapters/update/standalone-release';
import { ProtocolDaemonUpdateView } from '../src/adapters/update/update-view';
import { FyWorkSearchGateway } from '../src/adapters/work-search/fy-work-search-gateway';
import { registerAgendaCommands } from '../src/lib/agenda/commands';
import { AgendaController } from '../src/lib/agenda/controller';
import { ProtocolAgendaGateway } from '../src/lib/agenda/gateway';
import { AgentToolsController, registerBrowserPageCommands, registerTerminalCommands } from '../src/lib/agent-tools';
import { registerAnalyticsCommands } from '../src/lib/analytics/commands';
import { AnalyticsController } from '../src/lib/analytics/controller';
import { registerAuditCommands } from '../src/lib/audit/commands';
import { AuditController } from '../src/lib/audit/controller';
import { ProtocolAuditGateway } from '../src/lib/audit/gateway';
import { BoardController } from '../src/lib/board/board-controllers';
import { MergeGateController } from '../src/lib/board/merge-gate';
import { BrowserController, registerBrowserCommands, registerFirewallCommands } from '../src/lib/browser';
import { registerCatalogCommands } from '../src/lib/catalog/commands';
import { CatalogController } from '../src/lib/catalog/controller';
import { ProtocolCatalogGateway } from '../src/lib/catalog/gateway';
import { registerCatalogInstallCommands } from '../src/lib/catalog-install/commands';
import { CatalogInstallController } from '../src/lib/catalog-install/controller';
import { registerShareCommands } from '../src/lib/catalog-share/commands';
import { ShareController } from '../src/lib/catalog-share/controller';
import { ProtocolSharingGateway } from '../src/lib/catalog-share/gateway';
import { registerConfigCommands } from '../src/lib/config/commands';
import { ConfigController } from '../src/lib/config/controller';
import { ProtocolConfigGateway } from '../src/lib/config/gateway';
import { type InstalledDaemonBinary, resolveDaemonBinaryPath } from '../src/lib/daemon/binary';
import { registerDaemonCommands } from '../src/lib/daemon/commands';
import { DaemonController } from '../src/lib/daemon/controller';
import { paneCredentialValue, paneCredentialWarnings } from '../src/lib/daemon/credential';
import { ProtocolFirewallStatusReader } from '../src/lib/daemon/firewall-status';
import { type DaemonLayout, resolveDaemonLayout, resolveDaemonStateHome } from '../src/lib/daemon/layout';
import { legacyWireReport } from '../src/lib/daemon/legacy-wire';
import { ProtocolLimitsStatusReader } from '../src/lib/daemon/limits-status';
import type { IServiceDefinitionSupervisor } from '../src/lib/daemon/ports';
import { registerProfileCommands } from '../src/lib/daemon/profile/commands';
import { ProfileController, ProtocolProfileGateway } from '../src/lib/daemon/profile/controller';
import { MachineSetupNotice } from '../src/lib/daemon/setup-notice';
import { DirectSupervisor, LaunchdSupervisor, SystemdSupervisor } from '../src/lib/daemon/supervisor';
import { registerDeviceCommands } from '../src/lib/device/commands';
import { DeviceController } from '../src/lib/device/controller';
import { ProtocolDeviceGateway } from '../src/lib/device/gateway';
import { registerFilesystemCommands } from '../src/lib/filesystem/commands';
import { FilesystemController } from '../src/lib/filesystem/controller';
import { ProtocolFilesystemGateway } from '../src/lib/filesystem/gateway';
import { ProtocolAccountGateway } from '../src/lib/fleet/account-gateway';
import { registerAccountModelCommands } from '../src/lib/fleet/account-model';
import type { AccountCommandDeps } from '../src/lib/fleet/account-ports';
import { registerFleetCommands } from '../src/lib/fleet/commands';
import { ProtocolRecommendationGateway } from '../src/lib/fleet/gateway';
import { resolveFleetLayout } from '../src/lib/fleet/layout';
import { RecommendController } from '../src/lib/fleet/recommend';
import { registerGrantCommands } from '../src/lib/grants/commands';
import { GrantController } from '../src/lib/grants/controller';
import { ProtocolGrantGateway } from '../src/lib/grants/gateway';
import { registerHarnessCommands } from '../src/lib/harness/commands';
import { HarnessController } from '../src/lib/harness/controller';
import { registerHistoryCommands } from '../src/lib/history/commands';
import { HistoryController } from '../src/lib/history/controller';
import {
  ContinueSessionController,
  ImportController,
  ProtocolImportGateway,
  registerImportCommands,
  registerNewCommand,
} from '../src/lib/import/index.ts';
import { registerInputCommands } from '../src/lib/input/commands';
import { InputController } from '../src/lib/input/controller';
import { ProtocolInputGateway } from '../src/lib/input/gateway';
import { registerInstructionsCommands } from '../src/lib/instructions/commands';
import { registerLearningCommands } from '../src/lib/learning/commands';
import { LearningController } from '../src/lib/learning/controller';
import { ProtocolLearningGateway } from '../src/lib/learning/gateway';
import { registerLessonCommands } from '../src/lib/lesson/commands';
import { LessonController } from '../src/lib/lesson/controller';
import { registerLocalSkillInstallCommands } from '../src/lib/local-skill-install/commands';
import { LocalSkillInstallController } from '../src/lib/local-skill-install/controller';
import { registerMigrationCommands } from '../src/lib/migration/commands';
import { MigrationController } from '../src/lib/migration/controller';
import { registerModelsCommands } from '../src/lib/models/commands';
import { ModelsController } from '../src/lib/models/controller';
import { registerNotifyCommands, runNotify } from '../src/lib/notify/commands';
import { ProtocolNotifyGateway } from '../src/lib/notify/gateway';
import { registerOnboardCommands } from '../src/lib/onboard/commands';
import { OnboardController } from '../src/lib/onboard/controller';
import { ProtocolOnboardRelay } from '../src/lib/onboard/relay';
import {
  ambientSession,
  PackController,
  ProtocolPackGateway,
  registerGuideCommand,
  registerRecommendCommand,
} from '../src/lib/pack';
import { registerPairCommands } from '../src/lib/pair/commands';
import { PairController } from '../src/lib/pair/controller';
import { ProtocolPairingGateway } from '../src/lib/pair/gateway';
import { registerPasskeyCommands } from '../src/lib/passkey/commands';
import { PasskeyController } from '../src/lib/passkey/controller';
import { ProtocolPasskeyGateway } from '../src/lib/passkey/gateway';
import { registerPinCommands } from '../src/lib/pins/commands';
import { PinController } from '../src/lib/pins/controller';
import { ProtocolPinGateway } from '../src/lib/pins/gateway';
import { registerCopyCommands } from '../src/lib/plan/commands';
import { CopyController } from '../src/lib/plan/controller';
import { ProtocolCopyGateway, ProtocolPlanGateway } from '../src/lib/plan/gateway';
import { PlanController } from '../src/lib/plan/plan-controller';
import type { IProgress } from '../src/lib/progress/index';
import { registerQueueCommands } from '../src/lib/queue/commands';
import { ProtocolQueueGateway } from '../src/lib/queue/gateway';
import { registerRenderCommands } from '../src/lib/render/commands';
import { RenderController } from '../src/lib/render/controller';
import { RENDER_GUIDE_SECTION } from '../src/lib/render/guide-text';
import { registerRestartCommands } from '../src/lib/restart/commands';
import { RestartController } from '../src/lib/restart/controller';
import { registerRulesCommands } from '../src/lib/rules/commands';
import { RulesController } from '../src/lib/rules/controller';
import { ProtocolRulesGateway } from '../src/lib/rules/gateway';
import { registerScratchCommands } from '../src/lib/scratch/commands';
import { ScratchController } from '../src/lib/scratch/controller';
import { AccountController } from '../src/lib/secrets/account-controller';
import { ProtocolAccountGateway as ProtocolSecretAccountGateway } from '../src/lib/secrets/account-gateway';
import { registerSecretCommands } from '../src/lib/secrets/commands';
import { SecretController } from '../src/lib/secrets/controller';
import { TwoFactorSeedController } from '../src/lib/secrets/factor-controller';
import { ProtocolTwoFactorSeedGateway } from '../src/lib/secrets/factor-gateway';
import { FactorKeyController } from '../src/lib/secrets/factor-keys-controller';
import { ProtocolSecretGateway } from '../src/lib/secrets/gateway';
import { SignInController } from '../src/lib/secrets/sign-in-controller';
import { registerSecurityCommands } from '../src/lib/security/commands';
import { SecurityController } from '../src/lib/security/controller';
import { ProtocolSecurityGateway } from '../src/lib/security/gateway';
import {
  ProtocolSessionCompactAtGateway,
  registerSessionCompactAtCommand,
  SessionCompactAtController,
} from '../src/lib/session/compact-at.ts';
import {
  AnswerQuestionController,
  boardLaneNames,
  type ICellColour,
  InterruptSessionController,
  type ISessionBoard,
  type ISessionSubtree,
  ListSessionsController,
  RenameSessionController,
  ResumeSessionController,
  registerSessionCommands,
  SendMessageController,
  type SessionCommandDeps,
  type SessionEnvironment,
  SessionPresenter,
  SessionStatusController,
  SessionSubtreeController,
  SignalSessionController,
  StartSessionController,
  SuggestNamesController,
} from '../src/lib/session/index.ts';
import {
  PinAgentController,
  ProtocolSessionPinGateway,
  registerSessionPinCommands,
} from '../src/lib/session/pin-agent.ts';
import {
  ProtocolSessionCredentialGateway,
  RevokeCredentialController,
  registerSessionCredentialCommands,
} from '../src/lib/session/revoke-credential.ts';
import { registerSetupCommands } from '../src/lib/setup/commands';
import { type IStateHomeClaimNotices, StateHomeClaimService } from '../src/lib/state-home/claim';
import { StateHomeController } from '../src/lib/state-home/controller';
import { registerStatuslineCommands } from '../src/lib/statusline/commands';
import { BulkStopController, registerStopCommands } from '../src/lib/stop';
import { registerSttCommands } from '../src/lib/stt/commands';
import { SttController } from '../src/lib/stt/controller';
import { ProtocolSttGateway } from '../src/lib/stt/gateway';
import { TerminalSlotsController } from '../src/lib/terminal-slots/controller';
import { registerTidyCommands } from '../src/lib/tidy/commands';
import { TidyController } from '../src/lib/tidy/controller';
import { registerTunnelCommands } from '../src/lib/tunnel/commands';
import { TunnelController } from '../src/lib/tunnel/controller';
import { ProtocolTunnelGateway, ProtocolTunnelStatusReader } from '../src/lib/tunnel/gateway';
import { NixProfileSwitch } from '../src/lib/update/profile-switch';
import { DAEMON_RELEASE_KEYS } from '../src/lib/update/release-keys';
import { DaemonUpdateStatusReader } from '../src/lib/update/status';
import { DaemonUpdater } from '../src/lib/update/updater';
import { assertSemver } from '../src/lib/version';
import { registerWorkSearchCommands } from '../src/lib/work-search/commands';
import { WorkSearchController } from '../src/lib/work-search/controller';
import { RelatedCheck } from '../src/lib/work-search/related';
import { registerWorktreeCommands } from '../src/lib/worktrees/commands';
import { WorktreeController } from '../src/lib/worktrees/controller';
import { ProtocolWorktreeGateway } from '../src/lib/worktrees/gateway';

// The daemon package names the daemon binary, as this package names the client one (`BINARY_NAME`, bin/wiring.ts).
const DAEMON_NAME = Object.keys(daemonPkg.bin)[0] ?? daemonPkg.name;
/**
 * The one claim service, shared by every path that creates state inside `<FY_HOME>`.
 *
 * Built here rather than per group because the whole defect was two writers with no agreement: the
 * fleet wiring and the daemon-control wiring create state in the same directory, and each having its
 * own notion of when a home becomes ours is how they came to disagree in the first place. The repair
 * command is passed in rather than spelled inside the domain, so a renamed binary renames the advice.
 */
function buildStateHomeClaims(notices?: IStateHomeClaimNotices): StateHomeClaimService {
  return new StateHomeClaimService(new FileStateHomeClaim(), `${BINARY_NAME} daemon adopt`, notices);
}

/**
 * Ask the daemon binary for the one host diagnosis it owns.
 *
 * `fyd --check` already reads the effective state home, the address occupant, and the exact
 * launchability rule a session start uses. Delegating keeps `fy doctor` from growing a second,
 * inevitably divergent definition of a working host.
 */
function registerDoctorCommand(program: Command, world: CliWorld): void {
  const environment = world.environment;
  program
    .command('doctor')
    .description('check host dependencies and what each missing program prevents')
    .action(async () => {
      // Inside a ferret's pane: which credential its fy and tools would present, said before anything else.
      for (const warning of paneCredentialWarnings(environment)) world.io.warn(warning);
      const daemon = DAEMON_NAME;
      const executable = Bun.which(daemon, { PATH: environment.PATH ?? '' });
      if (executable === null)
        throw new Error(
          `cannot find ${daemon} on PATH — install the daemon package before running ${BINARY_NAME} doctor`,
        );
      const child = Bun.spawn([executable, '--check'], { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
      process.exitCode = await child.exited;
      const stateHome = resolveDaemonStateHome(world.homeDirectory, environment.FY_HOME, PRODUCT_NAME);
      for (const line of await legacyWireReport(localDaemonHealth(world, stateHome), Date.now())) world.io.report(line);
    });
}

// ─── DOMAIN WIRING · the ONLY scaffold↔domain seam (grows with the product; SIT injects doubles here) ───
/** The adapters a CLI invocation needs; the SIT in-process driver injects captured/test doubles here. */
export interface CliWorld {
  readonly io: ICliIo;
  readonly spinner: ISpinner;
  /** What a long command shows while it works: a spinner on a terminal, plain lines elsewhere. */
  readonly progress: IProgress;
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
  const progress = chooseProgress(
    { stderrIsTty: Boolean(process.stderr.isTTY), environment: process.env },
    line => {
      console.error(line);
    },
    processProgressHost,
  );
  const io = new ProgressAwareIo(new ConsoleIo(), progress);
  return {
    io,
    progress,
    spinner: new OraSpinner(),
    prompt: new InquirerPrompt(),
    interactive: io.interactive(),
    cwd: process.cwd(),
    homeDirectory: resolveUserHome(),
    environment: process.env,
  };
}

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
/** The app address a plan's card link is built on, and why a set `FY_APP_URL` was not used. */
function planApp(
  setting: string | undefined,
  client: Pick<IFyApiClient, 'request'>,
): {
  readonly appOrigin: string;
  readonly appOriginNote?: string;
  readonly machine: () => Promise<DaemonId | undefined>;
} {
  const { origin, refused } = appOriginChoice(setting);
  return {
    appOrigin: origin,
    ...(refused === undefined ? {} : { appOriginNote: refused }),
    machine: async () => (await client.request(DAEMON_IDENTITY_PATH, DaemonIdentityViewSchema)).daemonId,
  };
}

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
 * Where the daemon executable lives, and what version it is.
 *
 * `FY_DAEMON_BIN` first, then `PATH`. Both answers go through `resolveDaemonBinaryPath`, which is
 * where the absolute-path rule lives — `systemd` requires an absolute `ExecStart` and fails a unit
 * that has anything else with 203/EXEC, and `launchd` behaves the same way.
 */
function resolveDaemonBinary(
  environment: Record<string, string | undefined>,
  daemonName: string,
): InstalledDaemonBinary {
  const located = resolveDaemonBinaryPath({
    daemonName,
    pinned: environment.FY_DAEMON_BIN,
    found: Bun.which(daemonName, { PATH: environment.PATH ?? '' }) ?? undefined,
    executable: isExecutableFile,
  });
  return { ...located, version: daemonBinaryVersion(located.path) };
}

/** Is this an executable regular file? `statSync` follows links, which is what a launcher does. */
function isExecutableFile(path: string): boolean {
  try {
    const state = statSync(path);
    return state.isFile() && (state.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * How long `fyd --version` may take before its answer is "unknown".
 *
 * Unbounded, a daemon executable that hangs on `--version` — a wrapper waiting on a lock, a binary for
 * the wrong platform under emulation — hung every lifecycle verb with nothing on screen. The version is
 * only ever used to SAY a running daemon is older than the installed one, so an unknown version costs
 * one notice and nothing else.
 */
const DAEMON_VERSION_TIMEOUT_MS = 5_000;

function daemonBinaryVersion(path: string): string | undefined {
  const result = Bun.spawnSync([path, '--version'], {
    stdout: 'pipe',
    stderr: 'ignore',
    timeout: DAEMON_VERSION_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) return undefined;
  const version = new TextDecoder().decode(result.stdout).trim();
  return version === '' ? undefined : version;
}

/**
 * Builds the daemon-control controller.
 *
 * Constructed lazily, per invocation: resolving the layout can fail (for example, on a nonsensical
 * `FY_HOME`) and that must surface as an error from `fy daemon …`, never as a CLI that cannot even
 * print `--help`. The daemon executable is resolved later still, when a verb actually needs to record
 * or launch one — `fy daemon status` and `fy daemon logs` work on a host that has no daemon at all.
 */
function resolveWorldDaemonLayout(world: CliWorld): DaemonLayout {
  const environment = world.environment;
  const userId = typeof process.getuid === 'function' ? process.getuid() : 0;
  return resolveDaemonLayout({
    platform: process.platform,
    homeDirectory: resolveUserHome(environment),
    stateHome: environment.FY_HOME,
    configHome: environment.XDG_CONFIG_HOME,
    stateDirectory: environment.XDG_STATE_HOME,
    runtimeDirectory: privateRuntimeDirectory(environment.XDG_RUNTIME_DIR, userId),
    userId,
    daemonName: DAEMON_NAME,
    product: PRODUCT_NAME,
    searchPath: environment.PATH ?? '',
    locale: { LC_ALL: environment.LC_ALL, LC_CTYPE: environment.LC_CTYPE, LANG: environment.LANG },
  });
}

/** The local daemon's health probe: THIS state home's own address, never `FY_URL` (see below). */
function localDaemonHealth(world: CliWorld, stateHome: string): ProtocolDaemonHealth {
  const environment = { ...world.environment, FY_URL: undefined };
  return new ProtocolDaemonHealth(lazyHealthClient(environment, stateHome), undefined, async (path, timeoutMs) => {
    const response = await fetch(new URL(path, `${await daemonBaseUrl(environment, stateHome)}/`), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, body: await response.json().catch(() => undefined) };
  });
}

/** How the installed daemon got onto this host, read from the host itself. */
function hostInstallFacts(world: CliWorld): HostInstallFacts {
  return new HostInstallFacts({
    product: PRODUCT_NAME,
    homeDirectory: resolveUserHome(world.environment),
    platform: process.platform,
  });
}

/** The nix shell → nix profile switch, shared by `daemon install`'s offer and `daemon update`. */
function buildProfileSwitch(world: CliWorld, processes: BunDaemonProcess): NixProfileSwitch {
  return new NixProfileSwitch({
    facts: hostInstallFacts(world),
    packages: new CommandPackageManagers((argv, onLine) => processes.runStreaming(argv, onLine)),
    lifecycle: { executable: isExecutableFile, versionOf: daemonBinaryVersion },
    out: world.io,
    prompt: world.prompt,
    interactive: () => world.io.interactive(),
    product: PRODUCT_NAME,
    clientName: BINARY_NAME,
    daemonName: DAEMON_NAME,
    homeDirectory: resolveUserHome(world.environment),
  });
}

/**
 * Builds `fy daemon update`.
 *
 * Its lifecycle builds A NEW CONTROLLER FOR EVERY CALL, and that is the point: a controller resolves
 * the installed daemon once and remembers it, and an update changes the installed daemon — in place,
 * or (switching to a nix profile) at a new path, which is handed over as `FY_DAEMON_BIN`.
 */
function buildDaemonUpdater(world: CliWorld, client: SharedDaemonClient): DaemonUpdater {
  const environment = world.environment;
  const processes = new BunDaemonProcess();
  const layout = resolveWorldDaemonLayout(world);
  const health = localDaemonHealth(world, layout.stateHome);
  const controllerFor = (daemonPath?: string): DaemonController =>
    buildDaemonController(
      daemonPath === undefined ? world : { ...world, environment: { ...environment, FY_DAEMON_BIN: daemonPath } },
      client,
    );
  return new DaemonUpdater({
    facts: hostInstallFacts(world),
    latest: new GitHubLatestRelease(PRODUCT_NAME),
    packages: new CommandPackageManagers((argv, onLine) => processes.runStreaming(argv, onLine)),
    standalone: new StandaloneRelease({
      product: PRODUCT_NAME,
      clientName: BINARY_NAME,
      platform: process.platform,
      arch: process.arch,
      binaries: [BINARY_NAME, ...Object.keys(daemonPkg.bin)],
      keys: DAEMON_RELEASE_KEYS,
      run: argv => processes.run(argv),
    }),
    lifecycle: {
      installed: () => resolveDaemonBinary(environment, DAEMON_NAME),
      versionOf: daemonBinaryVersion,
      executable: isExecutableFile,
      restart: options =>
        controllerFor().restart({ midTurnSaid: true, ferretsKeepRunning: options?.ferretsKeepRunning }),
      installAt: path => controllerFor(path).install(),
      staleDefinition: () => controllerFor().staleDefinition(),
      probe: () => health.probe(),
    },
    updateView: new ProtocolDaemonUpdateView(client),
    switcher: buildProfileSwitch(world, processes),
    reports: new FileServiceStore(),
    out: world.io,
    prompt: world.prompt,
    interactive: () => world.io.interactive(),
    clock: new SystemMillisecondClock(),
    product: PRODUCT_NAME,
    clientName: BINARY_NAME,
    daemonName: DAEMON_NAME,
    progress: world.progress,
  });
}

function buildDaemonController(world: CliWorld, client: SharedDaemonClient): DaemonController {
  const environment = world.environment;
  const out = world.io;
  const daemonName = DAEMON_NAME;
  const layout = resolveWorldDaemonLayout(world);
  const processes = new BunDaemonProcess();
  const clock = new SystemMillisecondClock();
  const files = new FileServiceStore();
  // Every supervisor claims the state home before it creates the log directory inside it, so the
  // marker exists before the first entry does whichever way round `fy` and `fyd` are run.
  // Handed the terminal so a claim that adopts an empty, unmarked scaffold says so rather than
  // taking a directory over silently.
  const claims = buildStateHomeClaims(out);
  const service: IServiceDefinitionSupervisor | undefined =
    layout.manager === 'systemd'
      ? new SystemdSupervisor(layout, processes, files, claims)
      : layout.manager === 'launchd'
        ? new LaunchdSupervisor(layout, processes, files, claims)
        : undefined;
  return new DaemonController({
    layout,
    service,
    direct: new DirectSupervisor(layout, processes, files, claims),
    /**
     * THIS STATE HOME'S OWN ADDRESS, NEVER `FY_URL`. Every verb here manages the daemon process on
     * this host, and stop, restart and reset act on whatever answered: honouring a remote or forwarded
     * `FY_URL` reported a stranger's counts and handed its pid to a local SIGTERM.
     */
    health: localDaemonHealth(world, layout.stateHome),
    ioPressure: new ProcIoPressureReader(),
    logs: new TailDaemonLog(),
    nix: new NixStoreGcRoot(processes),
    // The claim reads the same clock the readiness and shutdown waits do, so the bound a caller waits
    // and the bound a peer may legitimately hold are measured against one source of time.
    lifecycle: new FileDaemonLifecycleLock(processes, new HostProcessIncarnations(processes), clock),
    // Resolved once per invocation: a verb now asks before its claim and again inside it, and each
    // answer that FOUND a daemon spawns its `--version`. A miss is not kept, so a daemon installed
    // while this invocation waited is still found.
    installedDaemon: (() => {
      let found: InstalledDaemonBinary | undefined;
      return () => (found ??= resolveDaemonBinary(environment, daemonName));
    })(),
    resetTrees: new FileResetTrees(),
    sessionTerminals: new TmuxSessionTerminalServer(processes),
    /**
     * The reset inventory, over the AUTHENTICATED shared client rather than the health probe.
     *
     * The secret store and the device registry both sit behind the host's admin credential, which the
     * probe token is not. It is only ever asked when the daemon answered a health probe, so the
     * connection it opens is one that already exists, and every failure is `undefined` — the counts are
     * a courtesy to somebody deciding, never a precondition of the recovery path.
     */
    resetInventory: new ProtocolResetInventory(client),
    claims,
    prompt: world.prompt,
    // Read when the reset would have to ask, not when this controller was built — the same answer every
    // other prompt in this CLI uses: both ends of the terminal, or nobody is there.
    interactive: () => world.io.interactive(),
    clientName: BINARY_NAME,
    clock,
    out,
    // The machine's own answer, through the same lazy client, after the start has already waited for it.
    setupNotice: new MachineSetupNotice({
      setUp: async () => (await new ProtocolAccountGateway(client).machine()).setUp,
      out,
      interactive: () => world.io.interactive(),
      clientName: BINARY_NAME,
    }),
    updateStatus: new DaemonUpdateStatusReader(hostInstallFacts(world), new ProtocolDaemonUpdateView(client)),
    tunnel: new ProtocolTunnelStatusReader(client),
    firewall: new ProtocolFirewallStatusReader(client),
    limits: new ProtocolLimitsStatusReader(client),
    nixShellOffer: buildProfileSwitch(world, processes),
    turns: { midTurn: async () => (await new ProtocolDaemonUpdateView(client).view())?.midTurn ?? 0 },
    restartMarker: new FileDaemonRestartMarker(restartMarkerPath(layout.stateHome)),
    progress: world.progress,
  });
}

/** Where the owner's Ferretry app lives: a plan card's deep link is `<this>/#agenda/<card>`. */

/** `fy pair`, and the QR `fy setup` offers at a terminal: one construction, so the two cannot differ. */
function buildPairController(world: CliWorld, client: SharedDaemonClient): PairController {
  const stateHome = resolveDaemonStateHome(world.homeDirectory, world.environment.FY_HOME, PRODUCT_NAME);
  return new PairController({
    gateway: new ProtocolPairingGateway(client),
    screen: new PlainScreen(),
    progress: world.spinner,
    exit: world.io,
    clock: new SystemMillisecondClock(),
    qr: new QrCodeTerminal(),
    terminal: new ProcessTerminalSize(),
    browser: desktopBrowserOpener(stateHome),
    redirectSweeper: { sweep: async () => void (await sweepPairingRedirects(stateHome, Date.now())) },
    binaryName: BINARY_NAME,
  });
}

/**
 * The same terminal with every progress line on stderr, for a command whose stdout is JSON. `fy setup
 * --json` drives verbs that report as they go, and their lines must not corrupt the one object an
 * agent parses.
 */
function stderrOnly(io: ICliIo): ICliIo {
  return {
    success: message => io.diagnostic(message),
    report: message => io.diagnostic(message),
    warn: message => io.diagnostic(message),
    error: message => io.error(message),
    diagnostic: message => io.diagnostic(message),
    setExitCode: code => io.setExitCode(code),
    interactive: () => io.interactive(),
  };
}

/**
 * Builds the state-home adopt controller.
 *
 * Lazy for the same reason the daemon controller is: resolving a state home can fail on a nonsensical
 * `FY_HOME`, and that must surface from `fy daemon adopt` rather than stop the CLI printing `--help`.
 */
function buildStateHomeController(world: CliWorld): StateHomeController {
  return new StateHomeController(
    buildStateHomeClaims(),
    resolveDaemonStateHome(world.homeDirectory, world.environment.FY_HOME, PRODUCT_NAME),
    world.io,
  );
}

/**
 * What one command group needs to wire itself: the program to hang commands on, plus the
 * collaborators every group shares.
 */
export interface DomainWiring extends DaemonWiring {
  readonly program: Command;
  readonly world: CliWorld;
}

/** The account model's collaborators, one set for every group that changes a machine's setup. */
function accountCommandDeps(world: CliWorld, client: SharedDaemonClient): AccountCommandDeps {
  return {
    gateway: new ProtocolAccountGateway(client),
    out: world.io,
    prompt: world.prompt,
    interactive: world.interactive,
    binaryName: BINARY_NAME,
    readText: path => Bun.file(isAbsolute(path) ? path : join(world.cwd, path)).text(),
    sleep: milliseconds => Bun.sleep(milliseconds),
    now: () => Date.now(),
    // `fy login add --from-env` reads this shell's own variables (docs/provider-presets.md).
    env: process.env,
    // Off a terminal, a one-click add with exactly one secret still missing reads it from stdin —
    // the same path `fy secret set` uses.
    readSecretValue: () => new StdinSecretValue(BINARY_NAME).read(),
    // `fy login budget` edits a login's file through the same checked write `fy config write` uses.
    config: new ProtocolConfigGateway(client),
  };
}

/** The related-work check a create asks before it files: the same daemon search `fy search` reads. */
function relatedCheck(world: CliWorld, client: SharedDaemonClient): RelatedCheck {
  return new RelatedCheck(new FyWorkSearchGateway(client), world.io, BINARY_NAME);
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
  ({ program, world, client, ownSessionId }) => {
    const notifyPorts = { gateway: new ProtocolNotifyGateway(client, ownSessionId), out: world.io, ownSessionId };
    registerAgendaCommands(
      program,
      new AgendaController(
        new ProtocolAgendaGateway(client, ownSessionId),
        world.io,
        ownSessionId,
        new AgendaBriefInput(world.cwd),
        undefined,
        { interactive: () => world.io.interactive(), ask: async message => await world.prompt.ask(message) },
        relatedCheck(world, client),
        new BoardCardTies(new FyBoardGateway(client)),
      ),
      async (words, options) => await runNotify(notifyPorts, words, options),
    );
  },
  ({ program, world, client, ownSessionId }) =>
    registerInputCommands(
      program,
      new InputController({
        gateway: new ProtocolInputGateway(client),
        out: world.io,
        prompt: world.prompt,
        interactive: world.interactive,
        ownSessionId,
        agentCredential: paneCredentialValue(world.environment),
        now: () => Date.now(),
        newDeliveryId: () => crypto.randomUUID(),
      }),
    ),
  ({ program, world, client, ownSessionId }) =>
    registerCopyCommands(
      program,
      new CopyController({
        gateway: new ProtocolCopyGateway(client),
        out: world.io,
        ownSessionId,
        agentCredential: paneCredentialValue(world.environment),
        sleep: async ms => await Bun.sleep(ms),
        nowMs: () => Date.now(),
      }),
      new PlanController({
        gateway: new ProtocolPlanGateway(client),
        out: world.io,
        ownSessionId,
        agentCredential: paneCredentialValue(world.environment),
        sleep: async ms => await Bun.sleep(ms),
        nowMs: () => Date.now(),
        ...planApp(world.environment.FY_APP_URL, client),
        openLink: async url => openInBrowser(url),
      }),
    ),
  ({ program, world, client, ownSessionId }) =>
    registerRulesCommands(
      program,
      new RulesController({
        gateway: new ProtocolRulesGateway(client),
        out: world.io,
        ownSessionId,
        agentCredential: paneCredentialValue(world.environment),
        sleep: async ms => await Bun.sleep(ms),
        nowMs: () => Date.now(),
        red: text => chalk.red(text),
        ...planApp(world.environment.FY_APP_URL, client),
        openLink: async url => openInBrowser(url),
      }),
    ),
  ({ program, world, client, ownSessionId }) =>
    registerPinCommands(program, new PinController(new ProtocolPinGateway(client), world.io, ownSessionId)),
  ({ program, world, client }) =>
    registerQueueCommands(program, { gateway: new ProtocolQueueGateway(client), out: world.io }),
  ({ program, world, client, ownSessionId }) =>
    registerNotifyCommands(program, {
      gateway: new ProtocolNotifyGateway(client, ownSessionId),
      out: world.io,
      ownSessionId,
    }),
  ({ program, world, client }) => registerAnalyticsCommands(program, new AnalyticsController(client, world.io)),
  ({ program, world, client, ownSessionId }) =>
    registerSecretCommands(
      program,
      new SecretController(
        new ProtocolSecretGateway(client),
        new SecretConsoleOutput(world.io),
        new StdinSecretValue(BINARY_NAME),
        process.cwd(),
      ),
      (() => {
        const accountGateway = new ProtocolSecretAccountGateway(client);
        const ports = {
          gateway: accountGateway,
          out: world.io,
          prompt: world.prompt,
          interactive: world.interactive,
          readRecipe: async (source: string) =>
            source === '-'
              ? await Bun.stdin.text()
              : await Bun.file(isAbsolute(source) ? source : join(world.cwd, source)).text(),
        };
        return {
          accounts: new AccountController(ports),
          signIns: new SignInController(ports),
          factorKeys: new FactorKeyController(ports),
          seeds: new TwoFactorSeedController({
            gateway: new ProtocolTwoFactorSeedGateway(client),
            accounts: accountGateway,
            out: world.io,
            prompt: world.prompt,
            interactive: world.interactive,
            ownSessionId,
            sleep: async ms => await Bun.sleep(ms),
            nowMs: () => Date.now(),
            ...planApp(world.environment.FY_APP_URL, client),
          }),
        };
      })(),
    ),
  ({ program, world, client }) =>
    registerFilesystemCommands(program, new FilesystemController(new ProtocolFilesystemGateway(client), world.io)),
  ({ program, world, client }) =>
    registerMigrationCommands(
      program,
      new MigrationController(client, new SessionPresenter(world.io, new SystemClock()), world.progress),
    ),
  ({ program, world, client, ownSessionId }) =>
    registerRestartCommands(
      program,
      new RestartController(client, new SessionPresenter(world.io, new SystemClock()), ownSessionId, world.progress),
    ),
  ({ program, world, client }) => registerScratchCommands(program, new ScratchController(client, world.io)),
  ({ program, world, client }) =>
    registerHarnessCommands(
      program,
      new HarnessController({
        gateway: client,
        out: world.io,
        prompt: world.prompt,
        interactive: world.interactive,
        wait: async milliseconds => await Bun.sleep(milliseconds),
        binaryName: BINARY_NAME,
      }),
    ),
  ({ program, world, client }) =>
    registerCatalogInstallCommands(
      program,
      new CatalogInstallController({
        gateway: client,
        files: new FsCatalogFileReader(),
        out: world.io,
        prompt: world.prompt,
        interactive: world.interactive,
        cwd: world.cwd,
        binaryName: BINARY_NAME,
      }),
    ),
  ({ program, world, client }) =>
    registerLocalSkillInstallCommands(
      program,
      new LocalSkillInstallController({
        gateway: client,
        out: world.io,
        prompt: world.prompt,
        interactive: world.interactive,
        cwd: world.cwd,
        binaryName: BINARY_NAME,
      }),
    ),
  ({ program, world, ownSessionId, restartPatience: patience, credentials }) =>
    registerSessionCommands(program, sessionCommands(world, ownSessionId, patience, credentials)),
  // `fy session revoke-credential`: a person cuts one ferret off (docs/agent-tools.md § "Cutting a ferret off").
  ({ program, world, client }) => {
    const presenter = new SessionPresenter(world.io, new SystemClock());
    registerSessionCredentialCommands(
      program,
      new RevokeCredentialController(new ProtocolSessionCredentialGateway(client), presenter, BINARY_NAME),
      presenter,
    );
  },
  // `fy session pin` and `unpin`: the owner's pinned agents, at the top of the sidebar.
  ({ program, world, client }) => {
    const presenter = new SessionPresenter(world.io, new SystemClock());
    registerSessionPinCommands(
      program,
      new PinAgentController(new ProtocolSessionPinGateway(client), presenter),
      presenter,
    );
  },
  // `fy session compact-at`: where one ferret squeezes its conversation (docs/compact-at.md).
  ({ program, world, client }) => {
    const presenter = new SessionPresenter(world.io, new SystemClock());
    registerSessionCompactAtCommand(
      program,
      new SessionCompactAtController(new ProtocolSessionCompactAtGateway(client), presenter),
      presenter,
    );
  },
  ({ program, world, client, ownSessionId }) => {
    const board = new BoardController({
      gateway: new FyBoardGateway(client),
      output: world.io,
      files: new BunTextFileReader(),
      binary: BINARY_NAME,
      environmentSessionId: ownSessionId,
      related: relatedCheck(world, client),
    });
    const mergeGate = new MergeGateController({ gateway: new FyMergeGateGateway(client), io: world.io });
    registerTaskCommands(program, { board, mergeGate });
    registerBoardCommands(program, board);
  },
  ({ program, world, client }) =>
    registerLaneCommands(program, { gateway: new FyLaneGateway(client), io: world.io, binaryName: BINARY_NAME }),
  ({ program, world, client }) =>
    registerBoardImportCommand(program, { gateway: new FyBoardImportGateway(client), io: world.io }),
  ({ program, world, client }) =>
    registerProjectCommands(program, {
      gateway: new FyProjectGateway(client),
      io: world.io,
      cwd: world.cwd,
      binaryName: BINARY_NAME,
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
        ...(process.getuid === undefined ? {} : { uid: process.getuid() }),
        loopbackMarker: async () => await readLoopbackFirewallMarker(async path => await Bun.file(path).text()),
      }),
    ),
  // After the browser group, because `browser firewall` mounts onto it.
  ({ program, world }) => registerFirewallCommands(program, BUNDLED_FIREWALL_FILES, world.io),
  // Terminals and browser pages by NAME — the agent tools' own actions, for scripts and for people. After
  // the browser group, because `browser page` mounts onto it.
  wiring => {
    const { program, world, client } = wiring;
    const toolsClient = agentToolsClient(world, wiring);
    const tools = new AgentToolsController(toolsClient, world.io, new FileScreenshotWriter());
    registerTerminalCommands(
      program,
      tools,
      new TerminalSlotsController(client, new SessionPresenter(world.io, new SystemClock())),
    );
    registerBrowserPageCommands(program, tools);
    // `fy lesson suggest`: the same agent route and credential as the MCP tool below.
    registerLessonCommands(program, new LessonController(toolsClient, world.io));
    // `fy instructions`: the sections this ferret launched with, read from the environment the wrapper read.
    registerInstructionsCommands(program, world.environment, world.io, BINARY_NAME);
    // The same client, as the MCP server every agent runtime starts (bin/mcp-group.ts).
    registerMcpGroup(program, world, wiring, toolsClient);
  },
  ({ program, world, client }) =>
    registerLearningCommands(
      program,
      new LearningController(new ProtocolLearningGateway(client), world.io, BINARY_NAME),
    ),
  ({ program, world, client }) =>
    registerSttCommands(program, new SttController(new ProtocolSttGateway(client), world.io)),
  // `fy config` (docs/config-files.md): check, find and confirm the configuration files. `check`,
  // `path`, `schema` and `guide` read the files directly, so they work with the daemon stopped.
  ({ program, world, client }) => {
    const stateHome = resolveDaemonStateHome(world.homeDirectory, world.environment.FY_HOME, PRODUCT_NAME);
    const assetsDirectory = join(stateHome, 'fleet', 'assets');
    registerConfigCommands(
      program,
      new ConfigController(
        new FileConfigFiles(join(stateHome, CONFIG_DIRECTORY_NAME), join(stateHome, 'state')),
        new ProtocolConfigGateway(client),
        world.io,
        BINARY_NAME,
        text => new Bun.CryptoHasher('sha256').update(text).digest('hex'),
        new StdinConfigText(),
        // The daemon's own check: a component source inside the state home is an error (docs/secrets.md).
        {
          componentSources: {
            fence: {
              homes: [stateHome, join(stateHome, 'state'), join(stateHome, CONFIG_DIRECTORY_NAME)],
              open: [assetsDirectory],
            },
            userHome: resolveUserHome(world.environment),
            assetsDirectory,
          },
        },
      ),
    );
  },
  // `fy render guide` (docs/fy-render.md § Guide for agents): the authoring guide the hypermedia
  // prompt's per-type lines point at. No daemon — the text ships in the binary.
  ({ program, world }) =>
    registerRenderCommands(program, new RenderController(world.io, BINARY_NAME, RENDER_GUIDE_SECTION)),
  ({ program, world, client }) =>
    registerCatalogCommands(
      program,
      new CatalogController(
        new ProtocolCatalogGateway(client),
        world.io,
        world.prompt,
        new FileCatalogWriter(),
        world.interactive,
        world.cwd,
      ),
    ),
  ({ program, world, client }) =>
    registerShareCommands(
      program,
      new ShareController({
        sharing: new ProtocolSharingGateway(client),
        catalogs: new ProtocolCatalogGateway(client),
        out: world.io,
        screen: new PlainScreen(),
        qr: new QrCodeTerminal(),
        terminal: new ProcessTerminalSize(),
        prompt: world.prompt,
        interactive: world.interactive,
        binaryName: BINARY_NAME,
      }),
    ),
  ({ program, world, client }) =>
    registerWorktreeCommands(
      program,
      // The INVOCATION cwd, for the same reason the marker probe below takes one: a fork defaults to
      // the checkout the human is standing in, and a removal must be refused when that is the very
      // checkout being destroyed.
      new WorktreeController(new ProtocolWorktreeGateway(client), world.io, world.prompt, world.interactive, world.cwd),
    ),
  ({ program, world, client }) =>
    registerFleetCommands(
      program,
      new RecommendController({
        recommendations: new ProtocolRecommendationGateway(client),
        out: world.io,
        binaryName: BINARY_NAME,
      }),
    ),
  // The account model's command groups (docs/design/account-model.md §6.2): machine, runtimes,
  // credentials, profiles and components. Every write goes through the daemon's
  // reviewed changes, so nothing here touches a configuration file.
  ({ program, world, client }) => registerAccountModelCommands(program, accountCommandDeps(world, client)),
  ({ program, world }) =>
    registerStatuslineCommands(
      program,
      createStatuslineController({
        environment: world.environment,
        homeDirectory: resolveUserHome(world.environment),
        product: PRODUCT_NAME,
        io: world.io,
      }),
    ),
  // `fy history claim`, which a wrapper runs before `exec` so a conversation has one live writer (§9.3).
  ({ program, world }) =>
    registerHistoryCommands(
      program,
      new HistoryController(
        // Fenced like the daemon's: the wrapper's claim, too, never lands a lease in the state home.
        fencedConversationLeaseStore(
          resolveFleetLayout({
            stateHome: world.environment.FY_HOME,
            userHome: resolveUserHome(world.environment),
            product: PRODUCT_NAME,
          }),
          new HostProcessStarts(process.platform),
        ),
        world.io,
        {
          ...(world.environment.FY_SESSION_ID ? { session: world.environment.FY_SESSION_ID } : {}),
          ...(world.environment.FY_RUNTIME ? { runtime: world.environment.FY_RUNTIME } : {}),
        },
      ),
    ),
  // The operator reads (bin/reads-group.ts).
  wiring => registerReadsGroup(wiring.program, wiring.world, wiring),
  // The daemon group manages a LOCAL PROCESS, so nothing in it may depend on a token existing: it has
  // to answer "is the daemon up?" on a host that has none, which is exactly what a fresh
  // `daemon install` leaves behind. Its health probe therefore has its own unauthenticated client.
  //
  // It does hold the shared one, for the setup notice alone. That is safe because the shared client is
  // LAZY — it resolves the address and the admin token on first use, and the only thing here that uses
  // it runs after a start has already waited for the daemon to serve.
  //
  // AND ITS SHARED CLIENT NEVER WAITS OUT A RESTART: these verbs ARE the restart, and `restart` asking
  // a stopped daemon how many ferrets are mid-turn must not wait a minute for an answer that is "none".
  ({ program, world, credentials }) => {
    const lifecycleClient = lazyDaemonClient(
      lazyDaemonConnection(world.environment, world.homeDirectory, undefined, () => {
        // Its own health read, which does not wait out a restart either.
        const { instances: _patient, ...impatient } = credentials();
        return impatient;
      }),
    );
    registerDaemonCommands(
      program,
      () => buildDaemonController(world, lifecycleClient),
      () => buildStateHomeController(world),
      () => buildDaemonUpdater(world, lifecycleClient),
    );
  },
  // The grant verbs mount onto the group above and DO take the shared client, because unlike every
  // other daemon verb they change what the daemon serves rather than whether it is running. They are
  // registered after it for that reason: the group has to exist before verbs can be added to it.
  ({ program, world, client }) =>
    registerGrantCommands(
      program,
      () =>
        new GrantController({
          gateway: new ProtocolGrantGateway(client),
          out: world.io,
          clientName: BINARY_NAME,
        }),
    ),
  // `fy device` reads and changes what each paired device may do. It takes the shared client, which is
  // lazy, so listing devices is the first thing that resolves the address and the admin token.
  ({ program, world, client }) =>
    registerDeviceCommands(
      program,
      () =>
        new DeviceController({
          gateway: new ProtocolDeviceGateway(client),
          out: world.io,
          prompt: world.prompt,
          interactive: world.interactive,
          clientName: BINARY_NAME,
        }),
    ),
  // The security verbs mount onto the same group, after it, and take the shared client for the same reason.
  ({ program, world, client }) =>
    registerSecurityCommands(
      program,
      () =>
        new SecurityController({
          gateway: new ProtocolSecurityGateway(client),
          out: world.io,
          clientName: BINARY_NAME,
        }),
    ),
  // `fy daemon tunnel` switches this machine's opt-in Cloudflare tunnel through the running daemon, which
  // applies it live. It mounts onto the same group, after it, with the shared client for the same reason.
  ({ program, world, client }) =>
    registerTunnelCommands(
      program,
      () =>
        new TunnelController({
          gateway: new ProtocolTunnelGateway(client),
          out: world.io,
          clientName: BINARY_NAME,
        }),
    ),
  ({ program, world, client }) =>
    registerAuditCommands(
      program,
      () => new AuditController({ gateway: new ProtocolAuditGateway(client), out: world.io }),
    ),
  ({ program, world, client }) =>
    registerProfileCommands(
      program,
      () =>
        new ProfileController({
          gateway: new ProtocolProfileGateway(client),
          tracer: new PlatformSyscallTracer(
            bunTracerHost(resolveDaemonStateHome(world.homeDirectory, world.environment.FY_HOME, PRODUCT_NAME)),
          ),
          out: world.io,
          progress: world.progress,
          sleep: async ms => await Bun.sleep(ms),
          now: () => Date.now(),
          writeFile: async (path, text) => {
            await Bun.write(path, text);
          },
          service: async () => await buildDaemonController(world, client).serviceFacts(),
        }),
    ),
  // Pairing writes its screen through its own uncoloured writer rather than `world.io`: the screen is
  // mostly a QR, and tinting the one image the onboarding depends on is a risk with nothing to gain.
  ({ program, world, client }) => registerPairCommands(program, buildPairController(world, client)),
  // The owner's passkey recovery verb. It dials the daemon with the host's admin credential, which is the
  // one caller the daemon treats as "at the machine" — no other credential could be answered.
  ({ program, world, client }) =>
    registerPasskeyCommands(
      program,
      new PasskeyController({
        gateway: new ProtocolPasskeyGateway(client),
        out: world.io,
        time: new IntlLocalTime(),
        binaryName: BINARY_NAME,
      }),
    ),
  // `daemon setup` and `daemon import <tool>` mount onto the daemon group above, so they come after it: a
  // booting daemon never sets a machine up, and these are how a person (or a script) does.
  ({ program, world, client }) => registerSetupCommands(program, accountCommandDeps(world, client)),
  // `fy import conversations` and `fy new --continue`: existing Claude Code/Codex conversations, kept on as ferrets.
  ({ program, world, client }) => {
    const gateway = new ProtocolImportGateway(client);
    const context = { now: () => Date.now(), binaryName: BINARY_NAME };
    registerImportCommands(program, new ImportController(gateway, world.io, context));
    // Pack mode (docs/pack-mode.md): `fy recommend`, and `fy new` without --continue. Inside a ferret's pane
    // FY_SESSION_ID names the ferret asking, which becomes the sub-ferret's parent.
    const pack = new PackController({
      gateway: new ProtocolPackGateway(client),
      out: world.io,
      progress: world.progress,
      parent: async () =>
        await ambientSession(world.environment, async argv => {
          const child = Bun.spawn({ cmd: [...argv], stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' });
          const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
          return code === 0 ? text : undefined;
        }).catch(() => undefined),
      cwd: world.cwd,
      absolute: path => (isAbsolute(path) ? path : join(world.cwd, path)),
      readFile: async path => await Bun.file(isAbsolute(path) ? path : join(world.cwd, path)).text(),
      binaryName: BINARY_NAME,
      sleep: async ms => await Bun.sleep(ms),
    });
    registerRecommendCommand(program, pack, new SessionPresenter(world.io, new SystemClock()));
    registerGuideCommand(program, pack, new SessionPresenter(world.io, new SystemClock()));
    registerNewCommand(
      program,
      new ContinueSessionController(gateway, world.io, world.prompt, { ...context, interactive: world.interactive }),
      pack,
    );
  },
  // `fy models list` and `fy models refresh` (docs/model-catalog.md): the catalogs the daemon reads.
  ({ program, world, client }) => registerModelsCommands(program, new ModelsController(client, world.io)),
  // `fy setup`: the one command after installing. It drives the daemon verbs above, then offers the
  // pairing QR only to a person at a terminal — `--json` and `--yes` name `fy pair` instead.
  ({ program, world, client }) =>
    registerOnboardCommands(
      program,
      () =>
        new OnboardController({
          daemon: quiet => buildDaemonController(quiet ? { ...world, io: stderrOnly(world.io) } : world, client),
          relay: new ProtocolOnboardRelay(client),
          machine: {
            setUp: async () => {
              try {
                return (await new ProtocolAccountGateway(client).machine()).setUp;
              } catch {
                return undefined;
              }
            },
          },
          pairing: { pair: () => buildPairController(world, client).pair({}) },
          prompt: world.prompt,
          out: world.io,
          interactive: () => world.io.interactive(),
          clientName: BINARY_NAME,
          clientVersion: pkg.version,
        }),
    ),
  ({ program, world, client, ownSessionId }) =>
    registerTidyCommands(
      program,
      new TidyController({
        plans: new FyTidyGateway(client),
        cards: new FyBoardGateway(client),
        agenda: new ProtocolAgendaGateway(client, ownSessionId),
        output: world.io,
        binary: BINARY_NAME,
        environmentSessionId: ownSessionId,
      }),
    ),
  ({ program, world, client, ownSessionId }) =>
    registerWorkSearchCommands(
      program,
      new WorkSearchController({
        gateway: new FyWorkSearchGateway(client),
        output: world.io,
        binary: BINARY_NAME,
        environmentSessionId: ownSessionId,
      }),
    ),
];

/**
 * The session command group's collaborators.
 *
 * It builds its own client rather than taking the shared one because the session commands need the
 * whole typed surface, not the `request`/`analytics` subset the gateways above use, and because a
 * session call must identify itself (`x-ferretry-client`) and its pane (`x-ferretry-session-id`) so
 * the daemon attributes it to the right actor. Still lazy: no token is demanded until a session
 * command actually runs.
 */
function sessionCommands(
  world: CliWorld,
  ownSessionId: string | undefined,
  restartPatience: DaemonRestartPatience,
  credentials: () => DaemonCredentialOptions,
): SessionCommandDeps {
  const cliEnvironment = world.environment;
  const environment: SessionEnvironment = {
    cwd: world.cwd,
    ...(ownSessionId === undefined ? {} : { callerSessionId: ownSessionId }),
  };
  const connect = createFyClientConnector({
    version: assertSemver(pkg.version),
    ...(cliEnvironment.FY_URL === undefined ? {} : { url: cliEnvironment.FY_URL }),
    ...(cliEnvironment.FY_TOKEN === undefined ? {} : { token: cliEnvironment.FY_TOKEN }),
    resolveLocalCredential: async () => {
      const { baseUrl, token, transport } = await daemonConnection(
        cliEnvironment,
        world.homeDirectory,
        undefined,
        credentials(),
      );
      return transport === undefined ? { baseUrl, token } : { baseUrl, token, transport };
    },
    ...(ownSessionId === undefined ? {} : { sessionId: ownSessionId }),
    restartPatience,
  });
  const api = new FySessionApi(connect);
  // The CARD column reads the board over the same lazy, memoised connector — `ps` never opens a
  // second connection for its lane names.
  const board: ISessionBoard = {
    laneNames: async () => boardLaneNames(new FyBoardGateway(await connect())),
  };
  // The daemon builds the whole table from its own registry, board and outbox: one request, whatever the size.
  const subtree: ISessionSubtree = {
    subtree: async id =>
      await (await connect()).request(`/v1/sessions/${encodeURIComponent(id)}/subtree`, SubtreeViewSchema),
  };
  // Chalk is the terminal's attention colour; it is the identity when colour is off (NO_COLOR, a
  // non-TTY stdout), which is exactly the deal the renderer measures widths under.
  const colour: ICellColour = { amber: cell => chalk.yellow(cell) };
  const files = new SessionFiles();
  const presenter = new SessionPresenter(world.io, new SystemClock());

  return {
    presenter,
    start: new StartSessionController(api, files, presenter, environment, BINARY_NAME),
    list: new ListSessionsController(api, presenter, board, colour),
    status: new SessionStatusController(api, presenter),
    subtree: new SessionSubtreeController(subtree, presenter, environment, new SystemClock(), colour),
    send: new SendMessageController(api, files, presenter, environment, {
      nowMs: () => Date.now(),
      sleep: milliseconds => Bun.sleep(milliseconds),
    }),
    answer: new AnswerQuestionController(api, presenter),
    names: new SuggestNamesController(api, presenter),
    interrupt: new InterruptSessionController(api, presenter),
    resume: new ResumeSessionController(api, presenter),
    signal: new SignalSessionController(api, presenter, environment),
    rename: new RenameSessionController(api, presenter),
  };
}

/** Route the product domain onto the program — one controller per command group. */
export function registerDomain(program: Command, world: CliWorld): void {
  const wiring: DomainWiring = { program, world, ...wireDaemon(program, world) };
  registerDoctorCommand(program, world);
  for (const register of DOMAIN_REGISTRARS) register(wiring);
}
// ─── END DOMAIN WIRING ────────────────────────────────────────────────────────────────────────

/** Composition root: build the program, wire the domain, run it, and release resources. */
export async function execute(argv: string[]): Promise<void> {
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
