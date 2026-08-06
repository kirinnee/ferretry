/**
 * The fleet-wide warden attention projection.
 *
 * A READ-ONLY view over the per-session attention boards, joined with the
 * warden's recent verdicts, the current anomalies, and the daemon's assignment,
 * queue and failover state. It answers exactly two human questions: which agent
 * needs the human, and why.
 *
 * It is a VIEW, not a second attention store. It never writes attention data and
 * never invents a resolution workflow — acting on a row happens on the
 * per-session surface reachable through its session id.
 *
 * ═══ ORDINARY ATTENTION IS SHOWN, NEVER JUDGED ═══
 *
 * A blocked task, a permission ask a person raised, any free-form row: these
 * have no warden selector, so no verdict can be matched to them and none is
 * invented. Such a row is listed with its own words and NOTHING ELSE — no
 * judgement, no recommendation. The join is legitimate; restating a human's own
 * request as a warden-shaped "Recommended action: nudge" is not, and that is
 * ordinary session Attention becoming warden output.
 *
 * Pure: the clock arrives as `now`; everything else arrives as arguments.
 */

import { wardenAnomalySubject, type WardenAnomaly, type WardenAnomalyKind } from './detect.ts';
import { instantMs, isoFromMs } from './time.ts';
import { WARDEN_TERMINAL_STATUSES, type WardenSessionStatus } from './types.ts';
import {
  parseWardenAnomalyKind,
  parseWardenVerdictSourceRef,
  type WardenRecommendation,
  type WardenVerdict,
  type WardenVerdictKind,
  type WardenVerdictSourceIdentity,
} from './verdicts.ts';

export type WardenJudgementState = 'judged' | 'pending' | 'queued' | 'failed' | 'none';

/** A verdict as the projection consumes it: the parsed report row plus, when
 *  the daemon recorded one, the sidecar facts naming who ran the check. */
export type JudgedVerdict = WardenVerdict & { readonly spawn?: WardenJudgeProvenance };

/** Who ran the check, when the report carried provenance. */
export interface WardenJudgeProvenance {
  readonly wardenSessionId?: string;
  readonly agent?: string;
  readonly model?: string;
  readonly harness?: string;
}

export interface WardenJudgement {
  readonly state: WardenJudgementState;
  /** The classified verdict, when a report exists. */
  readonly verdict?: WardenVerdictKind;
  /** Why — never blank. A state with no human-readable reason is worse than
   *  useless on a surface whose whole job is explaining. */
  readonly reason: string;
  readonly judgedBy?: WardenJudgeProvenance;
  /** What the judgement (or the failure it stands in for) is anchored to. */
  readonly at?: string;
  readonly reportPath?: string;
  readonly recommendation?: WardenRecommendation;
  /** The verdict predates this waiting item — it judged an earlier situation. */
  readonly stale?: boolean;
}

/** The attention sources a fleet row can come from. `warden-anomaly` marks a
 *  synthetic row for a current anomaly with no board record. */
export type FleetAttentionSource = 'task' | 'question' | 'agent-raised' | 'warden-anomaly';

export type AttentionRaisedBy = 'human' | 'agent' | 'daemon';

/** One row of a session's attention board, as this projection reads it. */
export interface AttentionItem {
  readonly id: string;
  readonly source: 'task' | 'question' | 'agent-raised';
  readonly subject: string;
  readonly why: string;
  readonly context?: string;
  readonly waitingSince: string;
  readonly howToResolve: string;
  readonly raisedBy?: AttentionRaisedBy;
  readonly raisedByName?: string;
  /** Identity of whatever created the row; the selector for a warden verdict. */
  readonly sourceRef?: string;
}

