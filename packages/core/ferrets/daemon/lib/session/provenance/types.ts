/**
 * The daemon's half of spawn provenance: the decision inputs. `SessionProvenanceSchema` lives in
 * `@ferretry/protocol` because the stamp is a field of `SessionConfig` — the daemon writes it, the CLI
 * reads it, and every paired browser receives it in a session view.
 *
 * `SessionAncestor` and `SessionSpawnRequest` stay here — they are the INPUTS to a decision this daemon
 * makes, never durable records anybody else reads.
 */

import type { SessionProvenance } from '../../protocol/session.ts';

export type { SessionProvenance, SessionSpawnOrigin, WardenLineageSource } from '../../protocol/session-provenance.ts';
export { SessionProvenanceSchema, SessionSpawnOriginSchema, WardenLineageSourceSchema } from '../../protocol/session-provenance.ts';

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
