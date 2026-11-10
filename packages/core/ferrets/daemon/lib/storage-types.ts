import type { JsonValue } from '@ferretry/std';
import type { SessionId } from './session-id.ts';

export interface JournalFingerprint {
  readonly device: string;
  readonly inode: string;
  readonly size: number;
  readonly modifiedAtMs: number;
}
export interface SessionEvent<T extends JsonValue = JsonValue> {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly sessionId: SessionId;
  readonly time: string;
  readonly type: string;
  readonly data: T;
}

export interface EventPointer {
  readonly sessionId: SessionId;
  readonly sequence: number;
  readonly time: string;
  readonly type: string;
  readonly byteOffset: number;
  readonly byteLength: number;
}

export interface IndexedSession {
  readonly id: SessionId;
  readonly status?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly lastSequence: number;
  /** One-based source line at the indexed journal byte offset. */
  readonly journalLine: number;
  readonly journal: JournalFingerprint | null;
}

export interface JournalProblem {
  readonly file: string;
  readonly line: number;
  readonly byteOffset: number;
  readonly message: string;
}

export interface RebuildPlan {
  readonly sessions: readonly IndexedSession[];
  readonly events: readonly EventPointer[];
  readonly problems: readonly JournalProblem[];
}

export interface RebuildResult {
  readonly sessionCount: number;
  readonly eventCount: number;
  readonly problems: readonly JournalProblem[];
  readonly failedSessionIds?: readonly string[];
  /** Quarantined sessions whose durable marker promises a journal that is no longer on disk. */
  readonly lostJournalSessionIds?: readonly string[];
}

/** How a yielding rebuild of the session index is run. */
export interface IndexRebuildOptions {
  /** Sessions taken per slice; the loop is handed back after every slice. At least one. */
  readonly sliceSize: number;
  /** Hands the event loop back (a macrotask turn on the kernel clock). Called once after every slice. */
  readonly yieldToLoop: () => Promise<void>;
  /** The daemon's stop: no further session is taken once it is aborted. */
  readonly signal?: AbortSignal;
}

/** What a yielding rebuild of the session index did. */
export interface IndexRebuildResult {
  /** Sessions the state folder holds a file for (archived ones excepted). */
  readonly surveyed: number;
  /** Surveyed sessions the index held no row for when the rebuild began. */
  readonly missing: number;
  /** Sessions the rebuild wrote a row for. */
  readonly rebuilt: number;
  /** Slices taken (each followed by one yield). */
  readonly slices: number;
  /** False when a stop, or a closed storage, ended the rebuild before every missing session was taken. */
  readonly complete: boolean;
  /** Sessions whose files could not be read; they stay unindexed and the next boot tries them again. */
  readonly failedSessionIds: readonly string[];
}

export interface ReplayPage {
  readonly events: readonly SessionEvent[];
  readonly rows: number;
  readonly afterSequence: number;
  readonly nextSequence?: number;
  readonly hasMore: boolean;
}