export interface FleetAttentionItem {
  readonly sessionId: string;
  readonly teammate?: string;
  readonly label?: string;
  readonly sessionStatus?: WardenSessionStatus;
  /** The attention id, or `anomaly:<kind>:<sessionId>` for a synthetic row. */
  readonly id: string;
  readonly source: FleetAttentionSource;
  readonly subject: string;
  readonly why: string;
  readonly context?: string;
  /** Oldest waiting first across the whole fleet. */
  readonly waitingSince: string;
  readonly howToResolve: string;
  /**
   * One named, executable next step — ABSENT on a row the warden has no
   * identity for.
   *
   * A task row, a permission ask a person raised, or any other ordinary session
   * Attention carries no warden selector, so there is no verdict to report and
   * nothing to derive a next step from. Synthesising one turned a human's own
   * request into a warden-shaped "Recommended action: nudge", which is exactly
   * the ordinary Attention becoming warden output that this projection must not
   * produce. Absent is the honest answer, and the reader renders the row without
   * a warden opinion.
   */
  readonly recommendation?: WardenRecommendation;
  readonly raisedBy?: AttentionRaisedBy;
  readonly raisedByName?: string;
  /** Absent for the same reason `recommendation` is: no warden identity, no
   *  warden judgement. */
  readonly judgement?: WardenJudgement;
  /** True for a synthesised anomaly row with no board record. */
  readonly fromAnomaly?: boolean;
  /** Set for a provider-wide anomaly expanded to each affected session. */
  readonly provider?: string;
}

/**
 * The four "no rows" situations, which must never collapse into one another:
 *
 * - `items` — rows exist; someone needs the human.
 * - `clean-sweep` — a sweep ran, every board read cleanly, nothing is waiting.
 * - `degraded` — a sweep ran but something could not be read, so a waiting agent
 *   may be HIDDEN. Never a clean all-clear.
 * - `no-sweep` — nothing has run yet; we simply do not know.
 */
export type WardenAttentionOutcome = 'items' | 'clean-sweep' | 'degraded' | 'no-sweep';

export interface WardenDegraded {
  readonly since?: string;
  readonly reason: string;
}

export interface BoardParseFailure {
  readonly sessionId: string;
  readonly parseErrors: number;
}

/** The finite recent-verdict window every judgement on this view was drawn from. */
export interface WardenVerdictCoverage {
  readonly limit: number;
  /** True when at least one older verdict exists outside the visible window. */
  readonly truncated: boolean;
}

export interface WardenAttentionView {
  readonly generatedAt: string;
  readonly lastSweepAt?: string;
  readonly outcome: WardenAttentionOutcome;
  /** Fleet-level banner: exhaustion, an overdue sweep, or unreadable boards. */
  readonly wardenDegraded?: WardenDegraded;
  readonly items: readonly FleetAttentionItem[];
  readonly boardsWithParseErrors: readonly BoardParseFailure[];
  readonly verdictCoverage: WardenVerdictCoverage;
}

/** The minimal session shape the projection reads. */
export interface FleetSessionLike {
  readonly config: { readonly id: string; readonly teammate?: string; readonly name?: string; readonly label?: string };
  readonly state: { readonly status?: WardenSessionStatus };
}

/** One session's parsed board, as the adapter hands it over. */
export interface AttentionBoardInput {
  readonly sessionId: string;
  readonly parseErrors: number;
  readonly items: readonly AttentionItem[];
}

export interface WardenAssignment {
  readonly wardenId?: string;
  readonly kinds?: readonly string[];
  readonly reportPath?: string;
}

/** The slice of the durable warden state this projection consumes. */
export interface WardenAttentionState {
  readonly lastSweepAt?: string;
  /** Live assigned wardens, keyed by TARGET session id. */
  readonly assignments?: Readonly<Record<string, WardenAssignment | undefined>>;
  /** Suspect targets deferred to the queue this sweep. */
  readonly assignedQueue?: readonly { readonly sessionId?: string; readonly kind?: string }[];
  /** Set while EVERY warden account is ineligible, so no judgement can land. */
  readonly exhaustedSince?: string;
}

