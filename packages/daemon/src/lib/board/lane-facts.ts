/**
 * WHERE PR FACTS PUT A CARD: the one owner of that decision (`board-design.md` §3.1).
 *
 * GitHub owns what a PR is; the lane a card sits in must never disagree with it. A move driven by an EVENT
 * (a PR just merged) can be missed — the daemon was off, the card was refiled after the merge, the PR was
 * linked late — so every place a fact can be stale (the watcher's poll, a refile, an import, a link) asks
 * {@link laneFromFacts} where the facts say the card belongs, instead of waiting for the event.
 *
 * - **Facts, not lanes.** The answer is read off the card's PRs, most advanced first: all merged and in a
 *   release → the lane `release.published` enters, and the lane `release.running` enters once this machine
 *   runs that release; any merged with none open → `pr.merged`; any open → `pr.ready` (`pr.opened` while
 *   all are drafts). A lane set that lacks the lane a fact names falls back to the next fact down.
 * - **Never backward, never sideways, except for newer work.** A card already at or past the lane stays. A
 *   card the owner or a ferret sent back stays back until a PR newer than that move merges; the merges it
 *   was sent back from are spent. The one fact that moves a card back is an open PR that is newer work than
 *   everything the card has shipped (opened after the last merge, else a higher number in the same
 *   repository): the card is back in review, and the history says "PR #1013 opened after #1008 shipped".
 *   An older open PR (a stale, abandoned one) never pulls a card back.
 * - **Gates are for decisions, not facts.** A fact moves a card through an `ownerGate` lane, forward out of
 *   Plan/Design or back out of To test. It never enters an owner-gated `closed` lane, nor any `closed`
 *   lane in a set with a `verify` lane: only the owner closes there.
 * - **No opinion** is `null`: the card is dropped or closed, has no PR to say anything, or is already where
 *   its facts put it.
 */
import {
  type BoardTask,
  categoryOf,
  compareProtocolVersions,
  isBackwardMove,
  type Lane,
  type LaneSet,
  type LaneTrigger,
  laneForTrigger,
  type PrLink,
  type TaskWorkflow,
} from '@ferretry/protocol';

/** What the facts are: the card's PRs as cached, and the version this machine runs (`null` when unknown). */
export interface LaneFacts {
  readonly prs: readonly PrLink[];
  readonly runningVersion: string | null;
}

/** Where the facts put a card, and the words that say why. */
export interface FactMove {
  readonly lane: Lane;
  /** The trigger whose lane this is: `laneForTrigger(laneSet, workflow, trigger)` is `lane`. */
  readonly trigger: LaneTrigger;
  readonly reason: string;
  /** The card goes back to an earlier lane, because newer work opened after what it shipped. */
  readonly backward: boolean;
}

/** The triggers a fact fires, as opposed to a person or a ferret deciding: their moves are never news. */
export const FACT_TRIGGERS: ReadonlySet<LaneTrigger> = new Set<LaneTrigger>([
  'pr.opened',
  'pr.ready',
  'ci.green',
  'pr.merged',
  'release.published',
  'release.running',
]);

interface Candidate {
  readonly trigger: LaneTrigger;
  readonly reason: string;
  /** Set on an open-PR candidate that is newer work than all shipped: what to say if it pulls a card back. */
  readonly pullBack?: string;
}

/** When the card was last sent back by a person or a ferret (a reopen, or a move to an earlier lane). */
const lastSentBackMs = (card: BoardTask): number | null => {
  let latest: number | null = null;
  for (const event of card.history) {
    const back = event.type === 'reopened' || (event.type === 'moved' && event.backward && event.auto !== true);
    const at = Date.parse(event.at);
    if (back && !Number.isNaN(at) && (latest === null || at > latest)) latest = at;
  }
  return latest;
};

/** The PRs that can still say where the card belongs: not closed unmerged, and not merged before it was sent back. */
const livePrs = (card: BoardTask, prs: readonly PrLink[]): readonly PrLink[] => {
  const sentBack = lastSentBackMs(card);
  return prs.filter(pr => {
    if (pr.state === 'closed') return false;
    if (pr.state !== 'merged' || sentBack === null || pr.mergedAt === null) return true;
    return Date.parse(pr.mergedAt) > sentBack;
  });
};

const named = (prs: readonly PrLink[]): string => `PR ${prs.map(pr => `#${String(pr.number)}`).join(', ')}`;

const sameRepository = (left: PrLink, right: PrLink): boolean => left.repo.toLowerCase() === right.repo.toLowerCase();

