/**
 * The attachment registry's pure rules (docs/jobs.md). An attachment is a live `fy job attach` process; the registry is how
 * the daemon (and, in later parts, the move gate and the hand-over) knows which ones a ferret holds and can ask them to let go.
 *
 * An entry names a process by pid AND the start the daemon read for it when it registered, so an entry whose pid the kernel
 * has since handed to another process is proved dead rather than trusted.
 */
import { type AttachmentEntry, type AttachmentsState } from '../../../contract/index.ts';

export type { AttachmentEntry, AttachmentsState };

export const EMPTY_ATTACHMENTS: AttachmentsState = { entries: [] };

/** The most attachments one job keeps; a newer one pushes out the oldest. A registry must not grow with every request. */
export const JOB_MAX_ATTACHMENTS_PER_JOB = 16;

/**
 * Adds `entry`, replacing any earlier one for the same (ferret, job, pid) — one process attached once — and keeping only the
 * newest {@link JOB_MAX_ATTACHMENTS_PER_JOB} of that job.
 */
export function withEntry(state: AttachmentsState, entry: AttachmentEntry): AttachmentsState {
  const others = state.entries.filter(
    existing =>
      existing.id !== entry.id &&
      !(existing.sessionId === entry.sessionId && existing.jobId === entry.jobId && existing.pid === entry.pid),
  );
  const ofJob = others.filter(existing => existing.sessionId === entry.sessionId && existing.jobId === entry.jobId);
  const evicted = new Set(
    ofJob
      .toSorted((x, y) => x.registeredAt.localeCompare(y.registeredAt))
      .slice(0, Math.max(0, ofJob.length + 1 - JOB_MAX_ATTACHMENTS_PER_JOB))
      .map(old => old.id),
  );
  return { ...state, entries: [...others.filter(existing => !evicted.has(existing.id)), entry] };
}

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

/**
 * Marks as detaching every entry whose recorded harness is gone: `harnessNow` is what the host reports for a harness pid
 * right now (`undefined` when no such process runs; `'unknown'` when it cannot say, which never condemns). An entry that
 * recorded no harness (a person's own terminal) is never an orphan. Answers the new state and how many it newly marked.
 */
export function withOrphansDetaching(
  state: AttachmentsState,
  harnessNow: ReadonlyMap<number, string | undefined | 'unknown'>,
): { readonly state: AttachmentsState; readonly marked: number } {
  let marked = 0;
  const entries = state.entries.map(entry => {
    if (entry.harness === undefined || entry.detaching) return entry;
    const now = harnessNow.get(entry.harness.pid);
    if (now === 'unknown' || now === entry.harness.start) return entry;
    marked += 1;
    return { ...entry, detaching: true };
  });
  return { state: { ...state, entries }, marked };
}

/** Entries of one ferret, oldest first. */
export const entriesOf = (state: AttachmentsState, sessionId: string): readonly AttachmentEntry[] =>
  state.entries
    .filter(entry => entry.sessionId === sessionId)
    .toSorted((a, b) => a.registeredAt.localeCompare(b.registeredAt));
