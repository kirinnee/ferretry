/**
 * The daemon's half of spawn provenance: the decision inputs, and what to do with a stamp that
 * cannot be read.
 *
 * THE SHAPE MOVED AND THE BEHAVIOUR STAYED, and the split is the point. `SessionProvenanceSchema`
 * now lives in `@ferretry/protocol` because the stamp is a field of `SessionConfig` — the daemon
 * writes it, the CLI reads it, and every paired browser receives it in a session view, so a shape
 * with readers in three packages needs one home. What could not move is
 * {@link parseSessionProvenance}: "an unreadable stamp is treated as no stamp" is a policy about
 * damaged local state, not a description of the wire, and the wire has no opinion about it.
 *
 * `SessionAncestor` and `SessionSpawnRequest` stay here too, and for the same reason — they are the
 * INPUTS to a decision this daemon makes, never durable records anybody else reads.
 *
 * The types are re-exported so no importer in this package had to change when the schema moved.
 */

import { type SessionProvenance, SessionProvenanceSchema } from '@ferretry/protocol';

export type { SessionProvenance, SessionSpawnOrigin, WardenLineageSource } from '@ferretry/protocol';
export { SessionProvenanceSchema, SessionSpawnOriginSchema, WardenLineageSourceSchema } from '@ferretry/protocol';

/**
 * One session as lineage resolution sees it.
 *
 * Deliberately narrower than the lifecycle record: resolution reads an id, a label, a parent and a
 * stamp, and declaring exactly those keeps the decision layer independent of the persisted session
 * shape.
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
 * Parse a persisted stamp, returning `undefined` rather than throwing when it is partial, corrupt,
 * or internally inconsistent.
 *
 * An unreadable stamp is treated as no stamp, which forces a fresh resolution rather than silently
 * shielding — or silently exposing — the session.
 *
 * STILL USEFUL AFTER THE FIELD WAS DECLARED, and it is worth saying why. Once `provenance` is part
 * of `SessionConfigSchema`, a damaged stamp fails the WHOLE config parse, so a reader that goes
 * through `SessionConfig` never sees one. This function is for the readers that do not: raw
 * documents, values from a store that has not parsed yet, and anything reconstructing a stamp by
 * hand.
 */
export function parseSessionProvenance(value: unknown): SessionProvenance | undefined {
  const parsed = SessionProvenanceSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
