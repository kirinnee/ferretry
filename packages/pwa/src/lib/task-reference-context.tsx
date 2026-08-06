/** Shared, scope-bound proof for local and qualified task references. */
import { createContext, useContext, useMemo, type ReactNode } from 'react';

import type { DaemonId } from './daemon-connection.ts';
import type { DaemonSessionScope } from './daemon-scope.ts';
import type { TaskReferenceResolver } from './references.ts';

export interface LocalSessionTaskReferenceRow {
  readonly id: string;
}

export interface BoardAggregateTaskReferenceRow {
  readonly id: string;
  readonly sessionId: string;
}

const unresolved: TaskReferenceResolver = () => null;
const TaskReferenceContext = createContext<TaskReferenceResolver>(unresolved);

/**
 * Proof from the current session's own task snapshot.
 *
 * This input can answer a bare lookup and the equivalent explicitly-qualified
 * lookup for the current session. It refuses every foreign qualifier.
 */
export const createLocalSessionTaskReferenceResolver = (
  scope: DaemonSessionScope,
  tasks: readonly LocalSessionTaskReferenceRow[],
): TaskReferenceResolver => {
  const ids = new Set(tasks.map(task => task.id.toUpperCase()));
  return lookup => {
    if (lookup.form === 'qualified' && lookup.sessionId !== scope.sessionId) return null;
    const id = lookup.id.toUpperCase();
    return ids.has(id) ? { daemonId: scope.daemonId, sessionId: scope.sessionId, id } : null;
  };
};

/**
 * Proof from an already-authorized Shared board aggregate.
 *
 * Its input shape cannot satisfy a bare lookup: only an exact qualified
 * `(sessionId,id)` is accepted. The composing resolver below also keeps the
 * current session on local evidence, so aggregate rows never widen local proof.
 */
export const createBoardAggregateTaskReferenceResolver = (
  daemonId: DaemonId,
  rows: readonly BoardAggregateTaskReferenceRow[],
): TaskReferenceResolver => {
  const idsBySession = new Map<string, ReadonlySet<string>>();
  for (const row of rows) {
    const ids = new Set(idsBySession.get(row.sessionId));
    ids.add(row.id.toUpperCase());
    idsBySession.set(row.sessionId, ids);
  }
  return lookup => {
    if (lookup.form !== 'qualified') return null;
    const id = lookup.id.toUpperCase();
    return idsBySession.get(lookup.sessionId)?.has(id) ? { daemonId, sessionId: lookup.sessionId, id } : null;
  };
};

export interface TaskReferenceResolverInputs {
  readonly scope: DaemonSessionScope;
  /** `undefined` means unread; an empty array is authoritative absence. */
  readonly localTasks?: readonly LocalSessionTaskReferenceRow[];
  /** Ready, authorized aggregate rows only. Refusal/unavailability is `undefined`. */
  readonly boardTasks?: readonly BoardAggregateTaskReferenceRow[];
}

/** Route each authored lookup to exactly one evidence domain. */
export const composeTaskReferenceResolvers =
  (
    scope: Pick<DaemonSessionScope, 'sessionId'>,
    local: TaskReferenceResolver | undefined,
    board: TaskReferenceResolver | undefined,
  ): TaskReferenceResolver =>
  lookup => {
    if (lookup.form === 'local' || lookup.sessionId === scope.sessionId) return local?.(lookup) ?? null;
    return board?.(lookup) ?? null;
  };

/** Compose the two evidence domains behind the one Markdown resolver port. */
export const createTaskReferenceResolver = (inputs: TaskReferenceResolverInputs): TaskReferenceResolver => {
  const { scope, localTasks, boardTasks } = inputs;
  const local = localTasks === undefined ? undefined : createLocalSessionTaskReferenceResolver(scope, localTasks);
  const board =
    boardTasks === undefined ? undefined : createBoardAggregateTaskReferenceResolver(scope.daemonId, boardTasks);
  return composeTaskReferenceResolvers(scope, local, board);
};

/**
 * The host owns fetching and daemon scoping. This provider only supplies its
 * already-scoped snapshots to Markdown, so it cannot create a second cache that
 * might carry task proof across paired daemons.
 */
export function TaskReferenceProvider({
  children,
  scope,
  tasks,
  boardTasks,
}: {
  readonly children: ReactNode;
  readonly scope: DaemonSessionScope;
  readonly tasks: readonly LocalSessionTaskReferenceRow[];
  readonly boardTasks?: readonly BoardAggregateTaskReferenceRow[];
}) {
  const resolver = useMemo(
    () =>
      createTaskReferenceResolver({ scope, localTasks: tasks, ...(boardTasks === undefined ? {} : { boardTasks }) }),
    [scope, tasks, boardTasks],
  );
  return <TaskReferenceContext.Provider value={resolver}>{children}</TaskReferenceContext.Provider>;
}

export const useTaskReferenceResolver = (): TaskReferenceResolver => useContext(TaskReferenceContext);
