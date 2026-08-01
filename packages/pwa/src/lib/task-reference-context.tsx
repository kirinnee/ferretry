/** Shared proof for task references supplied by one daemon-scoped task board. */
import { createContext, useContext, useMemo, type ReactNode } from 'react';

import type { TaskReferenceResolver } from './references.ts';

const unresolved: TaskReferenceResolver = () => false;
const TaskReferenceContext = createContext<TaskReferenceResolver>(unresolved);

/** Syntax is not proof: only an id in the host's current daemon task board links. */
export const createTaskReferenceResolver = (
  tasks: readonly Pick<{ readonly id: string }, 'id'>[],
): TaskReferenceResolver => {
  const ids = new Set(tasks.map(task => task.id.toUpperCase()));
  return id => ids.has(id.toUpperCase());
};

/**
 * The host owns fetching and daemon scoping. This provider only supplies its
 * already-scoped, current snapshot to Markdown, so it cannot create a second
 * cache that might carry task ids across paired daemons.
 */
export function TaskReferenceProvider({
  children,
  tasks,
}: {
  readonly children: ReactNode;
  readonly tasks: readonly { readonly id: string }[];
}) {
  const resolver = useMemo(() => createTaskReferenceResolver(tasks), [tasks]);
  return <TaskReferenceContext.Provider value={resolver}>{children}</TaskReferenceContext.Provider>;
}

export const useTaskReferenceResolver = (): TaskReferenceResolver => useContext(TaskReferenceContext);
