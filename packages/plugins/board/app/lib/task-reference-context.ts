/** Shared proof for card references: a board slice's cards, and every card id the machine holds. */

/** Whether a written card id names a card (`F12`, in any case). */
export type TaskReferenceResolver = (id: string) => boolean;

/**
 * Syntax is not proof. A reference links when its id is a card on this machine (`cardIds`, whatever its project,
 * lane or state) or a card of the host's current slice. `cardIds` and `cards` both absent: nothing is known, so
 * nothing is proved.
 */
export const createTaskReferenceResolver = (
  tasks: readonly { readonly id: string }[] = [],
  taskIds?: ReadonlySet<string>,
): TaskReferenceResolver => {
  return id => {
    const written = id.toUpperCase();
    return tasks.some(task => task.id.toUpperCase() === written) || taskIds?.has(written) === true;
  };
};
