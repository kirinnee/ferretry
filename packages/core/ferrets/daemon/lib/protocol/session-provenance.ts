/**
 * Spawn-side provenance for one session: who caused it to exist, and whether it descends from a
 * warden.
 *
 * THIS IS A SAFETY MECHANISM, NOT BOOKKEEPING. The warden detector shields a session from every
 * anomaly class when it can prove warden descent, because a warden that escalates against its own
 * offspring loops forever. The shield is only as good as the record behind it, and a stamp is the
 * only mechanism that survives the thing which breaks the alternative: a warden is ephemeral and is
 * pruned while its children are still running, so walking `parent` to rediscover descent reaches the
 * truth exactly while the ancestor it needs still exists — which for a finished warden is precisely
 * when it does not.
 *
 * So: record descent at spawn, carry it forward across resume and revive, and never let it weaken.
 *
 * WHY IT LIVES IN THE PROTOCOL. The stamp is a field of `SessionConfig`, which means the daemon
 * writes it, the CLI reads it, and every paired browser receives it in a session view. A shape with
 * four readers in three packages has exactly one honest home, and this is it.
 *
 * EVERY REFINEMENT IS LOAD-BEARING. Together they make an inconsistent stamp UNREADABLE rather
 * than half-true, and half-true is the dangerous state: a record claiming descent while naming no
 * warden would shield a session whose ancestry nobody can audit afterwards, while a stray warden
 * or warden origin beside `wardenLineage: false` would preserve only half of the same safety fact.
 */

/** The contract owns these shapes (`contract/records.ts`): `ferret.json` carries the stamp. */
export {
  type SessionProvenance,
  SessionProvenanceSchema,
  type SessionSpawnOrigin,
  SessionSpawnOriginSchema,
  type WardenLineageSource,
  WardenLineageSourceSchema,
} from '../../../contract/records.ts';
