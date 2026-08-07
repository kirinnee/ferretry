/**
 * The transfer envelope, written into the NEW session's own configuration document and nowhere else.
 *
 * This is the seam's `TransferEnvelopeWriter`: it takes the explicit target key on every call and
 * holds no other session id, so there is no argument through which it could be aimed at a source and
 * no closure that could have captured one (seam invariant I4). It goes further and REFUSES a target
 * that is the edge's own source, because the one document that names the source is the very envelope
 * being applied — so the cheapest possible check catches the one mistake that would be catastrophic.
 *
 * THREE FACTS LAND HERE, AND THE THIRD IS THE SAFETY-CRITICAL ONE:
 *
 *   * the durable configuration the transfer decided — the operator knobs, and the two hard
 *     statements `parent: absent` and `boardAccess: 'none'` that make a transferred session a
 *     top-level session with no inherited coordination authority;
 *   * `transferredFrom`, the target-only lineage edge back to the exact source, incarnation, cut and
 *     plan. It is written on the TARGET; nothing in this seam ever stamps the source;
 *   * warden descent, as a fresh spawn provenance stamp. `LineageFacet` is the transfer's answer to
 *     "does this conversation descend from a warden", and the warden detector reads its shield from
 *     the persisted stamp — so a facet that said `true` and was never written down would create a
 *     session a warden can escalate against, which is the loop the shield exists to prevent.
 *
 * IT IS REPLAY-SAFE BY BEING A PURE FUNCTION OF THE ENVELOPE. Every value written is either a
 * constant or a field of the plan-derived envelope, including the stamp's `at`, which is taken from
 * the edge rather than from a clock. Two applications of one envelope therefore produce byte-identical
 * documents, so a crash anywhere around this write replays into the same state rather than a newer one.
 *
 * A FRESH TARGET HAS NO SPAWN HISTORY, so the stamp is not merged with whatever is there — it is
 * reconciled against it. Absent means this is the first application; exactly the stamp this envelope
 * writes means a replay of it; anything else, damaged or perfectly valid, belongs to a session this
 * transfer did not create and is REFUSED. Neither obvious alternative is safe: overwriting erases
 * the evidence that something else owns the id, and adopting a foreign `wardenLineage` shields this
 * session on the strength of somebody else's ancestry, which the warden detector cannot later undo.
 *
 * The lifecycle record remains the authority for the fields it owns — the id, the name, the working
 * directory, the mode and the two instants — and the session repository writes those over this
 * document on its next transition. The values here agree with it by construction: the fork binder
 * refuses any target whose record disagrees with the plan before this writer is ever reached.
 */

import type { LineageFacet, SessionTransferEdge } from '@ferretry/protocol';
import type { JsonValue } from '../../lib/json.ts';
import { type SessionProvenance, SessionProvenanceSchema } from '../../lib/session/provenance/types.ts';
import { type SessionId, tryParseSessionId } from '../../lib/session-id.ts';
import { transferTargetLabel } from '../../lib/transfer/facets/lineage.ts';
import type { SessionTransferEnvelope, TransferEnvelopeWriter } from '../../lib/transfer/types.ts';
import type { DaemonStorage } from '../storage/session-storage.ts';

/** Raised where an envelope cannot be applied to the key it was handed. */
export class SessionTransferEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionTransferEnvelopeError';
  }
}

/** A JSON document as a plain field bag; anything else contributes no fields. */
function fields(document: unknown): Readonly<Record<string, unknown>> {
  return typeof document === 'object' && document !== null && !Array.isArray(document)
    ? (document as Readonly<Record<string, unknown>>)
    : {};
}

/**
 * The one spawn stamp a transferred session may carry, derived from the transfer decision alone.
 *
 * A transfer produces a TOP-LEVEL session, so the stamp names no parent — and the descent it does
 * carry therefore has to be recorded as `parent_stamp`, the authoritative source, because it was
 * resolved from the source session's own stamp while that session was still there to be read. An
 * `ancestor_walk` would be a claim this session could re-derive by walking a parent it does not have.
 *
 * TOTALLY DETERMINED, and exported so the fork binder reconciles a target's stored stamp against
 * THIS function rather than against a second description of the same rule. Every field is a function
 * of the lineage facet and the edge's instant, so one envelope has exactly one correct stamp and
 * anything else on a freshly reserved target is somebody else's.
 */
