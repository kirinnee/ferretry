/**
 * The PRs screen, the pure half (r9 E3): which PRs a filter keeps, how a project's PRs group by repository, what every
 * list folds, and how a time reads. No React, no clock of its own: the caller hands in `now` (the app's one clock).
 */
import type {
  CiState,
  RepoRef,
  WatchedPull,
  WatchedRepo,
  WatchEvent,
  WatchProjectView,
} from '../../../contract/index.ts';
import { WATCH_EVENTS } from '../../../contract/index.ts';

export const FILTERS = ['mine', 'review', 'all'] as const;
export type Filter = (typeof FILTERS)[number];

export const FILTER_WORDS: Readonly<Record<Filter, string>> = {
  mine: 'Mine',
  review: 'Review requested',
  all: 'All',
};

/** How many rows a list draws before it asks to show more. Every row stays reachable through the button. */
export const PAGE = 20;
/** How many of a project's repositories start open; the rest start folded to their header, and open on a tap. */
export const REPOS_OPEN = 2;
/** How many project sections the screen draws before it asks to show more. */
export const PROJECT_PAGE = 12;
/** How many repositories without an account are named before "and N more". */
export const NEEDS_PAGE = 5;

/** The words a notify choice carries on screen: one place, so the screen and its tests say the same thing. */
export const EVENT_WORDS: Readonly<Record<WatchEvent, string>> = {
  ciFailed: 'CI failed on my PR',
  reviewRequested: 'A review is asked of me',
  changesRequested: 'Changes requested on my PR',
  approved: 'My PR is approved',
  ciPassed: 'CI passed on my PR',
  comment: 'A new comment on my PR',
  closed: 'My PR is merged or closed',
};

export const EVENT_ORDER: readonly WatchEvent[] = WATCH_EVENTS;

const keeps = (filter: Filter, pull: WatchedPull): boolean =>
  filter === 'all' ? true : filter === 'mine' ? pull.mine : pull.requestedMe;

/** Newest update first; a tie breaks on the number so the order is total and never flickers between reads. */
const newest = (a: WatchedPull, b: WatchedPull): number =>
  b.updatedAt.localeCompare(a.updatedAt) || b.number - a.number;

export interface RepoGroup {
  readonly repo: RepoRef;
  readonly login: string;
  readonly checkedAt: string;
  readonly problem: string | undefined;
  /** What the filter keeps, newest first. */
  readonly pulls: readonly WatchedPull[];
  /** How many open PRs the repository has, before the filter. */
  readonly open: number;
}

const groupOf = (repo: WatchedRepo, filter: Filter): RepoGroup => ({
  repo: repo.repo,
  login: repo.login,
  checkedAt: repo.checkedAt,
  problem: repo.problem,
  pulls: repo.pulls.filter(pull => keeps(filter, pull)).sort(newest),
  open: repo.pulls.length,
});

/** A project's repositories, in the order the daemon listed them, each with the PRs the filter keeps. */
export const groupsOf = (view: WatchProjectView, filter: Filter): readonly RepoGroup[] =>
  view.repos.map(repo => groupOf(repo, filter));

/** How many PRs each filter would show for the views given: the chips' counts, so a chip never lies about its list. */
export function countsOf(views: readonly WatchProjectView[]): Readonly<Record<Filter, number>> {
  const counts = { mine: 0, review: 0, all: 0 };
  for (const view of views) {
    // A project whose watch is off shows no row, so it counts for nothing: a chip never counts what is not drawn.
    if (!view.watch) continue;
    for (const repo of view.repos)
      for (const pull of repo.pulls) {
        counts.all += 1;
        if (pull.mine) counts.mine += 1;
        if (pull.requestedMe) counts.review += 1;
      }
  }
  return counts;
}

/** Watched projects first (they have something to show), then by name; a total order. */
export function orderProjects(
  views: readonly WatchProjectView[],
  nameOf: (project: string) => string,
): readonly WatchProjectView[] {
  return [...views].sort(
    (a, b) =>
      Number(b.watch) - Number(a.watch) ||
      nameOf(a.project).localeCompare(nameOf(b.project)) ||
      a.project.localeCompare(b.project),
  );
}

/** What the screen says when a watched project shows nothing, so an empty list always has a reason. */
export type EmptyReason = 'watch-off' | 'no-results' | 'no-repos' | 'no-account' | 'none-open' | 'filtered';

export function emptyReason(
  view: WatchProjectView,
  groups: readonly RepoGroup[],
  filter: Filter,
  /** The project's own record says its folder holds no repository. */
  noRepo: boolean,
): EmptyReason | undefined {
  if (!view.watch) return 'watch-off';
  if (groups.some(group => group.pulls.length > 0)) return undefined;
  // The watch sends no repository both for "a repository is linked but not read yet" and for "there is none": only the
  // project's own record can tell them apart, so without it the honest words are "no results yet".
  if (view.repos.length === 0) return view.needsAccount.length > 0 ? 'no-account' : noRepo ? 'no-repos' : 'no-results';
  if (groups.some(group => group.open > 0) && filter !== 'all') return 'filtered';
  return 'none-open';
}

export const EMPTY_WORDS: Readonly<Record<EmptyReason, string>> = {
  'watch-off':
    'Watching is off for this project, so Ferretry is not asking GitHub about it. Turn it on to see its pull requests.',
  'no-results': 'No results yet. Ferretry has not read this project’s pull requests so far.',
  'no-repos': 'No GitHub repository was found inside this project’s folder.',
  'no-account':
    'None of this project’s repositories has a connected GitHub account to read it with. Connect an account to this project.',
  'none-open': 'No open pull requests.',
  filtered: 'No open pull request matches this filter. Choose All to see the rest.',
};

// ─── the CI word on a row ─────────────────────────────────────────────────────────────────────────────────────────

export const CI_ROW_WORDS: Readonly<Record<CiState, string>> = {
  none: 'No CI',
  queued: 'CI queued',
  running: 'CI running',
  passing: 'CI passing',
  failing: 'CI failing',
  cancelled: 'CI cancelled',
};

// ─── time ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * "4m ago", from the app's one clock. A time the clock has not reached yet (a skewed machine) reads "just now", never a
 * negative; an instant that does not parse reads as itself.
 */
export function agoLabel(now: number, instant: string): string {
  const at = Date.parse(instant);
  if (Number.isNaN(at)) return instant;
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** The rows a fold shows: the first `limit`, and how many wait behind the button. */
export const folded = <T>(
  items: readonly T[],
  limit: number,
): { readonly shown: readonly T[]; readonly more: number } => ({
  shown: items.slice(0, limit),
  more: Math.max(0, items.length - limit),
});
