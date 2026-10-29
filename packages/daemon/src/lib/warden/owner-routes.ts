/**
 * WHICH STANDING FLAGS ARE THE OWNER'S TO DECIDE, AND WHY — the half of "the Warden needs you" that no
 * investigation verdict states.
 *
 * An investigation's explicit `Verdict: NEEDS_HUMAN` is one way a flag reaches the owner, and
 * `escalation.ts` reads it from the report. Every other way is a fact of the Warden's own state, and
 * this module reads it from there:
 *
 * - `held` — a confident act the owner has not let the Warden do alone (Jev's `recommends`, or an
 *   investigation's verdict act), waiting on the owner's yes;
 * - `investigation_failed` — the last investigation of this flag finished without a readable verdict;
 * - `jev` — Jev handed the flag on (unsure, not sure enough, an act it may not do alone, a failure) and
 *   no investigation can follow, because that layer is off, capped or has no login;
 * - `untriaged` — nothing could look at it: investigations cannot follow and Jev is off or capped too.
 *
 * WHAT IS NEVER THE OWNER'S, whatever else holds: a flag the Warden is still handling — blessed, its
 * subject already cleared, a Jev act still landing, an investigation running or about to (a live
 * assignment, a live fleet warden's coverage, a queue that investigations will drain) — and everything
 * while the Warden is off, since the owner turned it off. (A question a ferret is waiting on is routed
 * like any flag; `escalation.ts` skips its notification when the ferret's board already asks the owner.)
 *
 * ONE ROUTE PER FLAG, the strongest reason first, so a flag is one notification that says its best reason.
 *
 * Pure: every input is a value, the clock included.
 */

import type { WardenAction } from '@ferretry/protocol';
import { backoffHold, jevActLandingOn } from './backoff.ts';
import { isAnomalyBlessed } from './bless.ts';
import type { WardenAnomaly } from './detect.ts';
import { heldActions } from './feed.ts';
import { jevHandoffKey, type WardenJevHandoff, type WardenRuntimeState } from './state.ts';
import { instantMs } from './time.ts';
import type { WardenInvestigationRecord, WardenLayersInEffect } from './triage.ts';
import { isTerminalStatus, type WardenSessionStatus } from './types.ts';

/** Why a standing flag is in front of the owner. */
export type WardenOwnerReason =
  | { readonly kind: 'held'; readonly action: WardenAction }
  | { readonly kind: 'investigation_failed'; readonly record: WardenInvestigationRecord }
  | { readonly kind: 'jev'; readonly handoff: WardenJevHandoff; readonly layers: WardenLayersInEffect }
  | { readonly kind: 'untriaged'; readonly layers: WardenLayersInEffect };

export interface WardenOwnerRoute {
  /** The flag, exactly as this sweep's detector reported it. */
  readonly anomaly: WardenAnomaly;
  readonly reason: WardenOwnerReason;
  /**
   * When the fact that put the flag in front of the owner was recorded: what dates the notification when
   * the flag has no anchor of its own.
   */
  readonly evidenceAt?: string;
}

export interface WardenOwnerRouteInput {
  /** THIS sweep's flags: the only evidence that anything is wrong. */
  readonly anomalies: readonly WardenAnomaly[];
  readonly state: Pick<
    WardenRuntimeState,
    | 'blessings'
    | 'backoff'
    | 'assignments'
    | 'assignedQueue'
    | 'sweepCoverage'
    | 'investigations'
    | 'actions'
    | 'jevHandoffs'
  >;
  /** The layers in effect after this sweep (`triage.ts` `effectiveLayers`). */
  readonly layers: WardenLayersInEffect;
  readonly enabled: boolean;
  readonly statusOf: (sessionId: string) => WardenSessionStatus | undefined;
  /** Whether a warden session is still running: a fleet warden's coverage outlives it. */
  readonly liveWarden: (wardenSessionId: string) => boolean;
  readonly nowMs: number;
}

/** The newest investigation of this exact flag, by start. */
function newestInvestigation(
  records: readonly WardenInvestigationRecord[],
  anomaly: WardenAnomaly,
): WardenInvestigationRecord | undefined {
  let newest: WardenInvestigationRecord | undefined;
  for (const record of records) {
    if (record.scope !== 'session' || record.targetId !== anomaly.sessionId || record.anomalyKind !== anomaly.kind)
      continue;
    if (newest === undefined || (instantMs(record.startedAt) ?? 0) > (instantMs(newest.startedAt) ?? 0))
      newest = record;
  }
  return newest;
}

