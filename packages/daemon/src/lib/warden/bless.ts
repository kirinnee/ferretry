/**
 * Warden blessings — the "stop re-investigating a session you just cleared"
 * store and predicate.
 *
 * A `LEAVE` verdict means "this session is healthy and progressing". Without a
 * blessing it changes nothing about the next sweep, so the same healthy session
 * is re-flagged minutes later and re-investigated by another expensive warden,
 * forever. Recording the clearance with a short lifetime lets the sweep drop the
 * candidate BEFORE it occupies the single warden slot.
 *
 * The design constraints, all encoded here:
 *
 * - NARROW — a blessing covers only the anomaly kinds the warden actually
 *   cleared. A genuinely new signal on the same session still triggers. A
 *   blanket blindfold on a session that later breaks is worse than the bug it
 *   was meant to fix.
 * - INVALIDATE ON STATE CHANGE — a blessing granted while a session was running
 *   does not survive it going terminal, wedging, or starting to await a human.
 * - EXPIRE — every blessing carries an absolute expiry.
 * - PERSISTABLE — a plain JSON-serialisable record, so a daemon restart does not
 *   drop every blessing and re-investigate the whole fleet at once.
 * - LEAVE ONLY — this module never inspects verdicts. Recording a blessing for
 *   anything but a cleared verdict is a caller error.
 *
 * Pure: no IO, no clock, no globals.
 */

import { WARDEN_BLESSING_CEILING_MINUTES, type WardenClearedBy } from '@ferretry/protocol';
import type { WardenAnomalyKind } from './detect.ts';
import { instantMs, isoFromMs } from './time.ts';
import type { WardenSessionStatus } from './types.ts';

/** One recorded blessing: a warden cleared this session, against these anomaly
 *  kinds, while it was in this status, until this instant. */
export interface Blessing {
  readonly sessionId: string;
  /** The anomaly kinds the warden cleared. An anomaly of a kind NOT in this
   *  list is unblessed and still triggers. */
  readonly kinds: readonly WardenAnomalyKind[];
  /** Session status at bless time; any change invalidates the blessing. */
  readonly status: WardenSessionStatus;
  readonly blessedAt: string;
  readonly expiresAt: string;
  /** The warden that issued the clearance, for provenance in the journal. */
  readonly wardenId?: string;
  /** Who judged it healthy: an investigation, Jev's confident leave, or the owner. Absent means a warden. */
  readonly by?: WardenClearedBy;
  /** How many clears of these flags in a row came before this one: its lifetime doubled that often. */
  readonly streak?: number;
  /** The owner left it alone until its status changes; {@link expiresAt} is only the outer bound. */
  readonly untilChange?: true;
}

/** At most one active blessing per session. A later clearance replaces it. */
export type BlessingStore = Readonly<Record<string, Blessing>>;

export const MINIMUM_BLESSING_MS = 60_000;

/** A configured blessing lifetime in milliseconds, floored at a minute so a
 *  mis-set zero or negative never produces an already-expired blessing that
 *  silently disables the feature. */
export function blessingTtlMs(minutes: number): number {
  return Math.max(MINIMUM_BLESSING_MS, Math.floor((Number.isFinite(minutes) ? minutes : 0) * 60_000));
}

/** The unexpired blessing for a session, or `undefined`. Says nothing about
 *  status — callers that care use `isAnomalyBlessed`. */
export function activeBlessing(store: BlessingStore, sessionId: string, nowMs: number): Blessing | undefined {
  const blessing = store[sessionId];
  if (blessing === undefined) return undefined;
  const expiry = instantMs(blessing.expiresAt);
  return expiry !== undefined && expiry > nowMs ? blessing : undefined;
}

/**
 * True when this anomaly is covered by an active blessing, so the sweep may drop
 * it before the concurrency gate.
 *
 * False — meaning the anomaly still triggers — when there is no blessing, the
 * blessing lapsed, the status has changed since it was granted, or the anomaly
 * is of a kind the warden never cleared. The status is re-checked here as well
 * as in reconciliation so a stale store can never mis-bless.
 */
