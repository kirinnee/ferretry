/**
 * The durable record of an irreversible act on one session's terminal: did it BEGIN, and did it
 * SETTLE.
 *
 * WHY DONE/NOT-DONE IS NOT ENOUGH, which is the whole reason this exists. Typing into a live harness
 * is not idempotent — a second `/compact` discards context nobody asked to lose, a second picker
 * drive opens a modal the first one may still be inside, and a second first turn hands an agent work
 * it may already have taken. A monotonic phase can only say whether an act finished, so after a
 * crash it reports "not finished" for two situations that call for opposite reactions: one where
 * nothing was typed, and one where the keystrokes landed and the answer was lost. Those must be
 * distinguishable, and only a record written BEFORE the act can distinguish them.
 *
 * So there are three durable states and the middle one is the point:
 *
 *   nothing on disk   the act has never been attempted; perform it
 *   `begun`           it was attempted and how it ended was never recorded; REFUSE, never replay
 *   `settled`         it finished; a retry resumes from that fact rather than repeating the act
 *
 * A LEDGER OF INTENT, NOT OF MEANING. It stores an opaque `effectId` and an opaque `fingerprint` and
 * never interprets either. What the act WAS — which model, which reasoning level, which turn — is
 * owned by whatever decided it, and a second description of that here would be a second owner able
 * to disagree with the first about what a retry is asking for.
 *
 * THE FINGERPRINT IS AUTHORIZATION, NOT AN OPTIMISATION. An effect id is minted by a caller, so the
 * same id presented with a different payload is a DIFFERENT act wearing an id that is already spoken
 * for. Answering it from the first act's record would tell a caller its reasoning switch had settled
 * when what settled was somebody else's model change, so it is a conflict and neither act happens.
 */

import { z } from 'zod';
import { InstantSchema } from '../../instant.ts';
import { type SessionId, SessionIdSchema } from '../../session-id.ts';

/**
 * One irreversible act on one session, named so a retry can recognise its own.
 *
 * The session id is part of the key rather than implied by where the record is kept, because the
 * record is read back off disk after a restart and must be able to prove it belongs to the session
 * asking about it — a path is evidence about a lookup, not about a document.
 */
export interface SessionEffectKey {
  readonly sessionId: SessionId;
  /** Opaque and caller-minted. Two different acts must never share one. */
  readonly effectId: string;
}

/** The two durable states of an effect that exists at all. */
export const SESSION_EFFECT_PHASES = ['begun', 'settled'] as const;
const SessionEffectPhaseSchema = z.enum(SESSION_EFFECT_PHASES);
export type SessionEffectPhase = z.infer<typeof SessionEffectPhaseSchema>;

/**
 * The whole durable value, parsed rather than asserted.
 *
 * `settledAt` exists exactly when the phase is `settled`, as a refinement rather than a convention:
 * a document carrying one without the other is a record this daemon wrote wrong, and reading it as
 * either state would answer a retry with a guess about whether keystrokes reached a live agent.
 */
export const SessionEffectRecordSchema = z
  .strictObject({
    v: z.literal(1),
    sessionId: SessionIdSchema,
    /** Stored verbatim, so the document proves which act it is independently of its filename. */
    effectId: z.string().min(1),
    /** The caller's rendering of what this act was asked to do. Opaque here. */
    fingerprint: z.string().min(1),
    phase: SessionEffectPhaseSchema,
    begunAt: InstantSchema,
    settledAt: InstantSchema.optional(),
  })
  .superRefine((value, context) => {
    if ((value.phase === 'settled') !== (value.settledAt !== undefined))
      context.addIssue({
        code: 'custom',
        message: 'an effect records when it settled exactly once it has settled, and never before',
        path: ['settledAt'],
      });
  });
export type SessionEffectRecord = z.infer<typeof SessionEffectRecordSchema>;

/** What a stored effect says about a caller asking under the same key. */
export type SessionEffectStanding =
  /** Never attempted. */
  | 'unclaimed'
  /** Attempted and finished: a retry resumes from it. */
  | 'settled'
  /** Attempted, and how it ended was never recorded. Nothing may replay it. */
  | 'unsettled'
  /** The key is held for a different act than the one being asked about. */
  | 'conflict';

