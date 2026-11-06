/** Shared proof for task references: a board slice's cards, and every card id the machine holds. */
import type { TaskReferenceResolver } from './references.ts';
import { resolveCardReference } from './session-cards.ts';

/** A card the host holds. */
interface ReferenceCard {
  readonly id: string;
}

/**
 * Syntax is not proof. A reference links when its id is a card on this machine (`taskIds`, whatever its
 * project, lane or state) or a card of the host's current slice. `taskIds` and `cards` both absent: nothing
 * is known, so nothing is proved.
 */
export const createTaskReferenceResolver = (
  cards: readonly ReferenceCard[] = [],
  taskIds?: ReadonlySet<string>,
): TaskReferenceResolver => {
  return id => resolveCardReference(cards, id) !== null || taskIds?.has(id.toUpperCase()) === true;
};
