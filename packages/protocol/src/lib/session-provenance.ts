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
 * four readers in three packages has exactly one honest home, and this is it. The daemon keeps the
 * BEHAVIOUR that goes with the shape — `parseSessionProvenance`, which reads a damaged stamp as no
 * stamp — because "what to do about a record we cannot read" is a daemon decision, not a wire fact.
 *
 * EVERY REFINEMENT IS LOAD-BEARING. Together they make an inconsistent stamp UNREADABLE rather
 * than half-true, and half-true is the dangerous state: a record claiming descent while naming no
 * warden would shield a session whose ancestry nobody can audit afterwards, while a stray warden
 * or warden origin beside `wardenLineage: false` would preserve only half of the same safety fact.
 */

import { z } from 'zod';
import { InstantSchema } from './common.ts';

/** What caused a session to be started. */
export const SessionSpawnOriginSchema = z.enum([
  /** A person asked for it. */
  'human',
  /** Another session spawned it as a teammate. */
  'session',
  /** A warden created it — either the warden itself or something it delegated to. */
  'warden',
]);
export type SessionSpawnOrigin = z.infer<typeof SessionSpawnOriginSchema>;

/**
 * How warden descent was established.
 *
 * Recorded because the three mechanisms are not equally trustworthy, and a shield that turns out to
 * be wrong is only diagnosable if the evidence behind it was kept. `parent_stamp` is the
 * authoritative path; `ancestor_walk` is the backstop that only works while the ancestor still
 * exists.
 */
export const WardenLineageSourceSchema = z.enum(['self_label', 'parent_stamp', 'ancestor_walk', 'none']);
export type WardenLineageSource = z.infer<typeof WardenLineageSourceSchema>;

export const SessionProvenanceSchema = z
  .object({
    v: z.literal(1),
    /** When the stamp was first made. Preserved across resume and revive. */
    at: InstantSchema,
    origin: SessionSpawnOriginSchema,
    /** The resolved parent session, when the spawn had one. */
    parent: z.string().min(1).optional(),
    /**
     * The warden this session traces back to: itself when it IS a warden, the nearest warden
     * ancestor otherwise. This is the traceback that lets a verdict be attributed to the warden that
     * issued it after that warden is gone.
     */
    warden: z.string().min(1).optional(),
    /** Authoritative descent record read by the warden detector. */
    wardenLineage: z.boolean(),
    lineageSource: WardenLineageSourceSchema,
  })
  .refine(value => value.wardenLineage === (value.lineageSource !== 'none'), {
    message: 'wardenLineage disagrees with the recorded lineage source',
    path: ['wardenLineage'],
  })
  .refine(value => value.wardenLineage === (value.warden !== undefined), {
    message: 'wardenLineage disagrees with the recorded warden traceback',
    path: ['warden'],
  })
  .refine(value => value.wardenLineage === (value.origin === 'warden'), {
    message: 'wardenLineage disagrees with the recorded spawn origin',
    path: ['origin'],
  });
export type SessionProvenance = z.infer<typeof SessionProvenanceSchema>;
