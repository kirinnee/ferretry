import type { AutoResumeSummary } from '@ferretry/protocol';
import { InstantSchema, NonEmptyStringSchema } from '@ferretry/protocol';
import { z } from 'zod';

/**
 * A session that was running when the host went down: it claimed a live agent, and the first
 * self-check after the daemon came back proved its terminal was gone.
 *
 * `status` is what the session claimed BEFORE that settle rewrote it to `failed`, because whether it
 * was mid-turn decides what a revived agent is told.
 */
export const AutoResumeCandidateSchema = z.strictObject({
  id: NonEmptyStringSchema,
  status: NonEmptyStringSchema,
  at: InstantSchema,
});
export type AutoResumeCandidate = z.infer<typeof AutoResumeCandidateSchema>;

/** The durable list of sessions still owed an auto-resume, written before any of them is attempted. */
export const AutoResumeLedgerSchema = z.strictObject({
  version: z.literal(1),
  candidates: z.array(AutoResumeCandidateSchema),
});

/** What the auto-resume needs to know about a session right now, read fresh at attempt time. */
export interface AutoResumeSubject {
  readonly status: string;
  readonly mode: 'auto' | 'interactive';
}

export interface AutoResumeLedgerPort {
  read(): Promise<readonly AutoResumeCandidate[]>;
  write(candidates: readonly AutoResumeCandidate[]): Promise<void>;
}

export interface AutoResumeRosterPort {
  /** `undefined` when the session no longer exists or its documents are unreadable. */
  subject(id: string): Promise<AutoResumeSubject | undefined>;
}

export interface AutoResumeAvailabilityPort {
  /** `undefined` when the session's runtime and login can serve; otherwise why they cannot. */
  unavailable(id: string): Promise<string | undefined>;
}

export interface AutoResumeResumerPort {
  /** The ordinary revive. Rejects when it was refused or failed; the message is the reason. */
  resume(id: string, message: string | undefined): Promise<void>;
}

export type AutoResumeOutcome =
  | { readonly kind: 'resumed'; readonly notified: boolean }
  | { readonly kind: 'skipped'; readonly reason: string };

export interface AutoResumeJournalPort {
  record(id: string, outcome: AutoResumeOutcome): Promise<void>;
}

export interface AutoResumeSummaryPort {
  write(summary: AutoResumeSummary): Promise<void>;
}

export interface AutoResumeSettingPort {
  enabled(): Promise<boolean>;
}

export interface AutoResumePorts {
  readonly ledger: AutoResumeLedgerPort;
  readonly roster: AutoResumeRosterPort;
  readonly availability: AutoResumeAvailabilityPort;
  readonly resumer: AutoResumeResumerPort;
  readonly journal: AutoResumeJournalPort;
  readonly summary: AutoResumeSummaryPort;
  readonly setting: AutoResumeSettingPort;
  readonly clock: { now(): string; nowMs(): number };
  readonly sleep: (milliseconds: number) => Promise<void>;
}

export interface AutoResumeSettings {
  /** How many sessions are revived at once. */
  readonly concurrency: number;
  /** The gap between one revive starting and the next worker's, so a reboot is not a thundering herd. */
  readonly staggerMs: number;
  /** A candidate older than this is a stale record of a long-ago outage, not a reboot to recover from. */
  readonly maxAgeMs: number;
}

export const defaultAutoResumeSettings: AutoResumeSettings = {
  concurrency: 2,
  staggerMs: 4_000,
  maxAgeMs: 24 * 60 * 60 * 1_000,
};
