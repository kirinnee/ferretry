/** Shared proof for task references supplied by one daemon-scoped board slice. */
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import type { TaskReferenceResolver } from './references.ts';
import { resolveCardReference } from './session-cards.ts';

const unresolved: TaskReferenceResolver = () => false;
const TaskReferenceContext = createContext<TaskReferenceResolver>(unresolved);

/** A card the host holds, with the id it had as an old task of this session when it was imported. */
interface ReferenceCard {
  readonly id: string;
  readonly legacyId?: string | null;
}

/**
 * Syntax is not proof: only an id of a card in the host's current board slice links, or the old id of a
 * task this session had before the import (it then links to the card that replaced it).
 */
export const createTaskReferenceResolver = (cards: readonly ReferenceCard[]): TaskReferenceResolver => {
  return id => resolveCardReference(cards, id) !== null;
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
  readonly tasks: readonly ReferenceCard[];
}) {
  const resolver = useMemo(() => createTaskReferenceResolver(tasks), [tasks]);
  return <TaskReferenceContext.Provider value={resolver}>{children}</TaskReferenceContext.Provider>;
}

export const useTaskReferenceResolver = (): TaskReferenceResolver => useContext(TaskReferenceContext);
