/**
 * REVIEW BLOCKED: a card sits in a review lane, its pull request cannot merge, and the ferret that answers for it
 * has gone idle — so nobody is looking.
 *
 * ═══ WHY ═══
 *
 * On 2026-11-04 the compact-header pull request sat with a merge conflict for about seven hours. The merger skipped
 * it silently, its ferret had finished its turn, and the Warden — which watched ferrets, not tasks — saw nothing
 * wrong. The board already knew: the GitHub watcher reads each linked PR's state and checks (and, since this, whether
 * GitHub can merge it) onto the card. Nothing connected that fact to anybody who could act on it.
 *
 * ═══ WHAT IT IS ═══
 *
 * Facts only, from the board as the sweep reads it and the fleet. A card is BLOCKED when it is in a review lane (not
 * dropped), and one of its linked PRs is open, not a draft, and either has a merge conflict or red CI
 * ({@link PrBlocker}). The blocking STATE is the set of (PR, blocker) pairs; the moment it was first seen is kept in
 * the Warden's memory, and it must have stood {@link REVIEW_BLOCKED_MS} before anyone is woken. A GitHub that said
 * nothing (no `gh`, signed out, a PR it could not resolve) leaves the cached facts as they were, so it neither
 * blocks nor unblocks a card: never guess.
 *
 * ═══ WHO IS WOKEN ═══
 *
 * The card's working ferret — its assignee, else its owner — and only when it is idle: running, its turn ended, no
 * declared wait, a login that can run. A ferret that is working, waiting on a peer, out of quota, or gone is not
 * nudged (a gone one is the orphan flag's), and nothing is remembered for it, so it is woken the moment it goes idle.
 * ONE nudge per blocking state: the same state is never told twice, however long it stands. A state that CHANGES — the
 * conflict fixed but CI still red, a second PR gone red — is a new state, with its own 30 minutes.
 *
 * Pure: the board, the fleet and the memory arrive through the arguments.
 */
import { type BoardTaskId, type BoardTaskView, categoryOf, formatTaskRef, type PrLink } from '@ferretry/protocol';
import { effectiveAssignee } from '../board/authority.ts';
import { inWardenLineage } from './detect.ts';
import type { WardenBoardRead } from './orphans.ts';
import { instantMs } from './time.ts';
import { isTerminalStatus, type WardenSessionView } from './types.ts';

/** How long a pull request must have been blocked, in one state, before its ferret is woken. */
export const REVIEW_BLOCKED_MS = 30 * 60_000;

/** What stops a PR from merging, as the card's cached facts show it. */
export type PrBlocker = 'conflict' | 'ci_failing';

/** One linked PR that cannot merge, and why. */
export interface BlockedPr {
  readonly url: string;
  readonly number: number;
  /** In a fixed order: conflict, then CI. */
  readonly blockers: readonly PrBlocker[];
}

/** A review-lane card with at least one blocked PR. */
export interface BlockedCard {
  readonly id: BoardTaskId;
  readonly ref: string;
  /** The ferret that answers for the card: its assignee, else its owner. */
  readonly assignee: string;
  readonly prs: readonly BlockedPr[];
  /** The blocking state, as a key: equal exactly when the same PRs are blocked for the same reasons. */
  readonly state: string;
}

/** The blockers a PR has; none for a PR that is not open, still a draft, or merges cleanly with green checks. */
export function blockersOf(pr: PrLink): readonly PrBlocker[] {
  if (pr.state !== 'open' || pr.draft) return [];
  return [
    ...(pr.mergeable === 'conflicting' ? (['conflict'] as const) : []),
    ...(pr.checks === 'failing' ? (['ci_failing'] as const) : []),
  ];
}

/** The state key of a card's blocked PRs: order of the card's links never matters. */
const stateOf = (prs: readonly BlockedPr[]): string =>
  prs
    .map(pr => `${pr.url}:${pr.blockers.join('+')}`)
    .toSorted()
    .join(' ');

/**
 * Every card in a review lane that has a blocked PR. A card whose lane its board no longer knows is not in review as
 * far as anyone can prove, and is left out.
 */
export function blockedReviewCards(board: WardenBoardRead): readonly BlockedCard[] {
  const blocked: BlockedCard[] = [];
  for (const view of board.views) {
    if (view.dropped !== null || !inReview(board, view)) continue;
    const prs = view.links.prs.flatMap((pr): BlockedPr[] => {
      const blockers = blockersOf(pr);
      return blockers.length === 0 ? [] : [{ url: pr.url, number: pr.number, blockers }];
    });
    if (prs.length === 0) continue;
    blocked.push({
      id: view.id,
      ref: formatTaskRef(view),
      assignee: effectiveAssignee(view),
      prs,
      state: stateOf(prs),
    });
  }
  return blocked;
}

const inReview = (board: WardenBoardRead, view: BoardTaskView): boolean => {
  const laneSet = board.laneSets.get(view.projectId);
  if (laneSet === undefined) return false;
  const category = categoryOf(laneSet, view.laneId);
  return category.ok && category.value === 'review';
};

/**
 * Whether the ferret is idle enough to be woken: running with its turn ended and nothing declared. A ferret out of
 * quota (`rate_limited`) cannot run, so a nudge would be a wasted turn.
 */
