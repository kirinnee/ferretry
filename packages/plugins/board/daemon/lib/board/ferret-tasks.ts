/**
 * A SESSION STARTED WITH A BRIEF GETS A TASK (`board-design.md` §3.1 items 1–2), made by the daemon with
 * the session, so nobody has to remember to.
 *
 * - **`fy start` and the app's New session**: the session owns its own task. Title from `--name`, brief and
 *   ask the prompt verbatim — the ask's source is the starting ferret (`session:<parent>`) or the owner —
 *   in the first backlog lane, and the session's focus.
 * - **`fy new`** (Pack): the task is the LEAD's delegation. Owner the lead, assignee the child, on the board
 *   the child inherits. Its parent comes from the lead's INTENT, never from the task it touched last: the
 *   task the brief names (`&F138`), else the lead's explicit focus card (`config.focusAnchor`), else none —
 *   a top-level task, said in the start's output. `--task <id>` names an EXISTING task instead: it is
 *   assigned to the child, and so is the lead's own open task with the same title, so a delegation never
 *   leaves a twin. The task's id is reserved BEFORE the start, because the child's brief names it.
 *
 * **Only where the board is on** (`board-switch.ts`): the board is opt-in. On a board that is off a start makes
 * no task, and a `fy new` makes one only when the lead holds a task to put it under (the brief names one, or
 * the lead's focus) or hands one over (`--task`): a lead may always give its helpers tasks.
 *
 * The task is written after the session's record and before its agent launches, so the agent's first turn
 * already has its focus task, and a start refused earlier leaves no task behind. **A board failure never
 * fails a start**: the session starts, and what could not be done is said (`notes`) instead.
 *
 * A project with no lanes yet gets the inferred template PROPOSED (unconfirmed, one agenda choice for the
 * owner) and the task lands on its real board; only when proposing fails does it go on the Unfiled board,
 * with a note saying how to move it.
 */
import { taskTitleFor, deriveTaskTitle } from './task-title.ts';
import {
  type BoardProjectId,
  type Task,
  type TaskCreateRequest,
  type TaskId,
  firstTaskRefIn,
  formatTaskRef,
  MAX_TASK_BRIEF_LENGTH,
  type TaskMessage,
  type TaskRef,
  UNFILED_PROJECT_ID,
} from '../../../contract/index.ts';
import type { BoardSwitchReader } from '../lanes/board-switch.ts';
import { effectiveAssignee } from './authority.ts';
import { BoardError } from './errors.ts';
import { taskCategory } from './graph.ts';
import type { BoardDiagnostics, LaneProposer, LaneSetSource, ProjectAdopter, FerretFocus } from './ports.ts';
import type { BoardService, TaskHolders, SignalDoneOutcome } from './service.ts';
import { clip } from './signal-done.ts';

/** The longest ask a task keeps; a longer brief is cut, and the brief field says so. */
const MAX_ASK_LENGTH = MAX_TASK_BRIEF_LENGTH;

/** The source an ask carries when the owner said it. */
const OWNER_ASK_SOURCE = 'owner';

/** The source an ask carries when a `fy new` made the task for a ferret no lead was recorded for: the work of a ferret, never the owner's ask. */
const PACK_ASK_SOURCE = 'fy new';

/** The source an ask carries when a ferret's brief said it. */
const ferretAskSource = (ferret: string): string => `session:${ferret}`;

/** The board's name as the owner reads it. */
interface BoardProjectNames {
  nameOf(projectId: BoardProjectId): Promise<string>;
}

export interface FerretTasksPorts {
  readonly board: Pick<
    BoardService,
    | 'reserve'
    | 'spawn'
    | 'signalDone'
    | 'snapshot'
    | 'requireHandOver'
    | 'handOver'
    | 'assignForOwner'
    | 'trigger'
    | 'mayAdoptUnder'
  >;
  readonly lanes: LaneSetSource;
  /** The board a session about to start in a folder will work on, for a `fy new --cwd` (`FerretProjects`). */
  readonly starts: {
    projectForStart(start: { readonly cwd: string; readonly parent?: string }): Promise<BoardProjectId>;
  };
  /** Whether a board is on: a start on a board that is off makes no task of its own. */
  readonly switches: BoardSwitchReader;
  readonly proposer: LaneProposer;
  /** Registers the repository of a session on the Unfiled board, so its task goes on that project's board. */
  readonly adoption?: ProjectAdopter;
  readonly projects: BoardProjectNames;
  readonly focus: Pick<FerretFocus, 'anchorOf'>;
  readonly diagnostics: BoardDiagnostics;
  /** The shipped command name, so every command a note prints exists after a rename. */
  readonly bin: string;
}

