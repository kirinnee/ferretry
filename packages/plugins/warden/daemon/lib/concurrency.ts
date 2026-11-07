/**
 * Fleet-wide warden concurrency and dedup gate.
 *
 * Two kinds of warden run under the warden label: the fleet SWEEP warden, which
 * triages the whole anomaly set at once and has no single target, and per-target
 * ASSIGNED wardens, one per suspect session.
 *
 * Both spawn sites share this one gate, so they draw down the SAME budget. When
 * each site counted its own, a sweep warden plus the assigned cap meant several
 * expensive sessions live at once, which is exactly what the cap exists to
 * prevent. Targets that cannot be spawned are queued, never dropped.
 *
 * Pure: no IO, no session-manager coupling.
 */

/** A currently-live warden session. */
export interface LiveWarden {
  readonly wardenId: string;
  /** The session this warden is investigating; absent for the fleet-sweep
   *  warden, which counts toward concurrency but guards no single target. */
  readonly targetId?: string;
}

export interface WardenGateInput {
  /** Fleet-wide cap on concurrently live wardens. Clamped to at least one — a
   *  zero cap would wedge supervision entirely. */
  readonly maxConcurrent: number;
  /** Every live warden right now. Its length is the current concurrency. */
  readonly live: readonly LiveWarden[];
  /** Fresh suspect targets from THIS sweep, in priority order. */
  readonly candidates: readonly string[];
  /** Targets carried over from earlier sweeps, oldest first. Persisted across
   *  sweeps so a deferred investigation is never silently lost. */
  readonly queued: readonly string[];
  /** True while the target is still a live, still-suspect session worth a
   *  warden. False for one that recovered, went terminal, or vanished. */
  readonly isStillSuspect: (targetId: string) => boolean;
}

export interface WardenGateDecision {
  /** Targets to spawn a warden for right now, in order. */
  readonly spawn: readonly string[];
  /** Targets to persist for the next sweep: still suspect, but no slot free. */
  readonly queue: readonly string[];
  /** Targets removed from the queue because they recovered or vanished —
   *  reported so the caller can log that an investigation was closed rather
   *  than lost. */
  readonly dropped: readonly string[];
}

/** Fleet-wide free warden slots: the cap (at least one) minus the live count. */
export function wardenSlotsFree(maxConcurrent: number, liveCount: number): number {
  const cap = Math.max(1, Math.floor(maxConcurrent));
  return Math.max(0, cap - Math.max(0, liveCount));
}

/**
 * Decide which assigned wardens to spawn now.
 *
 * Guarantees:
 * - never spawns past the fleet-wide cap, counting the sweep warden;
 * - never a second warden for a target already under investigation;
 * - a still-suspect target with no free slot is queued, not dropped;
 * - a queued target that has since recovered is dropped, not investigated;
 * - queued targets are retried before fresh candidates, so nothing starves;
 * - duplicate ids across the queue and this sweep collapse to one.
 */
export function decideAssignedWardens(input: WardenGateInput): WardenGateDecision {
  const underInvestigation = new Set<string>();
  for (const warden of input.live) {
    if (warden.targetId !== undefined) underInvestigation.add(warden.targetId);
  }

  // Queue first (FIFO, anti-starvation), then fresh candidates; collapse dupes.
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const id of [...input.queued, ...input.candidates]) {
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }

  const wasQueued = new Set(input.queued);
  const dropped: string[] = [];
  const eligible: string[] = [];
  for (const id of ordered) {
    // Already under investigation: neither a new spawn nor a re-queue, and not
    // a drop either — it did not recover, it is simply handled.
    if (underInvestigation.has(id)) continue;
    if (!input.isStillSuspect(id)) {
      // Only report a drop for something we were actively holding; a fresh
      // candidate that is no longer suspect was never queued to begin with.
      if (wasQueued.has(id)) dropped.push(id);
      continue;
    }
    eligible.push(id);
  }

  const slots = wardenSlotsFree(input.maxConcurrent, input.live.length);
  return { spawn: eligible.slice(0, slots), queue: eligible.slice(slots), dropped };
}
