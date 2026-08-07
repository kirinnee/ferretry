/**
 * What names one fork, and what names the decision it was asked to carry out.
 *
 * TWO IDENTITIES, DELIBERATELY SEPARATE, because they answer different questions and conflating
 * them is the defect this file exists to prevent.
 *
 * `SessionForkKey` — the COMPOSITE `(sourceSessionId, requestId)` — names the logical fork. A
 * request id is minted by the CALLER, so two different sessions can honestly be asked to fork under
 * the same one: a phone retrying a fork of session A and a laptop forking session B may both send
 * `req-7`. Keyed on the request id alone, the second caller would be answered with the first
 * caller's receipt and told that a session it never asked about had been forked. Keyed on the pair,
 * the same id on a different source is simply a different fork, which is the truth.
 *
 * The FINGERPRINT names the payload and nothing else. It deliberately does NOT include the source
 * session id: the key already pins that, the receipt pins it a second time against its own plan,
 * and a fingerprint that mixed the subject in would compare "which fork is this" with "what was it
 * asked to do" in one opaque string. So the two checks stay independent — a wrong subject is a
 * store defect, a wrong payload is a caller conflict, and the refusals say different things.
 *
 * `v` PARTICIPATES IN PAYLOAD IDENTITY. `ConversationMessagePoint` is a versioned durable wire
 * value, so a `v: 2` point that happened to carry the same `byteOffset` addresses a message under
 * whatever `v: 2` comes to mean. Two such requests under one request id are two different forks and
 * must conflict rather than replay each other, so the version is canonicalised alongside the offset
 * rather than dropped as a constant.
 */

import { createHash } from 'node:crypto';
import type { ConversationMessagePoint, SessionTransferPlan } from '@ferretry/protocol';

/**
 * The caller's already-parsed decision.
 *
 * A plain value rather than a schema: the wire shape of a fork request belongs to
 * `@ferretry/protocol` and the mount that parses it. A second schema here would be a second
 * definition of the same request with nothing to keep the two honest.
 *
 * `model` and `effort` are NULLABLE rather than optional so that "the caller stated no model" has
 * exactly one spelling. Two spellings of one fact canonicalise to two fingerprints, and a caller
 * whose retry serialised the field differently would be refused for a conflict it does not have.
 * Neither field is interpreted here — a target catalogue owns what a model or an effort means.
 */
export interface SessionForkCommand {
  /** The exact durable message the new session's conversation is cut at. */
  readonly through: ConversationMessagePoint;
  /** Opaque evidence that the raw prefix at `through` is still the one the operator selected. */
  readonly selectionBinding: string;
  readonly agent: string;
  readonly model: string | null;
  readonly effort: string | null;
}

/** One logical fork: a source, and the caller-minted id it asked under. */
export interface SessionForkKey {
  readonly sourceSessionId: string;
  readonly requestId: string;
}

/** The stable string identity of one logical fork, for keying and for refusal messages. */
export function sessionForkKey(key: SessionForkKey): string {
  return JSON.stringify([key.sourceSessionId, key.requestId]);
}

/**
 * The canonicalisation the fingerprint is taken over, exported so it can be read and tested.
 *
 * Field ORDER is the canonical form — an object would leave identity at the mercy of key insertion
 * order, and a retry assembled by a different code path would fingerprint differently while asking
 * for exactly the same fork. The leading namespace and version make this string's meaning explicit,
 * so a future field can be added with a version bump instead of silently re-dating every receipt
 * already on disk.
 */
export function canonicalSessionForkPayload(command: SessionForkCommand): string {
  return JSON.stringify([
    'session-fork',
    2,
    command.through.v,
    command.through.byteOffset,
    command.through.blockIndex,
    command.selectionBinding,
    command.agent,
    command.model,
    command.effort,
  ]);
}

/** The durable identity of one parsed fork payload. */
export function sessionForkFingerprint(command: SessionForkCommand): string {
  return createHash('sha256').update(canonicalSessionForkPayload(command)).digest('hex');
}

export interface SessionForkDecisionIdentity {
  readonly key: SessionForkKey;
  readonly requestFingerprint: string;
  readonly targetSessionId: string;
  readonly plan: SessionTransferPlan;
}

/**
 * Orders two object keys by UTF-16 code unit, which is the same order on every host.
 *
 * `localeCompare` was here, and it cannot be the ordering behind a DURABLE fingerprint: it answers
 * by collation, which consults the runtime's ICU data and the ambient locale. Two daemons — or one
 * daemon before and after a runtime upgrade — can therefore order the same two keys differently,
 * spell the same plan two ways, and hash it to two different decision fingerprints. The receipt
 * already on disk would then read as a mismatch against the very plan it was written from, and the
 * replay would refuse a fork that has nothing wrong with it. `<` and `>` on strings are defined by
 * code unit and consult no locale, so the spelling is a property of the value alone.
 *
 * `src/lib/tasks/task-order.ts` records the same lesson from the ordering kteam shipped.
 */
function byCodeUnit(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/** Recursively sorts object keys while preserving array order, yielding one JSON spelling per value. */
function canonicalJson(value: unknown): string {
  const normalized = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(entry => normalized(entry));
    if (candidate !== null && typeof candidate === 'object')
      return Object.fromEntries(
        Object.entries(candidate)
          .filter(([, entry]) => entry !== undefined)
          .sort(([left], [right]) => byCodeUnit(left, right))
          .map(([key, entry]) => [key, normalized(entry)]),
      );
    return candidate;
  };
  return JSON.stringify(normalized(value));
}

/**
 * Every resolved decision a durable fork receipt freezes.
 *
 * Unlike the request fingerprint above, this includes the explicit target binding and the complete
 * parsed transfer plan: resolved account/harness/model/effort, every durable setting, and every
 * facet. A same-key re-prepare therefore cannot replace P0 with a different but superficially
 * similar P1 after a crash.
 */
export function canonicalSessionForkDecision(decision: SessionForkDecisionIdentity): string {
  return canonicalJson([
    'session-fork-decision',
    1,
    decision.key.sourceSessionId,
    decision.key.requestId,
    decision.requestFingerprint,
    decision.targetSessionId,
    decision.plan,
  ]);
}

/** The durable identity of the full resolved plan and its one reserved target. */
export function sessionForkDecisionFingerprint(decision: SessionForkDecisionIdentity): string {
  return createHash('sha256').update(canonicalSessionForkDecision(decision)).digest('hex');
}
