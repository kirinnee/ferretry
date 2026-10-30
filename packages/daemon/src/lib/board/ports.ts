/**
 * What the board needs from the rest of the daemon, as ports. `BoardService` is constructed with one of
 * each; the composition root decides which implementation.
 *
 * Several are SEAMS for later units of the board build (`board-design.md` §6). Each ships with a stub
 * that is honest about what it does not know, and the unit named on it replaces the stub:
 *
 * - {@link LaneSetSource} — U3 (projects and lanes)
 * - {@link ActivityDeriver} — U5 (activity and staleness)
 * - {@link ReopenNotifier} and {@link AgendaLinkSource} — U7 (spawn, signal and agenda links)
 */
import type {
  AgendaRef,
  BoardActor,
  BoardChangedEvent,
  BoardProjectId,
  BoardQuarantinedCard,
  BoardTask,
  BoardTaskActivity,
  BoardTaskId,
  LaneSet,
  TaskKind,
  TaskRef,
} from '@ferretry/protocol';

// ---------------------------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------------------------

/** Every card the store could read, and the ones it could not. */
export interface BoardSnapshot {
  readonly cards: readonly BoardTask[];
  /** Card files that did not parse: excluded from every read, never overwritten, always reported. */
  readonly quarantined: readonly BoardQuarantinedCard[];
}

/** What one card write decided: the card to store (`null` stores nothing) and what to hand back. */
export interface BoardWrite<T> {
  readonly task: BoardTask | null;
  readonly result: T;
}

/**
 * The cards: one document per card, written atomically, serialized per card.
 *
 * A quarantined id is refused by {@link write} with `BoardUnavailableError`, so damage is preserved as
 * evidence and never replaced by a card rebuilt from nothing.
 */
export interface BoardStore {
  read(): Promise<BoardSnapshot>;
  /** The next id for a kind from the machine-wide counter. Never reused, even after a damaged counter. */
  allocateId(kind: TaskKind): Promise<BoardTaskId>;
  /** One card's read-decide-write, inside that card's serial section. `current` is undefined for a new id. */
  write<T>(id: BoardTaskId, decide: (current: BoardTask | undefined) => Promise<BoardWrite<T>>): Promise<T>;
}

// ---------------------------------------------------------------------------------------------------
// Projects and lanes (U3)
// ---------------------------------------------------------------------------------------------------

/** Which board a session works on, and each board's lanes. U3 implements it. */
export interface LaneSetSource {
  /** The board a session works on: its `config.projectId`. `UNFILED_PROJECT_ID` when it has none. */
  projectOf(sessionId: string): Promise<BoardProjectId>;
  /** A project's current lane set, or `null` while it has none (a create or refile there is refused). */
  laneSet(projectId: BoardProjectId): Promise<LaneSet | null>;
}

// ---------------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------------

/** One step of lineage: the session that started this one (`config.parent`). */
export interface SessionParents {
  parentOf(sessionId: string): Promise<string | undefined>;
}

/**
 * The card a session's activity is attributed to (`config.focusTask`, `board-design.md` §3.3). The board
 * writes it; U5 (activity) and U7 (agenda inference) read it.
 */
export interface SessionFocus {
  /** `false` when there is no such session to focus. */
  setFocus(sessionId: string, task: TaskRef): Promise<boolean>;
  focusOf(sessionId: string): Promise<TaskRef | null>;
}

// ---------------------------------------------------------------------------------------------------
// Derived at read time (U5, U7)
// ---------------------------------------------------------------------------------------------------

/** How a card is doing, as the activity deriver judges it. */
export interface CardActivity {
  readonly lastTouchedAt: string | null;
  readonly touchedBy: string | null;
  readonly activity: BoardTaskActivity;
}

/** Liveness, from session state. U5 implements it; until then a stub reads only the card's own history. */
export interface ActivityDeriver {
  derive(cards: readonly BoardTask[]): Promise<ReadonlyMap<BoardTaskId, CardActivity>>;
}

/** The agenda items raised against a card. */
export interface CardAsks {
  /** Every open item. */
  readonly open: readonly AgendaRef[];
  /** The open items blocking the work now; always a subset of `open`. */
  readonly blocking: readonly AgendaRef[];
}

/** The agenda store's link to cards. U7 implements it; until then no card has asks. */
export interface AgendaLinkSource {
  asksFor(cards: readonly BoardTask[]): Promise<ReadonlyMap<BoardTaskId, CardAsks>>;
}

// ---------------------------------------------------------------------------------------------------
// Side effects
// ---------------------------------------------------------------------------------------------------

/** A card the owner (or a ferret on someone else's card) sent back, with the words that sent it. */
export interface ReopenNotice {
  /** The card as it is after the reopen. */
  readonly task: BoardTask;
  readonly from: string;
  readonly to: string;
  readonly reason: string;
  readonly by: BoardActor;
}

/**
 * Delivers a reopen to the card's ferret (`board-design.md` §2.9): queued to a live assignee, resuming a
 * stopped one, else the card's owner ferret. U7 implements it. Called after the reopen is committed.
 */
export interface ReopenNotifier {
  reopened(notice: ReopenNotice): Promise<void>;
}

/** Publishes `board.changed` on the fleet feed, journalled on `sessionId`'s event log. */
export interface BoardChangeSink {
  changed(sessionId: string, event: BoardChangedEvent): Promise<void>;
}

/** Where the board reports what it could not do after a write had already committed. */
export interface BoardDiagnostics {
  warn(message: string): void;
}

export interface BoardClock {
  /** The instant to stamp on what is about to be written. */
  now(): string;
}
