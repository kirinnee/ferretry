/**
 * START A FERRET ON A TASK, as the owner asks for it from a notice or a task (`docs/board.md`, "Start a ferret on
 * a task").
 *
 * The button starts a NEW ferret, never the task's old one: the owner asked for somebody on the task, and the old
 * ferret may be gone, may have been started for another repository, or may carry a focus the task has since left.
 * Everything the new ferret needs is decided here, from the task, and none of it comes from the client:
 *
 * - **the task** is its focus task and its anchor, and is assigned to it (`FerretCards.open`, the same write
 *   `fy new --task` makes) — the start itself moves the task into its working lane;
 * - **the folder** is the task's own project's folder, resolved from the task as it is NOW, so a task refiled to
 *   another project starts in that project's folder;
 * - **the runtime** is the machine's default (a start that names none);
 * - **the brief** is the task: its ask, summary, premise and context, how to test it, its links and last events.
 *
 * Idempotent and alone per task: the check and the start run as one {@link StartOnCardPorts.exclusive} step, so a
 * retry after a lost response, or a second client, finds the first start's ferret and gets it back instead of
 * starting another. A task a live ferret already holds is never started a second time. A click's own key
 * ({@link StartOnCardPorts.recall}) also answers a retry once that ferret has finished, when no liveness is left to
 * find it by; a new click carries a new key and may start new work.
 *
 * Pure: the task, the lock, the roster and the start arrive through the ports; authority is the caller's.
 */
import {
  type TaskId,
  type TaskResponse,
  type TaskStartResponse,
  type TaskView,
  categoryOf,
  describeTaskEvent,
  formatTaskRef,
  type LaneSet,
  type PrLink,
  writtenProgressParts,
} from '../../../contract/index.ts';
import type { BoardCaller } from './authority.ts';
import { BoardError } from './errors.ts';

/** What a new ferret on a task is started with: all of it the daemon's decision, none of it the client's. */
export interface NewFerretOnTask {
  readonly card: TaskView;
  /** The task's project's folder. */
  readonly folder: string;
  /** What the session is called. */
  readonly name: string;
  /** The brief built from the task. */
  readonly prompt: string;
}

export interface StartOnTaskPorts {
  card(id: TaskId): Promise<TaskResponse>;
  /** The folder the task's project is registered at; `undefined` for a project with none (Unfiled). */
  folderOf(task: TaskView): Promise<string | undefined>;
  /** Every ferret that is alive on this machine, with the task it is working on (`null`: none). */
  live(): Promise<ReadonlyMap<string, TaskId | null>>;
  /** Every ferret whose pane could not be stopped (`kill_failed`): terminal, yet possibly still running, with its task. */
  stuck(): Promise<ReadonlyMap<string, TaskId | null>>;
  /** Runs `work` alone for this task: a second start of the same task waits for the first to finish. */
  exclusive<T>(id: TaskId, work: () => Promise<T>): Promise<T>;
  /** Starts the new ferret, with the task assigned to it. Throws {@link TaskStartRefused}. */
  start(start: NewFerretOnTask): Promise<StartedFerret>;
  /** What an earlier start with this key came to, kept apart from liveness; `undefined` for a key never seen. */
  recall(key: string): TaskStartResponse | undefined;
  /** Keeps what a start came to, under the key its click carried. */
  remember(key: string, result: TaskStartResponse): void;
  /** Stops a ferret whose task was taken from it by a close that raced the start. */
  stop(ferret: string, reason: string): Promise<void>;
  /** The shipped command name, so every command the brief prints exists after a rename. */
  readonly bin: string;
}

/** The ferret a start made: the launch can fail after the session exists, and then `status` is `failed` with its `reason`. */
interface StartedFerret {
  readonly ferret: string;
  readonly status: 'started' | 'failed';
  readonly reason?: string | undefined;
}

/** Why the new ferret would not start: the words are the start's own, for the person to read. */
export class TaskStartRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CardStartRefused';
  }
}

/** What the owner's start came to; `started: false` means a live ferret already holds the task and nothing was started. */
export type TaskStarted = TaskStartResponse;

const GONE = 'This task was closed; reopen it first.';

/** Whether the task was closed or dropped: nothing is started on it. */
function closed(task: TaskView, laneSet: LaneSet | null): boolean {
  if (task.dropped !== null) return true;
  if (laneSet === null) return false;
  const category = categoryOf(laneSet, task.laneId);
  return category.ok && category.value === 'closed';
}

const section = (heading: string, text: string): readonly string[] =>
  text.trim() === '' ? [] : ['', `${heading}:`, text.trim()];

/**
 * The live ferret that holds the task: its assignee; else its owner, unless the task is unclaimed in the backlog
 * (nobody's work yet, so a lead being alive does not hold every task it has not handed out); else any live ferret
 * whose focus it is.
 */
function heldBy(task: TaskView, laneSet: LaneSet | null, live: ReadonlyMap<string, TaskId | null>): string | undefined {
  if (task.assignee !== null) {
    if (live.has(task.assignee)) return task.assignee;
  } else if (live.has(task.owner)) {
    const category = laneSet === null ? undefined : categoryOf(laneSet, task.laneId);
    if (category?.ok !== true || category.value !== 'backlog') return task.owner;
  }
  return [...live].find(([, focus]) => focus === task.id)?.[0];
}

/** The task as the block a continuing ferret reads: what it is, the owner's words, its links and its newest history. */
const FOCUS_HISTORY_LINES = 5;

const laneNameIn = (laneSet: LaneSet | null, id: string): string =>
  laneSet?.lanes.find(lane => lane.id === id)?.name ?? id;

