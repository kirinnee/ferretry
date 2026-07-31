#!/usr/bin/env bun
import type { AnalyticsResponse, IFyApiClient } from '@ferretry/protocol';
import { FyApiClient } from '@ferretry/protocol/client';
import { Command } from 'commander';
import type { z } from 'zod';
import pkg from '../package.json' with { type: 'json' };
import { createFyClientConnector, FySessionApi, SessionFiles, SystemClock } from '../src/adapters/session/index.ts';
import { BunShell, type IShellRunner } from '../src/adapters/system/shell';
import { BunTextFileReader } from '../src/adapters/tasks/bun-text-file-reader';
import { environmentBoardCredentials, environmentSessionId } from '../src/adapters/tasks/task-environment';
import { FyTaskBoardGateway } from '../src/adapters/tasks/fy-task-board-gateway';
import { FyTaskGateway } from '../src/adapters/tasks/fy-task-gateway';
import { registerTaskBoardCommands } from '../src/adapters/tasks/task-board-commands';
import { registerTaskCommands } from '../src/adapters/tasks/task-commands';
import { type ICliIo, ConsoleIo } from '../src/adapters/terminal/console-io';
import { CliProgressBar, type IProgressBar } from '../src/adapters/terminal/progress';
import { type IPrompt, InquirerPrompt } from '../src/adapters/terminal/prompt';
import { type ISpinner, OraSpinner } from '../src/adapters/terminal/spinner';
import { registerAnalyticsCommands } from '../src/lib/analytics/commands';
import { AnalyticsController } from '../src/lib/analytics/controller';
import { registerAttentionCommands } from '../src/lib/attention/commands';
import { AttentionController } from '../src/lib/attention/controller';
import { ProtocolAttentionGateway } from '../src/lib/attention/gateway';
import { registerPinCommands } from '../src/lib/pins/commands';
import { PinController } from '../src/lib/pins/controller';
import { ProtocolPinGateway } from '../src/lib/pins/gateway';
import {
  AnswerQuestionController,
  InterruptSessionController,
  ListSessionsController,
  registerSessionCommands,
  type SessionCommandDeps,
  ResumeSessionController,
  SendMessageController,
  type SessionEnvironment,
  SessionPresenter,
  SessionStatusController,
  StartSessionController,
  SuggestNamesController,
} from '../src/lib/session/index.ts';
import { assertSemver } from '../src/lib/version';

// Identity is single-sourced from package.json: the bin key names the binary, version feeds --version.
const BINARY_NAME = Object.keys(pkg.bin)[0] ?? pkg.name;
const DESCRIPTION = 'Command-line client for the per-host agent daemon';

/** Scaffold: the commander program skeleton (identity + `--help`/`--version`), domain-free. */
export function createProgram(): Command {
  return new Command()
    .name(BINARY_NAME)
    .description(DESCRIPTION)
    .version(assertSemver(pkg.version), '-v, --version', 'print the CLI version')
    .showHelpAfterError();
}

// ─── DOMAIN WIRING · the ONLY scaffold↔domain seam (grows with the product; SIT injects doubles here) ───
/** The adapters a CLI invocation needs; the SIT in-process driver injects captured/test doubles here. */
export interface CliWorld {
  readonly io: ICliIo;
  readonly spinner: ISpinner;
  readonly progress: IProgressBar;
  readonly prompt: IPrompt;
  readonly shell: IShellRunner;
  readonly interactive: boolean;
  /** The process environment, injected so tests never depend on the ambient one. */
  readonly environment: Record<string, string | undefined>;
}

/** The real production world: the shipped IO adapters. */
export function buildWorld(): CliWorld {
  const io = new ConsoleIo();
  return {
    io,
    spinner: new OraSpinner(),
    progress: new CliProgressBar(),
    prompt: new InquirerPrompt(),
    shell: new BunShell(),
    interactive: io.interactive(),
    environment: process.env,
  };
}

/** Where `fyd` listens when the environment does not say otherwise. */
const DEFAULT_DAEMON_URL = 'http://127.0.0.1:7337';

/**
 * How the CLI finds the daemon: the environment, and nothing else. The CLI never reads `fyd`'s state
 * home — that is the seam the whole split exists to enforce.
 */
function daemonConnection(environment: Record<string, string | undefined>): {
  baseUrl: string;
  token: string;
  version: string;
} {
  const token = environment.FY_TOKEN?.trim() ?? '';
  if (token === '') {
    throw new Error('FY_TOKEN is not set — export the token fyd issued so the CLI can authenticate');
  }
  const url = environment.FY_URL?.trim() ?? '';
  return { baseUrl: url === '' ? DEFAULT_DAEMON_URL : url, token, version: assertSemver(pkg.version) };
}

/**
 * The one connection to the daemon, opened on first use and shared by every command group.
 *
 * Deferring the connection is what keeps `--help`, `--version` and a mistyped command working on a
 * host with no daemon and no token: nothing reaches the network until a command actually asks.
 */
function lazyDaemonConnection(environment: Record<string, string | undefined>): () => Promise<IFyApiClient> {
  let connected: Promise<FyApiClient> | undefined;
  return (): Promise<FyApiClient> => (connected ??= FyApiClient.connect(daemonConnection(environment)));
}

/** The deferred connection as the client object every command group is wired with. */
function lazyDaemonClient(client: () => Promise<IFyApiClient>): Pick<IFyApiClient, 'request' | 'analytics'> {
  return {
    request: async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit, timeoutMs?: number): Promise<T> => {
      const ready = await client();
      return timeoutMs === undefined ? ready.request(path, schema, init) : ready.request(path, schema, init, timeoutMs);
    },
    analytics: async (query?: string): Promise<AnalyticsResponse> => (await client()).analytics(query),
  };
}

/**
 * What one command group needs to wire itself: the program to hang commands on, plus the
 * collaborators every group shares.
 */
export interface DomainWiring {
  readonly program: Command;
  readonly world: CliWorld;
  readonly client: Pick<IFyApiClient, 'request' | 'analytics'>;
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
function sessionCommands(world: CliWorld, ownSessionId: string | undefined): SessionCommandDeps {
  const environment: SessionEnvironment = {
    cwd: process.cwd(),
    ...(ownSessionId === undefined ? {} : { callerSessionId: ownSessionId }),
    ...(process.env.FY_BOARD_CAPABILITY === undefined ? {} : { boardCapability: process.env.FY_BOARD_CAPABILITY }),
  };
  const api = new FySessionApi(
    createFyClientConnector({
      version: assertSemver(pkg.version),
      ...(process.env.FY_URL === undefined ? {} : { url: process.env.FY_URL }),
      ...(process.env.FY_TOKEN === undefined ? {} : { token: process.env.FY_TOKEN }),
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
  };
}

/** Route the product domain onto the program — one controller per command group. */
export function registerDomain(program: Command, world: CliWorld): void {
  // The injected environment, never the ambient one: an in-process journey must not inherit FY_*.
  const environment = world.environment;
  const wiring: DomainWiring = {
    program,
    world,
    client: lazyDaemonClient(lazyDaemonConnection(environment)),
    // One reading of "which session am I", shared by every group: blank is absent, not an empty id.
    ownSessionId: environmentSessionId(environment),
  };
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