export interface WardenAttentionInput {
  /** Wall-clock milliseconds, injected so the builder stays deterministic. */
  readonly now: number;
  readonly sessions: readonly FleetSessionLike[];
  readonly boards: readonly AttentionBoardInput[];
  readonly verdicts: readonly JudgedVerdict[];
  readonly verdictCoverage?: WardenVerdictCoverage;
  readonly anomalies: readonly WardenAnomaly[];
  readonly wardenState: WardenAttentionState;
  /** Sweep cadence; a sweep older than three times this reads as degraded. */
  readonly sweepIntervalMinutes?: number;
}

export const WARDEN_ATTENTION_VERDICT_LIMIT = 100;
const DEFAULT_SWEEP_INTERVAL_MINUTES = 5;
const STALE_SWEEP_MULTIPLE = 3;

const PROVIDER_SOURCE_PREFIX = 'provider-unavailable:';

/** A board row for a session in one of these states is finished history: the
 *  daemon already killed its pane. A durable board must never resurrect a dead
 *  session into the human's live action list. DERIVED from the one owner of
 *  "which statuses a session never leaves"; a second spelling here would drift
 *  the moment a status is added. */
const TERMINAL_ATTENTION_STATUSES: ReadonlySet<string> = new Set<string>(WARDEN_TERMINAL_STATUSES);

function isTerminalAttentionStatus(status: string | undefined): boolean {
  return status !== undefined && TERMINAL_ATTENTION_STATUSES.has(status);
}

/** Composite map keys. JSON-encoding the parts makes the key unambiguous by
 *  construction: a report path may contain any character a filesystem allows,
 *  so no single-character separator is safe to concatenate on. */
const anomalyKey = (sessionId: string, kind: WardenAnomalyKind): string => JSON.stringify([sessionId, kind]);
const reportKey = (sessionId: string, reportPath: string): string => JSON.stringify([sessionId, reportPath]);
const reportBlockKey = (sessionId: string, reportPath: string, kind: WardenAnomalyKind): string =>
  JSON.stringify([sessionId, reportPath, kind]);

/** Epoch milliseconds for sorting and comparison; unset and unreadable both
 *  sort as the beginning of time, which is where an unknown wait belongs. */
const sortableMs = (value: string | undefined): number => instantMs(value) ?? 0;

/**
 * Which warden verdict, if any, may judge this board row.
 *
 * Only a question row and a daemon-created agent-raised row carry a warden or
 * provider identity. A task, permission, or free-form row has no verdict
 * selector even when a coincidental source reference happens to resemble one —
 * otherwise one incident would judge unrelated rows.
 */
export function verdictMatchForItem(item: AttentionItem): WardenVerdictSourceIdentity | undefined {
  if (item.source === 'question') return { anomalyKind: 'unattended_question' };
  if (item.source !== 'agent-raised') return undefined;
  const sourceRef = item.sourceRef;
  if (sourceRef === undefined) return undefined;
  if (sourceRef.startsWith(PROVIDER_SOURCE_PREFIX)) return { anomalyKind: 'provider_unavailable' };
  if (sourceRef.startsWith('warden:')) return parseWardenVerdictSourceRef(sourceRef);
  return undefined;
}

/** Who ran the check, from the report's sidecar. A report written before the
 *  daemon recorded provenance is still judged; it simply cannot be attributed. */
function provenanceOf(verdict: JudgedVerdict): WardenJudgeProvenance | undefined {
  const spawn = verdict.spawn;
  if (spawn === undefined) return undefined;
  const provenance: WardenJudgeProvenance = {
    ...(spawn.wardenSessionId === undefined ? {} : { wardenSessionId: spawn.wardenSessionId }),
    ...(spawn.agent === undefined ? {} : { agent: spawn.agent }),
    ...(spawn.model === undefined ? {} : { model: spawn.model }),
    ...(spawn.harness === undefined ? {} : { harness: spawn.harness }),
  };
  return Object.keys(provenance).length > 0 ? provenance : undefined;
}

/** The one executable next step shown on a row, when the report did not name
 *  one itself. */