const prLine = (pr: PrLink): string => `PR #${String(pr.number)} ${pr.url} (${pr.draft ? 'draft' : pr.state})`;

const focusTaskBrief = (task: TaskView, laneSet: LaneSet | null): string => {
  const lines = [
    `Your task: ${formatTaskRef(task)} — ${task.title}`,
    `Lane: ${laneNameIn(laneSet, task.laneId)}`,
    '',
    `The ask, verbatim (${task.ask.source}):`,
    task.ask.text,
  ];
  for (const clarification of task.clarifications)
    lines.push('', `Clarified, verbatim (${clarification.source}):`, clarification.text);
  const links = [
    ...task.links.prs.map(prLine),
    ...(task.links.branch === null ? [] : [`branch ${task.links.branch}`]),
    ...task.links.commits.map(commit => `commit ${commit}`),
    ...task.links.docs.map(doc => `doc ${doc}`),
  ];
  if (links.length > 0) lines.push('', 'Links:', ...links.map(link => `- ${link}`));
  lines.push(
    '',
    'Last on the task:',
    ...task.history.slice(-FOCUS_HISTORY_LINES).map(
      event =>
        `- ${event.at}  ${describeTaskEvent(
          event,
          id => laneNameIn(laneSet, id),
          id => id,
        )}`,
    ),
  );
  return lines.join('\n');
};

/** The first turn of the new ferret: who asked, the task's own words, then the task as a continuing ferret reads it. */
export function startOnTaskBrief(task: TaskView, laneSet: LaneSet | null, bin: string): string {
  const ref = formatTaskRef(task);
  return [
    `The owner asked you to take over task ${ref}. Its last ferret has finished, so nobody else is working on it. Read what is already done, then carry on from there.`,
    ...section('Summary', task.summary),
    ...section(
      'Progress',
      writtenProgressParts(task.progress)
        .map(part => `${part.label}:\n${part.text.trim()}`)
        .join('\n\n'),
    ),
    ...section('Why it exists', task.premise),
    ...section('Context', task.context),
    ...section('How to test', task.howToTest),
    '',
    focusTaskBrief(task, laneSet),
    '',
    `The daemon assigned ${ref} to you and moved it into its working lane; \`${bin} task note\` adds progress.`,
  ].join('\n');
}

export async function startOnTask(
  ports: StartOnTaskPorts,
  id: TaskId,
  caller: BoardCaller,
  key?: string,
): Promise<TaskStarted> {
  if (caller.kind !== 'owner') {
    throw new BoardError('forbidden', 'only the owner may start a ferret on a task from here', ['owner-human']);
  }
  const kept = key === undefined ? undefined : `${id}:${key}`;
  return await ports.exclusive(id, async () => {
    const remembered = kept === undefined ? undefined : ports.recall(kept);
    if (remembered !== undefined) return remembered;
    const { card: task, laneSet } = await ports.card(id);
    const ref = formatTaskRef(task);
    if (closed(task, laneSet)) throw new BoardError('invalid', GONE);
    const holder = heldBy(task, laneSet, await ports.live());
    if (holder !== undefined) {
      const held = { card: task.id, ferret: holder, started: false };
      if (kept !== undefined) ports.remember(kept, held);
      return held;
    }
    // A pane that would not stop is terminal to the roster but may still be working: it holds the task, so a start
    // beside it is refused until the owner has stopped it.
    const stuck = [...(await ports.stuck())].some(([ferret, focus]) => task.assignee === ferret || focus === task.id);
    if (stuck) throw new BoardError('invalid', `A ferret on ${ref} could not be stopped; stop it first.`);
    const folder = await ports.folderOf(task);
    if (folder === undefined) {
      throw new BoardError(
        'invalid',
        `${ref} is not filed under a project folder on this machine, so there is nowhere to start a ferret on it. File it under a project first.`,
      );
    }
    let launched: StartedFerret;
    try {
      launched = await ports.start({
        card: task,
        folder,
        name: task.title,
        prompt: startOnTaskBrief(task, laneSet, ports.bin),
      });
    } catch (error) {
      if (error instanceof TaskStartRefused)
        throw new BoardError('invalid', `No ferret was started on ${ref}: ${error.message}`);
      throw error;
    }
    const { ferret } = launched;
    // The launch failed once the session existed: say why, and start nothing. A failed record is not proof that
    // nothing runs (the lifecycle can fail AFTER it typed the first turn, and leaves the pane up), and a failed
    // session is not live, so a retry would start a second ferret beside it: the pane is stopped first, and only a
    // stopped one lets the start be called failed. The task stays as the start left it, assigned to a ferret that
    // is not running, so the Warden names it again.
    if (launched.status === 'failed') {
      const why = launched.reason ?? 'it did not launch';
      try {
        await ports.stop(ferret, `${ref}: the ferret failed to launch`);
      } catch (error) {
        const stuck = error instanceof Error ? error.message : String(error);
        throw new BoardError(
          'invalid',
          `No ferret was started on ${ref}: ${why}. It could not be stopped (${stuck}), so check it before starting another.`,
        );
      }
      throw new BoardError('invalid', `No ferret was started on ${ref}: ${why}`);
    }
    // A close that raced the start wins, wherever in the start it landed: before the assignment it refuses the task,
    // after it the drop or the move to a closed lane leaves the assignee in place, so the task is read again whole.
    const after = await ports.card(id);
    if (after.card.assignee !== ferret || closed(after.card, after.laneSet)) {
      await ports.stop(ferret, `${ref} was closed while the ferret started on it`);
      throw new BoardError('invalid', GONE);
    }
    const result = { card: task.id, ferret, started: true };
    if (kept !== undefined) ports.remember(kept, result);
    return result;
  });
}
