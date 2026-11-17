/**
 * WHAT THE WATCHER LOOKS AT, and how often: pure decisions over the stored tasks.
 *
 * - **Only tasks that can still change** are touched: not dropped, not closed. Of their PRs, only those
 *   GitHub can still change are polled — never polled yet, open, or merged with no release found.
 * - **Auto-link** looks only at tasks still in a backlog, active or review lane: a task already shipped
 *   has its PR.
 * - **Cadence** is per repository: about once a minute while it has an open PR, every ten minutes when
 *   nothing is open, each delay jittered so a fleet of repositories does not poll in lockstep.
 * - **Refiling** (`board-design.md` §2.2): an Unfiled task with a PR in a registered project's repository
 *   moves to that project at once ({@link refileTargets}); `unfiled.ts` adds the ferret's own folder.
 */
import {
  type BoardProjectId,
  type Task,
  categoryOf,
  formatTaskRef,
  type LaneCategory,
  type PrLink,
  UNFILED_PROJECT_ID,
} from '../../../contract/index.ts';
import type { LaneSets } from '../board/index.ts';

/** About once a minute while a repository has an open PR linked. */
export const POLL_OPEN_MS = 60_000;
/** Every ten minutes otherwise, and after `gh` is found missing or signed out. */
export const POLL_IDLE_MS = 10 * 60_000;
/** How often the watcher wakes to see which repositories are due. */
export const WATCH_TICK_MS = 30_000;
/** The first look after the daemon starts: after the boot has settled, not during it. */
export const WATCH_FIRST_TICK_MS = 20_000;
/** Each delay is moved by up to this fraction either way. */
const WATCH_JITTER = 0.1;
/** How many repositories one tick polls; the rest are due at the next. */
export const MAX_REPOSITORIES_PER_TICK = 8;
/** How many release compares one tick may run, across every task. */
export const MAX_COMPARES_PER_TICK = 10;
/** How long a project's `origin` is trusted before it is read again. */
export const PROJECT_REMOTES_TTL_MS = 10 * 60_000;
/** Branches no task's work is on: a session sitting on one of them names no PR. */
export const SHARED_BRANCHES: ReadonlySet<string> = new Set(['main', 'master', 'trunk', 'develop', 'HEAD']);

/** A delay moved by up to {@link WATCH_JITTER} either way; `random` is in [0, 1). */
export const jittered = (ms: number, random: number): number => Math.round(ms * (1 + (random * 2 - 1) * WATCH_JITTER));

/** How long until a repository is polled again. */
export const pollDelay = (open: boolean, random: number): number =>
  jittered(open ? POLL_OPEN_MS : POLL_IDLE_MS, random);

/** A task's lane category, or `null` when its board has no lanes or no such lane. */
export const taskCategory = (task: Task, laneSets: LaneSets): LaneCategory | null => {
  const laneSet = laneSets.get(task.projectId);
  if (laneSet === undefined) return null;
  const category = categoryOf(laneSet, task.laneId);
  return category.ok ? category.value : null;
};

/** Whether GitHub can still change what a link caches. */
export const needsPoll = (pr: PrLink): boolean =>
  pr.state === 'unknown' || pr.state === 'open' || (pr.state === 'merged' && pr.releasedIn === null);

/** The tasks the watcher may still write: not dropped, and not in a closed lane. */
export const isWatched = (task: Task, laneSets: LaneSets): boolean =>
  task.dropped === null && taskCategory(task, laneSets) !== 'closed';

const LINKABLE: ReadonlySet<LaneCategory | null> = new Set<LaneCategory | null>(['backlog', 'active', 'review']);

/** Whether a PR may still be linked to a task automatically: it has not shipped yet. */
export const isLinkable = (task: Task, laneSets: LaneSets): boolean =>
  task.dropped === null && LINKABLE.has(taskCategory(task, laneSets));

/** A repository name as a key: GitHub ignores case in owner and repository names. */
export const repoKey = (repo: string): string => repo.toLowerCase();

/** A PR as a key, across every task: `owner/name#number`, case-folded. */
export const prKey = (repo: string, number: number): string => `${repoKey(repo)}#${String(number)}`;

/**
 * Whether someone, not the daemon, put the task on the Unfiled board on purpose: its last refile there was
 * theirs. Such a task stays where it was put, so the daemon never refiles it back and forth.
 */
export const unfiledOnPurpose = (task: Task): boolean => {
  const refiled = task.history.findLast(event => event.type === 'refiled' && event.toProject === UNFILED_PROJECT_ID);
  return refiled !== undefined && refiled.actor.kind !== 'daemon';
};

/** Whether a task is an Unfiled task the daemon may refile: still open, and not put there on purpose. */
export const isRefilable = (task: Task, laneSets: LaneSets): boolean =>
  task.projectId === UNFILED_PROJECT_ID && isWatched(task, laneSets) && !unfiledOnPurpose(task);

export interface RefileTarget {
  readonly card: Task;
  readonly projectId: BoardProjectId;
  readonly reason: string;
}

/**
 * The Unfiled tasks a registered project's repository claims, and where: the first of the task's PRs whose
 * repository a project owns decides. `owners` maps a case-folded `owner/name` to the project registered for
 * it first. Applies at once: a task that belongs on a board never waits on the Unfiled one.
 */
export const refileTargets = (
  tasks: readonly Task[],
  laneSets: LaneSets,
  owners: ReadonlyMap<string, { readonly id: BoardProjectId; readonly name: string }>,
): readonly RefileTarget[] =>
  tasks.flatMap(task => {
    if (!isRefilable(task, laneSets)) return [];
    const pr = task.links.prs.find(link => owners.has(repoKey(link.repo)));
    const owner = pr === undefined ? undefined : owners.get(repoKey(pr.repo));
    if (pr === undefined || owner === undefined) return [];
    return [
      {
        card: task,
        projectId: owner.id,
        reason: `${formatTaskRef(task)}'s PR #${String(pr.number)} is in ${pr.repo}, which ${owner.name} owns`,
      },
    ];
  });
