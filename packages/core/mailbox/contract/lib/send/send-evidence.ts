import type { SessionId } from '../../session-id.ts';
import type { ObservedHumanInput, TranscriptBatch, TranscriptIssueCode } from '../../transcript.ts';

/**
 * Issues that make a transcript read BLIND to its newest records — the only ones a send could be
 * proven by. A read with one of these can prove presence of what it did see, never absence.
 *
 * `source-truncated` is NOT one. A window pages through a transcript in bounded steps, and every step
 * that stops at its limit says so; the next step reads on from exactly there. Counting it as blind made
 * every transcript longer than one step (8 MiB) unable to prove any send absent, however far it was read.
 * Whether the reader got to the END is the drain's answer (`more`), not an issue's. A window that could
 * not START where it was asked (`window-capped`) did miss records, and is blind before it.
 */
const BLIND: ReadonlySet<TranscriptIssueCode> = new Set([
  'source-missing',
  'source-read-failed',
  'oversized-record',
  'window-capped',
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
    partial: watch.partial || batch.issues.some(issue => issue.code === 'window-capped'),
  };
}

/** One read of a session's transcript evidence. `readable: false` means absence cannot be proven. */
export interface SendEvidenceReading {
  readonly readable: boolean;
  /** The session has no transcript the daemon can prove is its own, which no amount of waiting fixes. */
  readonly unbound?: true;
  /**
   * Not unreadable — still reading. A look reads a bounded amount and keeps its place, so a huge
   * transcript is read across several looks; until the window reaches the end, absence is not yet
   * provable, and that is a reason to look again, never to call a message unconfirmed.
   */
  readonly catchingUp?: true;
  readonly inputs: readonly ObservedHumanInput[];
}

/** The transcript side: what the harness has recorded the agent receiving or holding. */
export interface SendEvidenceSource {
  /**
   * What the transcript holds from `since` on — the acceptance of the oldest send being looked for,
   * before which nothing can prove one. A source may read less than the whole file because of it.
   */
  read(id: SessionId, since: string): Promise<SendEvidenceReading>;
}
