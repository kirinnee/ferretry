/**
 * Spawn-side provenance for one session: who caused it to exist, and whether it
 * descends from a warden.
 *
 * This is the writer half of a contract whose reader is already merged. The
 * warden detector shields a session from every anomaly class when
 * `config.wardenLineage` is true, because a warden that escalates against its
 * own offspring loops forever. That shield is only as good as the stamp, and the
 * stamp is the only mechanism that survives the thing that breaks the
 * alternative: a warden is ephemeral and is pruned while its children are still
 * running, so walking `parent` to rediscover descent reaches the truth exactly
 * while the ancestor it needs is still present — which for a finished warden is
 * precisely when it is not.
 *
 * So provenance is a safety mechanism, not bookkeeping: record descent at spawn,
 * carry it forward across resume and revive, and never let it weaken.
 *
 * It round-trips through durable session state, so it is parsed back with a
 * schema rather than trusted — a partial or hand-edited record must never be
 * read as "not a warden descendant".
 */

import { z } from 'zod';
import { InstantSchema } from '../../instant.ts';

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
 * Recorded because the three mechanisms are not equally trustworthy, and a
 * shield that turns out to be wrong is only diagnosable if the evidence behind
 * it was kept. `parent_stamp` is the authoritative path; `ancestor_walk` is the
 * backstop that only works while the ancestor still exists.
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
     * The warden this session traces back to: itself when it IS a warden, the
     * nearest warden ancestor otherwise. This is the traceback that lets a
     * verdict be attributed to the warden that issued it after that warden is
     * gone.
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
  .refine(value => !value.wardenLineage || value.warden !== undefined, {
    message: 'a warden descendant must name the warden it traces back to',
    path: ['warden'],
  });
export type SessionProvenance = z.infer<typeof SessionProvenanceSchema>;

/**
 * One session as lineage resolution sees it.
 *
 * Deliberately narrower than the lifecycle record: resolution reads an id, a
 * label, a parent and a stamp, and declaring exactly those keeps the decision
 * layer independent of the persisted session shape.
 */
export interface SessionAncestor {
  readonly id: string;
  readonly label?: string;
  readonly parent?: string;
  /** The stamp this ancestor already carries, when it carries one. */
  readonly provenance?: SessionProvenance;
}

/** A spawn as the stamper sees it. */
export interface SessionSpawnRequest {
  /** The id already minted for the new session. */
  readonly id: string;
  /** The label the caller asked for, before any forcing. */
  readonly label?: string;
  /** The resolved parent, or nothing for a root session. */
  readonly parent?: string;
  /** Whether a person asked for this session directly. */
  readonly requestedByHuman: boolean;
}

/**
 * Parse a persisted stamp, returning `undefined` rather than throwing when it is
 * partial, corrupt, or internally inconsistent.
 *
 * An unreadable stamp is treated as no stamp, which forces a fresh resolution
 * rather than silently shielding — or silently exposing — the session.
 */
export function parseSessionProvenance(value: unknown): SessionProvenance | undefined {
  const parsed = SessionProvenanceSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
