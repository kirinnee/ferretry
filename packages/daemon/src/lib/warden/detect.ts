/**
 * Pure fleet anomaly detection. Fed a snapshot of session views plus the current
 * wall-clock time, it returns the anomaly list and a stable fingerprint of the
 * set. No I/O, no clock, no globals — everything arrives through the arguments.
 */

import { susFindings } from './sus.ts';
import { firstInstantMs, instantMs, isoFromMs, latestInstantMs } from './time.ts';
import {
  isTerminalStatus,
  livenessLedgerOf,
  WARDEN_LABEL,
  type WardenLivenessLedger,
  type WardenSessionStatus,
  type WardenSessionView,
} from './types.ts';

export type WardenAnomalyKind =
  | 'dead_monitor'
  | 'unattended_question'
  | 'abandoned_wreckage'
  | 'quota_reset_passed'
  | 'declared_wait_overdue'
  | 'peer_wait_unanswerable'
  | 'sus_thinking'
  | 'sus_subprocess'
  | 'provider_unavailable';

export interface WardenAnomaly {
  readonly kind: WardenAnomalyKind;
  readonly sessionId: string;
  /** Fleet-wide anomalies use a stable non-session identity for dedup. */
  readonly fleetKey?: string;
  /** Provider-outage diagnostics: the anomaly stays ONE fleet item even when
   *  many session snapshots corroborate it. */
  readonly provider?: string;
  readonly affectedSessionIds?: readonly string[];
  readonly teammate?: string;
  readonly label?: string;
  readonly status: WardenSessionStatus;
  /** Human-readable one-liner for the report and the CLI. */
  readonly detail: string;
  /** The instant the anomaly is anchored to (idle-since, finished-at, …). */
  readonly since?: string;
  /** Whole minutes spent in the anomalous state, when known. */
  readonly idleMinutes?: number;
  /** Sus anomalies get ONE assigned warden each rather than the shared triage
   *  session; that warden may act on this session only. */
  readonly assignedWarden?: boolean;
  /** Liveness snapshot for sus anomalies — the investigation's starting point. */
  readonly ledger?: WardenLivenessLedger;
}

export interface WardenDetectResult {
  readonly anomalies: readonly WardenAnomaly[];
  /** Stable identity of the anomaly SET (kind + session, order-independent) —
   *  used to suppress a repeat escalation for an unchanged situation. Empty
   *  when there are no anomalies. */
  readonly fingerprint: string;
}

export interface WardenDetectOptions {
  /** A waiting session idle at least this long is an unanswered question. */
  readonly unattendedMs: number;
  /** A failed or stalled session that entered its terminal state within this
   *  window is fresh wreckage worth flagging; older terminal sessions are the
   *  activity log's problem, not the warden's. */
  readonly terminalWindowMs: number;
  /** Sus: thinking with no transcript growth this long (seconds). */
  readonly susThinkingSeconds: number;
  /** Sus: a continuous subprocess episode this long (seconds). */
  readonly susSubprocessSeconds: number;
}

/** When an open-ended declared wait is force-woken by the daemon. Single
 *  definition: the daemon imports it for its own backstop so the detector and
 *  the wake can never drift apart — a warden that flagged waits before the
 *  daemon woke them would report every legitimate park. */
export const WAITING_BACKSTOP_MS = 4 * 60 * 60_000;

/** A sweep observes sessions still live enough for a warden action. Terminal
 *  history belongs to the activity log. Kept separate from detection so callers
 *  inspecting a saved historical snapshot may still call `detectAnomalies`. */
export const WARDEN_SCANNABLE_STATUSES: readonly WardenSessionStatus[] = [
  'running',
  'thinking',
  'tool_running',
  'awaiting_question',
  'awaiting_user',
  'interrupted',
  'rate_limited',
  'retrying',
  'waiting',
];

export function isWardenScannableStatus(status: WardenSessionStatus): boolean {
  return WARDEN_SCANNABLE_STATUSES.includes(status);
}

/** Statuses that MUST have a live monitor handle. */
const ACTIVE_MONITORED: readonly WardenSessionStatus[] = ['running', 'thinking', 'tool_running'];
/** Waiting statuses that, when idle too long, mean nobody answered. */
const WAITING_IDLE: readonly WardenSessionStatus[] = ['awaiting_question', 'awaiting_user', 'waiting'];

