/**
 * The attachment registry's pure rules (docs/jobs.md). An attachment is a live `fy job attach` process; the registry is how
 * the daemon (and, in later parts, the move gate and the hand-over) knows which ones a ferret holds and can ask them to let go.
 *
 * An entry names a process by pid AND the start the daemon read for it when it registered, so an entry whose pid the kernel
 * has since handed to another process is proved dead rather than trusted.
 */
import {
  type AttachmentEntry,
  type AttachmentsState,
} from '../../../contract/index.ts';

export type { AttachmentEntry, AttachmentsState };

export const EMPTY_ATTACHMENTS: AttachmentsState = { entries: [] };

export const withEntry = (state: AttachmentsState, entry: AttachmentEntry): AttachmentsState => ({
  ...state,
  entries: [...state.entries.filter(existing => existing.id !== entry.id), entry],
});

export const withoutEntry = (state: AttachmentsState, id: string): AttachmentsState => ({
  ...state,
  entries: state.entries.filter(entry => entry.id !== id),
});

/** Every entry of `sessionId` asked to detach (and, when `jobId` is given, only that job's). */
export function withDetaching(state: AttachmentsState, sessionId: string, jobId?: string): AttachmentsState {
  return {
    ...state,
    entries: state.entries.map(entry =>
      entry.sessionId === sessionId && (jobId === undefined || entry.jobId === jobId)
        ? { ...entry, detaching: true }
        : entry,
    ),
  };
}

/**
 * Drops the entries whose process is not the one that registered: `startNow` is what the host reports for a pid right now
 * (`undefined` when no such process runs). A reading that cannot be taken at all leaves the entry (never prunes on doubt).
 */
export function withoutStale(
  state: AttachmentsState,
  startNow: ReadonlyMap<number, string | undefined | 'unknown'>,
): AttachmentsState {
  return {
    ...state,
    entries: state.entries.filter(entry => {
      const now = startNow.get(entry.pid);
      return now === 'unknown' || now === entry.processStart;
    }),
  };
}

/** Entries of one ferret, oldest first. */
export const entriesOf = (state: AttachmentsState, sessionId: string): readonly AttachmentEntry[] =>
  state.entries.filter(entry => entry.sessionId === sessionId).toSorted((a, b) => a.registeredAt.localeCompare(b.registeredAt));
