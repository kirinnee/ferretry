import type { Clock, RouteHandler, StatePort } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import { type GitByteSpawn, KernelGitRunner } from '../adapters/git/runner.ts';
import {
  GitWorktreeGateway,
  KernelWorktreeClock,
  ManagedWorktreeAdapter,
  StateManagedWorktreeRegistry,
  WorktreeOperationQueue,
} from '../adapters/worktrees/index.ts';
import { type WorktreeRouteKey, type WorktreeSubsystem, worktreeRoutes } from '../lib/runtime/mounts/worktrees.ts';
import {
  type ManagedWorktreeOperations,
  ManagedWorktreeService,
  WorktreeError,
  type WorktreeSessionFact,
} from '../lib/worktrees/index.ts';
import { RepoWorktreeLister } from '../lib/worktrees/repo-list.ts';
import type { WorktreeDirectoryPinner, WorktreeFileSystem } from '../lib/worktrees/ports.ts';
import { GitRepoWorktreeRows } from '../adapters/worktrees/repo-git.ts';
import type { RepoWorktreeListResponse } from '../../contract/index.ts';

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
   * Which shells are still in a checkout (the terminal runtime). Terminals is a plugin Ferrets cannot read
   * (§2.1), so the feature asks what it contributes to `terminal.roots`; `undefined` is unknown: a read still succeeds and a destructive write
   * still refuses.
   */
  readonly terminalRoots: () => Promise<readonly string[] | undefined>;
  readonly withTerminalRemoval?: <T>(path: string, remove: () => Promise<T>) => Promise<T>;
  /** Opaque ids for ownership tokens (today: `crypto.randomUUID`). */
  readonly newId: () => string;
}

export interface BuiltWorktrees {
  readonly service: ManagedWorktreeService;
  /** Where managed checkouts live; `undefined` while this daemon hosts none. */
  readonly managedRoot: string | undefined;
  /** Every worktree of the repository whose common directory this is (the repository listing). */
  readonly listRepo: (commonDirectory: string) => Promise<RepoWorktreeListResponse>;
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
  const runner = io === undefined ? undefined : new KernelGitRunner(io.git);
  const operations: ManagedWorktreeOperations =
    io === undefined || runner === undefined
      ? NO_HOST_OPERATIONS
      : new ManagedWorktreeAdapter(
          new GitWorktreeGateway(runner, io.fileSystem, clock),
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
    {
      roots: async () => await needs.terminalRoots().catch(() => undefined),
      ...(needs.withTerminalRemoval === undefined ? {} : { withRemoval: needs.withTerminalRemoval }),
    },
    // The SAME clock the Git adapter stamps records with, so an intent this daemon writes before a mutation and
    // the record it writes after cannot disagree about when.
    clock,
    { next: needs.newId },
    io?.managedRoot,
  );
  // The repository listing reads the managed list's own inspection, the registry and the fleet, and writes nothing.
  const lister =
    io === undefined || runner === undefined
      ? undefined
      : new RepoWorktreeLister({
          rows: async commonDirectory => await new GitRepoWorktreeRows(runner).rows(commonDirectory),
          examine: async input => await operations.examine(input),
          records: async () => await service.records(),
          sessions: async () => await needs.sessions(),
          managedRoot: io.managedRoot,
          clock: { nowMs: () => needs.clock.nowMs(), sleep: async ms => await needs.clock.sleep(milliseconds(ms)) },
        });
  const listRepo = async (commonDirectory: string): Promise<RepoWorktreeListResponse> => {
    if (lister === undefined) throw new WorktreeError('no_managed_root', 'this daemon hosts no managed worktrees');
    return await lister.list(commonDirectory);
  };
  const subsystem: WorktreeSubsystem = {
    list: async () => await service.list(),
    checkRemoval: async (path, cwd) => await service.checkRemoval(path, cwd),
    remove: async request => await service.remove(request),
    create: async request => await service.create(request),
    listRepo,
  };
  return { service, managedRoot: io?.managedRoot, listRepo, routes: worktreeRoutes(subsystem) };
}