/**
 * True when the view is a warden or descends from one.
 *
 * The walk resolves parents against the FULL fleet index, not the (possibly
 * live-only) sweep slice: a warden that has already finished still shields the
 * children it spawned, and looking it up in the slice alone would silently
 * expose them to escalation.
 */
function inWardenLineage(view: WardenSessionView, fleet: ReadonlyMap<string, WardenSessionView>): boolean {
  const seen = new Set<string>();
  let current: WardenSessionView | undefined = view;
  while (current !== undefined && !seen.has(current.config.id)) {
    seen.add(current.config.id);
    if (current.config.label === WARDEN_LABEL) return true;
    current = current.config.parent === undefined ? undefined : fleet.get(current.config.parent);
  }
  return false;
}

/**
 * Deadline a declared wait should have been woken by, or `undefined` when the
 * wait carries no usable anchor.
 *
 * An open-ended wait has no deadline of its own, so it is judged against the
 * daemon's backstop measured from `since`. A wait whose `since` is missing or
 * unparseable yields no deadline at all: fabricating one from epoch zero would
 * report every such park as overdue.
 */
export function declaredWaitDeadlineMs(
  wait: { readonly since?: string; readonly until?: string },
  backstopMs = WAITING_BACKSTOP_MS,
): number | undefined {
  const until = instantMs(wait.until);
  if (until !== undefined) return until;
  const since = instantMs(wait.since);
  return since === undefined ? undefined : since + backstopMs;
}

