/**
 * THE GATE'S CARD LIST, FROM ONE PASS. The gates read every card on the board; each card is built from ONE sweep
 * (`views`, `laneSets`) and ONE snapshot (`cards`), the way v4's `board-gate-cards` did. Nothing here derives the board
 * again per card: a board of N cards costs one derivation, not N.
 */
import type { Task, TaskView } from '../../../contract/index.ts';
import type { TaskAudience } from './authority.ts';
import type { GateTask } from './gate-policy.ts';
import { BoardIndex, type LaneSets, stillBuilding } from './graph.ts';

export interface GateTasksPass {
  /** The one sweep: every card's derived view. */
  readonly views: readonly TaskView[];
  /** The one snapshot of the stored cards and their lane sets. */
  readonly cards: readonly Task[];
  readonly laneSets: LaneSets;
  readonly machineId: string;
  /** A project's name, asked once per project. */
  readonly projectName: (project: Task['projectId']) => Promise<string | undefined>;
  readonly audienceOf: (task: Task) => Promise<TaskAudience>;
  /** The rare card the sweep has no view for (written between the sweep and the snapshot): derived on its own. */
  readonly blockedByOf: (task: Task) => Promise<NonNullable<GateTask['blockedBy']>>;
}

export async function gateTasksOf(pass: GateTasksPass): Promise<GateTask[]> {
  const byId = new Map(pass.views.map(view => [view.id, view] as const));
  const index = new BoardIndex(pass.cards, pass.machineId);
  const names = new Map<string, Promise<string | undefined>>();
  const nameOf = (project: Task['projectId']): Promise<string | undefined> => {
    const known = names.get(project);
    if (known !== undefined) return known;
    const asked = pass.projectName(project);
    names.set(project, asked);
    return asked;
  };
  const out: GateTask[] = [];
  for (const stored of pass.cards) {
    const name = await nameOf(stored.projectId);
    const view = byId.get(stored.id);
    out.push({
      task: stored,
      laneSet: pass.laneSets.get(stored.projectId) ?? null,
      audience: await pass.audienceOf(stored),
      blockedBy: view === undefined ? await pass.blockedByOf(stored) : view.blockedBy,
      building: stillBuilding(stored, index, pass.laneSets),
      ...(name === undefined ? {} : { projectName: name }),
    });
  }
  return out;
}
