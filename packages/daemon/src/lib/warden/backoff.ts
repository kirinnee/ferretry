/**
 * Investigation backoff — how long the Warden leaves a situation alone after it has already paid to look
 * at it.
 *
 * WHY. A flat cooldown after every investigation meant the same healthy ferret was re-flagged and
 * re-investigated on a timer: the 30-minute cooldown ran out, the flag was still standing (nothing about
 * the ferret had changed), and another investigation was bought for the same answer — about three a day
 * per ferret, at roughly sixteen cents each.
 *
 * THE RULE. Keyed by (ferret, anomaly kind) and remembering the anomaly's SUBJECT (`detect.ts`: the turn,
 * and for a stuck command which command):
 *
 * - each automatic look at the SAME subject waits longer before the next: the base cooldown, then four
 *   times it, sixteen times, and a day at most — 30m → 2h → 8h → 24h with the default 30-minute base;
 * - a look that CLEARED the subject (an investigation's LEAVE, or Jev's confident leave) holds until the
 *   subject changes, a day at most, instead of lapsing after the short blessing lifetime;
 * - a different subject — a new turn, a different command, a different anomaly kind — starts afresh at
 *   once: a new situation is never hidden behind an old answer.
 *
 * The owner's own request and a manual forced run are never held: those people already decided.
 *
 * JEV'S ONE TRY. When Jev acts on a subject (`triage.ts`), that is remembered on the same entry and
 * counted as a look, so the act gets the rung's wait to land. It is never forgotten while the subject
 * stands — not by a later investigation either — so once that wait is over a subject Jev already acted
 * on goes past Jev ({@link jevActStanding}): one act per situation, then someone stronger looks.
 *
 * Pure: no IO, no clock, no globals.
 */

import type { WardenJevAct } from '@ferretry/protocol';
import type { WardenAnomaly, WardenAnomalyKind } from './detect.ts';
import { instantMs, isoFromMs } from './time.ts';

/** What the Warden remembers of its looks at one (ferret, kind). */
export interface InvestigationBackoff {
  /** The subject the looks were about. */
  readonly subject: string;
  /** Automatic looks at this subject in a row. */
  readonly count: number;
  readonly lastAt: string;
  /** The last look cleared it: left alone until the subject changes. */
  readonly cleared?: true;
  /** Jev already acted on this subject: what, and when. Kept for as long as the subject stands. */
  readonly jevActed?: { readonly action: WardenJevAct; readonly at: string };
}

/** Keyed by {@link backoffKey}. */
export type BackoffStore = Readonly<Record<string, InvestigationBackoff>>;

/** The top rung, and the outer bound on how long a clearance holds an unchanged subject. */
export const BACKOFF_CEILING_MS = 24 * 60 * 60_000;

/** Each rung waits this many times longer than the one before. */
export const BACKOFF_FACTOR = 4;

export function backoffKey(sessionId: string, kind: WardenAnomalyKind): string {
  return `${sessionId}|${kind}`;
}

/** How long after the `count`-th look at one subject the next automatic look may start. */
export function investigationBackoffMs(count: number, baseMs: number): number {
  if (!Number.isFinite(baseMs) || baseMs <= 0 || count <= 0) return 0;
  const rungs = Math.min(Math.floor(count) - 1, 8);
  return Math.min(BACKOFF_CEILING_MS, baseMs * BACKOFF_FACTOR ** rungs);
}

export interface BackoffSubject {
  readonly sessionId: string;
  readonly kind: WardenAnomalyKind;
  readonly subject?: string;
}

/** Count one look at a subject. A different subject than last time starts the count again. */
export function recordLook(store: BackoffStore, look: BackoffSubject, nowMs: number, cleared: boolean): BackoffStore {
  if (look.subject === undefined) return store;
  const key = backoffKey(look.sessionId, look.kind);
  const previous = store[key];
  const same = previous?.subject === look.subject;
  const count = same ? previous.count + 1 : 1;
  const jevActed = same ? previous.jevActed : undefined;
  return {
    ...store,
    [key]: {
      subject: look.subject,
      count,
      lastAt: isoFromMs(nowMs),
      ...(cleared ? { cleared: true } : {}),
      ...(jevActed === undefined ? {} : { jevActed }),
    },
  };
}

