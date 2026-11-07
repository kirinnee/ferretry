/**
 * Deciding whether a session about to be spawned descends from a warden.
 *
 * The source resolved this by walking `parent` at start time and asking whether
 * any ancestor carried the warden label. That walk is a backstop, not a
 * mechanism: it succeeds only while every ancestor between the session and the
 * warden is still in the index, and a warden finishes and is pruned long before
 * its children do. The fix is to consult the ancestor's own stamp FIRST — a
 * durable record made when the fact was known — and to fall back to the walk
 * only for sessions that predate stamping.
 */

import { WARDEN_LABEL } from '../../warden/types.ts';
import type { SessionAncestor, WardenLineageSource } from './types.ts';

/** What lineage resolution concluded, and on what evidence. */
export interface WardenLineageDecision {
  readonly wardenLineage: boolean;
  readonly lineageSource: WardenLineageSource;
  /** The warden the session traces back to; absent exactly when there is none. */
  readonly warden?: string;
}

const NOT_A_DESCENDANT: WardenLineageDecision = { wardenLineage: false, lineageSource: 'none' };

/** The warden an ancestor traces back to: the one its own stamp names, or itself
 *  when it is the warden. */
function wardenOf(ancestor: SessionAncestor): string {
  return ancestor.provenance?.warden ?? ancestor.id;
}

/** True when this single session is a warden or is already stamped as descending
 *  from one — the two facts that need no walking. */
function isWardenOrStamped(ancestor: SessionAncestor): boolean {
  return ancestor.label === WARDEN_LABEL || ancestor.provenance?.wardenLineage === true;
}

/**
 * Resolve warden descent for a spawn.
 *
 * `fleet` is a snapshot of the sessions the walk may resolve against, keyed by
 * id. It is passed in rather than read so this stays a pure decision — the same
 * shape the merged detector's own lineage check uses.
 *
 * The three mechanisms, in decreasing reliability:
 *
 * 1. The requested label is the warden label — the session IS a warden.
 * 2. The parent's stamp already records descent. Authoritative: it was written
 *    when the fact was known and it outlives the warden that caused it.
 * 3. Walking `parent` for a labelled warden. A backstop for sessions started
 *    before stamping existed.
 *
 * A parent that resolves nowhere leaves ancestry unknown, and unknown is NOT
 * treated as descent: shielding every session whose parent has been pruned would
 * quietly disable supervision for all of them.
 */
export function resolveWardenLineage(
  request: { readonly id: string; readonly label?: string; readonly parent?: string },
  fleet: ReadonlyMap<string, SessionAncestor>,
): WardenLineageDecision {
  if (request.label?.trim() === WARDEN_LABEL) {
    return { wardenLineage: true, lineageSource: 'self_label', warden: request.id };
  }
  const parent = request.parent === undefined ? undefined : fleet.get(request.parent);
  if (parent !== undefined && parent.provenance?.wardenLineage === true) {
    return { wardenLineage: true, lineageSource: 'parent_stamp', warden: wardenOf(parent) };
  }

  // The walk starts at the parent, not the session: the session does not exist
  // yet, and its own label was already ruled out above.
  const seen = new Set<string>([request.id]);
  let current = parent;
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    if (isWardenOrStamped(current)) {
      return { wardenLineage: true, lineageSource: 'ancestor_walk', warden: wardenOf(current) };
    }
    current = current.parent === undefined ? undefined : fleet.get(current.parent);
  }
  return NOT_A_DESCENDANT;
}

/**
 * The label a spawn must actually be stored with.
 *
 * Anything below a warden is FORCE-labelled, overriding both the requested label
 * and the one it would inherit, so a warden can never spawn a session the
 * detector would consider escalatable. With no descent, an explicit label wins
 * and an unattended child inherits its parent's so whole trees group together in
 * the session list.
 *
 * A blank or whitespace-only label is no label: the source stored `''` here,
 * which reads as a real label everywhere downstream and put such sessions in a
 * group whose name cannot be typed.
 */
export function resolveSpawnLabel(
  request: { readonly label?: string },
  parent: SessionAncestor | undefined,
  decision: WardenLineageDecision,
): string | undefined {
  if (decision.wardenLineage) return WARDEN_LABEL;
  const requested = request.label?.trim();
  if (requested !== undefined && requested.length > 0) return requested;
  const inherited = parent?.label?.trim();
  return inherited === undefined || inherited.length === 0 ? undefined : inherited;
}
