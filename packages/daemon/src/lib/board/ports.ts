/**
 * What the board needs from the rest of the daemon, as ports. `BoardService` is constructed with one of
 * each; the composition root decides which implementation.
 *
 * Several are SEAMS for later units of the board build (`board-design.md` §6). Each ships with a stub
 * that is honest about what it does not know, and the unit named on it replaces the stub:
 *
 * - {@link LaneSetSource} — U3 (projects and lanes)
 * - {@link LaneProposer} — U3 (lane proposals; U7 calls it for a start in a project with no lanes)
 */
import type {
  AgendaRef,
  BoardActor,
  BoardAttachment,
  BoardChangedEvent,
  BoardProjectId,
  BoardQuarantinedCard,
  BoardReopenAttachments,
  BoardSkip,
  BoardTask,
  BoardTaskActivity,
  BoardTaskId,
  LaneSet,
  TaskKind,
  TaskRef,
} from '@ferretry/protocol';
import type { BoardIndex, LaneSets } from './graph.ts';

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
  /**
   * `false` when there is no such session to focus. Taking a card clears the session's {@link skip}. The card's
   * `title` also becomes the name of a session the daemon titled itself, so an unnamed one is called by its work.
   * `anchor` also makes the card the session's delegation anchor ({@link anchorOf}).
   */
  setFocus(sessionId: string, task: TaskRef, title?: string, options?: { readonly anchor?: boolean }): Promise<boolean>;
  focusOf(sessionId: string): Promise<TaskRef | null>;
  /**
   * The card the session's own delegations go under (`config.focusAnchor`): set only on purpose (`fy task
   * focus`, creating a card, the card a start gave it), never by a plain touch like `focusTask` is.
   */
  anchorOf(sessionId: string): Promise<TaskRef | null>;
  /**
   * Records why the session's work has no card (`fy task skip`, `config.boardSkip`), replacing any earlier one.
   * `false` when there is no such session.
   */
  skip(sessionId: string, skip: BoardSkip): Promise<boolean>;
  /** The standing skip, or `null` when there is none (or the session took a card since). */
  skipOf(sessionId: string): Promise<BoardSkip | null>;
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

/**
 * What the activity deriver judges a board by: every card (a parent's roll-up needs its children), the
 * lanes (staleness is per lane) and the agenda's answer (a blocking ask makes a card `waiting`).
 */
export interface ActivityInputs {
  readonly cards: readonly BoardTask[];
  readonly index: BoardIndex;
  readonly laneSets: LaneSets;
  readonly asks: ReadonlyMap<BoardTaskId, CardAsks>;
}

/** Liveness, from session state (`LivenessActivityDeriver`). */
export interface ActivityDeriver {
  derive(inputs: ActivityInputs): Promise<ReadonlyMap<BoardTaskId, CardActivity>>;
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
  /** The files the owner sent with it, still in `from`'s session; the delivery carries them to whoever is told. */
  readonly attachments?: BoardReopenAttachments;
}

/**
 * The files the owner attached to a move back, as the attachment store holds them in one session. It names
 * each (for the card's history) and refuses — by rejecting — an id the session does not hold.
 */
export interface BoardAttachmentSource {
  describe(sessionId: string, ids: readonly string[]): Promise<readonly BoardAttachment[]>;
}

/**
 * Delivers a reopen to the card's ferret (`board-design.md` §2.9): queued to a live assignee, resuming a
 * stopped one, else the card's owner ferret. U7 implements it. Called after the reopen is committed.
 */
export interface ReopenNotifier {
  reopened(notice: ReopenNotice): Promise<void>;
}

/** A card the owner marked done: the card as it is after the move. */
export interface DoneNotice {
  readonly task: BoardTask;
}

/**
 * Tells each card's ferret the owner marked it done: ONE plain message per ferret, however many of its
 * cards are in `notices` (a bulk close is batched). Called after the close is committed.
 */
export interface DoneNotifier {
  done(notices: readonly DoneNotice[]): Promise<void>;
}

/**
 * Puts lanes on a project that has none (`board-design.md` §5 step 4), so a card a start makes there lands
 * on the project's real board: the template inferred from the project (a repository with `v*` tags →
 * `pr-release-verify`, a repository → `pr`, a folder → `quick`), UNCONFIRMED, proposed as `sessionId`,
 * which raises the one agenda choice for the owner. `null` when it could not.
 */
export interface LaneProposer {
  propose(projectId: BoardProjectId, sessionId: string): Promise<LaneSet | null>;
}

/**
 * Registers the git repository a ferret on the Unfiled board stands in and moves the ferret onto that project's
 * board, proposing its lanes as `proposer` when it has none (U3's `ProjectAdoption`). `null` leaves it Unfiled.
 */
export interface ProjectAdopter {
  adopt(
    sessionId: string,
    proposer?: string,
  ): Promise<{ readonly projectId: BoardProjectId; readonly proposed: boolean } | null>;
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
