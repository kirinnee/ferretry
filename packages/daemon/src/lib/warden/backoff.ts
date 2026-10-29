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
 * counted as a look, so the act gets that rung's wait to land ({@link recordJevAct}). While it lands,
 * nothing else on that FERRET is acted on or looked at, whatever its kind. After that, the same kind of
 * trouble on that ferret goes past Jev ({@link jevActStanding}) — on the same subject, and on a NEW
 * subject too for a day: an act starts a new turn or a new episode by its own effect, and a ferret that
 * stalls again soon after Jev's act needs someone stronger, not the same act again. One act per
 * situation, then someone stronger looks. The memory is kept for as long as the ferret lives.
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
  /** Jev's last act on this (ferret, kind): what, when, on which subject, and until when it is landing. */
  readonly jevActed?: JevActMemory;
}

/** What the Warden remembers of Jev's last act on one (ferret, kind). */
export interface JevActMemory {
  readonly action: WardenJevAct;
  readonly at: string;
  /** The subject it acted on ({@link jevSubject}). */
  readonly subject: string;
  /** Until when the act is given time to land: nothing is acted on or looked at meanwhile. */
  readonly landsBy: string;
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
  // Jev's act outlives a change of subject: its own effect is often what changed it.
  const jevActed = previous?.jevActed;
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

/** How long after Jev acted the same kind of trouble on the same ferret still goes past Jev. */
const JEV_REPEAT_WINDOW_MS = BACKOFF_CEILING_MS;

/**
 * Count Jev's act on a subject as a look and remember it. It lands for as long as that look's rung holds
 * the subject — so the hold and the landing end together — and never less than {@link JEV_ACT_GRACE_FLOOR_MS}.
 */
export function recordJevAct(
  store: BackoffStore,
  look: Pick<WardenAnomaly, 'sessionId' | 'kind' | 'subject' | 'status' | 'since'>,
  nowMs: number,
  action: WardenJevAct,
  baseMs: number,
): BackoffStore {
  const subject = jevSubject(look);
  const recorded = recordLook(store, { sessionId: look.sessionId, kind: look.kind, subject }, nowMs, false);
  const key = backoffKey(look.sessionId, look.kind);
  const entry = recorded[key] as InvestigationBackoff;
  const landsMs = nowMs + Math.max(JEV_ACT_GRACE_FLOOR_MS, investigationBackoffMs(entry.count, baseMs));
  return {
    ...recorded,
    [key]: { ...entry, jevActed: { action, at: isoFromMs(nowMs), subject, landsBy: isoFromMs(landsMs) } },
  };
}

/** Whether any act of Jev's on this ferret, of any kind, is still landing. */
export function jevActLandingOn(store: BackoffStore, sessionId: string, nowMs: number): boolean {
  return Object.entries(store).some(([key, entry]) => {
    if (key.slice(0, key.lastIndexOf('|')) !== sessionId || entry.jevActed === undefined) return false;
    const landsMs = instantMs(entry.jevActed.landsBy);
    return landsMs !== undefined && nowMs < landsMs;
  });
}

/**
 * Where a flag stands after Jev acted on its ferret:
 *
 * - `landing` while ANY act of Jev's on this ferret still has time to work — nobody looks, nobody is
 *   asked, whatever the flag's kind;
 * - `escalate` once that time is over, when Jev already acted on this kind of trouble here — on this
 *   subject, or on another within a day ({@link BACKOFF_CEILING_MS}): Jev is not asked again;
 * - `undefined` otherwise: Jev may answer it.
 */
export function jevActStanding(
  store: BackoffStore,
  anomaly: Pick<WardenAnomaly, 'sessionId' | 'kind' | 'subject' | 'status' | 'since'>,
  nowMs: number,
): { readonly standing: 'landing' | 'escalate'; readonly action?: WardenJevAct } | undefined {
  const acted = store[backoffKey(anomaly.sessionId, anomaly.kind)]?.jevActed;
  if (jevActLandingOn(store, anomaly.sessionId, nowMs))
    return { standing: 'landing', ...(acted === undefined ? {} : { action: acted.action }) };
  if (acted === undefined) return undefined;
  const actedMs = instantMs(acted.at);
  const recent = actedMs === undefined || nowMs - actedMs < JEV_REPEAT_WINDOW_MS;
  return acted.subject === jevSubject(anomaly) || recent ? { standing: 'escalate', action: acted.action } : undefined;
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
 * ceiling — by then no rung can still hold it, so it is only weight — except Jev's acts, kept while the
 * ferret lives.
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
    if (!liveSessionIds.has(sessionId) || lastMs === undefined) continue;
    // Jev's act is remembered for as long as the ferret lives: one try means one, however long it stands.
    if (entry.jevActed === undefined && nowMs - lastMs > 2 * BACKOFF_CEILING_MS) continue;
    next[key] = entry;
  }
  return next;
}
