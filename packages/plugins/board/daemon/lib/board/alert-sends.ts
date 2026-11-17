/**
 * A BOARD ALERT IS NEVER TYPED INTO THE OWNER'S OWN CHAT. A stale task, a red CI and a PR closed unmerged are
 * routed by `noticeRecipient` (`notice-route.ts`), which falls to an interactive session only when no automatic one is alive —
 * and for a lead the owner chats with, whose helpers have ended, that is nearly always: from 2026-10-31 to
 * 2026-11-03 one such lead had 177 of them typed into it as turns, 158 of them "CI is red".
 *
 * The send path cannot hold them back: a daemon message to an interactive session is not in the queue's delivery
 * order (`boardOnly`), so the queue hands it to the direct send path, which TYPES it. So this does, at the one
 * place every alert passes, whoever it was routed to — the alert route, the pre-routing fallback, or a helper's
 * lead standing in for it. The session's mode is read as the send path reads it (`config.mode`).
 *
 * Holding one back loses nothing the board does not show: a red CI is the task's PR fact, a PR closed unmerged is
 * a note in the task's history, a stale task is its activity. The alert is journalled on the session it was for,
 * so what was withheld can be counted. An automatic session gets every alert as before.
 *
 * A PRIVATE task is hidden from the default board, so a red CI or a PR closed unmerged on one is seen by nobody
 * who does not open it. Such an alert is also written as a note on the nearest PUBLIC ancestor that is still open ({@link AlertSurface}),
 * which the owner's default board does show — still not a turn. A stale nudge is journalled only: it is a task's own
 * quiet, and a note on its parent would count as the parent's activity.
 */
import type { Task, TaskId } from '../../../contract/index.ts';

/** How a ferret takes messages: `interactive` is the owner's own chat, `auto` a ferret on its own errand. */
export type InteractionMode = 'auto' | 'interactive';

/** A daemon notice to an interactive ferret is never typed into it: it belongs on the board, not in the queue. */
const boardOnly = (mode: InteractionMode): boolean => mode === 'interactive';

import { BoardIndex, taskCategory, type LaneSets } from './graph.ts';
import { isOpenOnBoard } from './query.ts';
import { taskVisibility } from './visibility.ts';

export interface BoardAlertPorts {
  /** How the session takes messages, as the send path reads it; `undefined` when it cannot be read. */
  mode(ferret: string): Promise<InteractionMode | undefined>;
  /** Sends the alert to the session through the ordinary send path, as the board's. */
  send(ferret: string, message: string): Promise<void>;
  /** Journals an alert that was held back on the session it was for. */
  withheld(ferret: string, message: string): Promise<void>;
  /** Puts a held-back alert about a task where the board shows it, without typing it anywhere. */
  surface(task: TaskId, message: string): Promise<void>;
}

/** What became of one alert: typed by the send path, or held back from an interactive session. */
export type BoardAlertOutcome = 'sent' | 'withheld';

export class BoardAlerts {
  constructor(private readonly ports: BoardAlertPorts) {}

  /**
   * Sends one alert unless its session is interactive. A session whose mode cannot be read — or whose read fails —
   * is sent to: the send path refuses one it cannot read, exactly as before. `about` names the task whose
   * actionable alert this is, so a held-back one can be surfaced on the board.
   */
  async send(ferret: string, message: string, about?: TaskId): Promise<BoardAlertOutcome> {
    const mode = await this.ports.mode(ferret).catch(() => undefined);
    if (mode !== undefined && boardOnly(mode)) {
      await this.ports.withheld(ferret, message);
      if (about !== undefined) await this.ports.surface(about, message);
      return 'withheld';
    }
    await this.ports.send(ferret, message);
    return 'sent';
  }
}

export interface AlertSurfacePorts {
  /** Every readable task, archived ones included, with every board's lanes. */
  snapshot(): Promise<{ readonly cards: readonly Task[]; readonly laneSets: LaneSets }>;
  /** Writes a note on a task's history as the daemon. */
  note(task: TaskId, text: string): Promise<void>;
  machineId(): string | undefined;
}

/**
 * The nearest ancestor of `task` that is public AND on the default board (open, not dropped, not in a closed lane —
 * the board's own `isOpenOnBoard`), never the task itself; `undefined` when there is none. An archived ancestor is
 * walked past: a note on it would sit where the default board does not list it.
 */
const visibleAncestor = (task: Task, index: BoardIndex, laneSets: LaneSets): Task | undefined => {
  const seen = new Set<TaskId>([task.id]);
  let parent = task.parent === null ? undefined : index.get(task.parent);
  while (parent !== undefined && !seen.has(parent.id)) {
    if (taskVisibility(parent) === 'public' && isOpenOnBoard(taskCategory(parent, laneSets), parent.dropped !== null))
      return parent;
    seen.add(parent.id);
    parent = parent.parent === null ? undefined : index.get(parent.parent);
  }
  return undefined;
};

/**
 * Where a held-back alert about a PRIVATE task is seen: a note on its nearest public ancestor that the default
 * board lists (open). A public task needs nothing (its own PR facts show), and a private task with no such ancestor
 * has nowhere visible to go — journalled only, a declared gap (docs/board.md).
 */
export class AlertSurface {
  constructor(private readonly ports: AlertSurfacePorts) {}

  async surface(id: TaskId, message: string): Promise<void> {
    const { cards: tasks, laneSets } = await this.ports.snapshot();
    const task = tasks.find(entry => entry.id === id);
    if (task === undefined || taskVisibility(task) === 'public') return;
    const ancestor = visibleAncestor(task, new BoardIndex(tasks, this.ports.machineId() ?? ''), laneSets);
    if (ancestor !== undefined)
      await this.ports.note(ancestor.id, `sub-task alert, not typed to the interactive lead: ${message}`);
  }
}
