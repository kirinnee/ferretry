/**
 * WHO A CARD IS FOR: the owner's ask, or an agent's own work (`docs/board.md` § Human and agent cards). The
 * Board shows the owner's cards and folds the rest under them, so this is the one place that decides it.
 *
 * A card is **human** when the owner asked for it:
 *
 * 1. the owner made it (the Board page, a paired device, the admin CLI);
 * 2. its ask's source names the owner (`owner`, "owner via lead jaeda", "owner (board move)"), whoever wrote
 *    the card down;
 * 3. a ferret recorded it from a session the OWNER started (`session:<id>`, or the recording ferret itself
 *    when the source names no session): only the owner talks in such a session.
 *
 * Everything else is **agent**: the card of a sub-ferret a lead started (`fy new` and `fy start` from a
 * ferret, ask `session:<lead>`), the daemon's own cards (the board import's untriaged asks), and a card a
 * sub-ferret recorded from its own brief. A session this daemon does not know reads as owner-started: a
 * card is never hidden from the owner on a guess.
 *
 * The rule cannot tell a top-level ferret's own idea from the owner's words in that ferret's chat; both read
 * as human, which errs toward showing the owner a card.
 */
import type { BoardTask, BoardTaskAskedBy, BoardTaskId, BoardTaskOrigin, TaskRef } from '@ferretry/protocol';
import type { BoardIndex } from './graph.ts';

/** An ask source that names the owner, in any of the ways ferrets write it down. */
const NAMES_OWNER = /\bowner\b/iu;

/** The session an ask source names: `session:<id>`, maybe followed by more words. */
const SESSION_SOURCE = /^session:([^\s(),]+)/u;

/** What the rule needs to know about sessions: whether a ferret started this one (`config.parent`). */
export interface OriginFacts {
  readonly startedByFerret: (sessionId: string) => boolean;
}

/**
 * The session whose words a ferret-made card records, when it takes a session's lineage to decide the
 * card's origin; `undefined` when the card decides without one (the owner made it, its source names the
 * owner, or the daemon made it).
 */
export const askSessionOf = (card: Pick<BoardTask, 'createdBy' | 'ask'>): string | undefined => {
  if (card.createdBy.kind !== 'ferret' || NAMES_OWNER.test(card.ask.source)) return undefined;
  return SESSION_SOURCE.exec(card.ask.source.trim())?.[1] ?? card.createdBy.sessionId;
};

/** Whether the owner asked for this card (see the file header). Pure and total. */
export const cardOrigin = (card: Pick<BoardTask, 'createdBy' | 'ask'>, facts: OriginFacts): BoardTaskOrigin => {
  if (card.createdBy.kind === 'owner' || NAMES_OWNER.test(card.ask.source)) return 'human';
  if (card.createdBy.kind === 'daemon') return 'agent';
  const session = askSessionOf(card);
  return session !== undefined && facts.startedByFerret(session) ? 'agent' : 'human';
};

/**
 * The nearest ancestor of a card on this machine whose origin is `human`, never the card itself; `null`
 * when none is (a parent on another machine ends the walk, and a loop in `parent` is walked once).
 */
export const humanParentOf = (
  card: Pick<BoardTask, 'id' | 'parent'>,
  index: BoardIndex,
  originOf: (card: BoardTask) => BoardTaskOrigin,
): TaskRef | null => {
  const seen = new Set<BoardTaskId>([card.id]);
  let parent = card.parent === null ? undefined : index.get(card.parent);
  while (parent !== undefined && !seen.has(parent.id)) {
    if (originOf(parent) === 'human') return { id: parent.id };
    seen.add(parent.id);
    parent = parent.parent === null ? undefined : index.get(parent.parent);
  }
  return null;
};

/**
 * Whether a PERSON asked for this card, for the surfaces that wait on the owner (the Inbox's cards to test): the
 * stricter sibling of {@link cardOrigin}. The card stores the answer ({@link decideAskedBy}, at creation); this
 * reads it from the ask's source alone, which is all a card without a stored one has: a person's only when the source
 * names the owner (the Board page's `owner (board)`, "owner via lead jaeda"). A top-level ferret's own follow-up
 * (`session:<lead>`, a review finding) reads as `agent` here although `cardOrigin` shows it; it stays on the Board.
 */
export const cardAskedBy = (card: Pick<BoardTask, 'ask'>): BoardTaskAskedBy =>
  NAMES_OWNER.test(card.ask.source) ? 'person' : 'agent';

/** The fewest normalized characters a match may rest on: a shorter ask ("fix it") could sit in any message. */
export const MIN_OWNER_MATCH = 24;

const normalized = (text: string): string => text.replace(/\s+/gu, ' ').trim().toLowerCase();

/**
 * Whether an ask is words the owner said: the ask contains one of `words`, or one of them contains the ask
 * (the first turn wraps the owner's message in text of its own), with whitespace collapsed and case ignored.
 * The shorter side must be at least {@link MIN_OWNER_MATCH} characters. A paraphrase does not match.
 */
export const ownerWordsMatch = (askText: string, words: readonly string[]): boolean => {
  const ask = normalized(askText);
  return words.some(word => {
    const said = normalized(word);
    const [short, long] = ask.length <= said.length ? [ask, said] : [said, ask];
    return short.length >= MIN_OWNER_MATCH && long.includes(short);
  });
};

/**
 * Who asked for a card that is being written, from the facts known once: the owner's own app (an owner caller
 * that is not the admin token, which a ferret can hold too), an ask source that names the owner, or an ask that
 * matches a message the owner sent the session it came from. `words` is read only when the first two do not
 * decide. Anything else, an unknown session included, is the agent's.
 */
export const decideAskedBy = async (
  card: Pick<BoardTask, 'createdBy' | 'ask'>,
  ownerApp: boolean,
  said: (sessionId: string) => Promise<readonly string[]>,
): Promise<BoardTaskAskedBy> => {
  if (ownerApp || cardAskedBy(card) === 'person') return 'person';
  const session = askSessionOf(card);
  return session !== undefined && ownerWordsMatch(card.ask.text, await said(session)) ? 'person' : 'agent';
};
