/**
 * The "sus" classifiers: alive-but-weird sessions the dumb per-session reflex
 * must never touch. Each finding earns ONE assigned warden that investigates
 * the actual work and returns a verdict.
 *
 * Pure: every input arrives through the arguments.
 */

import { instantMs } from './time.ts';
import type { WardenLivenessLedger } from './types.ts';

export type LivenessSignal = 'transcript' | 'counterAdvance' | 'tokenAdvance' | 'subprocess' | 'paneChange';

const LEDGER_FIELDS: Readonly<Record<LivenessSignal, keyof WardenLivenessLedger>> = {
  transcript: 'lastTranscriptAt',
  counterAdvance: 'lastCounterAdvanceAt',
  tokenAdvance: 'lastTokenAdvanceAt',
  subprocess: 'lastSubprocessAt',
  paneChange: 'lastPaneChangeAt',
};

export const DEFAULT_TICK_SECONDS = 30;

export type SusKind = 'sus_thinking' | 'sus_subprocess';

export interface SusFinding {
  readonly kind: SusKind;
  /** Whole seconds the weirdness has been going on; `undefined` when the signal
   *  was never seen at all (the whole turn has been quiet). */
  readonly forSeconds?: number;
  readonly detail: string;
}

export interface SusOptions {
  /** Thinking with no transcript growth for this long is suspicious. */
  readonly susThinkingSeconds: number;
  /** A continuous subprocess episode this long is suspicious. */
  readonly susSubprocessSeconds: number;
  /** Monitor tick, seconds — "now" means within two ticks. */
  readonly tickSeconds?: number;
  /** Turn start; signals never seen are floored here so a fresh turn is never
   *  instantly suspicious. */
  readonly anchorMs?: number;
}

/**
 * Seconds since each ledger signal, floored by `anchorMs`. `Infinity` means the
 * signal was never seen and there is no anchor to fall back on.
 */
export function ledgerAges(
  ledger: WardenLivenessLedger,
  nowMs: number,
  anchorMs?: number,
): Readonly<Record<LivenessSignal, number>> {
  const ages: Record<LivenessSignal, number> = {
    transcript: Number.POSITIVE_INFINITY,
    counterAdvance: Number.POSITIVE_INFINITY,
    tokenAdvance: Number.POSITIVE_INFINITY,
    subprocess: Number.POSITIVE_INFINITY,
    paneChange: Number.POSITIVE_INFINITY,
  };
  for (const signal of Object.keys(LEDGER_FIELDS) as LivenessSignal[]) {
    const observed = instantMs(ledger[LEDGER_FIELDS[signal]]);
    const at = Math.max(observed ?? 0, anchorMs ?? 0);
    ages[signal] = at > 0 ? Math.max(0, (nowMs - at) / 1_000) : Number.POSITIVE_INFINITY;
  }
  return ages;
}

function minutes(seconds: number): number {
  return Math.floor(seconds / 60);
}

/**
 * The two sus classifiers:
 *
 * - `sus_thinking` — a work indicator advanced within the last two ticks, the
 *   token counter did NOT (climbing tokens are certain progress and are exempt
 *   however long the think runs), and the transcript has not grown for
 *   `susThinkingSeconds`.
 * - `sus_subprocess` — a subprocess was seen within the last two ticks and its
 *   continuous episode is at least `susSubprocessSeconds` old.
 */
export function susFindings(ledger: WardenLivenessLedger, nowMs: number, options: SusOptions): readonly SusFinding[] {
  const activeWithin = 2 * (options.tickSeconds ?? DEFAULT_TICK_SECONDS);
  const ages = ledgerAges(ledger, nowMs, options.anchorMs);
  const findings: SusFinding[] = [];

  const thinkingNow = ages.counterAdvance <= activeWithin;
  const tokensClimbing = ages.tokenAdvance <= activeWithin;
  if (thinkingNow && !tokensClimbing && ages.transcript >= options.susThinkingSeconds) {
    const forSeconds = Number.isFinite(ages.transcript) ? Math.floor(ages.transcript) : undefined;
    findings.push({
      kind: 'sus_thinking',
      forSeconds,
      detail: `the work indicator is active (duration climbing, tokens flat or absent) but the transcript has not grown for ${
        forSeconds === undefined ? 'the whole turn' : `${minutes(forSeconds)}m`
      }`,
    });
  }

  const episodeStart = instantMs(ledger.subprocessSince);
  if (ages.subprocess <= activeWithin && episodeStart !== undefined) {
    const forSeconds = Math.floor(Math.max(0, nowMs - episodeStart) / 1_000);
    if (forSeconds >= options.susSubprocessSeconds) {
      findings.push({
        kind: 'sus_subprocess',
        forSeconds,
        detail: `a background subprocess has been running continuously for ${minutes(forSeconds)}m`,
      });
    }
  }

  return findings;
}
