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
