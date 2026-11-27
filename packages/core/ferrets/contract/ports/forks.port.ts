import type { FerretId } from '@ferretry/kernel/contract';
import type { Result } from '@ferretry/std';
import type { TurnRef } from '../kinds/harness.ts';
import type { LaunchOrigin } from '../launch-origin.ts';
import type { StartFailure } from './lifecycle.port.ts';

/** How a fork is made beyond which ferret and which turn. */
export interface ForkOptions {
  /** The new ferret's name; absent, Ferrets gives it a callsign as it does any start. */
  readonly name?: string;
  /**
   * `same`: the new ferret works in the source's folder. `new`: it works in a new managed worktree cut from the source
   * checkout's HEAD (uncommitted changes are not copied).
   */
  readonly worktree: 'new' | 'same';
}

/** What a fork made: the new ferret, the conversation its harness cut for it, and where it works. */
export interface ForkedFerret {
  readonly ferret: FerretId;
  readonly harnessConversation: string;
  readonly folder: string;
  /** Present when `worktree: 'new'` made a checkout. */
  readonly worktree?: { readonly path: string; readonly branch: string };
}

/**
 * Why a fork was refused. Every failure before `start` writes nothing; `start` and the failures after the cut leave the
 * source untouched.
 */
export type ForkFailure =
  | {
      readonly code: 'no_ferret' | 'forbidden' | 'running' | 'unsupported' | 'worktree' | 'cut';
      readonly reason: string;
    }
  | { readonly code: 'start'; readonly reason: string; readonly start: StartFailure };

/** A fork of a ferret's conversation into a new ferret (core's `forks` slice; Conversation's alone calls it). */
export interface ForksApi {
  forks?: {
    /**
     * Cuts `from`'s conversation at `at` through its harness (`Harness.fork`) and starts a NEW ferret on the cut. The source
     * is never written. `caller` is who the fork is for: a ferret reaches only itself and its helpers (`mayTouch`).
     * A harness with no `fork` refuses with a sentence saying so, and nothing is written.
     */
    fork(
      from: FerretId,
      at: TurnRef,
      options: ForkOptions,
      caller: LaunchOrigin,
    ): Promise<Result<ForkedFerret, ForkFailure>>;
  };
}
