import { instantMs } from '../../warden/time.ts';
import type { SessionHealthSettings } from './settings.ts';
import type { WardenSweepObservation, WardenSweepVerdict } from './types.ts';

/**
 * How long the warden may go without a completed sweep. A slow configured interval must widen the
 * deadline rather than trip it, so the floor is a minimum and never a cap.
 */
export function wardenSweepDeadlineMs(intervalMs: number, settings: SessionHealthSettings): number {
  const configured =
    Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs * settings.wardenSweepStaleIntervals : 0;
  return Math.max(settings.wardenSweepStaleFloorMs, configured);
}

/**
 * Decides whether the warden is still sweeping.
 *
 * The ancestor of this code asked `lastSweepMs > 0 && now - lastSweepMs > deadline`, which answers
 * "is it PROVABLY stale" and resolves every other case to fresh. Three real conditions fell through
 * it: an unparseable timestamp (`Date.parse` yields NaN, and `NaN > 0` is false), a timestamp in the
 * future after a clock step, and an armed timer that has never swept at all. In each the daemon
 * reported an all-clear for a warden that had stopped working.
 *
 * This asks the opposite question — "can it be SHOWN to be current" — so anything unproven resolves
 * to a re-arm. Re-arming an already-healthy warden replaces one timer; leaving a dead one armed
 * leaves the fleet unsupervised, which is the strictly worse error. The one case deliberately kept
 * quiet is `within-grace`: a freshly armed timer that has not yet reached its first sweep is doing
 * exactly what it should, and re-arming it on every boot would be noise, not safety.
 */
export function classifyWardenSweep(
  observation: WardenSweepObservation,
  settings: SessionHealthSettings,
): WardenSweepVerdict {
  const deadlineMs = wardenSweepDeadlineMs(observation.intervalMs, settings);
  if (!observation.timerArmed) return { state: 'timer-dead', needsRearm: true, ageMs: undefined, deadlineMs };
  const nowMs = observation.nowMs;
  if (!Number.isFinite(nowMs)) return { state: 'unknown', needsRearm: true, ageMs: undefined, deadlineMs };
  const sweptAtMs = instantMs(observation.lastSweepAt);
  if (observation.lastSweepAt !== undefined && sweptAtMs === undefined)
    return { state: 'unknown', needsRearm: true, ageMs: undefined, deadlineMs };
  // Nothing has swept yet, so the deadline runs from when the timer was armed instead.
  if (sweptAtMs === undefined) {
    const armedAtMs = observation.armedAtMs;
    if (armedAtMs === undefined || !Number.isFinite(armedAtMs) || armedAtMs > nowMs)
      return { state: 'unknown', needsRearm: true, ageMs: undefined, deadlineMs };
    const armedForMs = nowMs - armedAtMs;
    return armedForMs > deadlineMs
      ? { state: 'stale', needsRearm: true, ageMs: armedForMs, deadlineMs }
      : { state: 'within-grace', needsRearm: false, ageMs: armedForMs, deadlineMs };
  }
  // A sweep dated after "now" cannot age it; the clock moved under us, so freshness is unproven.
  if (sweptAtMs > nowMs) return { state: 'unknown', needsRearm: true, ageMs: undefined, deadlineMs };
  const ageMs = nowMs - sweptAtMs;
  return ageMs > deadlineMs
    ? { state: 'stale', needsRearm: true, ageMs, deadlineMs }
    : { state: 'fresh', needsRearm: false, ageMs, deadlineMs };
}
