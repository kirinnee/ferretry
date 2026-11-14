/**
 * Everything one `fy` invocation needs from the outside, handed to the pure router (doctrine: `lib` never touches
 * `process`, the network or the disk). `bin/fy.ts` builds the real one from the adapters; tests build fakes.
 */
import type { Health, PluginInventory } from '@ferretry/kernel/contract';
import type { CliContext, Manifest, TerminalIo } from '@ferretry/kernel/manifest';
import type { Duration } from '@ferretry/std';
import type { DaemonTransport, InventoryCache } from './client.ts';
import type { Environment } from './credential.ts';
import type { CommandRegistry } from './registry.ts';
import type { StatuslinePorts } from './commands/statusline.ts';
import type { DaemonController, DaemonControlReads } from './daemon/controller.ts';
import type { IDaemonPrompt } from './update/machine.ts';
import type { DaemonUpdateOptions } from './update/updater.ts';
import type { IDaemonUpdateViewPort } from './update/ports.ts';

export interface Identity {
  /** The binary name, single-sourced from `packages/cli/package.json` `bin`. */
  readonly binary: string;
  readonly version: string;
}

/** What a public `GET /v1/health` came to. No credential is read or sent. */
export type Probe =
  | { readonly state: 'up'; readonly baseUrl: string; readonly health: Health }
  | { readonly state: 'down'; readonly baseUrl: string; readonly why: string };

/** A daemon connection: where it is, how to talk to it, and its plugin inventory. */
export interface Connection {
  readonly baseUrl: string;
  readonly transport: DaemonTransport;
  readonly inventory: InventoryCache;
}

export type LaunchResult =
  | { readonly started: true; readonly baseUrl: string }
  | { readonly started: false; readonly why: string };

/**
 * What every plugin's `cli` half is handed beyond its client and the terminal (`CliContext`: `clock`, `sleep`,
 * `readText`, `ownState`). `env` is not here: it is the allowed part of {@link CliWorld.environment}.
 */
export interface PluginHost {
  readonly clock: NonNullable<CliContext<Manifest>['clock']>;
  /** Waits, and ends early (rejecting with the signal's reason) when the signal aborts. */
  sleep(delay: Duration, signal?: AbortSignal): Promise<void>;
  /** As today's `readRecipe`: UTF-8 text from a path relative to the working directory; `-` reads standard input. No size cap. */
  readText(path: string): Promise<string>;
  /** The raw bytes of a path by the same rules as `readText` (relative to the working directory, `-` is standard input, no size cap). */
  readBytes(path: string): Promise<Uint8Array>;
  /** As today's `existsSync(resolve(cwd, path))`: a directory or an unreadable file exists; `-` is a file name. */
  exists(path: string): Promise<boolean>;
  /** Standard input as it arrives, for a verb that answers each line as it comes (`mcp serve`). */
  stdin(): AsyncIterable<Uint8Array>;
  /** The CLI's real working directory, never the inherited `PWD`, which a parent's `cwd:` option leaves stale. */
  cwd(): string;
  /** The kernel's state port over ONLY this plugin's own declared opaque files; any other file is refused. */
  ownState(manifest: Manifest): NonNullable<CliContext<Manifest>['ownState']>;
}

export interface CliWorld {
  readonly host: PluginHost;
  readonly io: TerminalIo;
  readonly environment: Environment;
  readonly identity: Identity;
  readonly registry: CommandRegistry;
  probe(): Promise<Probe>;
  /** Opens the connection on first use; starts the daemon first when none answers and this is a person's shell. */
  connect(options: { readonly asOwner: boolean }): Promise<Connection>;
  /** Starts the daemon now (`fy daemon start`). */
  launch(): Promise<LaunchResult>;
  /**
   * The daemon's process control (`fy daemon stop|restart|install|uninstall|logs|which|reset`), built for one verb.
   * The verb hands in the two reads that need a connection; this world opens none of its own for them.
   */
  daemon?(reads: DaemonControlReads): { readonly controller: DaemonController; exitCode(): number };
  /** Asks a person one question on the terminal and reads the line they type. Never used off a terminal. */
  readonly prompt?: IDaemonPrompt;
  /** A local file's text; throws when it cannot be read. */
  readText?(path: string): Promise<string>;
  /** `fy statusline`'s two effects: the passive usage file and the person's own command. Absent: nothing is recorded. */
  readonly statusline?: StatuslinePorts;
  /** The shell's local update transaction. Never depends on an enabled plugin. */
  update?(options: DaemonUpdateOptions, view: IDaemonUpdateViewPort): Promise<number>;
}

export type { PluginInventory };
