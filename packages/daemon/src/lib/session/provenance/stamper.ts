/**
 * Stamping provenance onto a session — at spawn, and again on every resume and
 * revive.
 *
 * The re-stamp is the part the source did not have. It resolved warden descent
 * once, when the session was created, and never again; a session relaunched
 * after its warden ancestor had been pruned came back with nothing recording
 * that it was warden offspring, became eligible for `dead_monitor`, and reopened
 * the self-escalation path the shield exists to close. So a resume re-resolves
 * lineage and MERGES the result with what is already stamped, and the merge can
 * only ever strengthen the shield.
 */

import type { ClockPort } from '../../ports.ts';
import { WARDEN_LABEL } from '../../warden/types.ts';
import { resolveSpawnLabel, resolveWardenLineage } from './lineage.ts';
import type { SessionAncestor, SessionProvenance, SessionSpawnOrigin, SessionSpawnRequest } from './types.ts';

/** Everything the daemon must record and apply for one spawn. */
export interface StampedSpawn {
  /** The stamp to persist with the session. */
  readonly provenance: SessionProvenance;
  /**
   * The label the session must be stored with, which is NOT always the one that
   * was requested — warden descent forces it.
   */
  readonly label: string | undefined;
}

/**
 * Which origin a spawn records.
 *
 * Warden descent wins over the human flag: a person can ask a warden to
 * delegate, but the session that results is still warden offspring, and calling
 * it human-originated would misattribute anything the warden then does through
 * it.
 */
function originOf(request: SessionSpawnRequest, wardenLineage: boolean): SessionSpawnOrigin {
  if (wardenLineage) return 'warden';
  if (request.parent !== undefined) return 'session';
  return request.requestedByHuman ? 'human' : 'session';
}

export class SessionProvenanceStamper {
  constructor(private readonly clock: ClockPort) {}

  /**
   * Stamp a brand-new session.
   *
   * `fleet` is the ancestor snapshot the lineage walk may resolve against; an
   * empty map is legitimate and simply means no ancestor can be consulted.
   */
  stamp(request: SessionSpawnRequest, fleet: ReadonlyMap<string, SessionAncestor>): StampedSpawn {
    const decision = resolveWardenLineage(request, fleet);
    const parent = request.parent === undefined ? undefined : fleet.get(request.parent);
    return {
      provenance: {
        v: 1,
        at: this.clock.now(),
        origin: originOf(request, decision.wardenLineage),
        ...(request.parent === undefined ? {} : { parent: request.parent }),
        ...(decision.warden === undefined ? {} : { warden: decision.warden }),
        wardenLineage: decision.wardenLineage,
        lineageSource: decision.lineageSource,
      },
      label: resolveSpawnLabel(request, parent, decision),
    };
  }

  /**
   * Re-stamp a session that is being resumed or revived.
   *
   * `existing` is whatever survived on disk — possibly nothing, for a session
   * created before stamping existed. The spawn facts (`at`, `origin`, `parent`)
   * come from the existing stamp when there is one, because a resume does not
   * create the session and must not rewrite its history. Lineage is MONOTONIC:
   * once recorded, no later resolution can clear it, so a pruned warden ancestor
   * can no longer unshield its offspring.
   *
   * `request` must carry the session's CURRENT label and parent, not an empty
   * shell: the returned label is what the session is stored with, and a resume
   * that omitted the label would drop the group the session belongs to. Only
   * lineage is recovered from the stamp — the rest of the request is the caller's
   * to supply.
   */
  restamp(
    request: SessionSpawnRequest,
    fleet: ReadonlyMap<string, SessionAncestor>,
    existing: SessionProvenance | undefined,
  ): StampedSpawn {
    const fresh = this.stamp(request, fleet);
    if (existing === undefined) return fresh;
    if (existing.wardenLineage) {
      // Already shielded. Keep the original evidence verbatim rather than
      // downgrading a `parent_stamp` to an `ancestor_walk` that happens to still
      // resolve, and keep the label forced.
      return { provenance: existing, label: WARDEN_LABEL };
    }
    return {
      provenance: {
        ...fresh.provenance,
        at: existing.at,
        origin: fresh.provenance.wardenLineage ? fresh.provenance.origin : existing.origin,
        ...(existing.parent === undefined ? {} : { parent: existing.parent }),
      },
      label: fresh.label,
    };
  }
}
