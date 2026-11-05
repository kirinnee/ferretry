/**
 * The two rules the daemon applies to a voice stream: may a countdown send, and is the browser sending
 * too fast (`docs/voice-stream.md` §8). Pure functions of values and a time the caller passes in; there
 * is no clock here, so every edge is testable at an exact millisecond.
 */
import {
  VOICE_ECHO_MAX_AGE_MS,
  VOICE_RATE_MAX_UNITS,
  VOICE_RATE_WINDOW_MS,
  VOICE_SHOWN_MIN_AGE_MS,
  type VoiceNonce,
} from './voice-stream.ts';
import type { VoiceUplinkControl } from './voice-stream-uplink.ts';

// ── Which nonces the daemon issued, and which the phone has echoed ─────────────────────────────────

/** The most nonces the ledger remembers. Five a second for a one-second window never nears it. */
const LEDGER_MAX_ISSUED = 16;

export interface VoiceNonceLedger {
  /** Nonces issued within the window, oldest first. */
  readonly issued: readonly { readonly nonce: VoiceNonce; readonly issuedAt: number }[];
  /** When the newest echoed nonce was issued; `undefined` before any echo of a known nonce. */
  readonly echoedIssuedAt: number | undefined;
}

export const EMPTY_VOICE_NONCE_LEDGER: VoiceNonceLedger = { issued: [], echoedIssuedAt: undefined };

/** Notes that the daemon issued `nonce` at `now`, forgetting those too old to matter. */
export function recordNonceIssued(ledger: VoiceNonceLedger, nonce: VoiceNonce, now: number): VoiceNonceLedger {
  const fresh = ledger.issued.filter(entry => now - entry.issuedAt <= VOICE_ECHO_MAX_AGE_MS);
  return { ...ledger, issued: [...fresh, { nonce, issuedAt: now }].slice(-LEDGER_MAX_ISSUED) };
}

/**
 * Notes an echo. An echo of a nonce the daemon did not issue (or has forgotten) changes nothing; an echo
 * of an older nonce than one already echoed does not move the proof backwards.
 */
export function recordNonceEcho(ledger: VoiceNonceLedger, nonce: VoiceNonce): VoiceNonceLedger {
  const entry = ledger.issued.find(candidate => candidate.nonce === nonce);
  if (entry === undefined) return ledger;
  if (ledger.echoedIssuedAt !== undefined && ledger.echoedIssuedAt >= entry.issuedAt) return ledger;
  return { ...ledger, echoedIssuedAt: entry.issuedAt };
}

// ── What the phone said it showed ──────────────────────────────────────────────────────────────────

/** The newest `shown` the daemon received, and when. */
export interface VoiceShown {
  readonly turnId: number;
  readonly revision: number;
  readonly receivedAt: number;
}

/** The newest `shown` after one uplink control: a `shown` replaces it, anything else leaves it. */
export const recordShown = (
  current: VoiceShown | undefined,
  control: VoiceUplinkControl | undefined,
  now: number,
): VoiceShown | undefined =>
  control?.kind === 'shown' ? { turnId: control.turnId, revision: control.revision, receivedAt: now } : current;

// ── May a countdown send? ──────────────────────────────────────────────────────────────────────────

export type VoiceSendRefusal = 'cancelled' | 'not_shown' | 'shown_too_recent' | 'no_echo' | 'echo_stale';

export type VoiceSendVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: VoiceSendRefusal };

export interface VoiceSendQuestion {
  /** The caller's clock, in milliseconds. */
  readonly now: number;
  /** The turn and transcript revision the countdown is for. */
  readonly turnId: number;
  readonly revision: number;
  readonly shown: VoiceShown | undefined;
  readonly ledger: VoiceNonceLedger;
  /** Hold, a close, a stream error, speech resuming, or `voice.use` narrowed. */
  readonly cancelled: boolean;
}

/**
 * Plan §1.5. A send is allowed only when it is not cancelled; a `shown` for this exact turn and revision
 * was received at least 500 ms ago (inclusive); and the newest echoed nonce was issued no more than 1 s
 * ago (inclusive). The first rule that fails is named.
 *
 * Every time the rule reads — `now`, the shown time, the nonce issue times and the rate guard's arrivals — must
 * come from ONE monotonic clock domain, separate from the wire's unix timestamps (the countdown's `at`/`now`).
 * Ages are differences within that domain; a negative or non-finite age fails closed (`shown_too_recent` for
 * the shown time, `echo_stale` for the echoed nonce) rather than passing as "not stale".
 */
export function mayAutoSend(question: VoiceSendQuestion): VoiceSendVerdict {
  const { now, turnId, revision, shown, ledger } = question;
  if (question.cancelled) return { allowed: false, reason: 'cancelled' };
  if (shown === undefined || shown.turnId !== turnId || shown.revision !== revision)
    return { allowed: false, reason: 'not_shown' };
  // Fail closed: an age that is negative (a time from the future, a clock that went backwards) or not a
  // finite number proves nothing, so it is never old enough and never fresh enough.
  const shownAge = now - shown.receivedAt;
  if (!Number.isFinite(shownAge) || shownAge < VOICE_SHOWN_MIN_AGE_MS)
    return { allowed: false, reason: 'shown_too_recent' };
  if (ledger.echoedIssuedAt === undefined) return { allowed: false, reason: 'no_echo' };
  const echoAge = now - ledger.echoedIssuedAt;
  if (!Number.isFinite(echoAge) || echoAge < 0 || echoAge > VOICE_ECHO_MAX_AGE_MS)
    return { allowed: false, reason: 'echo_stale' };
  return { allowed: true };
}

// ── Is the browser sending too fast? ───────────────────────────────────────────────────────────────

/** Arrival times of recent uplink units, one entry per unit. Holds at most one more than the limit. */
export interface VoiceRateGuard {
  readonly arrivals: readonly number[];
}

export const EMPTY_VOICE_RATE_GUARD: VoiceRateGuard = { arrivals: [] };

/**
 * Counts `units` uplink units arriving at `now`. `exceeded` is true when more than the limit (156: 1.25×
 * the nominal 25 a second, over 5 s) arrived within the window; the caller then closes the stream. The
 * window is exclusive at its old end: a unit exactly 5,000 ms old no longer counts.
 */
export function recordUplinkUnits(
  guard: VoiceRateGuard,
  now: number,
  units: number,
): { readonly guard: VoiceRateGuard; readonly exceeded: boolean } {
  const added = Number.isFinite(units) ? Math.min(Math.max(0, Math.floor(units)), VOICE_RATE_MAX_UNITS + 1) : 0;
  const recent = guard.arrivals.filter(arrival => now - arrival < VOICE_RATE_WINDOW_MS);
  const arrivals = [...recent, ...Array.from({ length: added }, () => now)].slice(-(VOICE_RATE_MAX_UNITS + 1));
  return { guard: { arrivals }, exceeded: arrivals.length > VOICE_RATE_MAX_UNITS };
}