/** Where a delegated task's parent came from: the brief that names it, or the lead's explicit focus task. */
export type ParentFrom = 'brief' | 'focus';

/** A `fy new`'s task, decided before the child exists so its brief can name it. */
export interface Delegation {
  readonly lead: string;
  /** The helper's brief as the lead wrote it, without the footer the daemon adds. */
  readonly brief: string;
  /** The child's task id: reserved for a new task, the lead's own for an existing one. */
  readonly id: TaskId;
  /** The task already exists (`--task`, or the lead's open task with this title): it is assigned, not made. */
  readonly existing: boolean;
  /** The task the child's task sits under; `null` for a top-level task. */
  readonly parent: TaskRef | null;
  /** Why it sits there; absent for a top-level task and for an existing task, which keeps the parent it had. */
  readonly parentFrom?: ParentFrom;
  /** The board's name as the owner reads it; `undefined` when the child may run on another board. */
  readonly project?: string;
  /** The OWNER started the ferret on this existing task (`ownerDelegation`): no lead hands it down, the owner assigns it. */
  readonly byOwner?: true;
  /** Who held the existing task when the start judged it: the assignment writes only if it still finds them (`TaskHolders`). */
  readonly held?: TaskHolders;
}

/** Who holds a task now, as a start must still find them when it assigns it. */
const holdersOf = (task: Pick<Task, 'owner' | 'assignee'>): TaskHolders => ({
  owner: task.owner,
  assignee: task.assignee,
});

/** What delegating a task came to: the delegation, or why the start must not go on. */
export interface DelegationOutcome {
  readonly delegation?: Delegation;
  /** Set when `--task` named a task the lead may not hand over: the start is refused with this. */
  readonly refusal?: string;
  readonly notes: readonly string[];
}

/** What a `fy new` hands the board to decide its task from. */
export interface DelegationRequest {
  readonly brief: string;
  /** The name the child session is given, which titles a new task. */
  readonly name?: string | undefined;
  /** An existing task the child works on (`--task`). */
  readonly card?: TaskId | undefined;
}

/** A task's title as compared for twins: case, spacing and punctuation do not tell two titles apart. */
const normalisedTitle = (title: string): string =>
  title
    .normalize('NFKC')
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** What a start is about to launch. */
export interface StartedFerret {
  readonly ferret: string;
  readonly name?: string | undefined;
  /** The brief as given; a `fy new`'s is its delegation's. */
  readonly brief: string;
  /** The starting ferret (`config.parent`); absent when the owner started it. */
  readonly parent?: string | undefined;
  /** Set for a `fy new`: the task the lead's delegation reserved. */
  readonly delegation?: Delegation | undefined;
  /** The start came through `fy new`: with no lead recorded, its task is still a ferret's errand, never the owner's ask. */
  readonly viaPack?: true | undefined;
}

/** The task a start made, or why it made none. */
export interface OpenedTask {
  readonly card?: Task;
  /** The board's name as the owner reads it. */
  readonly project?: string;
  readonly notes: readonly string[];
}

/** A task's title: the session's name, else the brief's own, never its raw first words. */
export const taskTitle = (name: string | undefined, brief: string): string =>
  (name === undefined ? null : deriveTaskTitle(name)) ?? taskTitleFor(brief, 'Task');

/** A brief as a task's ask: verbatim, cut only at the field's limit. */
export const askOf = (text: string, source: string): TaskMessage => ({ text: clip(text, MAX_ASK_LENGTH), source });

/**
 * The delegation of a start the owner made on an existing task ("Start a ferret on it"): it is assigned to the new
 * ferret as the owner's act, and the task keeps its owner and its parent.
 */
export const ownerDelegation = (task: Pick<Task, 'id' | 'owner' | 'assignee' | 'parent'>): Delegation => ({
  lead: task.owner,
  brief: '',
  id: task.id,
  existing: true,
  parent: task.parent,
  byOwner: true,
  held: holdersOf(task),
});

