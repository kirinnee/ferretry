/**
 * The warden's own view of the fleet.
 *
 * These are deliberately narrow structural types rather than the full protocol
 * session schemas: the warden reads a handful of fields, and declaring exactly
 * those keeps the pure decision layer independent of the wire contract. The
 * status union is the exception — a narrower copy of it would silently drop a
 * session in a status the warden had never heard of.
 */

import type { SessionStatus, SessionTurnState } from '@ferretry/protocol';

/** Label that marks a fleet-warden session. Warden sessions — and everything
 *  they spawn — are excluded from every anomaly class so a warden can never
 *  escalate against itself. */
export const WARDEN_LABEL = 'fleet-warden';

/** Session lifecycle states — the protocol's own union, so a new status can never fall outside the warden. */
export type WardenSessionStatus = SessionStatus;

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
  /** A frame change that is not the harness's own spinner, clock or status line (`meaningfulPaneText`). */
  readonly lastMeaningfulPaneAt?: string;
  /** Start of the current continuous subprocess episode. */
  readonly subprocessSince?: string;
  /** Which tool command the current episode is — a different one is a different episode. */
  readonly subprocessKey?: string;
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
  /**
   * Stamped at spawn on a warden and on everything a warden spawns.
   *
   * Lineage CANNOT be reconstructed reliably by walking `parent`: the walk only
   * works while every ancestor is still present, and a warden is ephemeral — it
   * finishes and is pruned long before its children do. Recording descent when
   * it is known is the only mechanism that survives that, so this flag is
   * authoritative and the parent walk is a backstop for sessions that predate
   * it.
   */
  readonly wardenLineage?: boolean;
  /** A person cut this session off (`fy session revoke-credential`): the Warden never revives it. */
  readonly credentialRevoked?: boolean;
  readonly agent?: string;
  /** The harness the session runs, as its configuration records it: what a move must stay on. */
  readonly harness?: 'claude' | 'codex';
  readonly model?: string;
  /**
   * The model a start RESOLVED when the account pinned none.
   *
   * Carried beside `model` rather than folded into it because the two answer
   * different questions: `model` is what an operator configured, and this is what
   * actually ran. A surface naming the node's model wants the resolved value —
   * reporting "not recorded" for a session that is demonstrably running one is
   * the kind of quiet blank a person reads as a broken screen.
   */
  readonly modelHint?: string;
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
  readonly subprocessKey?: string;
  /** Any visible frame change in the pane. */
  readonly lastPaneAt?: string;
  /** A frame change that is not the harness's own spinner, clock or status line. */
  readonly lastMeaningfulPaneAt?: string;
  /** The turn the session is on. */
  readonly turn?: number;
  /**
   * Whose move it is: `working` while the agent works a turn, `your-turn` once it ended its turn and
   * waits at the prompt, `needs-input` while it is parked on a question or permission prompt. A session
   * can be `running` and `your-turn` at once — that is a finished ferret waiting on its owner.
   */
  readonly turnState?: SessionTurnState;
  /** When `turnState` last changed: for a ferret at its prompt, when its turn ended. */
  readonly turnStateAt?: string;
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
    lastMeaningfulPaneAt: state.lastMeaningfulPaneAt,
    subprocessSince: state.subprocessSince,
    subprocessKey: state.subprocessKey,
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
  /** When the liveness reflex confirmed this ferret frozen, this episode. */
  readonly frozenAt?: string;
  /**
   * When THIS daemon began watching the ferret (`WardenLivenessMonitor.observedSince`). The sus
   * classifiers measure silence from no earlier than this: a restarted daemon's documents carry
   * instants from before it was watching, and silence nobody observed is no evidence. Absent: the
   * session's own turn start is the only floor.
   */
  readonly observedSince?: string;
  /** Since when a browser the agent launched has been running under its pane, this turn. */
  readonly leftoverBrowserSince?: string;
}
