/**
 * The Warden status lists, as the wire carries them, and the held actions that still wait on the owner.
 *
 * A HELD action — a verdict or Jev asked for something the owner has not let the Warden do alone — is
 * put in front of the owner as a Warden card (`owner-routes.ts`, `escalation.ts`); this module only
 * says which holds still stand.
 *
 * Pure: every input is a value.
 */

import type { WardenAction, WardenBlessingView, WardenInvestigation, WardenJevBefore } from '@ferretry/protocol';
import type { BlessingStore } from './bless.ts';
import type { WardenAnomaly } from './detect.ts';
import type { WardenQueueEntryMeta } from './state.ts';
import { instantMs } from './time.ts';
import type { WardenInvestigationRecord } from './triage.ts';
import { isTerminalStatus, type WardenSessionStatus } from './types.ts';

const DAY_MS = 86_400_000;

/** How many investigations and actions the status lists. */
export const WARDEN_STATUS_LIST_LIMIT = 20;

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
  /** What Jev has said so far about a queued flag (`jev-checks.ts` {@link jevBeforeInvestigation}). */
  readonly jevFor?: (anomaly: WardenAnomaly) => WardenJevBefore | undefined;
}

const optionalJev = (jev: WardenJevBefore | undefined): { readonly jev?: WardenJevBefore } =>
  jev === undefined ? {} : { jev };

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
      ...optionalJev(input.jevFor?.(anomaly)),
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
    ...optionalJev(record.jev),
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
