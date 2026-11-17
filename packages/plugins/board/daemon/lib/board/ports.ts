/**
 * What the board needs from the rest of the daemon, as ports. `BoardService` is constructed with one of each; the
 * adapters (`daemon/adapters/`) implement them over the kernel ports and the contracts of the subsystems Board needs:
 *
 * - Ferrets (`FerretsApi`): lineage (`FerretParents`), a ferret's liveness (`FerretLivenessSource`), the task a ferret
 *   is on (`FerretFocus`), the board a ferret works on (`LaneSetSource.projectOf`), telling a ferret (`ReopenNotifier`,
 *   `DoneNotifier`, `BoardNudgeSender`).
 * - Asks (`AsksApi`): the `task` source's obligations (`TaskObligations`, in `gate-items.ts`), the open asks that name a
 *   task (`TaskAskLinkSource`), a yes/no the owner answered (`BoardOptIn.answered`), the threads a task may carry out
 *   (`BoardThreads`).
 * - Projects (`ProjectsApi`, optional `uses`): a project's name and folder; absent, only the Unfiled board exists.
 * - Board's own state (`kernel.state`): the tasks (`BoardStore`), the sweep memory, each board's switch and lane set.
 */
import type {
  AskRef,
  BoardAttachment,
  BoardChangedEvent,
  BoardProjectId,
  BoardQuarantinedTask,
  BoardReopenAttachments,
  BoardSkip,
  Task,
  TaskActivity,
  TaskActor,
  TaskId,
  TaskKind,
  TaskRef,
  LaneSet,
} from '../../../contract/index.ts';
import type { BoardIndex, LaneSets } from './graph.ts';

// ---------------------------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------------------------

/** Every task the store could read, and the ones it could not. */
export interface BoardSnapshot {
  readonly cards: readonly Task[];
  /** Task files that did not parse: excluded from every read, never overwritten, always reported. */
  readonly quarantined: readonly BoardQuarantinedTask[];
}

/** What one task write decided: the task to store (`null` stores nothing) and what to hand back. */
export interface BoardWrite<T> {
  readonly task: Task | null;
  readonly result: T;
}

/**
 * The cards: one document per card, written atomically, serialized per task.
 *
 * A quarantined id is refused by {@link write} with `BoardUnavailableError`, so damage is preserved as
 * evidence and never replaced by a task rebuilt from nothing.
 */
export interface BoardStore {
  read(): Promise<BoardSnapshot>;
  /** The next id for a kind from the machine-wide counter. Never reused, even after a damaged counter. */
  allocateId(kind: TaskKind): Promise<TaskId>;
  /** One task's read-decide-write, inside that task's serial section. `current` is undefined for a new id. */
  write<T>(id: TaskId, decide: (current: Task | undefined) => Promise<BoardWrite<T>>): Promise<T>;
}

// ---------------------------------------------------------------------------------------------------
// Projects and lanes (U3)
// ---------------------------------------------------------------------------------------------------

/** Which board a session works on, and each board's lanes. U3 implements it. */
export interface LaneSetSource {
  /** The board a session works on: its `config.projectId`. `UNFILED_PROJECT_ID` when it has none. */
  projectOf(ferret: string): Promise<BoardProjectId>;
  /** A project's current lane set, or `null` while it has none (a create or refile there is refused). */
  laneSet(projectId: BoardProjectId): Promise<LaneSet | null>;
}

// ---------------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------------

/** One step of lineage: the session that started this one (`config.parent`). */
export interface FerretParents {
  parentOf(ferret: string): Promise<string | undefined>;
}

/**
 * The name a ferret is recorded by on a task it acts on, as Ferrets knows it at that moment. Total: a ferret
 * Ferrets does not know reads as its id, so a recorded name is never empty.
 */
export interface FerretNames {
  nameOf(ferret: string): Promise<string>;
}

/**
 * The task a session's activity is attributed to (`config.focusCard`, `board-design.md` §3.3). The board
 * writes it; U5 (activity) and U7 (agenda inference) read it.
 */
