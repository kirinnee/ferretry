/**
 * Carrying the spawn stamp forward across a resume or a revive.
 *
 * WHY A RESUME NEEDS TO WRITE ANYTHING AT ALL. The stamp is made at create and lives in the
 * session's configuration document, and `StorageSessionLifecycleRepository.configDocument` merges
 * `{ ...envelope, ...stored, ...record.config }` — the STORED document beats the envelope. That is
 * exactly right for monotonicity, because it means no later transition can quietly overwrite a
 * shield. It also means a re-stamp cannot be delivered through the lifecycle at all, so a session
 * created before stamping existed would carry no stamp for the rest of its life, and its offspring
 * would resolve descent by walking to an ancestor that may already be pruned. This service is the
 * seam that fixes both, and it is the only writer on the revive path.
 *
 * MONOTONICITY IS NOT REIMPLEMENTED HERE. `SessionProvenanceStamper.restamp` already refuses to
 * weaken a recorded lineage — it returns the existing stamp verbatim once descent is on record —
 * and a second copy of that rule here would be a second place for it to drift. This service decides
 * only WHEN to write, never what the stamp should say.
 *
 * IT WRITES ONLY ON A DIFFERENCE, and that is a correctness property rather than an optimisation. A
 * revive of an already-correct session is the common case by a wide margin, and an unconditional
 * write would rewrite every session's configuration document on every revive — turning a read-mostly
 * document into a write-mostly one, and widening the window in which a torn write can damage a
 * record whose whole purpose is to survive.
 */

import type { SessionProvenance } from '@ferretry/protocol';
import type { SessionProvenanceStamper } from './stamper.ts';
import type { SessionAncestor, SessionSpawnRequest } from './types.ts';

/**
 * The two fields one spawn decision owns, as they are stored today.
 *
 * THE LABEL IS HERE BECAUSE IT IS PART OF THE SAME DECISION. `resolveSpawnLabel` FORCES a warden
 * descendant's label, so the stamp and the label are two halves of one answer — and a document where
 * they disagree is worse than one carrying neither, because `inWardenLineage` checks the LABEL first
 * and a stale non-warden label beside `wardenLineage: true` hides the disagreement until somebody
 * edits it. A start writes both from one `stamp()` call; a revive has to do the same or it
 * re-introduces exactly the split the start avoids.
 */
export interface SessionProvenanceRecord {
  readonly provenance?: SessionProvenance;
  readonly label?: string;
}

/** Reads and writes one session's spawn decision. Nothing else in the document is its business. */
export interface SessionProvenanceStore {
  read(sessionId: string): Promise<SessionProvenanceRecord>;
  write(sessionId: string, record: SessionProvenanceRecord): Promise<void>;
}

/** The fleet as lineage resolution may consult it. Snapshotted per relaunch, never cached. */
export interface SessionAncestry {
  snapshot(): Promise<ReadonlyMap<string, SessionAncestor>>;
}

/** What the recorder answers with, so a caller can tell "already right" from "brought up to date". */
export interface RecordedProvenance {
  readonly provenance: SessionProvenance;
  /** The label the stamp forces, which a warden descendant is stored under. */
  readonly label: string | undefined;
  /** False when the stored stamp already said this, so nothing was written. */
  readonly written: boolean;
}

export class SessionProvenanceRecorder {
  constructor(
    private readonly stamper: SessionProvenanceStamper,
    private readonly store: SessionProvenanceStore,
    private readonly ancestry: SessionAncestry,
  ) {}

  /**
   * Brings one relaunched session's stamp up to date, writing only if it changed.
   *
   * `request` must carry the session's CURRENT label and parent rather than an empty shell: the
   * label the stamper returns is what the session is stored under, and a relaunch that omitted the
   * label would drop the group the session belongs to.
   */
  async recordRelaunch(request: SessionSpawnRequest): Promise<RecordedProvenance> {
    const stored = await this.store.read(request.id);
    const stamped = this.stamper.restamp(request, await this.ancestry.snapshot(), stored.provenance);
    const label = normalizedLabel(stamped.label);

    /**
     * BOTH HALVES ARE COMPARED, and the label is not an afterthought.
     *
     * A session discovered to be warden-descended on this relaunch gets `wardenLineage: true` — and
     * without the label comparison it would keep whatever non-warden label it was started under,
     * producing a document whose two shield mechanisms disagree. An already-shielded session whose
     * label has since drifted is the same defect arriving from the other direction, and comparing
     * only the stamp would report `written: false` and repair nothing.
     */
    /**
     * The STORED label is compared RAW against the decided one, deliberately.
     *
     * Normalising both sides first would read a stored `'   '` as already equal to a decided
     * `undefined` and leave that noncanonical value on disk forever — and nothing downstream trims:
     * a surface grouping sessions by label treats `'   '` as its own group, so the session sits in a
     * group of one that nobody asked for. Comparing raw makes the mismatch visible exactly once; the
     * write below removes the key, and every later relaunch compares `undefined` to `undefined` and
     * writes nothing. One repair, then stable.
     */
    if (
      stored.provenance !== undefined &&
      sameProvenance(stored.provenance, stamped.provenance) &&
      stored.label === label
    )
      return { provenance: stored.provenance, label, written: false };

    await this.store.write(request.id, { provenance: stamped.provenance, ...(label === undefined ? {} : { label }) });
    return { provenance: stamped.provenance, label, written: true };
  }
}

/**
 * A label that is absent, blank, or only whitespace is the SAME answer: this session has none.
 *
 * Normalising before the comparison is what stops a document flipping between `''` and an absent
 * field on every relaunch — an endless rewrite of a record whose whole purpose is to sit still.
 */
function normalizedLabel(label: string | undefined): string | undefined {
  const trimmed = label?.trim() ?? '';
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Whether two stamps say the same thing, field by field.
 *
 * Written out rather than compared by serialisation because the two optional fields make key ORDER
 * and key PRESENCE both variable, and a JSON comparison would report a difference for a stamp that
 * is identical in every way that matters — producing exactly the unconditional rewrite this service
 * exists to avoid.
 */
function sameProvenance(left: SessionProvenance, right: SessionProvenance): boolean {
  return (
    left.v === right.v &&
    left.at === right.at &&
    left.origin === right.origin &&
    left.parent === right.parent &&
    left.warden === right.warden &&
    left.wardenLineage === right.wardenLineage &&
    left.lineageSource === right.lineageSource
  );
}
