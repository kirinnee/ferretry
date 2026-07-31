/**
 * The warden's own view of the fleet.
 *
 * These are deliberately narrow structural types rather than the full protocol
 * session schemas: the warden reads a handful of fields, and declaring exactly
 * those keeps the pure decision layer independent of the wire contract.
 */

/** Label that marks a fleet-warden session. Warden sessions — and everything
 *  they spawn — are excluded from every anomaly class so a warden can never
 *  escalate against itself. */
export const WARDEN_LABEL = 'fleet-warden';

/** Session lifecycle states the warden distinguishes. */
export type WardenSessionStatus =
  | 'created'
  | 'starting'
  | 'running'
  | 'thinking'
  | 'tool_running'
  | 'awaiting_question'
  | 'awaiting_user'
  | 'interrupted'
  | 'rate_limited'
  | 'retrying'
  | 'kill_failed'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'stalled'
  | 'stopped';

/** Statuses a session never leaves. */
export const WARDEN_TERMINAL_STATUSES: readonly WardenSessionStatus[] = [
  'completed',
  'failed',
  'stalled',
  'stopped',
  'kill_failed',
];

export function isTerminalStatus(status: WardenSessionStatus): boolean {
  return WARDEN_TERMINAL_STATUSES.includes(status);
}

/** A teammate's declared wait (`fy signal waiting`). */
export interface WardenDeclaredWait {
  readonly since?: string;
  readonly until?: string;
  readonly condition?: string;
  readonly peer?: string;
  readonly peerName?: string;
}

/** Per-life-sign timestamps the sus classifiers reason over. */
export interface WardenLivenessLedger {
  /** The conversation transcript grew. */
  readonly lastTranscriptAt?: string;
  /** A recognised work indicator advanced (elapsed seconds, token counter, …). */
  readonly lastCounterAdvanceAt?: string;
  /** The token counter specifically climbed — certain progress. */
  readonly lastTokenAdvanceAt?: string;
  /** A harness tool or subprocess was observed alive. */
  readonly lastSubprocessAt?: string;
  /** Any visible frame change in the pane. */
  readonly lastPaneChangeAt?: string;
  /** Start of the current continuous subprocess episode. */
  readonly subprocessSince?: string;
}

/** The persisted configuration fields the warden reads. */
export interface WardenSessionConfig {
  readonly id: string;
  readonly mode: 'auto' | 'interactive';
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly teammate?: string;
  readonly label?: string;
  readonly parent?: string;
  readonly agent?: string;
  readonly model?: string;
  readonly intervalSeconds?: number;
}

/** The observed state fields the warden reads. */
export interface WardenSessionState {
  readonly status: WardenSessionStatus;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly lastActivityAt?: string;
  readonly lastTranscriptAt?: string;
  readonly lastCounterAdvanceAt?: string;
  readonly lastTokenAdvanceAt?: string;
  readonly lastSubprocessAt?: string;
  readonly subprocessSince?: string;
  /** Any visible frame change in the pane. */
  readonly lastPaneAt?: string;
  readonly reason?: string;
  readonly waiting?: WardenDeclaredWait;
  readonly quota?: { readonly resetAt?: number };
}

/** Project the liveness signals a state carries into a ledger. */
export function livenessLedgerOf(state: WardenSessionState): WardenLivenessLedger {
  return {
    lastTranscriptAt: state.lastTranscriptAt,
    lastCounterAdvanceAt: state.lastCounterAdvanceAt,
    lastTokenAdvanceAt: state.lastTokenAdvanceAt,
    lastSubprocessAt: state.lastSubprocessAt,
    lastPaneChangeAt: state.lastPaneAt,
    subprocessSince: state.subprocessSince,
  };
}

/** One session as the detector sees it: persisted config and state plus the one
 *  fact pure logic cannot derive — whether the daemon holds a live monitor
 *  handle for it. */
export interface WardenSessionView {
  readonly config: WardenSessionConfig;
  readonly state: WardenSessionState;
  readonly hasLiveMonitor: boolean;
  /** True when a done marker exists for the session's CURRENT turn: the
   *  teammate declared its work finished even if the status never flipped.
   *  Such a session is never resumable wreckage — resuming it would make a
   *  finished teammate redo its turn. */
  readonly hasDoneMarker?: boolean;
}