/**
 * The standing of an effect that EXISTS.
 *
 * `unclaimed` is excluded by construction rather than by convention: it is a statement about an
 * absent file, so a record that is on disk can never be in it, and the type says so where a caller
 * would otherwise have to prove it.
 */
export type SessionEffectHeldStanding = Exclude<SessionEffectStanding, 'unclaimed'>;

/** What an attempt may do, which is the standing with `unclaimed` resolved into an instruction. */
export type SessionEffectAdmission = SessionEffectHeldStanding | 'perform';

/**
 * The durable begun/settled ledger.
 *
 * `inspect` and `begin` are deliberately separate. `inspect` answers without writing, for a caller
 * that wants to know where an act stands — a recovery report, or a precondition read before other
 * refusals are evaluated. `begin` is the compare-and-set that a caller must win before it may touch
 * a terminal, and it is the only method that admits an act.
 */
export interface SessionEffectLedger {
  /** Where this act stands, writing nothing. */
  inspect(key: SessionEffectKey, fingerprint: string): Promise<SessionEffectStanding>;
  /**
   * Durably records the intent BEFORE the act, and says what this attempt may do.
   *
   * `perform` is returned to exactly one attempt per key, whatever else is racing it.
   */
  begin(key: SessionEffectKey, fingerprint: string, at: string): Promise<SessionEffectAdmission>;
  /**
   * Durably records that the act finished.
   *
   * Idempotent only for an effect that is ALREADY settled under the same fingerprint. A missing,
   * damaged or conflicting document is refused rather than repaired: settling an effect nothing
   * began would manufacture a record that keystrokes reached an agent, which is the one lie this
   * ledger exists to make impossible.
   */
  settle(key: SessionEffectKey, fingerprint: string, at: string): Promise<void>;
}

/** Raised where an effect record cannot be read, or cannot be settled as asked. */
export class SessionEffectLedgerError extends Error {
  constructor(
    readonly key: SessionEffectKey,
    detail: string,
  ) {
    super(`the durable effect ${JSON.stringify(key.effectId)} on session ${key.sessionId} ${detail}`);
    this.name = 'SessionEffectLedgerError';
  }
}

/**
 * Reads a stored document as this key's effect record, refusing anything else.
 *
 * The key is re-proved against the document rather than trusted from the lookup, because the
 * filename is a HASH of the effect id: a collision, a hand-edited file or a record copied between
 * sessions would otherwise answer one act's retry with another act's outcome, and the retry would
 * skip keystrokes it still owed or repeat ones it did not.
 */
export function parseSessionEffectRecord(document: unknown, key: SessionEffectKey): SessionEffectRecord {
  const parsed = SessionEffectRecordSchema.safeParse(document);
  if (!parsed.success)
    throw new SessionEffectLedgerError(
      key,
      `has a record that is not a usable one: ${parsed.error.issues
        .map(issue => `${issue.path.join('.') || '(root)'} ${issue.message}`)
        .join('; ')}`,
    );
  if (parsed.data.sessionId !== key.sessionId || parsed.data.effectId !== key.effectId)
    throw new SessionEffectLedgerError(
      key,
      `has a record belonging to ${JSON.stringify(parsed.data.effectId)} on session ${parsed.data.sessionId}`,
    );
  return parsed.data;
}

/** Where a held record leaves a caller asking under the same key. */
export function sessionEffectStanding(held: SessionEffectRecord, fingerprint: string): SessionEffectHeldStanding {
  if (held.fingerprint !== fingerprint) return 'conflict';
  return held.phase === 'settled' ? 'settled' : 'unsettled';
}

/** The record an attempt writes before it touches anything. */
export function beginSessionEffect(key: SessionEffectKey, fingerprint: string, at: string): SessionEffectRecord {
  return parseSessionEffectRecord(
    { v: 1, sessionId: key.sessionId, effectId: key.effectId, fingerprint, phase: 'begun', begunAt: at },
    key,
  );
}

/** The record that says the act finished, keeping the instant the attempt began verbatim. */
export function settleSessionEffect(held: SessionEffectRecord, at: string): SessionEffectRecord {
  return parseSessionEffectRecord(
    { ...held, phase: 'settled', settledAt: at },
    { sessionId: held.sessionId, effectId: held.effectId },
  );
}
