/**
 * WHO A BOARD NOTICE IS FOR when a card needs its people to act: a stale nudge, a red CI, a PR closed unmerged.
 *
 * The card's ASSIGNEE answers for it. When that session has ended, the nearest live ancestor lead of the
 * assignee does; only when nobody in that line is left does it fall to the card's owner (its creator by
 * default) and the owner's leads. An interactive session is the owner's own chat, so it is chosen only when
 * no automatic session is alive anywhere in that order. Pure: a function of the card and one roster read.
 */
import type { Card } from '../../../contract/index.ts';
import { MAX_LINEAGE_DEPTH } from './lineage.ts';
import { presenceOf, type FerretLiveness, type FerretRoster } from './activity.ts';

/** The session a notice goes to, and whether it is the owner's own interactive chat. */
export interface NoticeRecipient {
  readonly ferret: string;
  readonly session: FerretLiveness;
  readonly interactive: boolean;
}

/** `ferret` and the leads above it, nearest first, walked up the roster's `lead`; a loop ends the walk. */
const lineOf = (roster: FerretRoster, ferret: string): readonly string[] => {
  const line: string[] = [];
  let current: string | undefined = ferret;
  while (current !== undefined && !line.includes(current) && line.length < MAX_LINEAGE_DEPTH) {
    line.push(current);
    const lead: string | undefined = roster.sessions.get(current)?.lead;
    current = lead === undefined || lead === '' ? undefined : lead;
  }
  return line;
};

/**
 * The first live session in the assignee's line, then the owner's; an automatic one before any interactive
 * one. `null` when no session is alive in either line, or when the assignee itself could not be read: this
 * function never picks somebody else then. What a caller does with `null` is its own call — the stale sweep
 * sends nothing, a PR alert goes to {@link alertFallback}.
 */
export const noticeRecipient = (
  roster: FerretRoster,
  card: Pick<Card, 'owner' | 'assignee'>,
): NoticeRecipient | null => {
  const assignee = card.assignee ?? card.owner;
  if (presenceOf(roster, assignee) === 'unknown') return null;
  const order = [...new Set([...lineOf(roster, assignee), ...lineOf(roster, card.owner)])];
  let interactive: NoticeRecipient | null = null;
  for (const ferret of order) {
    const session = roster.sessions.get(ferret);
    if (session === undefined || presenceOf(roster, ferret) !== 'alive') continue;
    const found = { ferret, session, interactive: session.interactive === true };
    if (!found.interactive) return found;
    interactive ??= found;
  }
  return interactive;
};

/** The alerts a PR raises about a card. */
export type PrAlertReason = 'ci-failing' | 'closed-unmerged';

/**
 * Who a PR alert goes to when {@link noticeRecipient} found nobody: the same session it went to before routing
 * existed — the card's working ferret for a red CI, its owner for a PR closed unmerged. The sender then lets a
 * sub-ferret's lead stand in for it (`nudgeTarget`), and the send path revives an ended session.
 */
export const alertFallback = (card: Pick<Card, 'owner' | 'assignee'>, reason: PrAlertReason): string =>
  reason === 'ci-failing' ? (card.assignee ?? card.owner) : card.owner;
