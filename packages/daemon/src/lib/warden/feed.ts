/**
 * The "Needs you" feed and the status lists, as the wire carries them.
 *
 * The fleet attention projection (`attention.ts`) answers "which ferret needs the owner, and why" from
 * the session boards, the verdicts and the flags nothing has judged. This module adds the two things
 * that projection could not know about, and nothing else:
 *
 * - a HELD action — a verdict asked for something the owner has not let the Warden do alone, so it waits
 *   on the owner — is a row of its own;
 * - a flag a live FLEET warden was sent about is being looked at, not ignored.
 *
 * Pure: every input is a value.
 */

import type {
  WardenAction,
  WardenBlessingView,
  WardenInvestigation,
  WardenAnomalyKind as WireAnomalyKind,
  WardenAttentionView as WireAttentionView,
  FleetAttentionItem as WireFleetAttentionItem,
} from '@ferretry/protocol';
import type { WardenAttentionView } from './attention.ts';
import type { BlessingStore } from './bless.ts';
import type { WardenAnomaly } from './detect.ts';
import type { WardenQueueEntryMeta, WardenSweepCoverage } from './state.ts';
import { instantMs } from './time.ts';
import type { WardenInvestigationRecord } from './triage.ts';
import { isTerminalStatus, type WardenSessionStatus } from './types.ts';

const DAY_MS = 86_400_000;

/** How many investigations and actions the status lists. */
export const WARDEN_STATUS_LIST_LIMIT = 20;

const ANOMALY_ROW = /^anomaly:([a-z_]+):/u;

/** The anomaly kind a projection row is about, when it is a flag row. */
function rowKind(id: string): WireAnomalyKind | undefined {
  return ANOMALY_ROW.exec(id)?.[1] as WireAnomalyKind | undefined;
}

/** Held actions that still wait on the owner: recent, on a ferret that is still alive, not since done. */
export function heldActions(
  actions: readonly WardenAction[],
  statusOf: (sessionId: string) => WardenSessionStatus | undefined,
  nowMs: number,
): readonly WardenAction[] {
  const settled = new Set<string>();
  const held: WardenAction[] = [];
  // Newest first: a later `done` of the same act on the same ferret settles every earlier hold.
  for (const action of actions) {
    // A leftover cleanup is housekeeping, listed under Recent actions: a browser left open is never a
    // reason to ask for the owner.
    if (action.action === 'close_leftover') continue;
    const key = `${action.sessionId}\u0000${action.action}`;
    if (action.outcome !== 'held') {
      settled.add(key);
      continue;
    }
    if (settled.has(key)) continue;
    const at = instantMs(action.at);
    const status = statusOf(action.sessionId);
    if (at === undefined || nowMs - at > DAY_MS || status === undefined || isTerminalStatus(status)) continue;
    settled.add(key);
    held.push(action);
  }
  return held;
}

/** One held action as a feed row. */
function heldRow(
  action: WardenAction,
  names: ReadonlyMap<string, { teammate?: string; label?: string }>,
): WireFleetAttentionItem {
  const name = names.get(action.sessionId);
  return {
    sessionId: action.sessionId,
    ...(name?.teammate === undefined ? {} : { teammate: name.teammate }),
    ...(name?.label === undefined ? {} : { label: name.label }),
    id: `action:${action.action}:${action.sessionId}`,
    source: 'warden-action',
    subject: action.action === 'stop' ? 'The Warden recommends stopping it' : 'The Warden recommends an action',
    why: action.detail,
    waitingSince: action.at,
    howToResolve:
      action.action === 'stop'
        ? 'Open the ferret and stop it, or leave it running.'
        : 'Open the ferret and decide whether to do it.',
    recommendation: {
      // A cleanup never reaches here (`heldActions`); it reads as nothing to do.
      action:
        action.action === 'failover'
          ? 'migrate'
          : action.action === 'bless' || action.action === 'close_leftover'
            ? 'leave'
            : action.action,
      reason: action.detail,
      ...(action.agent === undefined ? {} : { agent: action.agent }),
    },
    ...(action.anomalyKind === undefined ? {} : { anomalyKind: action.anomalyKind }),
    ...(action.reportPath === undefined
      ? {}
      : { judgement: { state: 'judged', reason: action.detail, reportPath: action.reportPath, at: action.at } }),
  };
}

export interface WardenFeedInput {
  readonly projection: WardenAttentionView;
  readonly actions: readonly WardenAction[];
  readonly statusOf: (sessionId: string) => WardenSessionStatus | undefined;
  readonly names: ReadonlyMap<string, { teammate?: string; label?: string }>;
  readonly nowMs: number;
}

