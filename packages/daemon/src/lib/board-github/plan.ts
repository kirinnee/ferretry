/**
 * WHAT THE WATCHER LOOKS AT, and how often: pure decisions over the stored cards.
 *
 * - **Only cards that can still change** are touched: not dropped, not closed. Of their PRs, only those
 *   GitHub can still change are polled — never polled yet, open, or merged with no release found.
 * - **Auto-link** looks only at cards still in a backlog, active or review lane: a card already shipped
 *   has its PR.
 * - **Cadence** is per repository: about once a minute while it has an open PR, every ten minutes when
 *   nothing is open, each delay jittered so a fleet of repositories does not poll in lockstep.
 * - **Refiling** (`board-design.md` §2.2): a card left on the Unfiled board for over a day with a PR linked
 *   moves to the project whose repository that PR is in.
 */
import {
  type BoardProjectId,
  type BoardTask,
  categoryOf,
  formatTaskRef,
  type LaneCategory,
  type PrLink,
  UNFILED_PROJECT_ID,
} from '@ferretry/protocol';
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
/** How many release compares one tick may run, across every card. */
export const MAX_COMPARES_PER_TICK = 10;
/** How long a project's `origin` is trusted before it is read again. */
export const PROJECT_REMOTES_TTL_MS = 10 * 60_000;
/** How long a card sits on the Unfiled board, with a PR linked, before it is refiled. */
export const UNFILED_REFILE_AFTER_MS = 24 * 60 * 60_000;
/** Branches no card's work is on: a session sitting on one of them names no PR. */
export const SHARED_BRANCHES: ReadonlySet<string> = new Set(['main', 'master', 'trunk', 'develop', 'HEAD']);

/** A delay moved by up to {@link WATCH_JITTER} either way; `random` is in [0, 1). */
export const jittered = (ms: number, random: number): number => Math.round(ms * (1 + (random * 2 - 1) * WATCH_JITTER));

/** How long until a repository is polled again. */
export const pollDelay = (open: boolean, random: number): number =>
  jittered(open ? POLL_OPEN_MS : POLL_IDLE_MS, random);

/** A card's lane category, or `null` when its board has no lanes or no such lane. */
export const cardCategory = (card: BoardTask, laneSets: LaneSets): LaneCategory | null => {
  const laneSet = laneSets.get(card.projectId);
  if (laneSet === undefined) return null;
  const category = categoryOf(laneSet, card.laneId);
  return category.ok ? category.value : null;
};

/** Whether GitHub can still change what a link caches. */
export const needsPoll = (pr: PrLink): boolean =>
  pr.state === 'unknown' || pr.state === 'open' || (pr.state === 'merged' && pr.releasedIn === null);

/** The cards the watcher may still write: not dropped, and not in a closed lane. */
export const isWatched = (card: BoardTask, laneSets: LaneSets): boolean =>
  card.dropped === null && cardCategory(card, laneSets) !== 'closed';

const LINKABLE: ReadonlySet<LaneCategory | null> = new Set<LaneCategory | null>(['backlog', 'active', 'review']);

/** Whether a PR may still be linked to a card automatically: it has not shipped yet. */
export const isLinkable = (card: BoardTask, laneSets: LaneSets): boolean =>
  card.dropped === null && LINKABLE.has(cardCategory(card, laneSets));

/** A repository name as a key: GitHub ignores case in owner and repository names. */
export const repoKey = (repo: string): string => repo.toLowerCase();

/** A PR as a key, across every card: `owner/name#number`, case-folded. */
export const prKey = (repo: string, number: number): string => `${repoKey(repo)}#${String(number)}`;

/** When a card last arrived on the Unfiled board: its last refile there, else its creation. */
const unfiledSince = (card: BoardTask): string => {
  const refiled = card.history.findLast(event => event.type === 'refiled' && event.toProject === UNFILED_PROJECT_ID);
  return refiled?.at ?? card.createdAt;
};

export interface RefileTarget {
  readonly card: BoardTask;
  readonly projectId: BoardProjectId;
  readonly reason: string;
}

/**
 * The Unfiled cards to refile, and where: the first of the card's PRs whose repository a registered project
 * owns decides. `owners` maps a case-folded `owner/name` to the project registered for it first.
 */
export const refileTargets = (
  cards: readonly BoardTask[],
  laneSets: LaneSets,
  owners: ReadonlyMap<string, { readonly id: BoardProjectId; readonly name: string }>,
  nowMs: number,
): readonly RefileTarget[] =>
  cards.flatMap(card => {
    if (card.projectId !== UNFILED_PROJECT_ID || !isWatched(card, laneSets)) return [];
    if (nowMs - Date.parse(unfiledSince(card)) <= UNFILED_REFILE_AFTER_MS) return [];
    const pr = card.links.prs.find(link => owners.has(repoKey(link.repo)));
    const owner = pr === undefined ? undefined : owners.get(repoKey(pr.repo));
    if (pr === undefined || owner === undefined) return [];
    return [
      {
        card,
        projectId: owner.id,
        reason: `${formatTaskRef(card)} sat on the Unfiled board for over a day, and its PR #${String(pr.number)} is in ${pr.repo}, which ${owner.name} owns`,
      },
    ];
  });
