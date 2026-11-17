/**
 * What the move needs to know about a ferret's KEPT jobs (docs/jobs.md), as a plain port the job keeper (Terminals)
 * contributes and the moves (Ferrets) read — Ferrets imports no plugin, so the question is asked through the
 * `jobs.keeper` hook ({@link JobKeeper}).
 *
 * Every answer is derived by the keeper from its own files and the process table; the moves never read a job's log or
 * its command line from here beyond the name and the plain facts below.
 */

/**
 * A live `fy job attach|run` process of a ferret, PROVEN by the keeper: the registry holds its pid and the process start
 * the keeper read for it, and an entry whose pid the kernel has since handed to another process is already pruned. A
 * match by pid against this list is therefore the proof; the argv alone is never trusted (it is a second, necessary check).
 */
export interface KeptAttachment {
  readonly pid: number;
  readonly jobId: string;
  readonly jobName: string;
  /** The job already ended: this attachment is only on its way out, and there is nothing left to re-attach to. */
  readonly jobEnded?: boolean;
}

/** One job of a ferret, as the hand-over tells it. */
export interface KeptJob {
  readonly id: string;
  readonly name: string;
  readonly state: 'running' | 'exited' | 'lost';
  readonly startedAt: string;
  readonly endedAt?: string;
  /** Present once it ended; a signal death reads 128 + the signal's number. */
  readonly exitCode?: number;
  /** An ended job whose end nobody has been told of yet: no live attachment saw it and no message was queued. */
  readonly unreported: boolean;
}

/** A finished job nobody was told about, with the ferret to tell. */
export interface UnreportedEnd {
  readonly ferret: string;
  readonly job: KeptJob;
}

export interface JobKeeperSource {
  /** The proven live attachments of one ferret. Total: an unreadable registry answers none. */
  attachments(ferret: string): Promise<readonly KeptAttachment[]>;
  /**
   * Asks every attachment of the ferret to let go (each prints its detach message and exits 75). No job is touched.
   * Answers how many were asked.
   */
  detach(ferret: string): Promise<number>;
  /** The ferret's running jobs and the ones that ended, newest first. */
  jobs(ferret: string): Promise<readonly KeptJob[]>;
  /** Records that the ferret was told how these jobs ended, so neither the hand-over nor the backstop repeats it. */
  markReported(ferret: string, jobIds: readonly string[]): Promise<void>;
  /**
   * Jobs that ended, are unreported, and have NO live attachment (and ended long enough ago for an attachment to have
   * reported it itself). The completion backstop reads this.
   */
  endedUnattached(): Promise<readonly UnreportedEnd[]>;
  /**
   * THE FLOOD GUARD'S ONE-TIME CUT-OVER (epoch ms): the instant the backstop first ran, kept in the keeper's own state and never
   * moved, so a daemon restart or update does not make it forget which jobs are history. The first call ever records `now`.
   * `undefined` when it cannot be known: the backstop then does nothing that pass.
   */
  backstopCutOver(): Promise<number | undefined>;
}
