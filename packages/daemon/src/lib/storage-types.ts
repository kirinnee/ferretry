import type { JsonValue } from './json.ts';
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
}

export interface ReplayPage {
  readonly events: readonly SessionEvent[];
  readonly rows: number;
  readonly afterSequence: number;
  readonly nextSequence?: number;
  readonly hasMore: boolean;
}
