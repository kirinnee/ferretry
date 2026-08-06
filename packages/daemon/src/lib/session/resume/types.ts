import { SessionStatusSchema, type SessionStatus } from '@ferretry/protocol';
import { z } from 'zod';
import { SessionIdSchema, type SessionId } from '../../session-id.ts';

/**
 * Which statuses a resume can act on: EVERY status the protocol's state document may hold.
 *
 * It used to be the LIFECYCLE's own six plus `retrying`, and that was a defect the moment the route
 * was mounted. The status this parses comes off `state.json`, which `SessionStateSchema` governs, and
 * that schema has sixteen — so a session sitting in `stalled`, `rate_limited`, `awaiting_question`,
 * `thinking`, `tool_running`, `interrupted`, `waiting` or `completed` failed to parse here, the
 * repository answered "no target", and `POST /v1/sessions/:id/resume` told the operator
 * `session not found` about a session `GET /v1/sessions` was listing at that same moment.
 *
 * Those are not obscure states: `stalled` and `rate_limited` are the two an operator revives FROM,
 * and they are also the two a migration onto another account exists for. Reading the document with
 * its own schema is what makes the answer honest — a status the resume policy has no special opinion
 * about is simply a non-terminal one, which is what it was.
 */
export const ResumableSessionStatusSchema = SessionStatusSchema;
export type ResumableSessionStatus = SessionStatus;

/**
 * Statuses from which a session will never run again without a deliberate revive.
 *
 * `completed` joins the two the lifecycle knew about, and for exactly their reason: a session that
 * finished its work has no agent left to type into, so its leftover pane is not a session to send a
 * message to — a revive replaces it. Every other status is a session that may still be running,
 * including `stalled` and `rate_limited`, where the pane is usually alive and the send shortcut is
 * the right answer.
 */
export const TERMINAL_RESUME_STATUSES: ReadonlySet<ResumableSessionStatus> = new Set([
  'failed',
  'stopped',
  'completed',
]);

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
  /**
   * Whether a LIVE, healthy pane must be replaced rather than typed into.
   *
   * A plain resume takes the send shortcut when the harness is still at a prompt, because the
   * cheapest way to hand a running agent its next turn is to type it. A MIGRATION cannot: the whole
   * point is that a different executable answers the next turn, so typing into the pane that is
   * already running would leave the old account serving a session whose own document says it moved.
   *
   * It is a policy field rather than a second method because everything else about the relaunch —
   * the snapshot before the kill, the journalled composer discard, the turn document, the retry
   * accounting, the launch gate and the per-session queue — is identical, and a parallel path would
   * be those orderings written a second time.
   */
  readonly replaceLiveTerminal?: boolean | undefined;
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

/**
 * A replacement pane was created but its process identity could not be recorded durably.
 *
 * This is not an ordinary readiness or delivery failure. A later probe may quite truthfully see
 * the pane alive, but preserving it would leave every durable reader addressing the incarnation
 * the revive replaced. Recovery must therefore surface the failure even when teardown also failed
 * and the unregistered replacement is still present.
 */
export class UnregisteredResumeReplacement extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UnregisteredResumeReplacement';
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
