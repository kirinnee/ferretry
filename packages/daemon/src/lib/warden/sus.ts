/**
 * The "sus" classifiers: alive-but-weird sessions the dumb per-session reflex
 * must never touch. Each finding earns ONE assigned warden that investigates
 * the actual work and returns a verdict.
 *
 * Pure: every input arrives through the arguments.
 */

import type { SessionTurnState } from '@ferretry/protocol';
import { instantMs } from './time.ts';
import type { WardenLivenessLedger } from './types.ts';

export type LivenessSignal =
  | 'transcript'
  | 'counterAdvance'
  | 'tokenAdvance'
  | 'subprocess'
  | 'paneChange'
  | 'meaningfulPane';

const LEDGER_FIELDS: Readonly<Record<LivenessSignal, keyof WardenLivenessLedger>> = {
  transcript: 'lastTranscriptAt',
  counterAdvance: 'lastCounterAdvanceAt',
  tokenAdvance: 'lastTokenAdvanceAt',
  subprocess: 'lastSubprocessAt',
  paneChange: 'lastPaneChangeAt',
  meaningfulPane: 'lastMeaningfulPaneAt',
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
  /** A tool command running this long with nothing moving for this long is stuck. */
  readonly susSubprocessSeconds: number;
  /** Whose move it is; `undefined` (a session from before the field) is judged as mid-turn. */
  readonly turnState?: SessionTurnState;
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
    meaningfulPane: Number.POSITIVE_INFINITY,
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
 * Whether the ferret is waiting on its OWNER rather than on its own work: it ended its turn (or is parked
 * on a question or permission prompt) and no tool command of its own is still running. Nothing a warden
 * could find there is worth paying for — the owner's move is already on their screen, and a question
 * nobody answers is `unattended_question`, which Attention owns. Detection resumes by itself the moment
 * the ferret works again.
 *
 * A turn that ended while a command it started still runs in the background is NOT waiting on the
 * owner: the ferret is waiting on that command, and a command that can never finish (a poll loop whose
 * exit condition is never met) is exactly what the stuck check exists for.
 */
export function waitingOnOwner(turnState: SessionTurnState | undefined, commandRunningNow: boolean): boolean {
  if (turnState === 'needs-input') return true;
  return turnState === 'your-turn' && !commandRunningNow;
}

/**
 * The two sus classifiers, both silent while the ferret is waiting on its owner ({@link waitingOnOwner}):
 *
 * - `sus_thinking` — only mid-turn: a work indicator advanced within the last two ticks, the token
 *   counter did NOT (climbing tokens are certain progress and are exempt however long the think runs),
 *   and the transcript has not grown for `susThinkingSeconds`.
 * - `sus_subprocess` — STUCK MID-TURN: a tool command has run continuously for `susSubprocessSeconds`
 *   AND nothing moved for that long — no transcript growth, no token advance, no MEANINGFUL screen
 *   change (the spinner, the elapsed clock and the status line are masked out, or a wedged command
 *   under an animating spinner would always look alive). The harness's own helpers (`fy mcp serve`,
 *   MCP and language servers), a server the agent left listening and a leftover browser are never a
 *   tool command — see `pane-processes.ts`.
 */
export function susFindings(ledger: WardenLivenessLedger, nowMs: number, options: SusOptions): readonly SusFinding[] {
  const activeWithin = 2 * (options.tickSeconds ?? DEFAULT_TICK_SECONDS);
  const ages = ledgerAges(ledger, nowMs, options.anchorMs);
  const episodeStart = instantMs(ledger.subprocessSince);
  const commandRunningNow = ages.subprocess <= activeWithin && episodeStart !== undefined;
  if (waitingOnOwner(options.turnState, commandRunningNow)) return [];
  const findings: SusFinding[] = [];

  const thinkingNow = ages.counterAdvance <= activeWithin;
  const tokensClimbing = ages.tokenAdvance <= activeWithin;
  const midTurn = options.turnState === undefined || options.turnState === 'working';
  if (midTurn && thinkingNow && !tokensClimbing && ages.transcript >= options.susThinkingSeconds) {
    const forSeconds = Number.isFinite(ages.transcript) ? Math.floor(ages.transcript) : undefined;
    findings.push({
      kind: 'sus_thinking',
      forSeconds,
      detail: `the work indicator is active (duration climbing, tokens flat or absent) but the transcript has not grown for ${
        forSeconds === undefined ? 'the whole turn' : `${minutes(forSeconds)}m`
      }`,
    });
  }

  if (commandRunningNow) {
    const forSeconds = Math.floor(Math.max(0, nowMs - episodeStart) / 1_000);
    // Quiet is measured from the episode's start at the earliest: what moved before the command began
    // says nothing about whether the command is stuck.
    const episodeAge = forSeconds;
    const quietSeconds = Math.min(ages.transcript, ages.tokenAdvance, ages.meaningfulPane, episodeAge);
    if (forSeconds >= options.susSubprocessSeconds && quietSeconds >= options.susSubprocessSeconds) {
      const background = options.turnState === 'your-turn' ? ' after its turn ended' : '';
      findings.push({
        kind: 'sus_subprocess',
        forSeconds,
        detail: `a tool command has run for ${minutes(forSeconds)}m${background} with nothing moving for ${minutes(
          Math.floor(quietSeconds),
        )}m — no transcript growth, no token advance, no screen change beyond the spinner`,
      });
    }
  }

  return findings;
}