/**
 * Whether a finished investigation left the owner nothing to go on: no report could be read
 * (`verdict` absent) or it could not be classified (`unknown`). It must be about THIS episode — one
 * that finished before the flag began judged an earlier situation.
 */
function failedInvestigation(
  record: WardenInvestigationRecord | undefined,
  anomaly: WardenAnomaly,
): record is WardenInvestigationRecord {
  if (record?.finishedAt === undefined) return false;
  if (record.verdict !== undefined && record.verdict !== 'unknown') return false;
  const since = instantMs(anomaly.since);
  return since === undefined || (instantMs(record.finishedAt) ?? 0) >= since;
}

/** Whether the Warden itself is still on this flag, so it is not the owner's yet. */
function stillHandled(input: WardenOwnerRouteInput, anomaly: WardenAnomaly, status: WardenSessionStatus): boolean {
  const { state, nowMs } = input;
  if (isAnomalyBlessed(state.blessings ?? {}, anomaly, status, nowMs)) return true;
  if (backoffHold(state.backoff ?? {}, anomaly, nowMs, 0)?.cleared === true) return true;
  if (jevActLandingOn(state.backoff ?? {}, anomaly.sessionId, nowMs)) return true;
  // An assignment is retired the sweep its warden finishes, so one that is held is one that runs.
  if (state.assignments?.[anomaly.sessionId] !== undefined) return true;
  const coverage = state.sweepCoverage;
  return (
    coverage !== undefined &&
    input.liveWarden(coverage.wardenId) &&
    coverage.anomalies.some(entry => entry.sessionId === anomaly.sessionId && entry.kind === anomaly.kind)
  );
}

/** Jev's hand-on of this flag, while it still describes it: same ferret, kind and status. */
function standingHandoff(input: WardenOwnerRouteInput, anomaly: WardenAnomaly): WardenJevHandoff | undefined {
  const handoff = input.state.jevHandoffs?.[jevHandoffKey(anomaly.sessionId, anomaly.kind)];
  return handoff?.status === anomaly.status ? handoff : undefined;
}

/** Every standing flag that is the owner's to decide now, with its strongest reason. Deterministic. */
export function wardenOwnerRoutes(input: WardenOwnerRouteInput): readonly WardenOwnerRoute[] {
  if (!input.enabled) return [];
  const held = heldActions(input.state.actions ?? [], input.statusOf, input.nowMs);
  const investigating = input.layers.llm.active;
  const queued = new Set((input.state.assignedQueue ?? []).map(anomaly => anomaly.sessionId));
  const routes: WardenOwnerRoute[] = [];
  for (const anomaly of input.anomalies) {
    const status = input.statusOf(anomaly.sessionId) ?? anomaly.status;
    if (isTerminalStatus(status) || stillHandled(input, anomaly, status)) continue;

    const action = held.find(entry => entry.sessionId === anomaly.sessionId && entry.anomalyKind === anomaly.kind);
    if (action !== undefined) {
      routes.push({ anomaly, reason: { kind: 'held', action }, evidenceAt: action.at });
      continue;
    }
    const record = newestInvestigation(input.state.investigations ?? [], anomaly);
    if (failedInvestigation(record, anomaly)) {
      routes.push({
        anomaly,
        reason: { kind: 'investigation_failed', record },
        ...(record.finishedAt === undefined ? {} : { evidenceAt: record.finishedAt }),
      });
      continue;
    }
    // While investigations can run, a flag Jev handed on — or one that waits in the queue — is theirs.
    if (investigating) continue;
    // The owner's own request waits for investigations to come back; it is already the owner's word.
    if (anomaly.kind === 'owner_request' && queued.has(anomaly.sessionId)) continue;
    const handoff = standingHandoff(input, anomaly);
    if (handoff !== undefined) {
      routes.push({ anomaly, reason: { kind: 'jev', handoff, layers: input.layers }, evidenceAt: handoff.at });
      continue;
    }
    routes.push({
      anomaly,
      reason: { kind: 'untriaged', layers: input.layers },
      ...(anomaly.since === undefined ? {} : { evidenceAt: anomaly.since }),
    });
  }
  return routes;
}
