/**
 * THE BOARD IS OPT-IN, ENFORCED (docs/board.md § The board is opt-in): whether a FERRET may make a card. The owner
 * decided (2026-11-01) that most work needs no card, and the Board rule said so in words alone — a ferret whose
 * other instructions told it to record every task made one anyway. So the daemon decides, on `fy task create`.
 *
 * A ferret's card is made when ONE of these holds, and refused otherwise:
 *
 * 1. **The board is on**: the owner switched the project's board on (`fy board on`).
 * 2. **A parent it holds**: the card goes under a card the ferret may adopt under (its own, or one its lead handed
 *    it) — it is splitting work that is already on the board.
 * 3. **The owner's Yes**: `--approval !A<n>` names an item the ferret raised on its OWN agenda, a yes/no question
 *    about tracking (it names a card, the board or tracking), that the owner answered Yes. One Yes makes one card.
 * 4. **The owner's words**: the card's ask is the owner's own words to this session (`ownerWordsMatch`), and those
 *    words ask for tracking (they name a card, the board, a ticket or tracking). A keyword test over real words: it
 *    can pass a card the owner did not mean, never one built from a ferret's own words.
 *
 * Only a ferret on its own credential is asked. The owner, the daemon (the card `fy new` makes for a sub-ferret, a
 * gate, a PR) and the admin token are not; a sub-ferret is refused every card before this is reached.
 *
 * Pure and total: the service gathers the facts and throws the refusal.
 */
import type { AgendaId, BoardTask, ResolvedAgendaItem } from '@ferretry/protocol';
import { ownerWordsMatch } from './origin.ts';

/** Words that ask for tracking on the board, in the owner's message or in the question they said Yes to. */
export const TRACKING_WORDS = /\b(?:cards?|boards?|tickets?|track(?:s|ed|ing)?)\b/iu;

/** What a ferret's card on a board rests on; `null` is a refusal. */
export type CardLicence = 'board-on' | 'parent' | 'approval' | 'owner-words';

/** Everything the decision reads, gathered by the service. */
export interface CardLicenceFacts {
  /** Whether the card's board is switched on. */
  readonly boardOn: boolean;
  /** Whether the card goes under a parent the caller may adopt under (the service has already checked that). */
  readonly parent: boolean;
  /** The approval the request names, already judged by {@link approvalProblem}: `true` only for a good one. */
  readonly approved: boolean;
  /** The card's ask, as the request carries it. */
  readonly askText: string;
  /** What the owner said to the caller's session. */
  readonly ownerSaid: readonly string[];
}

/** Whether the owner's words to this session ask for THIS card: the ask is their words, and those words track. */
export const ownerAskedForTracking = (askText: string, ownerSaid: readonly string[]): boolean =>
  ownerWordsMatch(
    askText,
    ownerSaid.filter(words => TRACKING_WORDS.test(words)),
  );

/** The first proof that holds, in the order the rule reads; `null` when none does. */
export const cardLicence = (facts: CardLicenceFacts): CardLicence | null => {
  if (facts.boardOn) return 'board-on';
  if (facts.parent) return 'parent';
  if (facts.approved) return 'approval';
  if (ownerAskedForTracking(facts.askText, facts.ownerSaid)) return 'owner-words';
  return null;
};

const YES = 'yes';
const NO = 'no';

/** The labels of an item's choices, folded: a yes/no item asks exactly Yes and No. */
const choicesOf = (item: Pick<ResolvedAgendaItem, 'ask'>): readonly string[] =>
  item.ask?.kind === 'multiple-choice' ? item.ask.options.map(option => option.label.trim().toLowerCase()) : [];

const isYesNo = (item: Pick<ResolvedAgendaItem, 'ask'>): boolean => {
  const choices = choicesOf(item);
  return choices.length === 2 && choices.includes(YES) && choices.includes(NO);
};

/**
 * Why the item `--approval` names is not the owner's Yes to tracking, or `null` when it is. `item` is the answered
 * item of that id on the CALLER's own agenda (`undefined` when there is none); `usedBy` is the card already made on
 * it, if any.
 */
export const approvalProblem = (
  id: AgendaId,
  item: ResolvedAgendaItem | undefined,
  caller: string,
  usedBy: Pick<BoardTask, 'id'> | undefined,
): string | null => {
  const ref = `!${id}`;
  if (item === undefined) return `${ref} is not an answered item on your agenda`;
  if (item.raisedBy !== 'agent' || item.raisedBySession !== caller) return `${ref} is not an item you raised`;
  if (!isYesNo(item)) return `${ref} is not a yes/no question`;
  if (![item.subject, item.why, item.howToResolve].some(text => TRACKING_WORDS.test(text))) {
    return `${ref} does not ask about tracking this on the board`;
  }
  if (item.resolvedBy !== 'human') return `${ref} was not answered by the owner`;
  const response = item.response;
  if (
    item.disposition !== 'done' ||
    response?.kind !== 'multiple-choice' ||
    response.choice.trim().toLowerCase() !== YES
  ) {
    return `the owner did not answer Yes to ${ref}`;
  }
  if (usedBy !== undefined) return `${ref} already made &${usedBy.id}; one Yes makes one card`;
  return null;
};

/**
 * The refusal a ferret reads: the board is off, so put what the owner must decide on the agenda; to track the work
 * anyway, ask first. `problem` is why a named approval did not count.
 */
export const offBoardRefusal = (board: string, problem?: string): string =>
  [
    `The ${board} board is off, so this work needs no card: put only what the owner must decide or do on your agenda (fy agenda add …).`,
    problem === undefined ? undefined : `The approval does not count: ${problem}.`,
    `To track it anyway, ask first: fy agenda add -k yesno "Track this on the board?" — then, once the owner says Yes, fy task create … --approval !A<n>.`,
  ]
    .filter((line): line is string => line !== undefined)
    .join(' ');
