/** Shared proof for card references: a board slice's cards, and every card id the machine holds. */

/** Whether a written card id names a card (`F12`, in any case). */
export type CardReferenceResolver = (id: string) => boolean;

/**
 * Syntax is not proof. A reference links when its id is a card on this machine (`cardIds`, whatever its project,
 * lane or state) or a card of the host's current slice. `cardIds` and `cards` both absent: nothing is known, so
 * nothing is proved.
 */
export const createCardReferenceResolver = (
  cards: readonly { readonly id: string }[] = [],
  cardIds?: ReadonlySet<string>,
): CardReferenceResolver => {
  return id => {
    const written = id.toUpperCase();
    return cards.some(card => card.id.toUpperCase() === written) || cardIds?.has(written) === true;
  };
};
