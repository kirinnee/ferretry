/** Shared proof for task references: a board slice's tasks, and every task id the machine holds. */

/** Whether a written task id names a task (`F12`, in any case). */
export type TaskReferenceResolver = (id: string) => boolean;

/**
 * Syntax is not proof. A reference links when its id is a task on this machine (`cardIds`, whatever its project,
 * lane or state) or a task of the host's current slice. `cardIds` and `tasks` both absent: nothing is known, so
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
