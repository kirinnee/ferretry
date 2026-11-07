import type { CatalogSubsystem } from '../../src/lib/runtime/mounts/catalogs.ts';
import {
  type ManagedWorktreeOperations,
  type ManagedWorktreeRegistry,
  ManagedWorktreeService,
  type SessionDirectorySubsystem,
  type TerminalRuntimePort,
  type WorktreeClock,
} from '../../src/lib/index.ts';
import type { DaemonModule } from '../../src/lib/runtime/modules.ts';
import { worktreesContribution } from '../lib/runtime/mounts/worktrees.ts';

/**
 * Managed worktrees: the checkouts this daemon creates and removes (`/v1/worktrees`), and the evidence a removal is
 * refused on.
 *
 * See `./learning.ts` for what a module file owns. This module has no `Seams` (it replaces no production adapter
 * that `DaemonWorld` carries: the Git operations arrive in the {@link WorktreeComposition} with the registry and the
 * managed root, which the opened state home decides), no jobs and no releases: the service is inert until a request.
 */

/**
 * The three things the managed-worktree surface cannot decide for itself.
 *
 * Each is a fact about THIS boot rather than about worktrees: the registry is a document inside the
 * state home that was just opened, the managed root is derived from that home's name, and the Git
 * operations are the one collaborator whose real behaviour means creating and destroying checkouts
 * on the machine running the test. Grouping them keeps the composition seam one parameter wide.
 */
export interface WorktreeComposition {
  readonly operations: ManagedWorktreeOperations;
  readonly registry: ManagedWorktreeRegistry;
  /** Absent means this daemon hosts no managed checkouts, which every route then says plainly. */
  readonly managedRoot: string | undefined;
}

/** What the worktrees module is built from. */
export interface WorktreesNeeds {
  /** The durable half and the Git operations, decided by the state home this boot opened. */
  readonly composition: WorktreeComposition;
  /** The session directory a removal asks which sessions are still in a checkout. */
  readonly sessions: Pick<SessionDirectorySubsystem, 'list'>;
  /** The terminal runtime a removal asks which shells are still in a checkout. */
  readonly terminals: Pick<TerminalRuntimePort, 'list'>;
  /** The project catalogue a checkout is joined to the Project that owns its repository by. */
  readonly catalogs: Pick<CatalogSubsystem, 'projects'>;
  /** The SAME clock the Git adapter stamps records with. */
  readonly clock: WorktreeClock;
}

export const worktreesModule: DaemonModule<void, WorktreesNeeds, ManagedWorktreeService> = {
  id: 'worktrees',
  build: needs => {
    const { composition, sessions, terminals, catalogs } = needs;
    // The evidence is read through the SAME collaborators the rest of the daemon serves from —
    // the session directory, the terminal runtime and the project catalog — so a refusal to
    // remove a checkout because a session or a shell is still in it cites the very records the
    // client would see if it asked. Collecting any of it separately is how a safety gate ends up
    // refusing on evidence nobody else can reproduce, or worse, never firing at all.
    const worktrees = new ManagedWorktreeService(
      composition.registry,
      composition.operations,
      // BOTH READS ANSWER `undefined` RATHER THAN THROWING, and neither swallows the failure: a
      // host whose tmux server will not answer used to take the whole worktree surface down with
      // a 500, and the only thing worse than that is the version that reports zero live shells
      // and lets a removal proceed. The domain turns an absent answer into an un-forceable
      // refusal, so a read still succeeds and a destructive write still refuses.
      {
        sessions: async () =>
          await sessions
            .list()
            .then(views =>
              views.map(session => ({
                id: session.config.id,
                cwd: session.config.cwd,
                status: session.state.status,
                ...(session.state.finishedAt === undefined ? {} : { finishedAt: session.state.finishedAt }),
              })),
            )
            .catch(() => undefined),
      },
      {
        roots: async () =>
          await terminals
            .list()
            .then(records => records.map(record => record.root))
            .catch(() => undefined),
      },
      { projects: async () => await catalogs.projects() },
      // The SAME clock the Git adapter stamps records with, so an intent this daemon writes
      // before a mutation and the record it writes after cannot disagree about when.
      needs.clock,
      { next: () => crypto.randomUUID() },
      composition.managedRoot,
    );
    return {
      id: 'worktrees',
      provides: worktrees,
      jobs: {},
      contributes: worktreesContribution(worktrees),
    };
  },
};