/** The projection plus the held actions, on the wire. */
export function wardenFeedView(input: WardenFeedInput): WireAttentionView {
  const { projection } = input;
  const rows: WireFleetAttentionItem[] = projection.items.map(item => {
    const kind = item.fromAnomaly === true ? rowKind(item.id) : undefined;
    return {
      ...item,
      ...(item.judgement === undefined ? {} : { judgement: { ...item.judgement } }),
      ...(kind === undefined ? {} : { anomalyKind: kind }),
    } as WireFleetAttentionItem;
  });
  const held = heldActions(input.actions, input.statusOf, input.nowMs).map(action => heldRow(action, input.names));
  const items = [...rows, ...held];
  return {
    generatedAt: projection.generatedAt,
    ...(projection.lastSweepAt === undefined ? {} : { lastSweepAt: projection.lastSweepAt }),
    outcome: items.length > 0 ? 'items' : projection.outcome,
    ...(projection.wardenDegraded === undefined ? {} : { wardenDegraded: { ...projection.wardenDegraded } }),
    items,
    boardsWithParseErrors: projection.boardsWithParseErrors.map(entry => ({ ...entry })),
    verdictCoverage: { ...projection.verdictCoverage },
  };
}

/**
 * The flags a live fleet warden covers, as the projection's assignment shape: each one reads as "a
 * warden is looking at this now" instead of "nobody has judged this".
 */
export function coverageAssignments(
  coverage: WardenSweepCoverage | undefined,
  live: (wardenId: string) => boolean,
): Readonly<Record<string, { readonly wardenId: string; readonly kinds: readonly string[] }>> {
  if (coverage === undefined || !live(coverage.wardenId)) return {};
  const assignments: Record<string, { wardenId: string; kinds: string[] }> = {};
  for (const anomaly of coverage.anomalies) {
    const entry = assignments[anomaly.sessionId] ?? { wardenId: coverage.wardenId, kinds: [] };
    entry.kinds.push(anomaly.kind);
    assignments[anomaly.sessionId] = entry;
  }
  return assignments;
}

/** The blessings still in force, on the wire. */
export function blessingViews(store: BlessingStore, nowMs: number): readonly WardenBlessingView[] {
  return Object.values(store)
    .filter(blessing => (instantMs(blessing.expiresAt) ?? 0) > nowMs)
    .map(blessing => ({
      sessionId: blessing.sessionId,
      kinds: [...blessing.kinds],
      expiresAt: blessing.expiresAt,
      by: blessing.by ?? 'warden',
      ...(blessing.streak === undefined ? {} : { streak: blessing.streak }),
      ...(blessing.untilChange === true ? { untilChange: true as const } : {}),
    }));
}

export interface WardenInvestigationListInput {
  readonly queue: readonly WardenAnomaly[];
  readonly meta: Readonly<Record<string, WardenQueueEntryMeta>>;
  readonly records: readonly WardenInvestigationRecord[];
  readonly live: (wardenId: string) => boolean;
}

/** Queued investigations first, in queue order; then started ones, newest first. */
export function investigationList(input: WardenInvestigationListInput): readonly WardenInvestigation[] {
  const queued: WardenInvestigation[] = input.queue.map(anomaly => {
    const meta = input.meta[anomaly.sessionId];
    return {
      id: `queued:${anomaly.sessionId}`,
      state: 'queued',
      scope: 'session',
      origin: meta?.origin ?? 'sweep',
      targetSession: anomaly.sessionId,
      anomalyKind: anomaly.kind,
      ...(meta === undefined ? {} : { queuedAt: meta.queuedAt }),
    };
  });
  const started: WardenInvestigation[] = input.records.map(record => ({
    id: record.id,
    state: record.finishedAt === undefined && input.live(record.id) ? 'running' : 'done',
    scope: record.scope,
    origin: record.origin,
    ...(record.targetId === undefined ? {} : { targetSession: record.targetId }),
    ...(record.anomalyKind === undefined ? {} : { anomalyKind: record.anomalyKind }),
    wardenSession: record.id,
    startedAt: record.startedAt,
    ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
    reportPath: record.reportPath,
    ...(record.verdict === undefined ? {} : { verdict: record.verdict }),
    ...(record.costUsd === undefined ? {} : { costUsd: record.costUsd }),
    ...(record.agent === undefined ? {} : { agent: record.agent }),
    ...(record.model === undefined ? {} : { model: record.model }),
  }));
  return [...queued, ...started].slice(0, WARDEN_STATUS_LIST_LIMIT);
}

/** Keep today's investigations and the newest `limit` beyond them. Newest first in, newest first out. */
export function retainRecords<T extends { readonly startedAt?: string; readonly at?: string }>(
  records: readonly T[],
  day: string,
  limit: number,
): readonly T[] {
  return records.filter((record, index) => index < limit || (record.startedAt ?? record.at ?? '').startsWith(day));
}
