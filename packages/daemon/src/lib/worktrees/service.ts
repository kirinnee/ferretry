import {
  type BranchDeletionConfirmation,
  type CreatedWorktree,
  type CreateWorktreeRequest,
  type ManagedWorktreeView,
  type ProjectInfo,
  projectForWorktree,
  type RemovedWorktree,
  type SessionStatus,
  type WorktreeListResponse,
  type WorktreeRemovalDecision,
  type WorktreeRemovalRequest,
} from '@ferretry/protocol';
import { WorktreeError, WorktreeRemovalRefusal } from './errors.ts';
import { isWithinDirectory, sharingSessionIds } from './policy.ts';
import type { WorktreeClock } from './ports.ts';
import {
  findManagedWorktree,
  isRegistrySettled,
  isRemovalInterrupted,
  type ManagedWorktreeRegistry,
  type ManagedWorktreeRegistryState,
  withManagedWorktree,
  withManagedWorktreeIntent,
  withoutManagedWorktreeIntent,
  withRemovalAbandoned,
  withRemovalStarted,
  withRemovedManagedWorktree,
} from './registry.ts';
import type {
  CheckManagedWorktreeRemovalInput,
  CreatedManagedWorktree,
  CreateManagedWorktreeInput,
  ManagedWorktree,
  ManagedWorktreeAdoption,
  ManagedWorktreeInspection,
  ManagedWorktreeIntent,
  ManagedWorktreePlan,
  ManagedWorktreePresence,
  RemovedManagedWorktree,
  RemoveManagedWorktreeInput,
} from './types.ts';

/**
 * The managed-worktree surface: the registry, the live Git refresh, and the safety decisions between.
 *
 * IT LIVES IN THE DOMAIN AND TALKS TO PORTS, so every branch below — every refusal, every piece of
 * missing evidence, every ordering — is decided from values rather than from a repository on disk.
 * The Git work itself is one port, because the expensive, hard-to-drive part of this feature is
 * running Git, and the part that is easy to get wrong is deciding what to do with what Git said.
 *
 * A LIST IS A REFRESH, NOT A REPLAY. Every row is re-inspected against live Git and live host state
 * on every read. Replaying the registry would report a checkout somebody deleted by hand as present,
 * a branch somebody switched as unchanged, and a dirty tree as safe to remove — and the last of
 * those is the one that destroys work.
 *
 * AND EVERY READ RECONCILES FIRST. Both mutations are two steps — declare, then ask Git — so both
 * have a window where the daemon can die holding half an answer. `#settled` is where the disk gets
 * to decide what actually happened; it does no Git work at all when the registry has nothing
 * outstanding, which is every ordinary read.
 */

/**
 * Whether a session is FINISHED, keyed exhaustively so a new status cannot default to the safe-
 * looking answer.
 *
 * Two conditions, both required, and they are the same two the daemon's own pane reaper demands: a
 * terminal status AND the instant it finished. A status with no `finishedAt` is incomplete evidence
 * about a session that may still be holding the checkout, and this surface refuses on incomplete
 * evidence rather than deleting somebody's working tree on the strength of a half-written document.
 */
const SESSION_TERMINAL_STATUS = {
  created: false,
  starting: false,
  running: false,
  thinking: false,
  tool_running: false,
  awaiting_question: false,
  awaiting_user: false,
  interrupted: false,
  rate_limited: false,
  retrying: false,
  waiting: false,
  kill_failed: true,
  completed: true,
  failed: true,
  stalled: true,
  stopped: true,
} as const satisfies { readonly [K in SessionStatus]: boolean };

/** One session, reduced to the two things a worktree decision may consider. */
export interface WorktreeSessionFact {
  readonly id: string;
  readonly cwd: string;
  readonly status: SessionStatus;
  readonly finishedAt?: string;
}

/** Whether this session may still be working in a checkout. Unproven-finished counts as active. */
export function isWorktreeSessionActive(session: WorktreeSessionFact): boolean {
  return !(SESSION_TERMINAL_STATUS[session.status] && session.finishedAt !== undefined);
}

/**
 * Which sessions the daemon holds, and whether each is still alive.
 *
 * `undefined` means the directory could not be read AT ALL — which is not the same as holding no
 * sessions, and must never be read as one. See {@link managedWorktreeRemovalContext}.
 */
export interface WorktreeSessionEvidence {
  sessions(): Promise<readonly WorktreeSessionFact[] | undefined>;
}

