/**
 * PEER: today's `daemon/src/lib/warden/detect.ts`, `warden/liveness.ts`, `warden/liveness-monitor.ts` and
 * `warden/pane-processes.ts` — owned by the warden plugin.
 * Ferrets is core and cannot import a plugin's code (§2.1); this is the part the session code reads, injected by the host.
 *
 * The wait backstop and its deadline, and the liveness and pane-process types, are copied verbatim; the pane work
 * classifier (`paneWorkSummary`) is a function the host supplies ({@link PaneWorkSummarizer}).
 */

// ── today's warden/detect.ts ────────────────────────────────────────────────────────────────────

export const WAITING_BACKSTOP_MS = 4 * 60 * 60_000;

// ── today's warden/liveness.ts ──────────────────────────────────────────────────────────────────

// ── today's warden/liveness-monitor.ts ──────────────────────────────────────────────────────────

// ── today's warden/pane-processes.ts ────────────────────────────────────────────────────────────

/** One entry under the pane, as the inventory observed it. Parents are listed before children. */
interface PaneProcess {
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
type PaneWorkSummarizer = (processes: readonly PaneProcess[]) => PaneWorkSummary;

// ── the process walk the liveness look reads ────────────────────────────────────────────────────
