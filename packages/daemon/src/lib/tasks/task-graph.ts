import type { Task, TaskId } from '@ferretry/protocol';
import { TaskError } from './task-error.ts';

/** A dependency is satisfied once the work it gates actually exists — built, live, or done. */
export const dependencySatisfied = (task: Task | undefined): boolean =>
  task !== undefined && (task.phase === 'built' || task.phase === 'live' || task.phase === 'done');

/** Indexes the record set, refusing a set that names the same task twice. */
export const taskGraphMap = (tasks: readonly Task[]): ReadonlyMap<TaskId, Task> => {
  const graph = new Map<TaskId, Task>();
  for (const task of tasks) {
    if (graph.has(task.id)) throw new TaskError('ambiguous', `task ${task.id} exists more than once`);
    graph.set(task.id, task);
  }
  return graph;
};

/**
 * Proves the candidate record set is a DAG whose every edge resolves.
 *
 * This runs over the **whole candidate set after the mutation is applied**, never over the edge in
 * isolation: a rule that only inspects the edge being added cannot see the cycle it closes two hops
 * away. The message names the concrete cycle so the writer knows which edge to remove.
 */
export const assertTaskDag = (tasks: readonly Task[]): void => {
  const graph = taskGraphMap(tasks);
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!graph.has(dependency)) {
        throw new TaskError('not-found', `${task.id} depends on missing task ${dependency}`);
      }
    }
  }

  const visiting = new Set<TaskId>();
  const visited = new Set<TaskId>();
  const path: TaskId[] = [];
  const visit = (id: TaskId): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const start = path.indexOf(id);
      const cycle = [...path.slice(Math.max(0, start)), id].join(' → ');
      throw new TaskError('cycle', `dependency cycle refused: ${cycle}`);
    }
    visiting.add(id);
    path.push(id);
    for (const dependency of graph.get(id)?.dependsOn ?? []) visit(dependency);
    path.pop();
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of graph.keys()) visit(id);
};

/** Every task that declares an edge to `id`, in record order. */
export const taskDependents = (tasks: readonly Task[], id: TaskId): readonly Task[] =>
  tasks.filter(task => task.dependsOn.includes(id));

/** Dropping work something else still waits on would silently strand the dependent. */
export const assertTaskCanDrop = (tasks: readonly Task[], id: TaskId): void => {
  const dependents = taskDependents(tasks, id).filter(task => task.phase !== 'dropped');
  if (dependents.length === 0) return;
  throw new TaskError(
    'dependency-conflict',
    `${id} cannot be dropped; depended on by ${dependents.map(task => task.id).join(', ')}`,
  );
};

/** The unsatisfied edges holding a task back, in the order the task declared them. */
export const taskBlockedBy = (tasks: readonly Task[], task: Task): readonly TaskId[] => {
  const graph = taskGraphMap(tasks);
  return task.dependsOn.filter(id => !dependencySatisfied(graph.get(id)));
};

/** Returns the record set with `replacement` substituted for the task of the same id. */
export const replaceGraphTask = (tasks: readonly Task[], replacement: Task): readonly Task[] =>
  tasks.map(task => (task.id === replacement.id ? replacement : task));
