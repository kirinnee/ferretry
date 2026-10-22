import type { ObservedHumanInput, TranscriptBatch, TranscriptIssueCode } from '../../transcript/types.ts';

/**
 * Issues that make a transcript read BLIND to its newest records — the only ones a send could be
 * proven by. A read with one of these can prove presence of what it did see, never absence.
 */
const BLIND: ReadonlySet<TranscriptIssueCode> = new Set([
  'source-missing',
  'source-read-failed',
  'source-truncated',
  'oversized-record',
]);

/** What a send watch has seen of a session's transcript since the oldest watched send. */
export interface SendEvidenceWatch {
  /** The person's (or a peer's) inputs the transcript has recorded so far, oldest first. */
  readonly inputs: readonly ObservedHumanInput[];
  /** Something made this read unable to see the newest records, so absence cannot be proven. */
  readonly blind: boolean;
  /** The window could not start where it was asked to, so absence before it is unprovable. */
  readonly partial: boolean;
}

/**
 * One transcript batch folded into a send watch: a reset starts the inputs over, every batch's inputs
 * are appended, and its issues decide whether the read can still prove absence.
 */
export function foldSendEvidenceBatch(watch: SendEvidenceWatch, batch: TranscriptBatch): SendEvidenceWatch {
  return {
    inputs: [...(batch.reset ? [] : watch.inputs), ...batch.observedInputs],
    blind: watch.blind || batch.issues.some(issue => BLIND.has(issue.code)),
    partial: watch.partial || batch.issues.some(issue => issue.code === 'source-truncated'),
  };
}
