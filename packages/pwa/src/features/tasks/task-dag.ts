import type { TaskStatus, TaskSummary } from '@ferretry/protocol';

/** A task board projection suitable for an interactive dependency graph. */
export interface TaskDagNode {
  readonly id: string;
  readonly task: TaskSummary | null;
  /** A dependency that the current board response did not include. */
  readonly missing: boolean;
  /** The task belongs to a different session than the surface being viewed. */
  readonly crossSession: boolean;
}

interface TaskDagEdge {
  /** The task waiting on a dependency. */
  readonly from: string;
  /** The dependency task. */
  readonly to: string;
}

export interface TaskDag {
  readonly nodes: readonly TaskDagNode[];
  readonly edges: readonly TaskDagEdge[];
}

interface FilteredTaskDagNode extends TaskDagNode {
  /** False means this node remains solely to show a matching task's path. */
  readonly matchesFilter: boolean;
}

export interface FilteredTaskDag {
  readonly nodes: readonly FilteredTaskDagNode[];
  readonly edges: readonly TaskDagEdge[];
  readonly matchCount: number;
  readonly contextCount: number;
}

export interface TaskDagTask extends TaskSummary {
  readonly sessionId?: string | null;
}

/**
 * Builds graph data without smuggling a session-only identity into a fleet
 * view. Missing dependencies are visible nodes, never silently discarded.
 */
export const taskDag = (tasks: readonly TaskDagTask[], sessionId?: string | null): TaskDag => {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const nodes = new Map<string, TaskDagNode>();
  const edges: TaskDagEdge[] = [];

  for (const task of tasks) {
    nodes.set(task.id, {
      id: task.id,
      task,
      missing: false,
      crossSession:
        sessionId !== undefined && sessionId !== null && task.sessionId !== null && task.sessionId !== sessionId,
    });
    for (const dependencyId of task.dependsOn) {
      if (!nodes.has(dependencyId) && !byId.has(dependencyId)) {
        nodes.set(dependencyId, { id: dependencyId, task: null, missing: true, crossSession: false });
      }
      edges.push({ from: task.id, to: dependencyId });
    }
  }

  return { nodes: [...nodes.values()], edges };
};

/** Exact-status filtering retains transitive dependency ancestry as PATH context. */
export const filterTaskDag = (dag: TaskDag, statuses: ReadonlySet<TaskStatus> | null): FilteredTaskDag => {
  if (statuses === null) {
    return {
      nodes: dag.nodes.map(node => ({ ...node, matchesFilter: true })),
      edges: [...dag.edges],
      matchCount: dag.nodes.length,
      contextCount: 0,
    };
  }

  const matches = new Set(dag.nodes.flatMap(node => (node.task && statuses.has(node.task.status) ? [node.id] : [])));
  const dependencies = new Map<string, string[]>();
  for (const edge of dag.edges) dependencies.set(edge.from, [...(dependencies.get(edge.from) ?? []), edge.to]);
  const included = new Set(matches);
  const pending = [...matches];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined) continue;
    for (const dependency of dependencies.get(id) ?? []) {
      if (included.has(dependency)) continue;
      included.add(dependency);
      pending.push(dependency);
    }
  }
  const nodes = dag.nodes.flatMap<FilteredTaskDagNode>(node =>
    included.has(node.id) ? [{ ...node, matchesFilter: matches.has(node.id) }] : [],
  );
  return {
    nodes,
    edges: dag.edges.filter(edge => included.has(edge.from) && included.has(edge.to)),
    matchCount: matches.size,
    contextCount: nodes.length - matches.size,
  };
};

interface TaskDagLayoutNode extends FilteredTaskDagNode {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
}

interface TaskDagLayoutEdge {
  readonly dependentId: string;
  readonly dependencyId: string;
  readonly path: string;
}

export interface TaskDagLayout {
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly TaskDagLayoutNode[];
  readonly edges: readonly TaskDagLayoutEdge[];
}

const nodeSortKey = (node: FilteredTaskDagNode): string => {
  const order = node.task?.order;
  const rank = order === null || order === undefined ? '999999999' : String(order).padStart(9, '0');
  return `${rank}\u0000${node.task?.title ?? node.id}\u0000${node.id}`;
};

/** Deterministic dependency-first layered layout with no runtime graph library. */
export const layoutTaskDag = (dag: FilteredTaskDag): TaskDagLayout => {
  const nodeWidth = 228;
  const nodeHeight = 92;
  const columnGap = 38;
  const rowGap = 88;
  const padding = 32;
  if (dag.nodes.length === 0) return { width: padding * 2, height: padding * 2, nodes: [], edges: [] };

  const byId = new Map(dag.nodes.map(node => [node.id, node]));
  const dependencies = new Map<string, string[]>();
  for (const edge of dag.edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    dependencies.set(edge.from, [...(dependencies.get(edge.from) ?? []), edge.to]);
  }
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const value = Math.max(0, ...(dependencies.get(id) ?? []).map(dependency => visit(dependency) + 1));
    visiting.delete(id);
    depth.set(id, value);
    return value;
  };
  for (const node of dag.nodes) visit(node.id);

  const levels = new Map<number, FilteredTaskDagNode[]>();
  for (const node of dag.nodes)
    levels.set(depth.get(node.id) ?? 0, [...(levels.get(depth.get(node.id) ?? 0) ?? []), node]);
  const maxDepth = Math.max(...levels.keys());
  for (const level of levels.values()) level.sort((a, b) => nodeSortKey(a).localeCompare(nodeSortKey(b)));
  const widest = Math.max(...[...levels.values()].map(level => level.length));
  const graphWidth = widest * nodeWidth + Math.max(0, widest - 1) * columnGap;
  const positioned = new Map<string, TaskDagLayoutNode>();
  for (let level = 0; level <= maxDepth; level += 1) {
    const nodes = levels.get(level) ?? [];
    const levelWidth = nodes.length * nodeWidth + Math.max(0, nodes.length - 1) * columnGap;
    const left = padding + (graphWidth - levelWidth) / 2;
    nodes.forEach((node, index) => {
      positioned.set(node.id, {
        ...node,
        x: left + index * (nodeWidth + columnGap),
        y: padding + level * (nodeHeight + rowGap),
        width: nodeWidth,
        height: nodeHeight,
        depth: level,
      });
    });
  }
  const edges = dag.edges.flatMap<TaskDagLayoutEdge>(edge => {
    const dependency = positioned.get(edge.to);
    const dependent = positioned.get(edge.from);
    if (!dependency || !dependent) return [];
    const x1 = dependency.x + dependency.width / 2;
    const y1 = dependency.y + dependency.height;
    const x2 = dependent.x + dependent.width / 2;
    const y2 = dependent.y;
    const middle = y1 + (y2 - y1) / 2;
    return [
      {
        dependentId: edge.from,
        dependencyId: edge.to,
        path: `M ${x1} ${y1} C ${x1} ${middle}, ${x2} ${middle}, ${x2} ${y2}`,
      },
    ];
  });
  return {
    width: graphWidth + padding * 2,
    height: (maxDepth + 1) * nodeHeight + maxDepth * rowGap + padding * 2,
    nodes: [...positioned.values()],
    edges,
  };
};

export const taskTitlePreview = (title: string, maxCharacters = 30): string =>
  title.length <= maxCharacters ? title : `${title.slice(0, Math.max(1, maxCharacters - 1)).trimEnd()}…`;
