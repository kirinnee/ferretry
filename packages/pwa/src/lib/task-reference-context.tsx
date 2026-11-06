/** Shared proof for task references: a board slice's cards, and every card id the machine holds. */
import type { TaskReferenceResolver } from './references.ts';
import { resolveCardReference } from './session-cards.ts';

/** A card the host holds, with the id it had as an old task of this session when it was imported. */
interface ReferenceCard {
  readonly id: string;
  readonly legacyId?: string | null;
}

/**
 * Syntax is not proof. A reference links when its id is a card on this machine (`taskIds`, whatever its
 * project, lane or state), a card of the host's current slice, or the old id of a task this session had
 * before the import (it then links to the card that replaced it). `taskIds` and `cards` both absent: nothing
 * is known, so nothing is proved.
 */
export const createTaskReferenceResolver = (
  cards: readonly ReferenceCard[] = [],
  taskIds?: ReadonlySet<string>,
): TaskReferenceResolver => {
  return id => resolveCardReference(cards, id) !== null || taskIds?.has(id.toUpperCase()) === true;
};