export function fallbackRecommendation(
  judgement: WardenJudgement,
  status: string | undefined,
  kind: WardenAnomalyKind | undefined,
): WardenRecommendation {
  if (judgement.recommendation !== undefined) return judgement.recommendation;
  if (judgement.state === 'judged') {
    switch (judgement.verdict) {
      case 'cleared':
        return { action: 'leave', reason: 'The warden found the work healthy; no action is needed.' };
      case 'nudged':
        return { action: 'leave', reason: 'The warden already nudged this session; let it respond.' };
      case 'revived':
        return { action: 'leave', reason: 'The warden already resumed this session; let it continue.' };
      case 'killed':
        return { action: 'leave', reason: 'The warden already stopped this session; no further action is needed.' };
      default:
        break;
    }
  }
  if (status === 'interrupted' || kind === 'dead_monitor') {
    return {
      action: 'restart',
      reason: 'The session is not actively running; restart it to continue from its saved context.',
    };
  }
  return {
    action: 'nudge',
    reason:
      judgement.state === 'pending'
        ? 'A warden is checking it; nudge only if it needs an immediate response.'
        : 'Ask the session to restate its blocker or continue.',
  };
}

/** The verdict indexes, built once per projection. Identity is exact — target
 *  plus anomaly kind, or target plus report path — because a session-wide index
 *  would let one incident judge unrelated rows and would hide simultaneous
 *  anomaly classes. */
function indexVerdicts(verdicts: readonly JudgedVerdict[]): {
  readonly byAnomaly: ReadonlyMap<string, WardenVerdict>;
  readonly byReport: ReadonlyMap<string, WardenVerdict>;
  readonly byReportBlock: ReadonlyMap<string, WardenVerdict>;
} {
  const byAnomaly = new Map<string, WardenVerdict>();
  const byReport = new Map<string, WardenVerdict>();
  const byReportBlock = new Map<string, WardenVerdict>();

  const keepNewest = (index: Map<string, WardenVerdict>, key: string, verdict: WardenVerdict): void => {
    const previous = index.get(key);
    if (previous === undefined || sortableMs(verdict.at) > sortableMs(previous.at)) index.set(key, verdict);
  };

  for (const verdict of verdicts) {
    const sessionId = verdict.targetSession;
    if (sessionId === undefined) continue;

    // A needs-human request is emitted for one block only. When a fleet report
    // holds several blocks for the same session the source reference cannot say
    // which, so prefer the needs-human one rather than attaching a cleared
    // sibling and reading as an all-clear.
    const key = reportKey(sessionId, verdict.reportPath);
    const previous = byReport.get(key);
    const newer = previous === undefined || sortableMs(verdict.at) > sortableMs(previous.at);
    const sameInstantButLouder =
      previous !== undefined &&
      sortableMs(verdict.at) === sortableMs(previous.at) &&
      previous.verdict !== 'needs_human' &&
      verdict.verdict === 'needs_human';
    if (newer || sameInstantButLouder) byReport.set(key, verdict);

    if (verdict.anomalyKind !== undefined) {
      keepNewest(byAnomaly, anomalyKey(sessionId, verdict.anomalyKind), verdict);
      keepNewest(byReportBlock, reportBlockKey(sessionId, verdict.reportPath, verdict.anomalyKind), verdict);
    }
  }

  return { byAnomaly, byReport, byReportBlock };
}