export interface FerretFocus {
  /**
   * `false` when there is no such session to focus. Taking a task clears the session's {@link skip}. The task's
   * `title` also becomes the name of a session the daemon titled itself, so an unnamed one is called by its work.
   * `anchor` also makes the task the session's delegation anchor ({@link anchorOf}).
   */
  setFocus(ferret: string, task: TaskRef, title?: string, options?: { readonly anchor?: boolean }): Promise<boolean>;
  focusOf(ferret: string): Promise<TaskRef | null>;
  /** Every ferret's focused task from ONE read of the store (a roster of N ferrets reads it once, not N times). */
  focusOfAll(): Promise<ReadonlyMap<string, TaskRef | null>>;
  /**
   * The task the session's own delegations go under (`config.focusAnchor`): set only on purpose (`fy task
   * focus`, creating a task, the task a start gave it), never by a plain touch like `focusCard` is.
   */
  anchorOf(ferret: string): Promise<TaskRef | null>;
  /**
   * Records why the session's work has no task (`fy card skip`, `config.boardSkip`), replacing any earlier one.
   * `false` when there is no such session.
   */
  skip(ferret: string, skip: BoardSkip): Promise<boolean>;
  /** The standing skip, or `null` when there is none (or the session took a task since). */
  skipOf(ferret: string): Promise<BoardSkip | null>;
}

// ---------------------------------------------------------------------------------------------------
// Derived at read time (U5, U7)
// ---------------------------------------------------------------------------------------------------

/** How a task is doing, as the activity deriver judges it. */
export interface TaskActivityFacts {
  readonly lastTouchedAt: string | null;
  readonly touchedBy: string | null;
  readonly activity: TaskActivity;
}

/**
 * What the activity deriver judges a board by: every task (a parent's roll-up needs its children), the
 * lanes (staleness is per lane) and the agenda's answer (a task whose agenda carries its open ask is never stale).
 */
export interface ActivityInputs {
  readonly cards: readonly Task[];
  readonly index: BoardIndex;
  readonly laneSets: LaneSets;
  readonly asks: ReadonlyMap<TaskId, TaskAsks>;
}

/** Liveness, from session state (`LivenessActivityDeriver`). */
export interface ActivityDeriver {
  derive(inputs: ActivityInputs): Promise<ReadonlyMap<TaskId, TaskActivityFacts>>;
}

/** The open asks that carry a task. */
export interface TaskAsks {
  /** Every open ask that names the task: its gate entry's ask, or an ask that mentions it. */
  readonly open: readonly AskRef[];
  /** The ones asking the task's gate that the owner has yet to answer; always a subset of `open`. */
  readonly asking: readonly AskRef[];
}

/** Asks' link to tasks: which open asks name each task. A task only DERIVES from it; the task holds no copy. */
export interface TaskAskLinkSource {
  /** The open asks on `tasks`: one Asks read, whatever the size of the board. */
  asksFor(tasks: readonly Task[], signal?: AbortSignal): Promise<ReadonlyMap<TaskId, TaskAsks>>;
}

// ---------------------------------------------------------------------------------------------------
// Side effects
// ---------------------------------------------------------------------------------------------------

/** A task the owner (or a ferret on someone else's task) sent back, with the words that sent it. */
export interface ReopenNotice {
  /** The task as it is after the reopen. */
  readonly task: Task;
  readonly from: string;
  readonly to: string;
  readonly reason: string;
  /** Who sent it back; an owner on the host's admin token says so in its `via`. */
  readonly by: TaskActor;
  /** The files the owner sent with it, still in `from`'s session; the delivery carries them to whoever is told. */
  readonly attachments?: BoardReopenAttachments;
}

/**
 * The files the owner attached to a move back, as the attachment store holds them in one session. It names
 * each (for the task's history) and refuses — by rejecting — an id the session does not hold.
 */
export interface BoardAttachmentSource {
  describe(ferret: string, ids: readonly string[]): Promise<readonly BoardAttachment[]>;
}

/**
 * Delivers a reopen to the task's ferret (`board-design.md` §2.9): queued to a live assignee, resuming a
 * stopped one, else the task's owner ferret. U7 implements it. Called after the reopen is committed.
 */
export interface ReopenNotifier {
  reopened(notice: ReopenNotice): Promise<void>;
}

/** A task the owner marked done: the task as it is after the move. */
export interface DoneNotice {
  readonly task: Task;
  /** Who closed it: the owner's app (a paired device), or the host's admin token, which may be a ferret. */
  readonly by: 'owner' | 'admin-token';
}