/**
 * The working directory of every shell this daemon has open.
 *
 * ROOTS RATHER THAN TERMINALS, because containment is the only question asked of them, and handing
 * the domain a terminal record would hand it an id it could be tempted to act on. Removing a
 * checkout out from under a live shell is the one loss no override clears, so this evidence must
 * exist for that refusal to be anything but decorative.
 *
 * `undefined` means the host's terminals could not be listed — a tmux server that will not answer,
 * for one — and it is emphatically not an empty list. This distinction is not theoretical: the
 * end-to-end journey that first drove a real CLI against a real daemon found this port throwing and
 * taking the whole surface down with a 500, and the shape one line up from that bug is a surface
 * that answers cheerfully while its live-terminal refusal can never fire.
 */
export interface WorktreeTerminalEvidence {
  roots(): Promise<readonly string[] | undefined>;
}

/** The registered Projects, so a checkout can be joined to the one that owns its repository. */
export interface WorktreeProjectDirectory {
  projects(): Promise<readonly ProjectInfo[]>;
}

/** Opaque ids for ownership tokens and for the destination key of an unowned checkout. */
export interface WorktreeIdSource {
  next(): string;
}

/**
 * Running Git for one managed checkout.
 *
 * `examine` is deliberately one operation rather than two: the list needs live state and the check
 * needs a removal verdict, and they are read from the same Git answers. Two calls would run Git
 * twice and could return two accounts of one checkout, which is the staleness this surface exists to
 * remove. `adopt` and `presence` are the two questions reconciliation asks of the disk.
 */
export interface ManagedWorktreeOperations {
  create(input: CreateManagedWorktreeInput): Promise<CreatedManagedWorktree>;
  examine(input: CheckManagedWorktreeRemovalInput): Promise<ManagedWorktreeInspection>;
  remove(input: RemoveManagedWorktreeInput): Promise<RemovedManagedWorktree>;
  /** What became of a declared creation: is it there, is it ours, or was it never made. */
  adopt(intent: ManagedWorktreeIntent): Promise<ManagedWorktreeAdoption>;
  /** Whether the exact checkout incarnation a record names is still at its path. */
  presence(entry: ManagedWorktree): Promise<ManagedWorktreePresence>;
}

/** The intent a plan describes, which is everything about the checkout except the directory Git makes. */
export function managedWorktreeIntent(
  plan: ManagedWorktreePlan,
  declaredAt: string,
  ownerSessionId: string | undefined,
): ManagedWorktreeIntent {
  return {
    version: 1,
    path: plan.path,
    branch: plan.branch,
    repositoryRoot: plan.repositoryRoot,
    commonDir: plan.commonDir,
    ownershipToken: plan.ownershipToken,
    declaredAt,
    initialHead: plan.startOid,
    branchPreexisted: plan.branchPreexisted,
    sourceCwd: plan.sourceCwd,
    relativeCwd: plan.relativeCwd,
    ...(ownerSessionId === undefined ? {} : { ownerSessionId }),
  };
}

/**
 * The removal question for one checkout, assembled from host evidence rather than from a caller.
 *
 * Every collected fact can only ever ADD a refusal. That asymmetry is what makes it safe to collect
 * some of it optimistically: a session list this daemon could not read yields fewer blockers, never
 * a wrongly granted removal, because nothing here is an authorization.
 */
export function managedWorktreeRemovalContext(input: {
  readonly managed: ManagedWorktree;
  readonly managedRoot: string;
  readonly sessions: readonly WorktreeSessionFact[] | undefined;
  readonly terminalRoots: readonly string[] | undefined;
  readonly currentWorkingDirectory?: string;
  readonly confirmations?: readonly BranchDeletionConfirmation[];
}): CheckManagedWorktreeRemovalInput {
  const active = (input.sessions ?? []).filter(isWorktreeSessionActive);
  const owner = input.managed.ownerSessionId;
  const undetermined = [
    input.sessions === undefined
      ? 'the session directory could not be read, so an agent working in the checkout cannot be ruled out'
      : '',
    input.terminalRoots === undefined
      ? "the host's terminals could not be listed, so a live shell rooted in the checkout cannot be ruled out"
      : '',
  ].filter(reason => reason !== '');
  return {
    managed: input.managed,
    managedRoot: input.managedRoot,
    ownerActive: owner !== undefined && active.some(session => session.id === owner),
    ...(input.currentWorkingDirectory === undefined ? {} : { currentWorkingDirectory: input.currentWorkingDirectory }),
    otherSessions: active
      .filter(session => session.id !== owner)
      .map(session => ({ id: session.id, cwd: session.cwd })),
    liveTerminals: (input.terminalRoots ?? []).filter(root => isWithinDirectory(input.managed.path, root)).length,
    ...(undetermined.length === 0 ? {} : { undeterminedEvidence: undetermined }),
    ...(input.confirmations === undefined ? {} : { confirmations: input.confirmations }),
  };
}