export function detectAnomalies(
  sessions: readonly WardenSessionView[],
  nowMs: number,
  options: WardenDetectOptions,
  /** Full fleet lookup when `sessions` is deliberately live-only. */
  knownSessions: readonly WardenSessionView[] = sessions,
): WardenDetectResult {
  const anomalies: WardenAnomaly[] = [];
  const fleet = new Map(knownSessions.map(item => [item.config.id, item]));
  for (const view of sessions) fleet.set(view.config.id, view);

  for (const view of sessions) {
    const { config, state } = view;

    // NO RECURSION: never flag a warden or anything it spawned — that would
    // make the warden escalate against itself forever.
    if (inWardenLineage(view, fleet)) continue;

    // IMMORTAL INTERACTIVE: an interactive session is a human's terminal. Every
    // anomaly class answers "is anybody looking after this?" and for
    // interactive the answer is yes, by construction. Skipping the session
    // whole (rather than per-kind) is what makes "never flagged" auditable — a
    // new anomaly class cannot silently start catching interactive sessions.
    if (config.mode === 'interactive') continue;

    const base = {
      sessionId: config.id,
      teammate: config.teammate,
      label: config.label,
      status: state.status,
    } as const;

    if (ACTIVE_MONITORED.includes(state.status) && !view.hasLiveMonitor) {
      anomalies.push({
        ...base,
        kind: 'dead_monitor',
        detail: `status ${state.status} but no live monitor handle (the daemon is not watching this turn)`,
      });
    }

    const declaredWait = state.waiting;
    const settled = isTerminalStatus(state.status);

    // A DECLARED wait is deliberate, not unattended: the teammate said what it
    // is waiting for and the daemon holds the deadline. It becomes an anomaly
    // only once that deadline has visibly passed without a wake.
    if (declaredWait !== undefined && !settled) {
      const deadline = declaredWaitDeadlineMs(declaredWait);
      if (deadline !== undefined && nowMs - deadline >= options.unattendedMs) {
        anomalies.push({
          ...base,
          kind: 'declared_wait_overdue',
          detail: `declared wait is past ${declaredWait.until ?? 'its open-ended backstop'} and still waiting — the wake did not fire`,
          since: isoFromMs(deadline),
        });
      }
    }

    // PEER WAIT WHOSE PEER CAN NEVER ANSWER. `signal waiting --peer X` is
    // healthy for as long as X might still reply. Once X is terminal it cannot,
    // and the waiter is parked on an event that will never happen — reflex
    // suspended, ceiling suspended — until the backstop finally wakes it hours
    // later. Flagged with no idle grace: the evidence is categorical, not a
    // guess from elapsed time.
    if (declaredWait?.peer !== undefined && !settled && declaredWait.peer !== config.id) {
      const peer = fleet.get(declaredWait.peer);
      const peerName = declaredWait.peerName ?? declaredWait.peer;
      if (peer === undefined || isTerminalStatus(peer.state.status)) {
        anomalies.push({
          ...base,
          kind: 'peer_wait_unanswerable',
          detail:
            peer === undefined
              ? `parked awaiting a reply from ${peerName}, which is not a known session — nothing can wake it before the backstop`
              : `parked awaiting a reply from ${peerName}, which is ${peer.state.status} and can never reply`,
          since: declaredWait.since,
          // One assigned warden: the fix is judgement (re-ask someone else,
          // continue without the answer, or stop), not a mechanical retry.
          assignedWarden: true,
        });
      }
    }

    if (declaredWait === undefined && WAITING_IDLE.includes(state.status)) {
      const anchor =
        latestInstantMs(state.lastActivityAt, state.lastTranscriptAt, state.lastPaneAt, state.startedAt) ??
        instantMs(config.createdAt);
      const idleMs = anchor === undefined ? Number.POSITIVE_INFINITY : nowMs - anchor;
      if (idleMs >= options.unattendedMs) {
        const idleMinutes = Number.isFinite(idleMs) ? Math.floor(idleMs / 60_000) : undefined;
        anomalies.push({
          ...base,
          kind: 'unattended_question',
          detail: `${state.status} with no activity for ${idleMinutes ?? 'the whole session'}${idleMinutes === undefined ? '' : 'm'} — a question nobody answered`,
          since: anchor === undefined ? undefined : isoFromMs(anchor),
          idleMinutes,
          assignedWarden: true,
        });
      }
    }

    // A done marker for the current turn means the work FINISHED — the failed
    // status is a bookkeeping gap (the pane died before the transition), not
    // wreckage. Resuming it would make the teammate redo a finished turn.
    if ((state.status === 'failed' || state.status === 'stalled') && view.hasDoneMarker !== true) {
      // Priority order, NOT the latest of the three: an unrelated config write
      // must not make ancient wreckage look like it failed moments ago and so
      // keep it inside the sweep window forever.
      const finishedMs = firstInstantMs(state.finishedAt, state.lastActivityAt, config.updatedAt);
      if (finishedMs !== undefined && nowMs - finishedMs <= options.terminalWindowMs) {
        anomalies.push({
          ...base,
          kind: 'abandoned_wreckage',
          detail: `${state.status} within the sweep window and never resumed or stopped${state.reason === undefined ? '' : `: ${state.reason}`}`,
          since: isoFromMs(finishedMs),
        });
      }
    }

    // Sus list: alive but weird. Only meaningful while a monitor is actually
    // watching — an unmonitored session is already a dead_monitor anomaly and
    // its ledger is stale by construction, so classifying it sus as well would
    // assign a second warden to the same fault.
    if (ACTIVE_MONITORED.includes(state.status) && view.hasLiveMonitor) {
      const ledger = livenessLedgerOf(state);
      for (const finding of susFindings(ledger, nowMs, {
        susThinkingSeconds: options.susThinkingSeconds,
        susSubprocessSeconds: options.susSubprocessSeconds,
        tickSeconds: config.intervalSeconds,
        anchorMs: instantMs(state.startedAt),
      })) {
        anomalies.push({
          ...base,
          kind: finding.kind,
          detail: `${finding.detail} — assign a warden to investigate`,
          idleMinutes: finding.forSeconds === undefined ? undefined : Math.floor(finding.forSeconds / 60),
          assignedWarden: true,
          ledger,
        });
      }
    }

    if (state.status === 'rate_limited') {
      const resetAt = state.quota?.resetAt;
      if (typeof resetAt === 'number' && Number.isFinite(resetAt) && resetAt <= nowMs) {
        anomalies.push({
          ...base,
          kind: 'quota_reset_passed',
          detail: 'rate_limited but the quota reset time has passed and it was never resumed',
          since: isoFromMs(resetAt),
        });
      }
    }
  }

  return { anomalies, fingerprint: fingerprintAnomalies(anomalies) };
}

/**
 * Order-independent identity of an anomaly set. Two sweeps with the same
 * (kind, session) pairs fingerprint identically regardless of ordering or of
 * volatile detail and timestamp fields.
 */
export function fingerprintAnomalies(anomalies: readonly WardenAnomaly[]): string {
  return anomalies
    .map(anomaly => `${anomaly.kind}:${anomaly.fleetKey ?? anomaly.sessionId}`)
    .toSorted()
    .join('|');
}