export function isAnomalyBlessed(
  store: BlessingStore,
  anomaly: { readonly sessionId: string; readonly kind: WardenAnomalyKind },
  currentStatus: WardenSessionStatus,
  nowMs: number,
): boolean {
  const blessing = activeBlessing(store, anomaly.sessionId, nowMs);
  if (blessing === undefined || blessing.status !== currentStatus) return false;
  return blessing.kinds.includes(anomaly.kind);
}

export interface BlessingRequest {
  readonly sessionId: string;
  readonly kinds: readonly WardenAnomalyKind[];
  readonly status: WardenSessionStatus;
  readonly wardenId?: string;
  readonly by?: WardenClearedBy;
  readonly streak?: number;
  readonly untilChange?: true;
}

/**
 * Record or replace a blessing, returning a new store. Kinds are de-duplicated,
 * and an empty request is a no-op: an empty blessing could never suppress
 * anything and would only add churn.
 */
export function recordBlessing(
  store: BlessingStore,
  request: BlessingRequest,
  nowMs: number,
  ttlMs: number,
): BlessingStore {
  const kinds = [...new Set(request.kinds)];
  if (kinds.length === 0) return store;
  return {
    ...store,
    [request.sessionId]: {
      sessionId: request.sessionId,
      kinds,
      status: request.status,
      blessedAt: isoFromMs(nowMs),
      expiresAt: isoFromMs(nowMs + Math.max(MINIMUM_BLESSING_MS, ttlMs)),
      ...(request.wardenId === undefined ? {} : { wardenId: request.wardenId }),
      ...(request.by === undefined ? {} : { by: request.by }),
      ...(request.streak === undefined || request.streak <= 0 ? {} : { streak: request.streak }),
      ...(request.untilChange === true ? { untilChange: true } : {}),
    },
  };
}

export interface BlessingReconciliation {
  readonly store: BlessingStore;
  /** Blessings cut short by a status change or the session disappearing. */
  readonly revoked: readonly string[];
  /** Blessings that simply ran out. */
  readonly expired: readonly string[];
}

/**
 * Sweep housekeeping: drop blessings that lapsed, that no longer match the
 * session's current status, or whose session is gone.
 *
 * Dropping rather than merely ignoring keeps the persisted store bounded and
 * makes "a blessing does not survive a status change" literal instead of
 * dormant-and-revivable. Revocations and expiries are reported separately so the
 * caller can journal a blessing that was cut short as distinct from one that ran
 * its course.
 */
export function reconcileBlessings(
  store: BlessingStore,
  statusById: ReadonlyMap<string, WardenSessionStatus>,
  nowMs: number,
): BlessingReconciliation {
  const next: Record<string, Blessing> = {};
  const revoked: string[] = [];
  const expired: string[] = [];

  for (const [sessionId, blessing] of Object.entries(store)) {
    const expiry = instantMs(blessing.expiresAt);
    if (expiry === undefined || expiry <= nowMs) {
      expired.push(sessionId);
      continue;
    }
    if (statusById.get(sessionId) !== blessing.status) {
      revoked.push(sessionId);
      continue;
    }
    next[sessionId] = blessing;
  }

  return { store: next, revoked, expired };
}

// ── Growing cooldown ─────────────────────────────────────────────────────────────────────────────

/** The longest a run of re-clears leaves a flag alone. */
export const BLESSING_CEILING_MS = WARDEN_BLESSING_CEILING_MINUTES * 60_000;

/**
 * How long a clear leaves a flag alone after `streak` clears of it in a row: the configured lifetime,
 * doubled per re-clear, up to four hours. A configured lifetime already above four hours is kept as it
 * is — the ceiling bounds the GROWTH, it never shortens what the owner chose.
 */
export function growingBlessingMs(baseMinutes: number, streak: number): number {
  const base = blessingTtlMs(baseMinutes);
  const doublings = Math.max(0, Math.min(Math.floor(Number.isFinite(streak) ? streak : 0), 16));
  return Math.min(Math.max(base, BLESSING_CEILING_MS), base * 2 ** doublings);
}

