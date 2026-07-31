#!/usr/bin/env bun
import type { AnalyticsResponse, IFyApiClient } from '@ferretry/protocol';
import { FyApiClient } from '@ferretry/protocol/client';
import { Command } from 'commander';
import type { z } from 'zod';
import pkg from '../package.json' with { type: 'json' };
import { BunShell, type IShellRunner } from '../src/adapters/system/shell';
import { type ICliIo, ConsoleIo } from '../src/adapters/terminal/console-io';
import { CliProgressBar, type IProgressBar } from '../src/adapters/terminal/progress';
import { type IPrompt, InquirerPrompt } from '../src/adapters/terminal/prompt';
import { type ISpinner, OraSpinner } from '../src/adapters/terminal/spinner';
import { PinController } from '../src/lib/pins/controller';
import { registerAnalyticsCommands } from '../src/lib/analytics/commands';
import { AnalyticsController } from '../src/lib/analytics/controller';
import { registerPinCommands } from '../src/lib/pins/commands';
import { ProtocolPinGateway } from '../src/lib/pins/gateway';
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
 * A protocol client that connects on first use.
 *
 * Deferring the connection is what keeps `--help`, `--version` and a mistyped command working on a
 * host with no daemon and no token: nothing reaches the network until a command actually asks.
 */
function lazyDaemonClient(
  environment: Record<string, string | undefined>,
): Pick<IFyApiClient, 'request' | 'analytics'> {
  let connected: Promise<FyApiClient> | undefined;
  const client = (): Promise<FyApiClient> => (connected ??= FyApiClient.connect(daemonConnection(environment)));
  return {
    request: async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit, timeoutMs?: number): Promise<T> => {
      const ready = await client();
      return timeoutMs === undefined ? ready.request(path, schema, init) : ready.request(path, schema, init, timeoutMs);
    },
    analytics: async (query?: string): Promise<AnalyticsResponse> => (await client()).analytics(query),
  };
}

/** Route the product domain onto the program — one controller per command group. */
export function registerDomain(program: Command, world: CliWorld): void {
  const environment = process.env;
  const client = lazyDaemonClient(environment);
  const ownSessionId = environment.FY_SESSION_ID;

  registerPinCommands(program, new PinController(new ProtocolPinGateway(client), world.io, ownSessionId));
  registerAnalyticsCommands(program, new AnalyticsController(client, world.io));
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
