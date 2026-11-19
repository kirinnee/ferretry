import type { WatchEvent, WatchedPull } from '../../../contract/index.ts';
import type { Ended } from './observe.ts';

/** One thing worth telling, with a key that names THIS occurrence (a repeat of it is the same key). */
export interface WatchEventLine {
  readonly event: WatchEvent;
  readonly pull: WatchedPull;
  readonly key: string;
  /** For `closed`: it ended merged. */
  readonly merged?: boolean;
}

/**
 * What changed between two looks at one repository, as events. Pure.
 *
 * - CI, review verdicts, comments and the end of a PR are told for the account's OWN PRs; "asked to review" for any PR.
 * - Each event is a TRANSITION (not failing → failing), so the next tick, which sees the same state, tells nothing; a
 *   run that is fixed and fails again is a new transition and a new line.
 * - `before` is every PR of the last look. A PR with no earlier look is new: it can ask for a review or already have
 *   CI, but it has no comments to be "new" against.
 * - The caller makes no events at all for a repository it has never looked at (the first look is a silent baseline).
 */
export function eventsOf(
  before: readonly WatchedPull[],
  after: readonly WatchedPull[],
  ended: readonly Ended[],
): readonly WatchEventLine[] {
  const last = new Map(before.map(pull => [pull.number, pull]));
  const lines: WatchEventLine[] = [];
  const add = (event: WatchEvent, pull: WatchedPull, detail: string, merged?: boolean): void => {
    const key = `${event}:${pull.repo.owner}/${pull.repo.name}#${pull.number}:${detail}`;
    lines.push({ event, pull, key, ...(merged === undefined ? {} : { merged }) });
  };
  for (const pull of after) {
    const old = last.get(pull.number);
    if (pull.requestedMe && old?.requestedMe !== true) add('reviewRequested', pull, pull.updatedAt);
    if (!pull.mine) continue;
    if (pull.ci === 'failing' && old?.ci !== 'failing') add('ciFailed', pull, pull.headSha);
    if (pull.ci === 'passing' && old?.ci !== 'passing') add('ciPassed', pull, pull.headSha);
    if (pull.review === 'changes_requested' && old?.review !== 'changes_requested')
      add('changesRequested', pull, pull.updatedAt);
    if (pull.review === 'approved' && old?.review !== 'approved') add('approved', pull, pull.updatedAt);
    if (old !== undefined && pull.comments > old.comments) add('comment', pull, String(pull.comments));
  }
  for (const end of ended) add('closed', end.pull, end.merged ? 'merged' : 'closed', end.merged);
  return lines;
}