export function idleForNudge(view: WardenSessionView): boolean {
  const { config, state } = view;
  return (
    config.mode === 'auto' &&
    state.status === 'running' &&
    state.turnState === 'your-turn' &&
    state.waiting === undefined
  );
}

// ── What the Warden does ───────────────────────────────────────────────────────────────────────────────

/** What the Warden knows of one blocked card: the state it saw, since when, and when it woke the ferret for it. */
export interface ReviewBlockedTold {
  readonly state: string;
  /** When this state was first seen. */
  readonly since: string;
  /** When the ferret was woken for this state: once. */
  readonly nudgedAt?: string;
}

/** Keyed by card id, kept while the card stays blocked. */
export type ReviewBlockedMemory = Readonly<Record<string, ReviewBlockedTold>>;

/** One nudge to send. */
export interface ReviewBlockedNudge {
  readonly cardId: BoardTaskId;
  readonly sessionId: string;
  /** The state it is for: what the memory records once it lands. */
  readonly state: string;
  readonly message: string;
}

export interface ReviewBlockedPlanInput {
  /** `blockedReviewCards` of a board read this sweep. */
  readonly blocked: readonly BlockedCard[];
  readonly fleet: readonly WardenSessionView[];
  readonly memory: ReviewBlockedMemory;
  /** Whether the Warden is on: off, nobody is woken (the clock still runs, so it is not woken late for time it was off). */
  readonly enabled: boolean;
  /** Whether the owner lets the Warden nudge a ferret alone. */
  readonly mayNudge: boolean;
  /** The CLI a ferret actually types. */
  readonly clientName: string;
  readonly nowMs: number;
  readonly blockedMs?: number;
}

export interface ReviewBlockedPlan {
  readonly nudges: readonly ReviewBlockedNudge[];
  /** The memory to keep, before any nudge is recorded as landed. */
  readonly memory: ReviewBlockedMemory;
}

const PR_BLOCKER_WORDS: Readonly<Record<PrBlocker, string>> = {
  conflict: 'a merge conflict',
  ci_failing: 'red CI',
};

/** How long, in whole minutes, from `sinceMs` to `nowMs`. */
const minutesSince = (nowMs: number, sinceMs: number): number => Math.max(0, Math.floor((nowMs - sinceMs) / 60_000));

/** The words for one PR's blockers: "a merge conflict", "red CI", "a merge conflict and red CI". */
const blockersInWords = (blockers: readonly PrBlocker[]): string =>
  blockers.map(each => PR_BLOCKER_WORDS[each]).join(' and ');

/** The short nudge a ferret is woken with: the card, each blocked PR and what blocks it, how long, and what to do. */
export function reviewBlockedMessage(card: BlockedCard, minutes: number): string {
  const prs = card.prs.map(pr => `${pr.url} has ${blockersInWords(pr.blockers)}`).join('; ');
  const conflict = card.prs.some(pr => pr.blockers.includes('conflict'));
  return (
    `The Warden checked ${card.ref}: it has sat in review ${minutes}m with a pull request that cannot merge — ${prs}. ` +
    `${conflict ? 'Rebase it onto its base branch and fix any red checks' : 'Fix the failing checks'}, push, ` +
    `or note on the card why it can wait.`
  );
}

/**
 * Whom to wake about each blocked card this sweep, and what to remember. Deterministic: the same inputs give the same
 * plan in the same order.
 *
 * Memory follows the blocked cards, not the ferrets: a card no longer blocked is forgotten (when it blocks again that
 * is news again), a card whose blocking state changed starts a new episode (its clock and its one nudge), and a card
 * whose state stands keeps its clock and whether it was woken.
 */
export function planReviewBlocked(input: ReviewBlockedPlanInput): ReviewBlockedPlan {
  const blockedMs = input.blockedMs ?? REVIEW_BLOCKED_MS;
  const fleet = new Map(input.fleet.map(view => [view.config.id, view]));
  const memory: Record<string, ReviewBlockedTold> = {};
  const nudges: ReviewBlockedNudge[] = [];
  const at = new Date(input.nowMs).toISOString();
  for (const card of input.blocked) {
    const known = input.memory[card.id];
    const told: ReviewBlockedTold = known?.state === card.state ? known : { state: card.state, since: at };
    memory[card.id] = told;
    if (!input.enabled || !input.mayNudge || told.nudgedAt !== undefined) continue;
    const sinceMs = instantMs(told.since);
    if (sinceMs === undefined || input.nowMs - sinceMs < blockedMs) continue;
    const ferret = fleet.get(card.assignee);
    if (ferret === undefined || isTerminalStatus(ferret.state.status)) continue;
    if (inWardenLineage(ferret, fleet) || !idleForNudge(ferret)) continue;
    nudges.push({
      cardId: card.id,
      sessionId: ferret.config.id,
      state: card.state,
      message: reviewBlockedMessage(card, minutesSince(input.nowMs, sinceMs)),
    });
  }
  return { nudges, memory };
}

/** The memory after a nudge landed: the state it was for, now woken. A nudge for a state the card has left is dropped. */
export function recordReviewBlockedNudge(
  memory: ReviewBlockedMemory,
  nudge: Pick<ReviewBlockedNudge, 'cardId' | 'state'>,
  at: string,
): ReviewBlockedMemory {
  const told = memory[nudge.cardId];
  return told?.state === nudge.state ? { ...memory, [nudge.cardId]: { ...told, nudgedAt: at } } : memory;
}
