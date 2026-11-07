/**
 * PEER: today's `daemon/src/lib/warden/detect.ts`, `warden/liveness.ts`, `warden/liveness-monitor.ts` and
 * `warden/pane-processes.ts` — owned by the warden plugin.
 * Ferrets is core and cannot import a plugin's code (§2.1); this is the part the session code reads, injected by the host.
 *
 * The wait backstop and its deadline, and the liveness and pane-process types, are copied verbatim; the pane work
 * classifier (`paneWorkSummary`) is a function the host supplies ({@link PaneWorkSummarizer}).
 */
import type { SessionStatus, SessionTurnState } from '../../protocol/session.ts';
import { instantMs } from '../../time.ts';

// ── today's warden/detect.ts ────────────────────────────────────────────────────────────────────

export const WAITING_BACKSTOP_MS = 4 * 60 * 60_000;

export function declaredWaitDeadlineMs(
  wait: { readonly since?: string; readonly until?: string },
  backstopMs = WAITING_BACKSTOP_MS,
): number | undefined {
  const until = instantMs(wait.until);
  if (until !== undefined) return until;
  const since = instantMs(wait.since);
  return since === undefined ? undefined : since + backstopMs;
}

// ── today's warden/liveness.ts ──────────────────────────────────────────────────────────────────

export interface LivenessSample {
  /** A digest of the screen as it is now. */
  readonly paneHash?: string;
  /** The screen itself, for its work counters. */
  readonly pane?: string;
  /** A digest of the transcript's tail: it changes when the conversation grows. */
  readonly transcriptHash?: string;
  /** A live tool command under the pane, or a background terminal the harness reports. */
  readonly subprocessAlive?: boolean;
  /** Which tool command is running — a different one starts a new episode. */
  readonly subprocessKey?: string;
  /** A browser the agent launched is still running under the pane. */
  readonly leftoverBrowser?: boolean;
}

// ── today's warden/liveness-monitor.ts ──────────────────────────────────────────────────────────

/** Today's `WardenSessionStatus` (`warden/types.ts`): the session status itself. */
type WardenSessionStatus = SessionStatus;

export interface LivenessTarget {
  readonly id: string;
  readonly status: WardenSessionStatus;
  readonly turn: number;
  readonly mode: 'auto' | 'interactive';
  /** A declared wait: the ferret said it is parked, so silence is expected. */
  readonly waiting: boolean;
  /** Whose move it is. A ferret whose turn is over waits on its owner: its silence is expected too. */
  readonly turnState?: SessionTurnState;
  readonly nudgeAfterSeconds?: number;
  readonly killAfterSeconds?: number;
  /** The tmux session its pane lives in, when it has one. */
  readonly tmuxSession?: string;
}

// ── today's warden/pane-processes.ts ────────────────────────────────────────────────────────────

/** One entry under the pane, as the inventory observed it. Parents are listed before children. */
export interface PaneProcess {
  readonly pid: number;
  /** Its parent; a parent not in the list is the pane itself. */
  readonly ppid?: number;
  readonly argv: string;
  readonly startedSecondsAgo?: number;
  /** Set when provenance recognised it as the agent's own (the tools server, the harness, …). */
  readonly known?: { readonly kind: string };
  /** It holds a listening socket: a server. `undefined` where that could not be observed. */
  readonly listening?: boolean;
}

/** What the liveness look keeps of a pane's processes: whether work runs, which, and a leftover browser. */
interface PaneWorkSummary {
  /** A tool command is running under the pane. */
  readonly toolCommand: boolean;
  /** Identity of the youngest running tool command — a different one starts a new episode. */
  readonly commandKey?: string;
  /** A browser the agent launched is still running. */
  readonly leftoverBrowser: boolean;
}

/** Today's `paneWorkSummary(processes)`: classifies a pane's process tree. */
export type PaneWorkSummarizer = (processes: readonly PaneProcess[]) => PaneWorkSummary;

// ── the process walk the liveness look reads ────────────────────────────────────────────────────

/**
 * The outcome of walking a pane's process tree — today's `ProcessObservation` (its inflight report,
 * Ferrets' own move code, not yet ported), trimmed to what the liveness look reads: an observed walk's processes
 * as {@link PaneProcess} entries. A failed walk is deliberately a distinct case: an inspection that could not run is
 * not evidence that nothing is running.
 */
export type ProcessObservation =
  | { readonly kind: 'observed'; readonly processes: readonly PaneProcess[] }
  | { readonly kind: 'unobservable'; readonly reason: string };