/**
 * How many times in a row each flag on one ferret has been cleared, while it held one status.
 *
 * A SEPARATE RECORD FROM THE BLESSING because it must outlive it: the blessing lapses, the flag comes
 * back, and the next clear is a RE-clear only if something remembers the last one. It resets exactly
 * when a blessing is revoked — the ferret changed status or vanished — and for one kind when that flag
 * stops being raised while nothing blesses it: trouble that went away and came back is not consecutive.
 */
export interface ClearStreak {
  readonly status: WardenSessionStatus;
  readonly counts: Readonly<Partial<Record<WardenAnomalyKind, number>>>;
}

export type ClearStreakStore = Readonly<Record<string, ClearStreak>>;

/** The clears in a row that came before this one: the longest among the kinds being cleared now. */
export function clearStreak(
  store: ClearStreakStore,
  sessionId: string,
  kinds: readonly WardenAnomalyKind[],
  status: WardenSessionStatus,
): number {
  const streak = store[sessionId];
  if (streak === undefined || streak.status !== status) return 0;
  return Math.max(0, ...kinds.map(kind => streak.counts[kind] ?? 0));
}

/** Count one clear of each kind. A ferret in a new status starts every count afresh. */
export function recordClears(
  store: ClearStreakStore,
  sessionId: string,
  kinds: readonly WardenAnomalyKind[],
  status: WardenSessionStatus,
): ClearStreakStore {
  if (kinds.length === 0) return store;
  const previous = store[sessionId];
  const counts: Partial<Record<WardenAnomalyKind, number>> = previous?.status === status ? { ...previous.counts } : {};
  for (const kind of new Set(kinds)) counts[kind] = (counts[kind] ?? 0) + 1;
  return { ...store, [sessionId]: { status, counts } };
}

/**
 * Sweep housekeeping for the streaks: a ferret that is gone or changed status loses all of them, and a
 * kind that is neither flagged now nor blessed loses its own.
 */
export function reconcileClearStreaks(
  store: ClearStreakStore,
  statusById: ReadonlyMap<string, WardenSessionStatus>,
  flagged: readonly { readonly sessionId: string; readonly kind: WardenAnomalyKind }[],
  blessings: BlessingStore,
  nowMs: number,
): ClearStreakStore {
  const next: Record<string, ClearStreak> = {};
  for (const [sessionId, streak] of Object.entries(store)) {
    if (statusById.get(sessionId) !== streak.status) continue;
    const blessed = activeBlessing(blessings, sessionId, nowMs)?.kinds ?? [];
    const counts: Partial<Record<WardenAnomalyKind, number>> = {};
    for (const [kind, count] of Object.entries(streak.counts) as [WardenAnomalyKind, number][]) {
      const standing = blessed.includes(kind) || flagged.some(f => f.sessionId === sessionId && f.kind === kind);
      if (standing) counts[kind] = count;
    }
    if (Object.keys(counts).length > 0) next[sessionId] = { status: streak.status, counts };
  }
  return next;
}

/**
 * A blessing over `kinds` merged into the active one the ferret already holds in the same status: the
 * kinds are joined and the LATER expiry wins, so clearing one more flag never shortens how long an
 * earlier clear leaves the others alone.
 */
export function mergeBlessing(
  store: BlessingStore,
  request: BlessingRequest,
  nowMs: number,
  ttlMs: number,
): BlessingStore {
  const current = activeBlessing(store, request.sessionId, nowMs);
  const same = current !== undefined && current.status === request.status ? current : undefined;
  const next = recordBlessing(store, { ...request, kinds: [...(same?.kinds ?? []), ...request.kinds] }, nowMs, ttlMs);
  const merged = next[request.sessionId];
  const keep = instantMs(same?.expiresAt) ?? 0;
  if (merged === undefined || same === undefined || keep <= (instantMs(merged.expiresAt) ?? 0)) return next;
  return {
    ...next,
    [request.sessionId]: {
      ...merged,
      expiresAt: same.expiresAt,
      ...(same.untilChange === true ? { untilChange: true } : {}),
    },
  };
}