/** The line a helper's brief gains (`subFerretFooter`): its task and where it is. */
export const taskFooterLine = (
  id: TaskId,
  project: string | undefined,
  bin: string,
  parent: TaskRef | null = null,
): string =>
  `Your task is ${formatTaskRef({ id })} on the ${project === undefined ? "project's" : project} board${parent === null ? '' : `, under ${formatTaskRef(parent)}`}; the daemon moves it for you (\`${bin} task note\` adds progress).`;

/** A task request the daemon fills for a start. */
const startRequest = (fields: {
  readonly title: string;
  readonly brief: string;
  readonly ask: TaskMessage;
  readonly parent: TaskRef | null;
  readonly assignee: string | null;
}): TaskCreateRequest => ({
  kind: 'feature',
  title: fields.title,
  summary: '',
  ask: fields.ask,
  premise: '',
  context: '',
  terms: [],
  brief: clip(fields.brief, MAX_TASK_BRIEF_LENGTH),
  howToTest: '',
  workflow: 'quick',
  parent: fields.parent,
  assignee: fields.assignee,
  dependsOn: [],
  files: [],
  docs: [],
});

const said = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class FerretTasks {
  constructor(private readonly ports: FerretTasksPorts) {}

  /**
   * A `fy new`'s task, before the child starts, and the child's id reserved (or the existing task named).
   * Its parent comes from intent: the task the brief names, else the lead's explicit focus task, else none.
   * `inLeadFolder` says the child runs where the lead does, so it inherits the lead's board and the footer can
   * name it; otherwise `cwd` is the folder it runs in. No delegation when the board can do nothing (the child then
   * starts with no task, and `notes` is what to say) or when `--task` named a task that cannot be handed over
   * (`refusal`). The board is opt-in, and asked of the board the CHILD will work on: a task is made there only when
   * it is on, or under a parent the lead holds on that same board (docs/board.md § The board is opt-in).
   */
  async delegate(
    lead: string,
    request: DelegationRequest,
    inLeadFolder: boolean,
    cwd?: string,
  ): Promise<DelegationOutcome> {
    try {
      if (request.card !== undefined) return await this.existingCard(lead, request.card);
      const title = taskTitle(request.name, request.brief);
      const projectId = inLeadFolder ? await this.ports.lanes.projectOf(lead) : undefined;
      const project = projectId === undefined ? undefined : await this.ports.projects.nameOf(projectId);
      const twin = projectId === undefined ? undefined : await this.twinOf(lead, projectId, title);
      if (twin !== undefined) {
        return {
          delegation: {
            lead,
            brief: request.brief,
            id: twin.id,
            existing: true,
            parent: twin.parent,
            held: holdersOf(twin),
            ...(project === undefined ? {} : { project }),
          },
          notes: [
            `You already had ${formatTaskRef(twin)} ("${twin.title}") for this work, so it was assigned to the helper instead of making a second task.`,
          ],
        };
      }
      const { parent, from } = await this.parentFor(lead, request.brief);
      const childBoard =
        projectId ??
        (cwd === undefined
          ? await this.ports.lanes.projectOf(lead)
          : await this.ports.starts.projectForStart({ cwd, parent: lead }));
      if (!(await this.licensed(childBoard, parent))) {
        const name = project ?? (await this.ports.projects.nameOf(childBoard));
        return {
          notes: [
            `No task was made for the helper: the ${name} board is off and you hold no task for this work. \`${this.ports.bin} new --task <id>\` hands it one.`,
          ],
        };
      }
      const id = await this.ports.board.reserve('feature');
      const notes =
        parent === null
          ? [
              `The helper's task has no parent, so it is at the top level of the board: \`${this.ports.bin} task reparent ${formatTaskRef({ id })} --parent <id>\` moves it, and \`${this.ports.bin} task focus <id>\` (or \`--task <id>\`) says where your helpers' tasks go next time.`,
            ]
          : [];
      return {
        delegation: {
          lead,
          brief: request.brief,
          id,
          existing: false,
          parent,
          ...(from === undefined ? {} : { parentFrom: from }),
          ...(project === undefined ? {} : { project }),
        },
        notes,
      };
    } catch (error) {
      const note = `No task was made for the helper: ${said(error)}`;
      this.ports.diagnostics.warn(note);
      return { notes: [note] };
    }
  }

  /**
   * `fy start --task <id>`, before the session exists: the existing task the new session takes over, judged with the
   * same authority as `fy new --task`. A ferret's start (`lead`) hands over only a task it may hand down; the owner's
   * (no lead) needs the task to exist. Either way the task must still be open work: a dropped or closed task is refused
   * here, before anything is written, and so is a start that is not an ordinary ferret (a miner, a guide builder or a
   * warden takes no task). `refusal` says why a task cannot be had; the start must not go on. The judgement is early,
   * not final: {@link takeOver} re-judges inside the write that assigns the task.
   */
  async startOn(lead: string | undefined, id: TaskId, ordinary = true): Promise<DelegationOutcome> {
    if (!ordinary) {
      return {
        refusal: `--task is for an ordinary ferret: a worker the daemon starts for itself takes no task`,
        notes: [],
      };
    }
    try {
      const outcome = lead === undefined ? await this.ownerStart(id) : await this.existingCard(lead, id);
      if (outcome.delegation === undefined) return outcome;
      const unavailable = await this.unavailable(id);
      return unavailable === undefined ? outcome : { refusal: unavailable, notes: [] };
    } catch (error) {
      return { refusal: `the board could not be read: ${said(error)}`, notes: [] };
    }
  }

  /**
   * `fy start --task`, once the session's record exists and before its agent launches: the task is assigned to it, or
   * the start is refused and `stop` takes the record down, so a session never runs on a task it was not given. The
   * assignment is one write that re-judges the task (dropped, closed, still the lead's to hand down), so a drop or a
   * reassignment between {@link startOn} and here loses the race cleanly: nothing is assigned and nothing launches.
   */
  async takeOver(
    delegation: Delegation,
    ferret: string,
    stop: (reason: string) => Promise<void>,
  ): Promise<{ readonly opened?: OpenedTask; readonly refusal?: string }> {
    try {
      return { opened: await this.handOver(delegation, ferret) };
    } catch (error) {
      const refusal = `${formatTaskRef({ id: delegation.id })} could not be handed to the new session: ${said(error)}`;
      await stop(refusal).catch((stopped: unknown) => {
        this.ports.diagnostics.warn(`could not stop ${ferret} after a refused task: ${said(stopped)}`);
      });
      return { refusal };
    }
  }

  private async ownerStart(id: TaskId): Promise<DelegationOutcome> {
    const { cards: tasks } = await this.ports.board.snapshot();
    const task = tasks.find(each => each.id === id);
    if (task === undefined) return { refusal: `there is no task ${formatTaskRef({ id })} on this machine`, notes: [] };
    return { delegation: ownerDelegation(task), notes: [] };
  }

  /** Why a task cannot take a new session: it is dropped or closed. `undefined` when it is open work. */
  private async unavailable(id: TaskId): Promise<string | undefined> {
    const { cards: tasks, laneSets } = await this.ports.board.snapshot();
    const task = tasks.find(each => each.id === id);
    if (task === undefined) return `there is no task ${formatTaskRef({ id })} on this machine`;
    if (task.dropped !== null) return `${formatTaskRef(task)} is dropped; reopen it before you start a ferret on it`;
    if (taskCategory(task, laneSets) === 'closed')
      return `${formatTaskRef(task)} is closed; reopen it before you start a ferret on it`;
    return undefined;
  }

  /** `--task`: the lead's existing task, handed over; refused (not failed) when it cannot be. */
  private async existingCard(lead: string, id: TaskId): Promise<DelegationOutcome> {
    let task: Task;
    try {
      task = await this.ports.board.requireHandOver(id, lead);
    } catch (error) {
      if (error instanceof BoardError) return { refusal: error.message, notes: [] };
      throw error;
    }
    const project = await this.ports.projects.nameOf(task.projectId);
    return {
      delegation: { lead, brief: '', id, existing: true, parent: task.parent, project, held: holdersOf(task) },
      notes: [],
    };
  }

  /**
   * The parent a NEW task goes under, from the lead's intent in priority order: the first task the brief
   * names, then the lead's explicit focus task. Neither is the task the lead merely touched last. Either counts
   * only when the lead may put a child under it and it is still work (`BoardService.mayAdoptUnder`): a brief that
   * merely mentions somebody else's task, or a closed one, gives no parent, so the board's switch decides.
   */
  private async parentFor(
    lead: string,
    brief: string,
  ): Promise<{ readonly parent: TaskRef | null; readonly from?: ParentFrom }> {
    const named = firstTaskRefIn(brief);
    const usable = async (ref: TaskRef | null | undefined): Promise<TaskRef | null> => {
      if (ref === null || ref === undefined) return null;
      return (await this.ports.board.mayAdoptUnder(lead, ref.id)) ? { id: ref.id } : null;
    };
    const fromBrief = await usable(named);
    if (fromBrief !== null) return { parent: fromBrief, from: 'brief' };
    const anchored = await usable(await this.ports.focus.anchorOf(lead));
    return anchored === null ? { parent: null } : { parent: anchored, from: 'focus' };
  }

  /**
   * The lead's own open task for this very work — same board, same title once case and punctuation are set
   * aside, still the lead's to give (nobody else is on it) — so a delegation reuses it rather than twinning it.
   */
  private async twinOf(lead: string, projectId: BoardProjectId, title: string): Promise<Task | undefined> {
    const { cards: tasks, laneSets } = await this.ports.board.snapshot();
    const wanted = normalisedTitle(title);
    return tasks.find(task => {
      if (task.owner !== lead || task.projectId !== projectId || task.dropped !== null) return false;
      if (effectiveAssignee(task) !== lead || normalisedTitle(task.title) !== wanted) return false;
      const category = taskCategory(task, laneSets);
      return category === 'backlog' || category === 'active' || category === 'review';
    });
  }

  /**
   * The task of a session being started, after its record and before its launch. Never rejects: a board
   * failure is a note, and the start goes on.
   */
  async open(start: StartedFerret): Promise<OpenedTask> {
    try {
      const delegation = start.delegation;
      const owner = delegation?.lead ?? start.ferret;
      const from = delegation?.lead ?? start.parent;
      const brief = delegation?.brief ?? start.brief;
      if (delegation?.existing === true) return await this.handOver(delegation, start.ferret);
      // A start with no delegation makes its own task only where the board is on.
      if (delegation === undefined && !(await this.ports.switches.isOn(await this.ports.lanes.projectOf(start.ferret))))
        return { notes: [] };
      const placed = await this.place(start.ferret, owner);
      // The board the child landed on is the one asked: a guess at start time that came out otherwise makes no task.
      if (delegation !== undefined && !(await this.licensed(placed.projectId, delegation.parent))) {
        return {
          notes: [
            `No task was made for the helper: the ${placed.project} board is off and you hold no task on it for this work.`,
          ],
        };
      }
      const id = delegation?.id ?? (await this.ports.board.reserve('feature'));
      const task = await this.ports.board.spawn(
        id,
        startRequest({
          title: taskTitle(start.name, brief),
          brief,
          ask: askOf(
            brief,
            from !== undefined ? ferretAskSource(from) : start.viaPack === true ? PACK_ASK_SOURCE : OWNER_ASK_SOURCE,
          ),
          parent: delegation?.parent ?? null,
          assignee: delegation === undefined ? null : start.ferret,
        }),
        { owner, by: owner, focus: start.ferret, projectId: placed.projectId },
      );
      if (delegation?.project !== undefined && delegation.project !== placed.project) {
        placed.notes.push(
          `The brief said ${formatTaskRef(task)} is on the ${delegation.project} board; it is on the ${placed.project} board, where the helper runs.`,
        );
      }
      for (const note of placed.notes) this.ports.diagnostics.warn(`${formatTaskRef(task)}: ${note}`);
      return { card: await this.workStarted(task, start.ferret), project: placed.project, notes: placed.notes };
    } catch (error) {
      const note = `No task was made for ${start.ferret}: ${said(error)}`;
      this.ports.diagnostics.warn(note);
      return { notes: [note] };
    }
  }

  /** Whether a lead's new task may go on `projectId`: its board is on, or the parent (already judged) is on it. */
  private async licensed(projectId: BoardProjectId, parent: TaskRef | null): Promise<boolean> {
    if (await this.ports.switches.isOn(projectId)) return true;
    if (parent === null) return false;
    const { cards: tasks } = await this.ports.board.snapshot();
    return tasks.find(task => task.id === parent.id)?.projectId === projectId;
  }

  /** The existing task, assigned to the session just started (by the lead, or by the owner); it keeps its owner and its parent. */
  private async handOver(delegation: Delegation, ferret: string): Promise<OpenedTask> {
    const held = delegation.held;
    if (held === undefined)
      throw new Error(`${formatTaskRef({ id: delegation.id })} was not judged before it was handed over`);
    const task =
      delegation.byOwner === true
        ? await this.ports.board.assignForOwner(delegation.id, ferret, held)
        : await this.ports.board.handOver(delegation.id, delegation.lead, ferret, held);
    // The task is assigned: nothing after this may undo the start, so the board's name is best effort.
    const project = await this.ports.projects.nameOf(task.projectId).catch((error: unknown) => {
      this.ports.diagnostics.warn(`could not name the board of ${formatTaskRef(task)}: ${said(error)}`);
      return undefined;
    });
    return {
      card: await this.workStarted(task, ferret),
      ...(project === undefined ? {} : { project }),
      notes: [],
    };
  }

  /**
   * A start IS the work starting (`work.started`), so the task enters the lane that trigger names for its
   * workflow (In progress, or Plan/Design for a plan-first card), whoever may move tasks: a helper cannot,
   * and a task left in the backlog while it is built tells the owner nothing. Best effort, like the task.
   */
  private async workStarted(task: Task, ferret: string): Promise<Task> {
    try {
      const moved = await this.ports.board.trigger(task.id, 'work.started', {
        ferret,
        reason: 'the session started on it',
      });
      return moved === null ? task : moved.card;
    } catch (error) {
      this.ports.diagnostics.warn(`could not move ${formatTaskRef(task)} to its working lane: ${said(error)}`);
      return task;
    }
  }

  /**
   * `fy signal done` on the board: the note and the move ({@link BoardService.signalDone}). Nothing is
   * typed into the lead's chat: the done message reaches it through `fy wait`, in the ferret's own words,
   * and the board shows the move. Never rejects: the signal is already recorded.
   */
  async signalled(ferret: string, message: string | undefined): Promise<SignalDoneOutcome | null> {
    let outcome: SignalDoneOutcome | null;
    try {
      outcome = await this.ports.board.signalDone(ferret, message);
    } catch (error) {
      this.ports.diagnostics.warn(`could not record ${ferret}'s done on its task: ${said(error)}`);
      return null;
    }
    return outcome;
  }

  /** The repository's board for a session on the Unfiled board; `null` when it stays where it is. */
  private async adopt(
    ferret: string,
    proposer: string,
  ): Promise<{ readonly projectId: BoardProjectId; readonly proposed: boolean } | null> {
    const adoption = this.ports.adoption;
    if (adoption === undefined) return null;
    if ((await this.ports.lanes.projectOf(ferret)) !== UNFILED_PROJECT_ID) return null;
    return await adoption.adopt(ferret, proposer).catch((error: unknown) => {
      this.ports.diagnostics.warn(`could not register the repository of ${ferret}: ${said(error)}`);
      return null;
    });
  }

  /**
   * The board a session's task goes on: its project's, with lanes proposed when the project has none, else
   * the Unfiled board with a note that says how to move it.
   */
  private async place(
    ferret: string,
    proposer: string,
  ): Promise<{ readonly projectId: BoardProjectId; readonly project: string; notes: string[] }> {
    const adopted = await this.adopt(ferret, proposer);
    if (adopted !== null) {
      const project = await this.ports.projects.nameOf(adopted.projectId);
      return {
        projectId: adopted.projectId,
        project,
        notes: [
          `${project} was registered as a project, so the task is on its board${adopted.proposed ? '; its lanes were proposed for the owner to confirm (an ask)' : ''}.`,
        ],
      };
    }
    const projectId = await this.ports.lanes.projectOf(ferret);
    const project = await this.ports.projects.nameOf(projectId);
    if ((await this.ports.lanes.laneSet(projectId)) !== null) return { projectId, project, notes: [] };
    const proposed = await this.ports.proposer.propose(projectId, proposer).catch((error: unknown) => {
      this.ports.diagnostics.warn(`could not propose lanes for ${project}: ${said(error)}`);
      return null;
    });
    if (proposed !== null) {
      return {
        projectId,
        project,
        notes: [`${project} had no lanes, so they were proposed for the owner to confirm (an ask).`],
      };
    }
    const unfiled = await this.ports.projects.nameOf(UNFILED_PROJECT_ID);
    return {
      projectId: UNFILED_PROJECT_ID,
      project: unfiled,
      notes: [
        `${project} has no lanes yet, so the task is on the ${unfiled} board: propose them with \`${this.ports.bin} board lanes propose --template <template>\`, then refile the task to ${project}.`,
      ],
    };
  }
}
