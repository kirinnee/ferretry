import { z } from 'zod';
import { SessionIdSchema, type SessionId } from '../../session-id.ts';
import { LifecycleSessionStatusSchema } from '../lifecycle/types.ts';

/**
 * A session waiting on an automatic retry is neither running nor finished, and the lifecycle's own
 * machine has no name for it: it is the resume slice that schedules and consumes it.
 */
export const ResumableSessionStatusSchema = z.union([LifecycleSessionStatusSchema, z.literal('retrying')]);
export type ResumableSessionStatus = z.infer<typeof ResumableSessionStatusSchema>;

/** Statuses from which a session will never run again without a deliberate revive. */
export const TERMINAL_RESUME_STATUSES: ReadonlySet<ResumableSessionStatus> = new Set(['failed', 'stopped']);

/**
 * Who asked. An operator at a CLI and an automatic reviver reach the same method, and they must not
 * get the same policy: only the automated path may be suppressed by a duplicate-work heuristic.
 */
export const ResumeActorSchema = z.enum(['admin-cli', 'admin-ui', 'peer', 'warden', 'daemon', 'unknown']);
export type ResumeActor = z.infer<typeof ResumeActorSchema>;

export interface ResumePolicy {
  /**
   * Whether this is automated recovery rather than a person asking. Automatic retries must not
   * clear the human-attention state an operator has not yet seen.
   */
  readonly automatic: boolean;
  /**
   * Whether the legacy label+checkout duplicate-work suppression applies. A label is a batch slug,
   * not lineage, so it may only ever gate an automatic reviver.
   */
  readonly dedupeSharedRecoveryScope: boolean;
  /** Refuse if the session is no longer in this status — the state it was scheduled against. */
  readonly expectedStatus?: ResumableSessionStatus | undefined;
  /** Refuse if the retry counter moved, so two schedulers cannot both consume one attempt. */
  readonly retryAttempt?: number | undefined;
}

/** What the terminal itself shows, independent of what any record claims. */
export interface PaneObservation {
  /** A pane exists under this session's name. */
  readonly alive: boolean;
  /** The pane exists but its process is gone — a shell that outlived its agent. */
  readonly dead: boolean;
  /** The harness is at a prompt and will accept typed input. */
  readonly promptReady: boolean;
}

/** One session, as everything in this slice reads it. */
export interface ResumeTarget {
  readonly id: SessionId;
  readonly status: ResumableSessionStatus;
  readonly mode: 'auto' | 'interactive';
  readonly cwd: string;
  /** Batch slug, if the client set one. Never lineage. */
  readonly label?: string | undefined;
  readonly turn: number;
  readonly retryAttempt?: number | undefined;
  /** A structured question the agent asked and nobody answered. */
  readonly pendingQuestion?: { readonly toolUseId: string } | undefined;
  /** Set when the session is quarantined awaiting a person; the value names why. */
  readonly needsHumanKind?: string | undefined;
  /** How many transient relaunch failures may be retried automatically. */
  readonly transientRetryBudget?: number | undefined;
}

/** A resume the daemon declined to perform. Distinct from a resume that was attempted and failed. */
export class ResumeRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResumeRefused';
  }
}

/** The guard failed: the session moved out from under the caller that scheduled this resume. */
export class ResumeCancelled extends ResumeRefused {
  constructor(expected: ResumableSessionStatus, found: ResumableSessionStatus) {
    super(`resume guard expected status ${expected} but found ${found}`);
    this.name = 'ResumeCancelled';
  }
}

/** The legacy duplicate-work suppression fired. Only ever raised against an automatic reviver. */
export class ReviveDedupeConflict extends ResumeRefused {
  constructor(
    readonly target: ResumeTarget,
    readonly conflict: ResumeTarget,
  ) {
    super(
      `automatic revive suppressed for session ${target.id}: live session ${conflict.id} shares ` +
        `label ${target.label ?? ''} and checkout ${target.cwd}, the legacy automatic-recovery ` +
        `dedupe scope; resume ${target.id} explicitly to recover the original session`,
    );
    this.name = 'ReviveDedupeConflict';
  }
}

export const ResumeTargetSchema = z.object({
  id: SessionIdSchema,
  status: ResumableSessionStatusSchema,
  mode: z.enum(['auto', 'interactive']),
  cwd: z.string().min(1),
  label: z.string().optional(),
  turn: z.number().int().min(0),
  retryAttempt: z.number().int().min(0).optional(),
  needsHumanKind: z.string().min(1).optional(),
  transientRetryBudget: z.number().int().min(0).optional(),
});

/** Durable boundary for resume: reads the target and records each transition it makes. */
export interface ResumeRepository {
  read(id: SessionId): Promise<ResumeTarget | undefined>;
  /** Every live session, for the duplicate-work heuristic. Terminal ones may be included. */
  list(): Promise<readonly ResumeTarget[]>;
  transition(id: SessionId, change: ResumeTransition): Promise<ResumeTarget>;
}

/** One durable state change a resume makes, named by the event it journals. */
export interface ResumeTransition {
  readonly event:
    | 'session.resuming'
    | 'session.resumed'
    | 'session.resume_false_terminal_averted'
    | 'session.retry_scheduled'
    | 'session.failed'
    | 'session.question_cancelled'
    | 'session.composer_discarded';
  readonly status?: ResumableSessionStatus | undefined;
  readonly turn?: number | undefined;
  readonly retryAttempt?: number | undefined;
  readonly reason?: string | undefined;
  readonly clearPendingQuestion?: boolean | undefined;
  readonly clearNeedsHuman?: boolean | undefined;
  readonly data?: Readonly<Record<string, string | number | boolean>> | undefined;
}

/** The terminal a resume replaces. Every call goes through the injected tmux port, never a shell. */
export interface ResumeLauncher {
  observe(id: SessionId): Promise<PaneObservation>;
  /** Captures the final frame before a pane is destroyed, so discarded composer text is recoverable. */
  snapshot(id: SessionId): Promise<void>;
  /** Kills the pane this daemon created for this session, and nothing else. */
  kill(id: SessionId, reason: string): Promise<void>;
  relaunch(id: SessionId): Promise<void>;
  deliver(id: SessionId, instruction: string): Promise<void>;
  /**
   * Independently re-probes after a relaunch error. A readiness failure is one observation; the
   * pane and process tree are another, and only their agreement justifies a terminal verdict.
   */
  confirmExit(id: SessionId): Promise<{ readonly confirmed: boolean; readonly pane: PaneObservation }>;
}

/** Where a revived agent reads its new turn. */
export interface ResumeTurnStore {
  /** Persists the turn document and returns the absolute file the agent must open. */
  writeTurn(id: SessionId, turn: number, document: string): Promise<string>;
  /** Clears the completion markers a previous turn left, so a stale one cannot end the new one. */
  clearMarkers(id: SessionId): Promise<void>;
}

/**
 * The per-session monitor. A relaunch must disarm the old one first: otherwise that monitor sees
 * resume's own deliberate kill and writes a terminal verdict in the middle of the relaunch.
 */
export interface ResumeMonitorControl {
  stop(id: SessionId): Promise<void>;
  start(id: SessionId): Promise<void>;
}

/** Whether a first launch for this session is still in flight, and how a caller waits for it. */
export interface LaunchGate {
  launching(id: SessionId): boolean;
  /** Resolves true once the launch settled, false if it did not within the budget. */
  awaitSettled(id: SessionId, timeoutMs: number): Promise<boolean>;
  /** Registers this resume's own relaunch, so the reflex layer grants it the same amnesty. */
  register(id: SessionId): { release(): void };
}
