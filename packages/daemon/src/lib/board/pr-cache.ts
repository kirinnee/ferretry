/**
 * WHAT GITHUB SAYS OF A CARD'S PULL REQUESTS, written onto the card (`board-design.md` §3.1 items 4 and 7).
 *
 * GitHub owns a PR's state, its checks, its merge and the release it first shipped in. The card keeps a
 * labelled projection of them on each link (`polledAt`), and only the daemon's watcher writes it. One call
 * here is ONE write: the cache, the automatic links, the notes and the lane moves those facts trigger land
 * together, so a crash can never leave a merged PR cached on a card that did not move.
 *
 * - **Triggers fire on a change, in the order a PR lives them.** Then every poll RECONCILES the card
 *   ({@link reconcileFacts}): whatever the cached facts say of its PRs, the card is caught up to it, so a
 *   card can never sit behind its own PR because an event was missed (the daemon was off, the card was
 *   refiled after the merge, the PR was linked late). A card sent back after its PR merged stays back
 *   (`lane-facts.ts`); `release.running` reads this machine's version.
 * - **Never backwards.** Every move goes through {@link triggerMove}, which refuses a move back and records
 *   "… while blocked by &F18" when a dependency had not shipped: reality wins over the gate (§2.7).
 * - **A PR closed unmerged** moves nothing: it adds a note and asks the watcher to nudge the card's owner
 *   ferret. CI going red moves nothing either; the card shows it, and the assignee is nudged once.
 * - **`releasedIn` is immutable** once set: a later poll never rewrites the release a PR shipped in.
 */
import {
  type BoardTask,
  formatTaskRef,
  type LaneTrigger,
  type PrChecks,
  type PrLink,
  prUrlParts,
  type ReleasedIn,
} from '@ferretry/protocol';
import { effectiveAssignee } from './authority.ts';
import { type CardContext, reconcileFacts, requireStanding, triggerMove, withEvent } from './card-actions.ts';

/**
 * How often an unchanged PR's `polledAt` is rewritten. A poll that learns nothing new does not write the
 * card every minute; the label is refreshed at this pace so it never claims an older look than it is.
 */
export const PR_POLL_LABEL_REFRESH_MS = 10 * 60_000;

/** What GitHub said of one PR on this poll. `url` is the link's own spelling of it. */
export interface PrObservation {
  readonly url: string;
  readonly state: 'open' | 'closed' | 'merged';
  readonly draft: boolean;
  readonly checks: PrChecks;
  /** Set exactly when `state` is `merged`. */
  readonly mergedAt: string | null;
  readonly mergeSha: string | null;
}

/** One poll's worth of facts for one card. */
export interface PrUpdate {
  /** PRs to link because a rule matched them, each with the rule's words. Already linked ones are skipped. */
  readonly link: readonly { readonly url: string; readonly because: string }[];
  readonly observed: readonly PrObservation[];
  /** The first release found containing a merged PR's merge commit. Ignored where one is already cached. */
  readonly releases: readonly { readonly url: string; readonly releasedIn: ReleasedIn }[];
  /** This daemon's own version, for `release.running`; `null` when it cannot be read as a version. */
  readonly runningVersion: string | null;
}

/** A message the watcher queues to one of the card's ferrets. */
interface PrNudge {
  readonly reason: 'closed-unmerged' | 'ci-failing';
  readonly sessionId: string;
  readonly message: string;
}

export interface PrUpdateOutcome {
  /** The card as written, or `null` when the poll changed nothing on it. */
  readonly task: BoardTask | null;
  readonly nudges: readonly PrNudge[];
}

/** A newly linked PR: nothing GitHub has said yet. */
const unpolled = (url: string): PrLink | null => {
  const parts = prUrlParts(url);
  return parts === null
    ? null
    : {
        url,
        number: parts.number,
        repo: parts.repo,
        state: 'unknown',
        draft: false,
        checks: 'none',
        mergedAt: null,
        mergeSha: null,
        releasedIn: null,
        polledAt: null,
      };
};

/** Whether two spellings name the same PR: GitHub's owner and repository names ignore case. */
export const samePr = (left: string, right: string): boolean => {
  const a = prUrlParts(left);
  const b = prUrlParts(right);
  return a !== null && b !== null && a.number === b.number && a.repo.toLowerCase() === b.repo.toLowerCase();
};

/** The order a PR lives its triggers in, so one poll that saw several moves the card forward through them. */
const TRIGGER_ORDER: readonly LaneTrigger[] = ['pr.opened', 'pr.ready', 'ci.green', 'pr.merged', 'release.published'];

interface PendingTrigger {
  readonly trigger: LaneTrigger;
  readonly reason: string;
}

interface LinkChange {
  readonly link: PrLink;
  readonly triggers: readonly PendingTrigger[];
  readonly closedUnmerged: boolean;
  readonly turnedRed: boolean;
}

const factsDiffer = (before: PrLink, after: PrLink): boolean =>
  before.state !== after.state ||
  before.draft !== after.draft ||
  before.checks !== after.checks ||
  before.mergedAt !== after.mergedAt ||
  before.mergeSha !== after.mergeSha ||
  before.releasedIn !== after.releasedIn;

