/**
 * Which sessions must never enter the capped fleet slice.
 *
 * SUPERVISION IS THE ONE EXCLUSION, and it is decided from the same DURABLE facts the warden
 * detector's own lineage shield reads — never a display name and never a UI string. `label` is the
 * spawn-side marker the supervision subsystem writes (`label: WARDEN_LABEL`) and the detector
 * already trusts; `parent` is the link a spawn records. Reusing both keeps one fact with one owner
 * instead of inventing a second marker that could disagree with the first.
 *
 * A caps surface that starved its own supervisor would be self-defeating in the worst way: the
 * facility that notices a wedged fleet would be the first thing the fleet's own settings could
 * throttle. This daemon is excluded structurally — it never launches ITSELF through the wrapper —
 * and supervision is excluded here.
 *
 * THE THREE MECHANISMS, in decreasing reliability, are the detector's own — see `warden/detect.ts`:
 *
 * 1. The session carries the warden label itself. Produced in production and PROVED end to end.
 * 2. `wardenLineage`, stamped at spawn. Read here for the day it exists. **DECLARED GAP: nothing in
 *    this daemon writes one.** `SessionProvenanceStamper` is constructed in the composition root and
 *    never called, so on a real host this field is always absent — which is exactly why (3) is not
 *    optional, and why a test that proved descendant exemption from a hand-written `wardenLineage`
 *    fixture alone would be proving nothing about the shipped product.
 * 3. Walking `parent` through the session documents. A backstop only: it reaches the truth exactly
 *    while every ancestor is still present, which for a finished warden is precisely when it is not.
 *
 * AN UNRESOLVABLE ANCESTOR IS NOT DESCENT. That is the detector's rule and this copies it rather
 * than inventing a second one: treating it as descent would shield every session whose parent has
 * been pruned and quietly uncap the whole fleet.
 *
 * Pure: no IO of its own — the walk reads through the port it is handed.
 */

import { WARDEN_LABEL } from '../warden/types.ts';
import type { SessionSpawnFacts, SessionSpawnFactsPort } from './ports.ts';

/** What the walk concluded about one session. */
export type FleetExemption =
  /** Supervision, or something it spawned: never capped. */
  | 'exempt'
  /** An ordinary agent: capped. */
  | 'governed'
  /** This session's OWN document could not be read, so nothing about it is established. */
  | 'unknown';

/** Longest ancestor chain the walk will follow. A chain longer than this is damage, not lineage, and
 *  the walk stops rather than reading unboundedly on a request. */
export const MAX_LINEAGE_DEPTH = 32;

/** True when this one session's own facts say it IS supervision, with no walking required. */
export function isWardenItself(facts: SessionSpawnFacts): boolean {
  return facts.label?.trim() === WARDEN_LABEL || facts.wardenLineage === true;
}

/**
 * Resolve whether one session may be capped, following its ancestry when it has any.
 *
 * `unknown` is returned ONLY when the session's own document is unreadable — never for an
 * unreadable ancestor, which is ordinary (a finished warden is pruned while its children run) and
 * resolves to `governed` per the rule in this module's header.
 */
export async function resolveFleetExemption(
  sessionId: string,
  sessions: SessionSpawnFactsPort,
): Promise<FleetExemption> {
  const own = await sessions.facts(sessionId).catch(() => undefined);
  if (own === undefined) return 'unknown';
  if (isWardenItself(own)) return 'exempt';
  const seen = new Set<string>([sessionId]);
  let parent = own.parent;
  for (let depth = 0; parent !== undefined && depth < MAX_LINEAGE_DEPTH; depth += 1) {
    // A cycle is damage rather than lineage; stop instead of reading the same documents forever.
    if (seen.has(parent)) return 'governed';
    seen.add(parent);
    const ancestor = await sessions.facts(parent).catch(() => undefined);
    // A pruned or unreadable ancestor leaves ancestry unknown, and unknown is NOT descent.
    if (ancestor === undefined) return 'governed';
    if (isWardenItself(ancestor)) return 'exempt';
    parent = ancestor.parent;
  }
  return 'governed';
}

/**
 * How a LAUNCH resolves that verdict.
 *
 * `unknown` does not cap. The only sessions this daemon marks are supervision and its descendants,
 * so an unreadable document is the one case where capping could starve the watchdog, and a fleet
 * with nothing watching it is strictly worse than one uncapped agent. The other half of the pair is
 * deliberately the OPPOSITE direction and lives in the service: the same `unknown` is warned about
 * and conservatively marked restart-required, so it never becomes silence — it becomes an uncapped
 * agent the settings surface is actively complaining about.
 */
export function launchIsExempt(exemption: FleetExemption): boolean {
  return exemption !== 'governed';
}