/**
 * Whether an open PR is newer work than a merged one: opened after it merged, else (when GitHub's open time
 * was never read) numbered higher in the same repository. Numbers of different repositories say nothing.
 */
const newerThan = (open: PrLink, merged: PrLink): boolean => {
  const openedAt = Date.parse(open.createdAt ?? '');
  const mergedAt = Date.parse(merged.mergedAt ?? '');
  if (!Number.isNaN(openedAt) && !Number.isNaN(mergedAt)) return openedAt > mergedAt;
  return sameRepository(open, merged) && open.number > merged.number;
};

/** The open PRs that are newer than every merged one, said as the reason a card goes back; `undefined` for none. */
const pullBackReason = (open: readonly PrLink[], merged: readonly PrLink[]): string | undefined => {
  const newer = merged.length === 0 ? [] : open.filter(pr => merged.every(shipped => newerThan(pr, shipped)));
  const last = merged.reduce<PrLink | null>(
    (latest, pr) =>
      latest === null || Date.parse(pr.mergedAt ?? '') > Date.parse(latest.mergedAt ?? '') ? pr : latest,
    null,
  );
  return newer.length === 0 || last === null
    ? undefined
    : `${named(newer)} opened after #${String(last.number)} shipped`;
};

/** The facts as candidates, most advanced first. */
const candidatesOf = (live: readonly PrLink[], running: string | null): readonly Candidate[] => {
  const open = live.filter(pr => pr.state === 'open');
  const merged = live.filter(pr => pr.state === 'merged');
  if (open.length > 0) {
    const ready = open.filter(pr => !pr.draft);
    const opened: Candidate = {
      trigger: 'pr.opened',
      reason: `${named(open)} open`,
      pullBack: pullBackReason(open, merged),
    };
    return ready.length > 0
      ? [
          {
            trigger: 'pr.ready',
            reason: `${named(ready)} ready for review`,
            pullBack: pullBackReason(ready, merged),
          },
          opened,
        ]
      : [opened];
  }
  if (merged.length === 0) return [];
  const candidates: Candidate[] = [];
  const releases = live.flatMap(pr => (pr.state === 'merged' && pr.releasedIn !== null ? [pr.releasedIn] : []));
  if (releases.length === live.length) {
    const first = releases[0];
    if (running !== null && first !== undefined) {
      const runsAll = releases.every(release => (compareProtocolVersions(running, release.version) ?? -1) >= 0);
      if (runsAll) {
        candidates.push({
          trigger: 'release.running',
          reason: `this machine runs ${running}, which includes ${first.version}`,
        });
      }
    }
    if (first !== undefined) {
      candidates.push({
        trigger: 'release.published',
        reason: `${named(live)} released in ${releases.map(release => release.version).join(', ')}`,
      });
    }
  }
  candidates.push({ trigger: 'pr.merged', reason: `${named(merged)} merged` });
  return candidates;
};

/** Whether a fact may take a card into this lane: nothing the owner alone decides. */
const factMayEnter = (lane: Lane, laneSet: LaneSet): boolean =>
  lane.category !== 'closed' ||
  (lane.ownerGate !== true && !laneSet.lanes.some(candidate => candidate.category === 'verify'));

/**
 * The lane the card's PR facts put it in, or `null` for no opinion (see the file header). Pure and total:
 * a lane id the set does not know, or a workflow with no lane for the fact, is no opinion.
 */
export const laneFromFacts = (
  card: BoardTask,
  laneSet: LaneSet,
  workflow: TaskWorkflow,
  facts: LaneFacts,
): FactMove | null => {
  if (card.dropped !== null) return null;
  const category = categoryOf(laneSet, card.laneId);
  if (!category.ok || category.value === 'closed') return null;
  for (const candidate of candidatesOf(livePrs(card, facts.prs), facts.runningVersion)) {
    const found = laneForTrigger(laneSet, workflow, candidate.trigger);
    if (!found.ok || found.value === null || !factMayEnter(found.value, laneSet)) continue;
    if (found.value.id === card.laneId) return null;
    const backward = isBackwardMove(laneSet, card.laneId, found.value.id);
    if (!backward.ok) return null;
    if (!backward.value)
      return { lane: found.value, trigger: candidate.trigger, reason: candidate.reason, backward: false };
    if (candidate.pullBack === undefined) {
      // Only an open PR can have newer work to say; behind a ready one a draft may still pull the card back.
      if (candidate.trigger === 'pr.ready') continue;
      return null;
    }
    return {
      lane: found.value,
      trigger: candidate.trigger,
      reason: `moved back to ${found.value.name}: ${candidate.pullBack}`,
      backward: true,
    };
  }
  return null;
};
