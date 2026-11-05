/**
 * THE LANES OF A MINI BOARD, built from cards read one by one.
 *
 * A `board` block that lists cards (`&F1 &F2`) draws what a `parent:` block draws: the cards grouped under
 * their lane, the lanes in the order their board keeps them. Pure and total, so a card in a lane its
 * board no longer has, or one whose lane set was not served, is placed under "Elsewhere" and never lost.
 */

import type { BoardTaskView, LaneCategory, LaneSet } from '@ferretry/protocol';

import { boardCardKey } from './board-model.ts';
import type { BoardCardOf } from './board-view.ts';
import type { DaemonConnection } from './daemon-connection.ts';

export interface EmbedLane {
  readonly key: string;
  readonly name: string;
  readonly category: LaneCategory | null;
  readonly cards: readonly BoardCardOf[];
}

export interface EmbedEntry {
  readonly task: BoardTaskView;
  readonly laneSet: LaneSet | null;
}

export const embedCardOf = (connection: DaemonConnection, task: BoardTaskView): BoardCardOf => ({
  key: boardCardKey(connection.daemonId, task.id),
  daemonId: connection.daemonId,
  machine: connection.daemonId,
  task,
  runningOn: [],
});

interface Slot {
  readonly project: number;
  readonly lane: number;
  readonly head: Omit<EmbedLane, 'cards'>;
  readonly cards: BoardCardOf[];
}

/** Cards grouped by project, then by lane in the lane set's own order; unplaced cards last in their project. */
export function groupEmbedLanes(connection: DaemonConnection, entries: readonly EmbedEntry[]): readonly EmbedLane[] {
  const projects = new Map<string, number>();
  const slots = new Map<string, Slot>();
  for (const { task, laneSet } of entries) {
    if (!projects.has(task.projectId)) projects.set(task.projectId, projects.size);
    const project = projects.get(task.projectId) ?? 0;
    const index = laneSet?.lanes.findIndex(candidate => candidate.id === task.laneId) ?? -1;
    const lane = index < 0 ? undefined : laneSet?.lanes[index];
    const key = `${task.projectId}/${lane === undefined ? 'unplaced' : lane.id}`;
    let slot = slots.get(key);
    if (slot === undefined) {
      slot = {
        project,
        lane: lane === undefined ? Number.MAX_SAFE_INTEGER : index,
        head: { key, name: lane?.name ?? 'Elsewhere', category: lane?.category ?? null },
        cards: [],
      };
      slots.set(key, slot);
    }
    slot.cards.push(embedCardOf(connection, task));
  }
  return [...slots.values()]
    .sort((a, b) => a.project - b.project || a.lane - b.lane)
    .map(slot => ({ ...slot.head, cards: slot.cards }));
}
