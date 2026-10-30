import type { BoardImportSummary, BoardProjectId, LaneSet, TaskRef } from '@ferretry/protocol';
import type { TaskEntry, TaskParseIssue } from '../tasks/task-snapshot.ts';

/** One session's old task file, as far as it could be read. */
export interface LegacySessionTasks {
  readonly sessionId: string;
  readonly entries: readonly TaskEntry[];
  /** Entries or activity that did not parse: those tasks (or their lost activity) are reported, never guessed at. */
  readonly issues: readonly TaskParseIssue[];
  /** The whole file was unreadable: nothing in it is imported. */
  readonly fatal: boolean;
}

/** Every old `tasks.json` in the state home, read and never written. Total: a file it cannot read is `fatal`. */
export interface LegacyTaskSource {
  read(): Promise<readonly LegacySessionTasks[]>;
}

/** The record that the import ran, one small document in the daemon's home. */
export interface BoardImportMarker {
  ran(): Promise<boolean>;
  record(at: string, summary: BoardImportSummary): Promise<void>;
}

/** The sessions of this daemon, and which strings name one. */
export interface ImportSessions {
  list(): Promise<readonly string[]>;
  /** Whether the string is the id of a session this daemon holds. */
  exists(value: string): Promise<boolean>;
  /** The session an old `assignee` string (an id, a callsign or a name) names, or `null` when it names none or several. */
  resolveAssignee(assignee: string): Promise<string | null>;
}

/** The boards the importer files cards on. */
export interface ImportProjects {
  projectOf(sessionId: string): Promise<BoardProjectId>;
  /** The project's lanes, or `null` while it has none. */
  laneSet(projectId: BoardProjectId): Promise<LaneSet | null>;
  /**
   * Proposes the lanes the project's folder suggests, UNCONFIRMED, on `sessionId`'s agenda as one choice for
   * the owner. Resolves to the proposed set, or `null` if the proposal could not be stored.
   */
  propose(projectId: BoardProjectId, sessionId: string): Promise<LaneSet | null>;
}

/** An open agenda item that names no card yet. */
export interface UnlinkedAsk {
  readonly id: string;
}

/** The link to put on one item. `blocking` marks the card as waiting on the owner for it. */
export interface AskLink {
  readonly id: string;
  readonly task: TaskRef;
  readonly blocking: boolean;
}

/** A session's agenda. */
export interface ImportAgenda {
  /** The open, non-notice items that have no `task` yet. */
  unlinked(sessionId: string): Promise<readonly UnlinkedAsk[]>;
  /** Sets `task` on each item (and marks it blocking where told); resolves to how many it linked. */
  link(sessionId: string, links: readonly AskLink[]): Promise<number>;
}

export interface BoardImportClock {
  now(): string;
}

export type { BoardImportProblem as ImportProblem, BoardImportSummary } from '@ferretry/protocol';