/** One link after this poll, and the changes it saw. */
const nextLink = (pr: PrLink, update: PrUpdate, now: string): LinkChange => {
  const observed = update.observed.find(entry => samePr(entry.url, pr.url));
  // Merged as of this poll: what GitHub just said, else what the cache already holds.
  const merged = (observed?.state ?? pr.state) === 'merged';
  const found = update.releases.find(entry => samePr(entry.url, pr.url))?.releasedIn;
  const releasedIn = merged ? (pr.releasedIn ?? found ?? null) : null;
  const facts: PrLink =
    observed === undefined
      ? { ...pr, releasedIn }
      : {
          ...pr,
          state: observed.state,
          draft: observed.draft,
          checks: observed.checks,
          mergedAt: merged ? observed.mergedAt : null,
          mergeSha: merged ? observed.mergeSha : null,
          releasedIn: merged ? releasedIn : null,
        };
  const stale = pr.polledAt === null || Date.parse(now) - Date.parse(pr.polledAt) >= PR_POLL_LABEL_REFRESH_MS;
  const changed = factsDiffer(pr, facts);
  const link = changed || (observed !== undefined && stale) ? { ...facts, polledAt: now } : pr;
  const name = `PR #${pr.number}`;
  const triggers: PendingTrigger[] = [];
  const wasOpen = pr.state === 'open';
  if (link.state === 'open' && !wasOpen) triggers.push({ trigger: 'pr.opened', reason: `${name} opened` });
  if (link.state === 'open' && !link.draft && (!wasOpen || pr.draft)) {
    triggers.push({ trigger: 'pr.ready', reason: `${name} ready for review` });
  }
  if (link.state === 'open' && link.checks === 'passing' && pr.checks !== 'passing') {
    triggers.push({ trigger: 'ci.green', reason: `${name} checks passed` });
  }
  if (link.state === 'merged' && pr.state !== 'merged')
    triggers.push({ trigger: 'pr.merged', reason: `${name} merged` });
  if (link.releasedIn !== null && pr.releasedIn === null) {
    triggers.push({ trigger: 'release.published', reason: `${name} released in ${link.releasedIn.version}` });
  }
  return {
    link,
    triggers,
    closedUnmerged: link.state === 'closed' && pr.state !== 'closed',
    turnedRed: link.state === 'open' && link.checks === 'failing' && pr.checks !== 'failing',
  };
};

/**
 * One poll applied to one card, by the daemon: the automatic links, the refreshed cache, the notes, and
 * every lane move those facts trigger, in the order a PR lives them (opened, ready, checks, merged,
 * released), then the reconcile that puts the card where its facts say (running here included).
 * `task: null` when nothing changed.
 */
export const applyPrUpdate = (card: BoardTask, update: PrUpdate, context: CardContext): PrUpdateOutcome => {
  requireStanding('trigger', context.standing, card);
  const ref = formatTaskRef(card);
  let next = card;
  for (const candidate of update.link) {
    if (next.links.prs.some(pr => samePr(pr.url, candidate.url))) continue;
    const link = unpolled(candidate.url);
    if (link === null) continue;
    next = withEvent(next, { type: 'linked', field: 'pr', value: candidate.url }, context);
    next = withEvent(
      next,
      { type: 'note', text: `PR #${link.number} linked automatically: ${candidate.because}` },
      context,
    );
    next = { ...next, links: { ...next.links, prs: [...next.links.prs, link] } };
  }
  const changes = next.links.prs.map(pr => nextLink(pr, update, context.now));
  const prs = changes.map(change => change.link);
  const linksChanged = prs.some((pr, index) => pr !== next.links.prs[index]);
  if (linksChanged) next = { ...next, links: { ...next.links, prs } };
  const nudges: PrNudge[] = [];
  for (const change of changes) {
    const name = `PR #${change.link.number}`;
    if (change.closedUnmerged) {
      next = withEvent(next, { type: 'note', text: `${name} was closed without merging` }, context);
      nudges.push({
        reason: 'closed-unmerged',
        sessionId: card.owner,
        message: `[board] ${ref} ${name} was closed without merging — reopen it, link its replacement, or drop the card`,
      });
    }
    if (change.turnedRed) {
      nudges.push({
        reason: 'ci-failing',
        sessionId: effectiveAssignee(card),
        message: `[board] ${ref} ${name} CI is red — fix it, or note on the card why it can stay red`,
      });
    }
  }
  const triggers = changes
    .flatMap(change => change.triggers)
    .toSorted((left, right) => TRIGGER_ORDER.indexOf(left.trigger) - TRIGGER_ORDER.indexOf(right.trigger));
  for (const pending of triggers) {
    next = triggerMove(next, pending.trigger, pending.reason, context) ?? next;
  }
  next =
    reconcileFacts(next, { ...context, runningVersion: update.runningVersion ?? context.runningVersion ?? null }) ??
    next;
  return { task: next === card ? null : next, nudges };
};