/** The shortest wait an act of Jev's is given to land, whatever the base cooldown: a nudge takes a while. */
export const JEV_ACT_GRACE_FLOOR_MS = 10 * 60_000;

/**
 * The subject Jev's one try is counted against. An anomaly with no subject of its own is identified by
 * its status and the instant its episode is anchored to, so a recurrence later is a new situation.
 */
export function jevSubject(anomaly: Pick<WardenAnomaly, 'subject' | 'status' | 'since'>): string {
  return anomaly.subject ?? `${anomaly.status}@${anomaly.since ?? 'unanchored'}`;
}

/** Count Jev's act on a subject as a look, and remember the act for as long as the subject stands. */
export function recordJevAct(
  store: BackoffStore,
  look: Pick<WardenAnomaly, 'sessionId' | 'kind' | 'subject' | 'status' | 'since'>,
  nowMs: number,
  action: WardenJevAct,
): BackoffStore {
  const subject = jevSubject(look);
  const recorded = recordLook(store, { sessionId: look.sessionId, kind: look.kind, subject }, nowMs, false);
  const key = backoffKey(look.sessionId, look.kind);
  const entry = recorded[key] as InvestigationBackoff;
  return { ...recorded, [key]: { ...entry, jevActed: { action, at: isoFromMs(nowMs) } } };
}

/**
 * Where a flag stands after Jev acted on its subject: `landing` while the act still has time to work
 * (nobody looks, nobody is asked), `escalate` once that time is over and the same subject is still
 * flagged (Jev is not asked again), or `undefined` when Jev never acted on this subject.
 */
export function jevActStanding(
  store: BackoffStore,
  anomaly: Pick<WardenAnomaly, 'sessionId' | 'kind' | 'subject' | 'status' | 'since'>,
  nowMs: number,
  baseMs: number,
): { readonly standing: 'landing' | 'escalate'; readonly action: WardenJevAct } | undefined {
  const entry = store[backoffKey(anomaly.sessionId, anomaly.kind)];
  if (entry?.jevActed === undefined || entry.subject !== jevSubject(anomaly)) return undefined;
  const actedMs = instantMs(entry.jevActed.at);
  if (actedMs === undefined) return { standing: 'escalate', action: entry.jevActed.action };
  const graceMs = Math.max(JEV_ACT_GRACE_FLOOR_MS, investigationBackoffMs(1, baseMs));
  return { standing: nowMs < actedMs + graceMs ? 'landing' : 'escalate', action: entry.jevActed.action };
}

export interface BackoffHold {
  readonly untilMs: number;
  /** Held because the last look cleared it, rather than because it was just looked at. */
  readonly cleared: boolean;
  readonly count: number;
}

/** Why this anomaly must not be looked at again yet, or `undefined` when it may be. */
export function backoffHold(
  store: BackoffStore,
  anomaly: BackoffSubject,
  nowMs: number,
  baseMs: number,
): BackoffHold | undefined {
  if (anomaly.subject === undefined) return undefined;
  const entry = store[backoffKey(anomaly.sessionId, anomaly.kind)];
  if (entry === undefined || entry.subject !== anomaly.subject) return undefined;
  const lastMs = instantMs(entry.lastAt);
  if (lastMs === undefined) return undefined;
  const cleared = entry.cleared === true;
  const untilMs = lastMs + (cleared ? BACKOFF_CEILING_MS : investigationBackoffMs(entry.count, baseMs));
  return nowMs < untilMs ? { untilMs, cleared, count: entry.count } : undefined;
}

/**
 * Sweep housekeeping: forget ferrets that are gone or finished, and anything older than twice the
 * ceiling — by then no rung can still hold it, so it is only weight.
 */
export function reconcileBackoff(
  store: BackoffStore,
  liveSessionIds: ReadonlySet<string>,
  nowMs: number,
): BackoffStore {
  const next: Record<string, InvestigationBackoff> = {};
  for (const [key, entry] of Object.entries(store)) {
    const sessionId = key.slice(0, key.lastIndexOf('|'));
    const lastMs = instantMs(entry.lastAt);
    if (!liveSessionIds.has(sessionId) || lastMs === undefined || nowMs - lastMs > 2 * BACKOFF_CEILING_MS) continue;
    next[key] = entry;
  }
  return next;
}
