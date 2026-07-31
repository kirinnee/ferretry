import { instantMs, isoFromMs } from '../../warden/time.ts';
import type { SessionHealthSettings } from './settings.ts';
import type { SelfCheckLedger, SelfCheckTick, SelfCheckVerdict, SessionHealthEvent } from './types.ts';

/** A ledger that has seen nothing. Exported as a value so no caller has to know its shape. */
export const emptySelfCheckLedger: SelfCheckLedger = {
  ticks: 0,
  wedges: 0,
  lastElapsedMs: undefined,
  lastAt: undefined,
  lastFreshness: undefined,
  eventLoopLagMs: 0,
};

function usableReading(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

/**
 * Decides how late a self-check tick was, and therefore whether the daemon's picture of the fleet
 * can still be trusted.
 *
 * Three outcomes are deliberately distinct. `fresh` is a proven on-time tick. `wedged` is a proven
 * multi-interval gap — the event loop stopped running and every belief the daemon holds is now
 * unverified. `unknown` is everything the daemon CANNOT prove either way: a monotonic reading that
 * went backwards or arrived non-finite, which means the clock source is broken rather than that the
 * daemon is healthy.
 *
 * The safe direction here is toward suspicion. The action a non-fresh tick triggers is a consistency
 * pass — reading state and repairing the index — which costs IO and disturbs no running agent. The
 * cost of the opposite error is the 2026-07-23 shape: a starved daemon reporting all-clear while
 * sessions fall out of the index. So anything unproven forces the deep pass, and only a `wedged`
 * verdict — real, measured starvation — is counted as a wedge in the ledger.
 */
export function classifySelfCheckTick(
  ledger: SelfCheckLedger,
  tick: SelfCheckTick,
  settings: SessionHealthSettings,
): SelfCheckVerdict {
  const previous = ledger.lastElapsedMs;
  // No previous reading is not a fault: it is the first tick after boot. The deep pass still runs —
  // boot is exactly when the index is least likely to match the session directories.
  if (previous === undefined && ledger.ticks === 0)
    return { freshness: 'first-tick', gapMs: undefined, lagMs: 0, deepPass: true, since: undefined };
  if (!usableReading(previous) || !usableReading(tick.elapsedMs) || tick.elapsedMs < previous)
    return { freshness: 'unknown', gapMs: undefined, lagMs: 0, deepPass: true, since: undefined };
  const gapMs = tick.elapsedMs - previous;
  const lagMs = Math.max(0, gapMs - settings.selfCheckIntervalMs);
  const wedged = gapMs >= settings.wedgeGapMs;
  const startedAtMs = instantMs(tick.at);
  return {
    freshness: wedged ? 'wedged' : 'fresh',
    gapMs,
    lagMs,
    deepPass: wedged,
    // Reported only when the wall instant itself parsed: a fabricated `since` is worse than none.
    since: wedged && startedAtMs !== undefined ? isoFromMs(startedAtMs - gapMs) : undefined,
  };
}

/** Folds one tick into the ledger. Pure: the caller owns the new value, nothing is mutated. */
export function recordSelfCheckTick(
  ledger: SelfCheckLedger,
  tick: SelfCheckTick,
  settings: SessionHealthSettings,
): { readonly ledger: SelfCheckLedger; readonly verdict: SelfCheckVerdict } {
  const verdict = classifySelfCheckTick(ledger, tick, settings);
  return {
    verdict,
    ledger: {
      ticks: ledger.ticks + 1,
      wedges: ledger.wedges + (verdict.freshness === 'wedged' ? 1 : 0),
      // A reading that is not usable must not become the baseline for the NEXT gap, or one broken
      // sample poisons every measurement after it.
      lastElapsedMs: usableReading(tick.elapsedMs) ? tick.elapsedMs : ledger.lastElapsedMs,
      lastAt: instantMs(tick.at) === undefined ? ledger.lastAt : tick.at,
      lastFreshness: verdict.freshness,
      eventLoopLagMs: verdict.lagMs,
    },
  };
}

/** The operator-facing record of a measured wedge. Only a proven gap produces one. */
export function wedgeEvent(verdict: SelfCheckVerdict, monitors: number): SessionHealthEvent | undefined {
  if (verdict.freshness !== 'wedged' || verdict.gapMs === undefined) return undefined;
  return {
    type: 'fleet.daemon_wedge',
    data: {
      gapSeconds: Math.round(verdict.gapMs / 1000),
      lagMs: verdict.lagMs,
      monitors,
      ...(verdict.since === undefined ? {} : { since: verdict.since }),
    },
  };
}