/**
 * Tells each task's ferret the owner marked it done: ONE plain message per ferret, however many of its
 * tasks are in `notices` (a bulk close is batched). Called after the close is committed.
 */
export interface DoneNotifier {
  done(notices: readonly DoneNotice[]): Promise<void>;
}

/**
 * Puts lanes on a project that has none (`board-design.md` §5 step 4), so a task a start makes there lands
 * on the project's real board: the template inferred from the project (a repository with `v*` tags →
 * `pr-release-verify`, a repository → `pr`, a folder → `quick`), UNCONFIRMED, proposed as `ferret`,
 * which raises the one agenda choice for the owner. `null` when it could not.
 */
export interface LaneProposer {
  propose(projectId: BoardProjectId, ferret: string): Promise<LaneSet | null>;
}

/**
 * Registers the git repository a ferret on the Unfiled board stands in and moves the ferret onto that project's
 * board, proposing its lanes as `proposer` when it has none (U3's `ProjectAdoption`). `null` leaves it Unfiled.
 */
export interface ProjectAdopter {
  adopt(
    ferret: string,
    proposer?: string,
  ): Promise<{ readonly projectId: BoardProjectId; readonly proposed: boolean } | null>;
}

/** Publishes `board.changed` on the fleet feed, journalled on `ferret`'s event log. */
export interface BoardChangeSink {
  changed(ferret: string, event: BoardChangedEvent): Promise<void>;
}

/** Where the board reports what it could not do after a write had already committed. */
export interface BoardDiagnostics {
  warn(message: string): void;
}

export interface BoardClock {
  /** The instant to stamp on what is about to be written. */
  now(): string;
}

/**
 * An ask the owner answered, as the opt-in rule reads it (`opt-in.ts`): who raised it, what it asked, and how it was
 * answered. The adapter builds it from `AsksApi.get` and `AsksApi.answers` on the ferret's own ledger.
 */
export interface AnsweredAsk {
  readonly raisedBy: 'ferret' | 'daemon' | 'owner';
  /** The ferret that raised it, when `raisedBy` is `ferret`. */
  readonly raisedByFerret?: string;
  /** Its subject (and title, when it has one): the question as asked. */
  readonly subject: string;
  readonly title?: string;
  /** The labels of its options; a yes/no asks exactly Yes and No. */
  readonly options: readonly string[];
  /** The answer, when there is one: who gave it and which option it chose. */
  readonly answer?: { readonly by: 'owner' | 'other'; readonly choice?: string };
}

/**
 * What the opt-in rule reads to decide whether a ferret may make a task (`opt-in.ts`, docs/board.md § The board is
 * opt-in): each board's switch, its name, and the caller's own answered asks.
 */
export interface BoardOptIn {
  /** Whether the project's board is switched on. A switch that cannot be read throws; the rule reads that as off. */
  isOn(projectId: BoardProjectId): Promise<boolean>;
  /** The board's name, as a refusal says it. */
  nameOf(projectId: BoardProjectId): Promise<string>;
  /** The answered ask `id` on `ferret`'s own ledger; `undefined` when there is none. */
  answered(ferret: string, id: string): Promise<AnsweredAsk | undefined>;
}

/** What the owner said to a session, for deciding whether a task's ask is theirs. */
export interface OwnerWords {
  /** Best effort by default. Strict reads reject incomplete/unreadable records instead of guessing nobody spoke. */
  said(ferret: string, options?: { readonly strict?: boolean }): Promise<readonly string[]>;
}

/** An open ask on a ferret's own ledger that a task may be made to carry out. */
export interface AskThread {
  readonly raisedBy: 'ferret' | 'daemon' | 'owner';
  readonly raisedByFerret?: string;
  /** A gate ask or a notice carries no task. */
  readonly gate: boolean;
  readonly notice: boolean;
  /** The task it is already linked to, when it is. */
  readonly card: TaskRef | null;
}

/** The asks a task may be made to carry out (`fy task new --thread`): linked to the task, nothing more. */
export interface BoardThreads {
  /** The OPEN ask `id` on `ferret`'s ledger; `undefined` when there is none. A read that fails throws. */
  open(ferret: string, id: string): Promise<AskThread | undefined>;
  /** Links the open ask `id` to `task`, refusing one already linked to another task. */
  link(
    ferret: string,
    id: string,
    task: TaskRef,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;
}
