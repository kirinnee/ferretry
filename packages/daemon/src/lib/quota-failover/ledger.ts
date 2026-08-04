/**
 * The durable record of what automatic failover has already done — the memory that makes "never
 * loop" true across a daemon restart.
 *
 * A DAMAGED LEDGER HALTS FAILOVER, and this is the single most important decision in the module.
 * An unreadable document is not an empty one: an empty ledger says "this session has never been
 * moved", which is precisely the permission a session that has already been moved twice must not be
 * granted. Reading damage as absence would turn a corrupted file into an unlimited move budget, and
 * two exhausted accounts would ping-pong a session for as long as the corruption lasted. So absence
 * (first boot) yields an empty ledger, and damage yields a refusal that names itself.
 *
 * WHY THE COUNTERS ARE HERE AND NOT DERIVED FROM THE SESSION DOCUMENT. A session's configuration
 * carries `migration: { from, to, at }` — the LAST move only, with no record of who asked for it. A
 * human's deliberate `fy migrate` and an unattended failover are indistinguishable in it, and the
 * move before last is gone. A guard built on that would spend a human's manual migration out of the
 * automatic budget, and would forget the first of two automatic moves.
 *
 * Pure: no IO, no clock, no globals.
 */

import { z } from 'zod';

const InstantSchema = z
  .string()
  .trim()
  .min(1)
  .refine(value => Number.isFinite(Date.parse(value)), 'must be a valid instant');

const QuotaFailoverMoveSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  at: InstantSchema,
  /** The reading the move was made on, kept so the record can be read back without the feed. */
  evidence: z.string().min(1),
});

export type QuotaFailoverMove = z.output<typeof QuotaFailoverMoveSchema>;

const QuotaFailoverSessionRecordSchema = z.object({
  /** Completed automatic moves, oldest first. */
  moves: z.array(QuotaFailoverMoveSchema).readonly().default([]),
  /** The last time this session was ATTEMPTED, whether it moved, was refused or failed. */
  lastAttemptAt: InstantSchema.optional(),
  lastOutcome: z.string().min(1).optional(),
});

export type QuotaFailoverSessionRecord = z.output<typeof QuotaFailoverSessionRecordSchema>;

const QuotaFailoverStateSchema = z.object({
  sessions: z.record(z.string().min(1), QuotaFailoverSessionRecordSchema).default({}),
  /** The last tick's own account, published so a human can tell a quiet loop from a stopped one. */
  lastTick: z
    .object({
      at: InstantSchema,
      summary: z.string(),
    })
    .optional(),
});

export type QuotaFailoverState = z.output<typeof QuotaFailoverStateSchema>;

export const emptyQuotaFailoverState: QuotaFailoverState = { sessions: {} };

/**
 * What a persisted ledger document means.
 *
 * `damaged` carries the reason rather than a flag, because that reason is what the tick reports as
 * its halt: an operator has to be told that failover is off and why, not merely that nothing moved.
 */
export type StoredQuotaFailoverState =
  | { readonly kind: 'ledger'; readonly state: QuotaFailoverState }
  | { readonly kind: 'damaged'; readonly reason: string };

/** Reads a stored ledger, refusing to read damage as a fresh start. */
export function parseStoredQuotaFailoverState(value: unknown): StoredQuotaFailoverState {
  if (value === undefined || value === null) return { kind: 'ledger', state: emptyQuotaFailoverState };
  const parsed = QuotaFailoverStateSchema.safeParse(value);
  if (parsed.success) return { kind: 'ledger', state: parsed.data };
  const issue = parsed.error.issues[0];
  const where = issue === undefined || issue.path.length === 0 ? 'document' : issue.path.map(String).join('.');
  const why = issue === undefined ? 'it is not a usable document' : issue.message;
  return {
    kind: 'damaged',
    reason:
      `the quota-failover ledger did not validate (${where}: ${why}); it is the record of which sessions ` +
      'have already been moved, and without it a move cannot be shown not to be a loop',
  };
}

/** This session's record, or an empty one. A session nothing has moved is a legitimate empty. */
export function sessionRecord(state: QuotaFailoverState, sessionId: string): QuotaFailoverSessionRecord {
  return state.sessions[sessionId] ?? { moves: [] };
}

/**
 * Why this session may not be attempted right now, or `undefined` when it may.
 *
 * Both guards are checked against the ledger rather than against anything observable on the session,
 * because both are statements about what THIS daemon has already spent on it.
 */
