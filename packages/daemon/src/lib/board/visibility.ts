/**
 * PUBLIC AND PRIVATE CARDS (`docs/board.md` § Public and private cards): public cards are the ones the owner asked
 * for; private cards are the ferrets' bookkeeping, sub-cards and helper cards included. The board shows public cards
 * unless asked for the rest.
 *
 * A card stores its `visibility`; one without it reads by {@link cardVisibility}. Who may change it is
 * {@link visibilityVerdict}, a pure function of the card and the caller's standing.
 */
import type { BoardTask, BoardTaskVisibility } from '@ferretry/protocol';
import type { BoardStanding } from './authority.ts';
import { cardAskedBy } from './origin.ts';

/** The facts a card's visibility rests on. */
export type VisibilityFacts = Pick<BoardTask, 'ask' | 'askedBy' | 'parent' | 'visibility'>;

/**
 * What a card without a stored visibility reads as: public when a person asked for it and it sits at the top
 * level, private otherwise (an agent's card, a sub-card). A stored value wins. Pure and total.
 */
export const defaultVisibility = (card: Pick<BoardTask, 'ask' | 'askedBy' | 'parent'>): BoardTaskVisibility =>
  (card.askedBy ?? cardAskedBy(card)) === 'person' && card.parent === null ? 'public' : 'private';

/** A card's visibility: the stored one, else {@link defaultVisibility}. Pure and total. */
export const cardVisibility = (card: VisibilityFacts): BoardTaskVisibility =>
  card.visibility ?? defaultVisibility(card);

/** The standings that may change a ferret's own card: its owner ferret, the leads above it, and the owner. */
const KEEPERS: readonly BoardStanding[] = ['owner-human', 'owner', 'ancestor'];

/** Why a visibility change is refused, or `null` when it is allowed. */
export interface VisibilityRefusal {
  readonly message: string;
  /** The standings that could do it, for the refusal's `allowed`. */
  readonly allowed: readonly BoardStanding[];
}

/**
 * Whether a caller of this standing may set a card (existing or about to be created) to `to`:
 *
 * - the owner may set any card either way;
 * - a ferret that owns the card, or leads the ferret that does, may set an agent-asked card either way;
 * - only the owner may make a person-asked card private (a ferret must never hide the owner's ask);
 * - a sub-card is private unless the owner makes it public, so a ferret may not publish one.
 */
export const visibilityVerdict = (
  card: Pick<BoardTask, 'ask' | 'askedBy' | 'parent'>,
  to: BoardTaskVisibility,
  standing: BoardStanding,
): VisibilityRefusal | null => {
  if (standing === 'owner-human') return null;
  const owner: readonly BoardStanding[] = ['owner-human'];
  if (!KEEPERS.includes(standing)) {
    return {
      message: 'only the card’s owner ferret, a lead above it or the owner may change its visibility',
      allowed: KEEPERS,
    };
  }
  if ((card.askedBy ?? cardAskedBy(card)) === 'person' && to === 'private') {
    return { message: 'only the owner may make a card they asked for private', allowed: owner };
  }
  if (card.parent !== null && to === 'public') {
    return { message: 'a sub-card is private unless the owner makes it public', allowed: owner };
  }
  return null;
};
