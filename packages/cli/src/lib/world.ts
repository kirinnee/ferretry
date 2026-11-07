/**
 * Everything one `fy` invocation needs from the outside, handed to the pure router (doctrine: `lib` never touches
 * `process`, the network or the disk). `bin/fy.ts` builds the real one from the adapters; tests build fakes.
 */
import type { Health, PluginInventory } from '@ferretry/kernel/contract';
import type { TerminalIo } from '@ferretry/kernel/manifest';
import type { DaemonTransport, InventoryCache } from './client.ts';
import type { Environment } from './credential.ts';
import type { CommandRegistry } from './registry.ts';
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

export interface CliWorld {
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
  /**
   * Listens for an interrupt (SIGINT, SIGTERM) for as long as a verb follows something. `release` gives the listeners
   * back. Absent where nothing can interrupt (a test), in which case a follower ends only when its feed does.
   */
  interrupt?(): { readonly signal: AbortSignal; release(): void };
  /** A local file's text; throws when it cannot be read. */
  readText?(path: string): Promise<string>;
  /** The shell's local update transaction. Never depends on an enabled plugin. */
  update?(options: DaemonUpdateOptions, view: IDaemonUpdateViewPort): Promise<number>;
}

export type { PluginInventory };
