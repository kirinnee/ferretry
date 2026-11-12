import type { Clock, RouteHandler, StatePort } from '@ferretry/kernel/contract';
import { type GitByteSpawn, KernelGitRunner } from '../adapters/git/runner.ts';
import {
  GitWorktreeGateway,
  KernelWorktreeClock,
  ManagedWorktreeAdapter,
  StateManagedWorktreeRegistry,
  WorktreeOperationQueue,
} from '../adapters/worktrees/index.ts';
import { type WorktreeRouteKey, worktreeRoutes } from '../lib/runtime/mounts/worktrees.ts';
import {
  type ManagedWorktreeOperations,
  ManagedWorktreeService,
  WorktreeError,
  type WorktreeSessionFact,
} from '../lib/worktrees/index.ts';
import type { WorktreeDirectoryPinner, WorktreeFileSystem } from '../lib/worktrees/ports.ts';

/**
 * Managed worktrees: the checkouts this daemon creates and removes (`/v1/worktrees`), and the evidence a removal is
 * refused on. Today's `daemon/bin/modules/worktrees.ts`, built inside Ferrets' `build(ctx)`. The service is inert
 * until a request: no jobs, no releases.
 */

/**
 * The host IO the Git operations need: byte-level Git, the managed root's file system, and the directory pinner.
 * These are the `kernel.spawn` / `RootHandle` additions being made on `rebuild/port-kernel`; until they land the host
 * passes none, and this daemon hosts no managed checkouts — which every route then says plainly (`no_managed_root`),
 * exactly as today's daemon did without a managed root.
 */
interface WorktreeHostIo {
  readonly git: GitByteSpawn;
  readonly fileSystem: WorktreeFileSystem;
  readonly pinner: WorktreeDirectoryPinner;
  /** Where managed checkouts live (inside the `worktrees` root). */
  readonly managedRoot: string;
}

/** What the worktrees module is built from. */
export interface WorktreesNeeds {
  readonly state: StatePort;
  /** The SAME clock the Git adapter stamps records with. */
  readonly clock: Clock;
  readonly io?: WorktreeHostIo;
  /**
   * Which ferrets are standing in which folders (from Ferrets' registry). `undefined` when unreadable, which the
   * domain turns into an un-forceable refusal.
   */
  readonly sessions: () => Promise<readonly WorktreeSessionFact[] | undefined>;
  /**
   * Which shells are still in a checkout (today: the terminal runtime). Terminals is a plugin Ferrets cannot read
   * (§2.1), so the host answers `undefined` until a hook carries it: a read still succeeds and a destructive write
   * still refuses.
   */
  readonly terminalRoots: () => Promise<readonly string[] | undefined>;
  /** Opaque ids for ownership tokens (today: `crypto.randomUUID`). */
  readonly newId: () => string;
}

export interface BuiltWorktrees {
  readonly service: ManagedWorktreeService;
  /** Where managed checkouts live; `undefined` while this daemon hosts none. */
  readonly managedRoot: string | undefined;
  readonly routes: { readonly [K in WorktreeRouteKey]: RouteHandler };
}

/** Operations for a daemon with no managed root: the service refuses before it would ever call one. */
const NO_HOST_OPERATIONS: ManagedWorktreeOperations = new Proxy({} as ManagedWorktreeOperations, {
  get: () => async () => {
    throw new WorktreeError('no_managed_root', 'this daemon hosts no managed worktrees');
  },
});

export function buildWorktrees(needs: WorktreesNeeds): BuiltWorktrees {
  const clock = new KernelWorktreeClock(needs.clock);
  const io = needs.io;
  const operations: ManagedWorktreeOperations =
    io === undefined
      ? NO_HOST_OPERATIONS
      : new ManagedWorktreeAdapter(
          new GitWorktreeGateway(new KernelGitRunner(io.git), io.fileSystem, clock),
          io.fileSystem,
          clock,
          new WorktreeOperationQueue(),
          io.pinner,
        );
  // The evidence is read through the SAME collaborators the rest of the daemon serves from, so a refusal to
  // remove a checkout because a ferret or a shell is still in it cites the very records the client would see if
  // it asked. BOTH READS ANSWER `undefined` RATHER THAN THROWING, and neither swallows the failure: the domain
  // turns an absent answer into an un-forceable refusal, so a read still succeeds and a destructive write still
  // refuses.
  const service = new ManagedWorktreeService(
    new StateManagedWorktreeRegistry(needs.state),
    operations,
    { sessions: async () => await needs.sessions().catch(() => undefined) },
    { roots: async () => await needs.terminalRoots().catch(() => undefined) },
    // The SAME clock the Git adapter stamps records with, so an intent this daemon writes before a mutation and
    // the record it writes after cannot disagree about when.
    clock,
    { next: needs.newId },
    io?.managedRoot,
  );
  return { service, managedRoot: io?.managedRoot, routes: worktreeRoutes(service) };
}
