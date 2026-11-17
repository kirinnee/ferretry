/**
 * THE LANES OF A MINI BOARD a `task` or `board` block draws in chat, built from tasks read one by one.
 *
 * Conversation hands the Board what the block named (`EmbedSpec`) and nothing the author typed about a task: the
 * title, lane and progress are read from the board. A board that lists tasks draws what a `parent:` block draws:
 * the tasks grouped under their lane, the lanes in the order their lane set keeps them. Pure and total, so a task
 * in a lane its board no longer has, or one whose lane set was not served, sits under "Elsewhere" and is never lost.
 */

import type { TaskView, LaneCategory, LaneSet } from '../../contract/index.ts';
import { THIS_MACHINE } from './machine.ts';
import { boardTaskKey, type BoardModel } from './board-model.ts';
import type { BoardTaskOf } from './board-view.ts';

/** What a block names: one task, a list of tasks, or the children of a task. */
export type EmbedSpec =
  | { readonly kind: 'card'; readonly id: string }
  | { readonly kind: 'cards'; readonly ids: readonly string[] }
  | { readonly kind: 'children'; readonly parent: string };

const isIds = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every(id => typeof id === 'string');

/** The spec a renderer was handed, or `null` for any other value: the renderer draws nothing it cannot name. */
export const embedSpecOf = (value: unknown): EmbedSpec | null => {
  const spec = value as {
    readonly kind?: unknown;
    readonly id?: unknown;
    readonly ids?: unknown;
    readonly parent?: unknown;
  };
  if (spec === null || typeof spec !== 'object') return null;
  if (spec.kind === 'card' && typeof spec.id === 'string') return { kind: 'card', id: spec.id };
  if (spec.kind === 'cards' && isIds(spec.ids)) return { kind: 'cards', ids: spec.ids };
  if (spec.kind === 'children' && typeof spec.parent === 'string') return { kind: 'children', parent: spec.parent };
  return null;
};

export interface EmbedLane {
  readonly key: string;
  readonly name: string;
  readonly category: LaneCategory | null;
  readonly cards: readonly BoardTaskOf[];
}

export interface EmbedEntry {
  readonly task: TaskView;
  readonly laneSet: LaneSet | null;
}

export const embedTaskOf = (task: TaskView): BoardTaskOf => ({
  key: boardTaskKey(THIS_MACHINE.daemonId, task.id),
  daemonId: THIS_MACHINE.daemonId,
  machine: THIS_MACHINE.daemonId,
  task,
  runningOn: [],
});

interface Slot {
  readonly project: number;
  readonly lane: number;
  readonly head: Omit<EmbedLane, 'cards'>;
  readonly cards: BoardTaskOf[];
}

/** Tasks grouped by project, then by lane in the lane set's own order; unplaced tasks last in their project. */
export const groupEmbedLanes = (entries: readonly EmbedEntry[]): readonly EmbedLane[] => {
  const projects = new Map<string, number>();
  const slots = new Map<string, Slot>();
  for (const { task, laneSet } of entries) {
    if (!projects.has(task.projectId)) projects.set(task.projectId, projects.size);
    const index = laneSet?.lanes.findIndex(candidate => candidate.id === task.laneId) ?? -1;
    const lane = index < 0 ? undefined : laneSet?.lanes[index];
    const key = `${task.projectId}/${lane === undefined ? 'unplaced' : lane.id}`;
    let slot = slots.get(key);
    if (slot === undefined) {
      slot = {
        project: projects.get(task.projectId) ?? 0,
        lane: lane === undefined ? Number.MAX_SAFE_INTEGER : index,
        head: { key, name: lane?.name ?? 'Elsewhere', category: lane?.category ?? null },
        cards: [],
      };
      slots.set(key, slot);
    }
    slot.cards.push(embedTaskOf(task));
  }
  return [...slots.values()]
    .sort((a, b) => a.project - b.project || a.lane - b.lane)
    .map(slot => ({ ...slot.head, cards: slot.cards }));
};

/** The lanes of a whole-board read that hold a child of `parent`, the tasks no lane holds under "Elsewhere". */
export const childLanes = (model: BoardModel, parent: string): readonly EmbedLane[] => {
  const wanted = (task: BoardTaskOf): boolean => task.task.parent?.id === parent;
  return model.groups
    .flatMap((group): EmbedLane[] => [
      ...group.lanes.map(lane => ({
        key: `${group.key}/${lane.id}`,
        name: lane.name,
        category: lane.category,
        cards: lane.cards.filter(wanted),
      })),
      { key: `${group.key}/unplaced`, name: 'Elsewhere', category: null, cards: group.unplaced.filter(wanted) },
    ])
    .filter(lane => lane.cards.length > 0);
};