export function attemptRefusal(
  record: QuotaFailoverSessionRecord,
  limits: { readonly maxMoves: number; readonly retryCooldownMs: number },
  nowMs: number,
): string | undefined {
  if (record.moves.length >= limits.maxMoves)
    return (
      `it has already been moved automatically ${record.moves.length} time(s), which is the configured ceiling; ` +
      'a session that keeps running out is a workload the pool does not fit, and moving it again would hide that'
    );
  if (record.lastAttemptAt === undefined) return undefined;
  const last = Date.parse(record.lastAttemptAt);
  // Fail closed on an unreadable instant, for the reason {@link barredTargets} does: the permissive
  // reading of a damaged timestamp is an attempt every single tick.
  if (!Number.isFinite(last))
    return 'the last attempt has no readable instant, so the retry cooldown cannot be shown to have elapsed';
  const remaining = last + limits.retryCooldownMs - nowMs;
  if (remaining > 0)
    return `the last attempt was ${Math.round((nowMs - last) / 1_000)}s ago and the retry cooldown has ${Math.round(remaining / 1_000)}s left`;
  return undefined;
}

/**
 * Every account this session has been on recently, mapped to why it is barred as a target.
 *
 * BOTH ENDS of each move are barred, not just the destination. Barring only the destination would
 * leave the account the session was moved AWAY from — the one that was out of tokens — immediately
 * eligible again, which is the ping-pong this exists to prevent stated in one sentence.
 */
export function barredTargets(
  record: QuotaFailoverSessionRecord,
  cooldownMs: number,
  nowMs: number,
): ReadonlyMap<string, string> {
  const barred = new Map<string, string>();
  for (const move of record.moves) {
    const at = Date.parse(move.at);
    if (!Number.isFinite(at)) {
      // An unreadable instant is treated as RECENT. The alternative — dropping it — would quietly
      // restore an account to eligibility because its timestamp was damaged, which is the benign
      // reading of ambiguous evidence this repository keeps having to remove.
      bar(barred, move.from, 'this session was moved off it and the move has no readable instant');
      bar(barred, move.to, 'this session was moved onto it and the move has no readable instant');
      continue;
    }
    const ageMs = nowMs - at;
    if (ageMs > cooldownMs) continue;
    const ago = `${Math.round(ageMs / 1_000)}s ago`;
    bar(barred, move.from, `this session was automatically moved off it ${ago}`);
    bar(barred, move.to, `this session was automatically moved onto it ${ago}`);
  }
  return barred;
}

/** First bar wins, so the most recent move's wording is not overwritten by an older one. */
function bar(barred: Map<string, string>, agent: string, reason: string): void {
  if (!barred.has(agent)) barred.set(agent, reason);
}

/** Records that a session was attempted, with what came of it. Every attempt is recorded, including
 *  the refused ones — the retry cooldown is measured from attempts, not from successes. */
export function recordAttempt(
  state: QuotaFailoverState,
  sessionId: string,
  attempt: { readonly at: string; readonly outcome: string; readonly move?: QuotaFailoverMove },
): QuotaFailoverState {
  const previous = sessionRecord(state, sessionId);
  return {
    ...state,
    sessions: {
      ...state.sessions,
      [sessionId]: {
        moves: attempt.move === undefined ? previous.moves : [...previous.moves, attempt.move],
        lastAttemptAt: attempt.at,
        lastOutcome: attempt.outcome,
      },
    },
  };
}

/** Publishes the tick's own account onto the ledger, so a reader can see the loop is alive. */
export function recordTick(state: QuotaFailoverState, at: string, summary: string): QuotaFailoverState {
  return { ...state, lastTick: { at, summary } };
}

/**
 * Drops records for sessions this daemon no longer holds.
 *
 * Bounded growth, and nothing more: a session that is gone can never be moved again, so its budget
 * and its cooldowns are unreachable. A roster this daemon could not read is passed as `undefined`
 * and prunes NOTHING — an empty roster from a failed read would otherwise erase the entire ledger,
 * which is the "damaged state read as empty state" bug in its purest form.
 */
export function pruneLedger(state: QuotaFailoverState, live: ReadonlySet<string> | undefined): QuotaFailoverState {
  if (live === undefined) return state;
  const kept = Object.entries(state.sessions).filter(([id]) => live.has(id));
  if (kept.length === Object.keys(state.sessions).length) return state;
  return { ...state, sessions: Object.fromEntries(kept) };
}
