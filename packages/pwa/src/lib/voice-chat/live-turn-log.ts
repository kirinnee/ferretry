/**
 * THE NUMBERS OF EVERY LIVE TURN, kept in memory for the page's lifetime. Numbers only — never a word,
 * never a transcript — so what is shown (and what a harness reads) cannot leak what was said.
 *
 * The one that matters to the person is `lastWordToSentMs`: from the last loud frame of their speech to
 * the message on the wire. The rest say where it went: waiting for the pause (the endpointer's own
 * length, a setting), working out the words (`endToWordsMs`: STT plus Fix clean-up), and the visible
 * countdown (`graceMs`, which is a choice, not a cost).
 */

import { percentile } from '../stt/dictation-timeline.ts';
import type { TurnNumbers } from './live-machine.ts';

/** Turns kept: enough to see a trend, small enough to forget. */
export const TURN_LOG_SIZE = 20;

export class LiveTurnLog {
  #turns: readonly TurnNumbers[] = [];

  add(turn: TurnNumbers): void {
    this.#turns = [...this.#turns.slice(1 - TURN_LOG_SIZE), turn];
  }

  get turns(): readonly TurnNumbers[] {
    return this.#turns;
  }

  get last(): TurnNumbers | null {
    return this.#turns.at(-1) ?? null;
  }
}

export interface TurnSummary {
  readonly count: number;
  /** Median and 90th percentile of each stage, ms. */
  readonly lastWordToSentMs: { readonly p50: number; readonly p90: number };
  readonly endToWordsMs: { readonly p50: number; readonly p90: number };
}

/** The median and p90 of the kept turns; null with none. */
export function summarizeTurns(turns: readonly TurnNumbers[]): TurnSummary | null {
  if (turns.length === 0) return null;
  const spread = (pick: (turn: TurnNumbers) => number): { p50: number; p90: number } => {
    const sorted = turns.map(pick).sort((a, b) => a - b);
    return { p50: percentile(sorted, 50) ?? 0, p90: percentile(sorted, 90) ?? 0 };
  };
  return {
    count: turns.length,
    lastWordToSentMs: spread(turn => turn.lastWordToSentMs),
    endToWordsMs: spread(turn => turn.endToWordsMs),
  };
}

/** "Sent 3.4 s after your last word." — the sentence the bar shows while the ferret works. */
export function lastTurnCopy(turn: TurnNumbers): string {
  return `Sent ${(turn.lastWordToSentMs / 1_000).toFixed(1)} s after your last word.`;
}
