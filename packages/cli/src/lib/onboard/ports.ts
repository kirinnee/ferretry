import type { IFyApiClient } from '@ferretry/protocol';
import type { DaemonInspection } from '../daemon/controller.ts';

/**
 * The daemon verbs `fy setup` drives. Satisfied by `DaemonController`, whose `install` and `start` are
 * already idempotent about a daemon that serves; `fy setup` decides which one to call so a healthy
 * daemon is never restarted just because somebody ran setup twice.
 */
export interface IOnboardDaemon {
  inspect(): Promise<DaemonInspection>;
  /** Write the user service definition and start the daemon under it. */
  install(): Promise<void>;
  /** Start the daemon as a direct child, for a host with no service manager. */
  start(): Promise<void>;
}

/** Where this daemon can be reached from another network, as the daemon itself publishes it. */
export type RelayReach =
  | { readonly state: 'relay'; readonly url: string }
  | { readonly state: 'direct-only' }
  | { readonly state: 'unknown'; readonly reason: string };

/** Reads the daemon's published carrier set. Never throws: a failure is `unknown` with its reason. */
export interface IOnboardRelay {
  reach(): Promise<RelayReach>;
}

/** Whether a runtime has been set up on this machine yet. `undefined` when the daemon cannot say. */
export interface IOnboardMachine {
  setUp(): Promise<boolean | undefined>;
}

/**
 * Shows the pairing QR to the person at this terminal and waits for the scan. Satisfied by
 * `PairController`. Only ever called on a terminal: the code is a live credential, so `fy setup`
 * never puts one into output a script, a log or an agent's transcript would keep.
 */
export interface IOnboardPairing {
  pair(): Promise<void>;
}

/** Where the person answers a question; never asked off a terminal. */
export interface IOnboardPrompt {
  ask(message: string): Promise<string>;
}

/** The shared output port's slice `fy setup` writes through. */
export interface IOnboardOutput {
  success(message: string): void;
  report(message: string): void;
  warn(message: string): void;
  setExitCode(code: number): void;
}

/** The only client capability the carrier read needs. */
export type CarrierApiClient = Pick<IFyApiClient, 'request'>;