export function transferSpawnProvenance(lineage: LineageFacet, at: string): SessionProvenance {
  const carried = lineage.wardenLineage;
  // Parsed rather than asserted: an inconsistent stamp is refused here, before the detector reads it.
  return SessionProvenanceSchema.parse({
    v: 1,
    // The edge's instant, so a replay of one envelope writes one stamp rather than a fresher one.
    at,
    origin: carried ? 'warden' : 'human',
    ...(lineage.warden === null ? {} : { warden: lineage.warden }),
    wardenLineage: carried,
    lineageSource: carried ? 'parent_stamp' : 'none',
  });
}

/** Stable JSON: keys sorted recursively, so two equal values compare equal however they were built. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, held]) => held !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, held]) => `${JSON.stringify(key)}:${canonical(held)}`).join(',')}}`;
}

/**
 * The stamp to write, having refused anything already there that this envelope could not have put
 * there.
 *
 * A FRESHLY RESERVED TARGET HAS NO SPAWN HISTORY. So there are exactly two legitimate states: no
 * stamp at all, which is the first application, and precisely the stamp this envelope writes, which
 * is a replay of it. Everything else — a malformed record, or a perfectly valid one naming a
 * different warden — belongs to a session this transfer did not create, and both of the obvious
 * reactions to it are wrong. Overwriting a foreign stamp would erase the evidence that something
 * else owns this id; preserving a foreign `wardenLineage` would shield THIS session on the strength
 * of somebody else's ancestry, and the warden detector cannot tell the difference afterwards.
 */
function reconciledProvenance(current: unknown, envelope: SessionTransferEnvelope): JsonValue {
  const expected = transferSpawnProvenance(envelope.lineage, envelope.transferredFrom.at);
  if (current !== undefined && canonical(current) !== canonical(expected))
    throw new SessionTransferEnvelopeError(
      `the session this envelope names already carries a spawn stamp this transfer could not have written ` +
        `(${JSON.stringify(current)} rather than ${JSON.stringify(expected)}); a fork's target is a fresh session, ` +
        'so a foreign or damaged stamp is refused rather than overwritten or adopted',
    );
  return expected as unknown as JsonValue;
}

export class StorageTransferEnvelopeWriter implements TransferEnvelopeWriter {
  constructor(private readonly storage: DaemonStorage) {}

  async apply(newSessionId: string, envelope: SessionTransferEnvelope): Promise<void> {
    const id = this.target(newSessionId, envelope.transferredFrom);
    await this.storage.updateConfig(id, current => this.document(fields(current), envelope));
  }

  /** The explicit target key, proved usable and proved not to be the source it descends from. */
  private target(newSessionId: string, edge: SessionTransferEdge): SessionId {
    const id = tryParseSessionId(newSessionId);
    if (id === undefined)
      throw new SessionTransferEnvelopeError(
        `${JSON.stringify(newSessionId)} is not a usable session id, so a transfer envelope cannot be applied to it`,
      );
    if (id === edge.sourceSessionId)
      throw new SessionTransferEnvelopeError(
        `a transfer envelope names ${edge.sourceSessionId} as its source and may only ever be written to the fresh ` +
          'session it created; applying it to the source would restamp the very session this seam never touches',
      );
    return id;
  }

  /**
   * The merged configuration document.
   *
   * `parent` is DELETED rather than set to null, because the protocol spells an absent parent as an
   * absent field and a null would be refused by the schema every reader parses this with.
   */
  private document(current: Readonly<Record<string, unknown>>, envelope: SessionTransferEnvelope): JsonValue {
    const durable = envelope.durable;
    const merged: Record<string, unknown> = {
      ...current,
      cwd: durable.cwd,
      mode: durable.mode,
      boardAccess: durable.boardAccess,
      harnessFlags: [...durable.harnessFlags],
      remoteControl: durable.remoteControl,
      intervalSeconds: durable.intervalSeconds,
      timeoutSeconds: durable.timeoutSeconds,
      nudgeAfterSeconds: durable.nudgeAfterSeconds,
      killAfterSeconds: durable.killAfterSeconds,
      directSendMaxChars: durable.directSendMaxChars,
      resumeMenuChoice: durable.resumeMenuChoice,
      maxSnapshots: durable.maxSnapshots,
      retry: { ...durable.retry },
      transferredFrom: { ...envelope.transferredFrom },
      provenance: reconciledProvenance(current.provenance, envelope),
    };
    const targetLabel = transferTargetLabel(envelope.lineage, durable.label);
    if (targetLabel === null) delete merged.label;
    else merged.label = targetLabel;
    delete merged.parent;
    return merged as JsonValue;
  }
}
