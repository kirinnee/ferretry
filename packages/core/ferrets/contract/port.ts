import { defineEvent, definePort, type FerretId } from '@ferretry/kernel/contract';
import type { Result } from '@ferretry/std';
import { z } from 'zod';
import type { FerretRole, FerretState, FerretSummary, HarnessKey, PackId } from './ids.ts';
import type { RunnerHandle, SitrepLine } from './kinds.ts';

/** A request to start a ferret (from the owner's route, a pack, the board, or a lead for its helper). */
export interface StartRequest {
  readonly name?: string;
  readonly parent?: FerretId;
  readonly pack?: PackId;
  readonly role?: FerretRole;
  readonly harness?: HarnessKey;
  readonly runtime?: string;
  readonly login?: string;
  readonly folder: string;
  readonly prompt?: string;
  readonly by: 'owner' | 'ferret' | 'pack' | 'board';
}

export type StartFailure =
  | { readonly code: 'refused'; readonly reason: string } // a start.decide taker said no
  | { readonly code: 'folder'; readonly reason: string } // WorkFolders refused the folder
  | { readonly code: 'harness_unavailable' | 'runner_unavailable' | 'login_unavailable'; readonly reason: string }
  | { readonly code: 'failed'; readonly reason: string };

/** A ferret's whole status: its state, its turn, what plugins add, and its blockers from the Asks port. */
export interface Sitrep {
  readonly ferret: FerretSummary;
  readonly lines: readonly SitrepLine[];
  /** Open asks about this ferret (ids, `!A3`). */
  readonly blockers: readonly string[];
}

/**
 * The Ferrets port (§2.2): who each ferret is, its lineage, its state; start, stop and resume through the harness
 * and runner plugins. "A ferret touches only its own; a lead also its helpers'" is `mayTouch`, decided here and
 * nowhere else.
 */
export interface FerretsApi {
  get(ferret: FerretId): Promise<FerretSummary | undefined>;
  list(filter?: {
    readonly state?: FerretState;
    readonly parent?: FerretId;
    readonly pack?: PackId;
  }): Promise<readonly FerretSummary[]>;
  /** Synchronous, memory-only: whether `caller` may act on `target` (itself, or a helper of its own lineage). */
  mayTouch(caller: FerretId, target: FerretId): boolean;
  children(ferret: FerretId): readonly FerretId[];
  /** The harness keys currently provided under `harnesses` (a plugin off is absent). */
  harnesses(): readonly HarnessKey[];
  start(request: StartRequest): Promise<Result<FerretId, StartFailure>>;
  stop(ferret: FerretId, how: 'polite' | 'now'): Promise<void>;
  resume(ferret: FerretId): Promise<Result<FerretId, StartFailure>>;
  /** Adopts a live process by its runner handle without restarting it (spine D15). */
  attach(ferret: FerretId, handle: RunnerHandle): Promise<Result<FerretId, StartFailure>>;
  /**
   * The runner handle of a running ferret (Terminals: its tmux pane id), as `ferret.json` keeps it, so a harness finds
   * the ferret's pane after a daemon restart. `undefined` for a stopped or unknown ferret. Not a secret.
   */
  handle(ferret: FerretId): Promise<RunnerHandle | undefined>;
  sitrep(ferret: FerretId): Promise<Sitrep | undefined>;
}

export const FerretsPort = definePort<FerretsApi>('ferrets');

/** A ferret was added, changed state, or went away. A wake-up for views; the truth is `FerretsPort`. */
export const FerretsChanged = defineEvent(
  'ferrets.changed',
  z.strictObject({ ferret: z.string().min(1), generation: z.number().int() }),
);