/**
 * The list order: live checkouts first, newest first within each group.
 *
 * A tombstone beside a live checkout reads as something still on disk, and the first thing anyone
 * does with this list is decide what to clean up — so the rows that still exist come first and the
 * ones that do not are visibly a second group.
 */
export function orderManagedWorktreeViews(views: readonly ManagedWorktreeView[]): readonly ManagedWorktreeView[] {
  return [...views].sort((left, right) => {
    const removed = Number(left.removedAt !== undefined) - Number(right.removedAt !== undefined);
    return removed === 0 ? right.createdAt.localeCompare(left.createdAt) : removed;
  });
}

export class ManagedWorktreeService {
  /**
   * The tail of the complete lifecycle chain.
   *
   * Registry writes are individually atomic, but an intent/stamp followed by Git followed by its
   * settled record is ONE state machine. Serializing only each write lets a concurrent list
   * reconcile the middle of that state machine and erase its recovery evidence.
   */
  private lifecycle: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly registry: ManagedWorktreeRegistry,
    private readonly operations: ManagedWorktreeOperations,
    private readonly sessions: WorktreeSessionEvidence,
    private readonly terminals: WorktreeTerminalEvidence,
    private readonly directory: WorktreeProjectDirectory,
    private readonly clock: WorktreeClock,
    private readonly ids: WorktreeIdSource,
    /** Where managed checkouts live. Absent means this daemon cannot host one at all. */
    private readonly managedRoot: string | undefined,
  ) {}

  async list(): Promise<WorktreeListResponse> {
    return await this.#runLifecycle(async () => await this.#list());
  }

  async #list(): Promise<WorktreeListResponse> {
    const [state, sessions, terminalRoots, projects] = await Promise.all([
      this.#settled(),
      this.sessions.sessions(),
      this.terminals.roots(),
      this.directory.projects(),
    ]);
    const views: ManagedWorktreeView[] = [];
    for (const entry of state.worktrees) {
      views.push(await this.#view(entry, sessions, terminalRoots, projects));
    }
    for (const intent of state.intents) views.push(unresolvedView(intent, projects));
    return {
      worktrees: [...orderManagedWorktreeViews(views)],
      ...(this.managedRoot === undefined ? {} : { managedRoot: this.managedRoot }),
    };
  }

  async checkRemoval(path: string, currentWorkingDirectory?: string): Promise<WorktreeRemovalDecision> {
    return await this.#runLifecycle(async () => await this.#checkRemoval(path, currentWorkingDirectory));
  }

  async #checkRemoval(path: string, currentWorkingDirectory?: string): Promise<WorktreeRemovalDecision> {
    const { managed, managedRoot } = await this.#live(path);
    const [sessions, terminalRoots] = await Promise.all([this.sessions.sessions(), this.terminals.roots()]);
    const examined = await this.operations.examine(
      managedWorktreeRemovalContext({
        managed,
        managedRoot,
        sessions,
        terminalRoots,
        ...(currentWorkingDirectory === undefined ? {} : { currentWorkingDirectory }),
      }),
    );
    return examined.decision;
  }

  /**
   * Removes one checkout, and only with consent for each class of loss it would cause.
   *
   * THE INTENT IS STAMPED BEFORE GIT IS ASKED, and cleared again the moment the answer is known. A
   * refusal clears it here; a crash leaves it for the next read to settle against the disk. Marking
   * the record removed only afterwards used to mean a crash left a row pointing at a directory that
   * was already gone, and every retry then refused with `missing_worktree` forever.
   */
  async remove(request: WorktreeRemovalRequest): Promise<RemovedWorktree> {
    return await this.#runLifecycle(async () => await this.#remove(request));
  }

  async #remove(request: WorktreeRemovalRequest): Promise<RemovedWorktree> {
    const { managed, managedRoot } = await this.#live(request.path);
    const refreshEvidence = async (): Promise<CheckManagedWorktreeRemovalInput> => {
      const [sessions, terminalRoots] = await Promise.all([this.sessions.sessions(), this.terminals.roots()]);
      return managedWorktreeRemovalContext({
        managed,
        managedRoot,
        sessions,
        terminalRoots,
        confirmations: request.confirmations,
        ...(request.currentWorkingDirectory === undefined
          ? {}
          : { currentWorkingDirectory: request.currentWorkingDirectory }),
      });
    };
    const context = await refreshEvidence();
    await this.registry.write(state => withRemovalStarted(state, managed.path, this.clock.nowIso()));
    let removed: RemovedManagedWorktree;
    try {
      removed = await this.operations.remove({
        ...context,
        overrides: request.overrides,
        deleteBranch: request.deleteBranch,
        refreshEvidence,
      });
    } catch (error) {
      if (error instanceof WorktreeRemovalRefusal) {
        await this.registry.write(state => withRemovalAbandoned(state, managed.path));
      } else {
        await this.#reconcileFailedRemoval(managed);
      }
      throw error;
    }
    await this.registry.write(state => withRemovedManagedWorktree(state, managed.path, removed.removedAt));
    return {
      path: removed.path,
      branch: removed.branch,
      branchRetained: removed.branchRetained,
      removedAt: removed.removedAt,
      branchBlockers: [...removed.branchBlockers],
    };
  }

  /**
   * Forks a new checkout and files the record that makes it manageable.
   *
   * THE INTENT IS DECLARED FROM THE PLAN, which the operations port hands back after it has decided
   * the destination and before it asks Git for anything. Filing only the finished record used to
   * mean a crash mid-checkout left a directory on disk that nothing knew about — unlistable,
   * unremovable, and holding a branch.
   */
  async create(request: CreateWorktreeRequest): Promise<CreatedWorktree> {
    return await this.#runLifecycle(async () => await this.#create(request));
  }

  async #create(request: CreateWorktreeRequest): Promise<CreatedWorktree> {
    const managedRoot = this.#managedRoot();
    const owner = request.sessionId;
    const created = await this.operations.create({
      sourceCwd: request.sourcePath,
      branch: request.branch,
      sessionId: owner ?? `unowned-${this.ids.next()}`,
      ...(owner === undefined ? {} : { ownerSessionId: owner }),
      ownershipToken: this.ids.next(),
      managedRoot,
      base: request.base,
      onPlanned: async plan => {
        await this.registry.write(state =>
          withManagedWorktreeIntent(state, managedWorktreeIntent(plan, this.clock.nowIso(), owner)),
        );
      },
    });
    await this.registry.write(state => withManagedWorktree(state, created.managed));
    const [sessions, terminalRoots, projects] = await Promise.all([
      this.sessions.sessions(),
      this.terminals.roots(),
      this.directory.projects(),
    ]);
    return {
      worktree: await this.#view(created.managed, sessions, terminalRoots, projects),
      cwd: created.cwd,
    };
  }

  /**
   * The registry, with every outstanding intent settled against the disk first.
   *
   * IT COSTS NOTHING WHEN THERE IS NOTHING OUTSTANDING — the common case reads the document, sees a
   * settled registry, and runs no Git at all. When there IS something, the disk decides: a checkout
   * that exists and proves it is ours becomes a record, one that was never made drops its intent,
   * one that exists and cannot be proved ours is KEPT and reported, and a removal that never
   * happened goes back to being a live row.
   */
  async #settled(): Promise<ManagedWorktreeRegistryState> {
    const current = await this.registry.read();
    if (isRegistrySettled(current)) return current;

    for (const intent of current.intents) {
      const adoption = await this.operations.adopt(intent);
      if (adoption.kind === 'adopted') {
        await this.registry.write(state => withManagedWorktree(state, adoption.managed));
      } else if (adoption.kind === 'absent') {
        await this.registry.write(state => withoutManagedWorktreeIntent(state, intent.path));
      }
    }
    for (const entry of current.worktrees.filter(isRemovalInterrupted)) {
      const presence = await this.operations.presence(entry);
      if (presence.kind === 'owned') {
        await this.registry.write(state => withRemovalAbandoned(state, entry.path));
      } else if (presence.kind === 'absent') {
        await this.registry.write(state => withRemovedManagedWorktree(state, entry.path, this.clock.nowIso()));
      }
    }
    return await this.registry.read();
  }

  /**
   * Settles an error that may have happened after mutation, without destroying the stamp on a guess.
   *
   * The exact owned incarnation proves the checkout still exists and abandons the removal. Absence
   * proves it was removed and writes the tombstone. A foreign incarnation or failed probe proves
   * neither, so the stamp stays for the next read.
   */
  async #reconcileFailedRemoval(managed: ManagedWorktree): Promise<void> {
    const presence = await this.operations.presence(managed).catch(() => undefined);
    if (presence?.kind === 'owned') {
      await this.registry.write(state => withRemovalAbandoned(state, managed.path));
    } else if (presence?.kind === 'absent') {
      await this.registry.write(state => withRemovedManagedWorktree(state, managed.path, this.clock.nowIso()));
    }
  }

  /** Runs one complete lifecycle after the previous one, even when the previous one failed. */
  async #runLifecycle<Result>(operation: () => Promise<Result>): Promise<Result> {
    const current = this.lifecycle.catch(() => undefined).then(operation);
    this.lifecycle = current;
    return await current;
  }

  /** The record for a path that still exists, or a stated refusal naming which of the two it is. */
  async #live(path: string): Promise<{ managed: ManagedWorktree; managedRoot: string }> {
    const state = await this.#settled();
    const managed = findManagedWorktree(state.worktrees, path);
    if (managed === undefined) {
      const pending = state.intents.find(intent => intent.path === path);
      throw new WorktreeError(
        'unknown_worktree',
        pending === undefined
          ? `no managed worktree at ${path}`
          : `the checkout at ${path} is an unfinished creation this daemon cannot prove it made`,
      );
    }
    if (managed.removedAt !== undefined) {
      throw new WorktreeError(
        'unknown_worktree',
        `the worktree at ${path} was already removed at ${managed.removedAt}`,
      );
    }
    return { managed, managedRoot: this.#managedRoot() };
  }

  #managedRoot(): string {
    if (this.managedRoot === undefined) {
      throw new WorktreeError('no_managed_root', 'this daemon has no managed worktree root, so it hosts no checkouts');
    }
    return this.managedRoot;
  }

  /** One record as the wire sees it: the durable facts, live Git, and who is standing in it. */
  async #view(
    managed: ManagedWorktree,
    sessions: readonly WorktreeSessionFact[] | undefined,
    terminalRoots: readonly string[] | undefined,
    projects: readonly ProjectInfo[],
  ): Promise<ManagedWorktreeView> {
    const active = (sessions ?? []).filter(isWorktreeSessionActive);
    const owner = managed.ownerSessionId;
    const project = projectForWorktree(projects, managed.commonDir);
    const shared = sharingSessionIds(
      managed.path,
      active.filter(session => session.id !== owner),
    );
    const inspection =
      managed.removedAt === undefined && this.managedRoot !== undefined
        ? await this.operations.examine(
            managedWorktreeRemovalContext({
              managed,
              managedRoot: this.managedRoot,
              sessions,
              terminalRoots,
            }),
          )
        : undefined;
    return {
      path: managed.path,
      branch: managed.branch,
      repositoryRoot: managed.repositoryRoot,
      commonDirectory: managed.commonDir,
      relativeCwd: managed.relativeCwd,
      createdAt: managed.createdAt,
      initialHead: managed.initialHead,
      branchPreexisted: managed.branchPreexisted,
      ...(managed.removedAt === undefined ? {} : { removedAt: managed.removedAt }),
      ...(owner === undefined ? {} : { ownerSessionId: owner }),
      ownerActive: owner !== undefined && active.some(session => session.id === owner),
      sharedWith: [...shared],
      ...(project === undefined ? {} : { projectId: project.id }),
      ...(inspection === undefined ? {} : { live: inspection.live, removal: inspection.decision }),
    };
  }
}

/**
 * An interrupted creation, reported rather than hidden.
 *
 * It carries no live state and no removal verdict, because neither can be read from something this
 * daemon cannot prove is its own checkout. What it carries is the path and the reason, which is what
 * an operator needs in order to go and look.
 */
function unresolvedView(intent: ManagedWorktreeIntent, projects: readonly ProjectInfo[]): ManagedWorktreeView {
  const project = projectForWorktree(projects, intent.commonDir);
  return {
    path: intent.path,
    branch: intent.branch,
    repositoryRoot: intent.repositoryRoot,
    commonDirectory: intent.commonDir,
    relativeCwd: intent.relativeCwd,
    createdAt: intent.declaredAt,
    initialHead: intent.initialHead,
    branchPreexisted: intent.branchPreexisted,
    ...(intent.ownerSessionId === undefined ? {} : { ownerSessionId: intent.ownerSessionId }),
    ownerActive: false,
    sharedWith: [],
    ...(project === undefined ? {} : { projectId: project.id }),
    unresolved: `declared at ${intent.declaredAt} and never finished; the daemon cannot prove the directory at this path is its own`,
  };
}