export function buildWardenAttentionView(input: WardenAttentionInput): WardenAttentionView {
  const { now, boards, verdicts, anomalies, wardenState } = input;
  const verdictCoverage = input.verdictCoverage ?? { limit: WARDEN_ATTENTION_VERDICT_LIMIT, truncated: false };
  const sessionsById = new Map(input.sessions.map(session => [session.config.id, session]));
  const { byAnomaly, byReport, byReportBlock } = indexVerdicts(verdicts);

  const assignedAnomalies = new Set<string>();
  const assignedReports = new Set<string>();
  for (const [sessionId, assignment] of Object.entries(wardenState.assignments ?? {})) {
    for (const rawKind of assignment?.kinds ?? []) {
      const kind = parseWardenAnomalyKind(rawKind);
      if (kind !== undefined) assignedAnomalies.add(anomalyKey(sessionId, kind));
    }
    if (assignment?.reportPath !== undefined) assignedReports.add(reportKey(sessionId, assignment.reportPath));
  }

  const queuedAnomalies = new Set<string>();
  for (const queued of wardenState.assignedQueue ?? []) {
    const kind = parseWardenAnomalyKind(queued.kind);
    if (queued.sessionId !== undefined && kind !== undefined) queuedAnomalies.add(anomalyKey(queued.sessionId, kind));
  }

  const { exhaustedSince } = wardenState;

  const matchingVerdict = (sessionId: string, match: WardenVerdictSourceIdentity): WardenVerdict | undefined => {
    if (match.reportPath !== undefined && match.anomalyKind !== undefined)
      return byReportBlock.get(reportBlockKey(sessionId, match.reportPath, match.anomalyKind));
    if (match.anomalyKind !== undefined) return byAnomaly.get(anomalyKey(sessionId, match.anomalyKind));
    if (match.reportPath !== undefined) return byReport.get(reportKey(sessionId, match.reportPath));
    return undefined;
  };

  const isAssigned = (sessionId: string, match: WardenVerdictSourceIdentity): boolean => {
    const byPath = match.reportPath !== undefined && assignedReports.has(reportKey(sessionId, match.reportPath));
    const byKind = match.anomalyKind !== undefined && assignedAnomalies.has(anomalyKey(sessionId, match.anomalyKind));
    if (match.reportPath !== undefined && match.anomalyKind !== undefined) return byPath && byKind;
    return byPath || byKind;
  };

  const computeJudgement = (
    sessionId: string,
    match: WardenVerdictSourceIdentity,
    waitingSince?: string,
  ): WardenJudgement => {
    const verdict = matchingVerdict(sessionId, match);
    if (verdict !== undefined) {
      const judgedBy = provenanceOf(verdict);
      const shared = {
        reason: verdict.reason ?? 'A warden reached a verdict on this session.',
        ...(judgedBy === undefined ? {} : { judgedBy }),
        at: verdict.at,
        reportPath: verdict.reportPath,
        ...(verdict.recommendation === undefined ? {} : { recommendation: verdict.recommendation }),
      };
      if (verdict.verdict === 'unknown') {
        return {
          ...shared,
          state: 'failed',
          verdict: 'unknown',
          reason: verdict.reason ?? 'The warden report could not be classified.',
        };
      }
      // A row created by one exact report is judged by that report, whatever
      // the millisecond ordering of the two writes. Only a kind match uses
      // time, where a later flag really is a new recurrence of the same class.
      //
      // A kind match with NO anchor cannot be shown to be current, and
      // "cannot be shown to be current" must resolve to stale, not to fresh.
      // The other way round, any clearance still inside the verdict window
      // silently covers a situation that is happening right now — which is how
      // a wedged agent comes to be reported as an all-clear.
      const stale =
        match.anomalyKind !== undefined &&
        match.reportPath === undefined &&
        (waitingSince === undefined || sortableMs(verdict.at) < sortableMs(waitingSince));
      return { ...shared, state: 'judged', verdict: verdict.verdict, ...(stale ? { stale: true } : {}) };
    }

    if (isAssigned(sessionId, match)) {
      return { state: 'pending', reason: 'A warden is investigating this anomaly now.' };
    }
    if (match.anomalyKind !== undefined && queuedAnomalies.has(anomalyKey(sessionId, match.anomalyKind))) {
      return { state: 'queued', reason: 'This anomaly is queued for a warden.' };
    }
    if (exhaustedSince !== undefined) {
      return {
        state: 'failed',
        reason: 'No warden could run — every warden account is exhausted.',
        at: exhaustedSince,
      };
    }
    if (verdictCoverage.truncated) {
      return {
        state: 'none',
        reason: `No matching judgement was found in the recent ${verdictCoverage.limit}-verdict window.`,
      };
    }
    return { state: 'none', reason: 'No matching warden judgement yet.' };
  };

  const items: FleetAttentionItem[] = [];
  const coveredAnomalies = new Set<string>();

  // 1) Every open board row — the fleet-wide "who needs the human".
  for (const board of boards) {
    const session = sessionsById.get(board.sessionId);
    if (isTerminalAttentionStatus(session?.state.status)) continue;

    for (const item of board.items) {
      const match = verdictMatchForItem(item);
      const exact = match === undefined ? undefined : matchingVerdict(board.sessionId, match);
      if (match?.anomalyKind !== undefined) coveredAnomalies.add(anomalyKey(board.sessionId, match.anomalyKind));
      if (match?.reportPath !== undefined && match.anomalyKind === undefined && exact?.anomalyKind !== undefined)
        coveredAnomalies.add(anomalyKey(board.sessionId, exact.anomalyKind));

      // ORDINARY ATTENTION GETS NO WARDEN OPINION. A row with no warden
      // selector was never judged and never could be, so it carries neither a
      // judgement nor a recommendation — see `FleetAttentionItem`.
      const judgement = match === undefined ? undefined : computeJudgement(board.sessionId, match, item.waitingSince);
      const teammate = session?.config.teammate ?? session?.config.name;
      const provider =
        item.sourceRef?.startsWith(PROVIDER_SOURCE_PREFIX) === true
          ? item.sourceRef.slice(PROVIDER_SOURCE_PREFIX.length)
          : undefined;

      items.push({
        sessionId: board.sessionId,
        ...(teammate === undefined ? {} : { teammate }),
        ...(session?.config.label === undefined ? {} : { label: session.config.label }),
        ...(session?.state.status === undefined ? {} : { sessionStatus: session.state.status }),
        id: item.id,
        source: item.source,
        subject: item.subject,
        why: item.why,
        ...(item.context === undefined ? {} : { context: item.context }),
        waitingSince: item.waitingSince,
        howToResolve: item.howToResolve,
        ...(item.raisedBy === undefined ? {} : { raisedBy: item.raisedBy }),
        ...(item.raisedByName === undefined ? {} : { raisedByName: item.raisedByName }),
        ...(judgement === undefined
          ? {}
          : {
              recommendation: fallbackRecommendation(judgement, session?.state.status, match?.anomalyKind),
              judgement,
            }),
        ...(provider === undefined || provider === '' ? {} : { provider }),
      });
    }
  }

  // 2) Current anomalies with no board record, expanded to the sessions they
  //    affect — but only where the warden reached no confident, current
  //    judgement, so a cleared anomaly stays quiet while a pending, queued,
  //    failed or unjudged one can never silently read as fine.
  const seenAnomalyRows = new Set<string>();
  for (const anomaly of anomalies) {
    const targets =
      anomaly.kind === 'provider_unavailable'
        ? [...new Set([anomaly.sessionId, ...(anomaly.affectedSessionIds ?? [])])]
        : [anomaly.sessionId];

    for (const target of targets) {
      if (target === '' || coveredAnomalies.has(anomalyKey(target, anomaly.kind))) continue;
      const session = sessionsById.get(target);
      const targetStatus = session?.state.status ?? anomaly.status;
      if (isTerminalAttentionStatus(targetStatus)) continue;

      const rowId = `anomaly:${anomaly.kind}:${target}`;
      if (seenAnomalyRows.has(rowId)) continue;

      const judgement = computeJudgement(target, { anomalyKind: anomaly.kind }, anomaly.since);
      // A current judgement covers the anomaly and stays quiet. A STALE verdict
      // judged an earlier situation and does not, so a re-flagged agent never
      // reads as fine. `needs_human` is the opposite of an all-clear: keep
      // surfacing it until the board row exists, or a delayed board write would
      // briefly turn the warden's explicit request into silence.
      if (judgement.state === 'judged' && judgement.verdict !== 'needs_human' && judgement.stale !== true) continue;
      seenAnomalyRows.add(rowId);

      const teammate = session?.config.teammate ?? session?.config.name ?? anomaly.teammate;
      const label = session?.config.label ?? anomaly.label;
      items.push({
        sessionId: target,
        ...(teammate === undefined ? {} : { teammate }),
        ...(label === undefined ? {} : { label }),
        ...(targetStatus === undefined ? {} : { sessionStatus: targetStatus }),
        id: rowId,
        source: 'warden-anomaly',
        subject: wardenAnomalySubject(anomaly.kind),
        why: anomaly.detail,
        waitingSince: anomaly.since ?? wardenState.lastSweepAt ?? isoFromMs(now),
        howToResolve: 'Open the session and decide what to do.',
        recommendation: fallbackRecommendation(judgement, targetStatus, anomaly.kind),
        judgement,
        fromAnomaly: true,
        ...(anomaly.provider === undefined ? {} : { provider: anomaly.provider }),
      });
    }
  }

  // Oldest waiting first, with a deterministic tie-break so the order is stable
  // between polls.
  const ordered = items.toSorted(
    (left, right) =>
      sortableMs(left.waitingSince) - sortableMs(right.waitingSince) ||
      left.sessionId.localeCompare(right.sessionId) ||
      left.id.localeCompare(right.id),
  );

  const boardsWithParseErrors = boards
    .filter(board => board.parseErrors > 0)
    .map(board => ({ sessionId: board.sessionId, parseErrors: board.parseErrors }));

  const intervalMinutes = input.sweepIntervalMinutes ?? DEFAULT_SWEEP_INTERVAL_MINUTES;
  const lastSweep = instantMs(wardenState.lastSweepAt);
  const sweepStale = lastSweep !== undefined && now - lastSweep > intervalMinutes * STALE_SWEEP_MULTIPLE * 60_000;

  const wardenDegraded = degradedBanner({
    exhaustedSince,
    sweepStale,
    lastSweepAt: wardenState.lastSweepAt,
    unreadableBoards: boardsWithParseErrors.length > 0,
  });

  // An unreadable board can HIDE a waiting agent, so a sweep with parse errors
  // and no visible rows must not read as a clean all-clear — that would tell the
  // human "nobody needs you" over a board we could not open. `no-sweep` stays
  // reserved for "nothing ran at all".
  const outcome: WardenAttentionOutcome =
    ordered.length > 0
      ? 'items'
      : wardenDegraded !== undefined
        ? 'degraded'
        : wardenState.lastSweepAt === undefined
          ? 'no-sweep'
          : 'clean-sweep';

  return {
    generatedAt: isoFromMs(now),
    ...(wardenState.lastSweepAt === undefined ? {} : { lastSweepAt: wardenState.lastSweepAt }),
    outcome,
    ...(wardenDegraded === undefined ? {} : { wardenDegraded }),
    items: ordered,
    boardsWithParseErrors,
    verdictCoverage,
  };
}

function degradedBanner(evidence: {
  readonly exhaustedSince?: string;
  readonly sweepStale: boolean;
  readonly lastSweepAt?: string;
  readonly unreadableBoards: boolean;
}): WardenDegraded | undefined {
  if (evidence.exhaustedSince !== undefined) {
    return {
      since: evidence.exhaustedSince,
      reason: 'All warden accounts are exhausted — new judgements are paused.',
    };
  }
  if (evidence.sweepStale) {
    return {
      ...(evidence.lastSweepAt === undefined ? {} : { since: evidence.lastSweepAt }),
      reason: 'Warden sweeps are overdue — judgements may be out of date.',
    };
  }
  if (evidence.unreadableBoards) {
    return { reason: 'Some attention boards could not be read — a waiting agent may be hidden.' };
  }
  return undefined;
}
