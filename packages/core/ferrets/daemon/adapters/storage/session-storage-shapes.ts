import type { SessionId } from '../../lib/session-id.ts';
import type { JournalScan } from '../../lib/storage/journal.ts';
import type { SessionSource } from '../../lib/storage/rebuild.ts';
import type { IndexedSession, JournalProblem } from '../../lib/storage-types.ts';

export interface SourceCollection {
  readonly sources: readonly SessionSource[];
  /** The sessions whose journal was NOT read because its version is the one the index row records. */
  readonly unchanged: ReadonlySet<string>;
  readonly problems: readonly JournalProblem[];
  readonly failedSessionIds: readonly string[];
  readonly lostJournalSessionIds: readonly string[];
}

/** One session as a health tick sees it: cheap to obtain, enough to spot lost history. */
export interface SessionDirectorySurvey {
  readonly id: SessionId;
  /**
   * True when the journal is gone from a session that owes one: the index witnesses a journal the session used to
   * have, and the state folder no longer holds it.
   */
  readonly journalLost: boolean;
}

export type SessionInspection =
  | { readonly kind: 'current'; readonly session?: IndexedSession }
  | { readonly kind: 'repair'; readonly source: SessionSource | null; readonly session?: IndexedSession };

/**
 * A session's journal as read: what its lines add up to (each folded into the scan as it was read, never held as a
 * list), how many there were, and whether the read reached the end of the file.
 */
export interface JournalRead {
  readonly scan: JournalScan;
  /** Lines read: the position the next append lands at. */
  readonly count: number;
  readonly complete: boolean;
}

/** A session's three files as read in one pass. */
export interface SessionRead {
  readonly source: SessionSource | undefined;
  readonly journal: JournalRead;
}

/** Which sessions hold which files, from the state port's listings. */
export interface SessionNames {
  readonly all: readonly string[];
  readonly configs: ReadonlySet<string>;
  readonly states: ReadonlySet<string>;
  readonly histories: ReadonlySet<string>;
}

/**
 * How fresh a read must be. Kept so every caller is unchanged; the state port proves every read, so both answer the
 * file as it is now.
 */
export type DocumentFreshness = 'proved' | 'heard';

/** What the archive records of a session it is about to take: the name it answered to and what that name's hold runs from. */
export interface ArchiveVerdict {
  readonly name?: string;
  /** The configuration's `createdAt` and `updatedAt`: what a callsign's hold on its name is measured from. */
  readonly configTimes?: { readonly createdAt: string; readonly updatedAt: string };
}
