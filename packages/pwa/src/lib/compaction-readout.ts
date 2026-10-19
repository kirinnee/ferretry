import {
  compactionFreed,
  compactionPercent,
  type SessionCompactionDone,
  type SessionCompactionRunning,
} from '@ferretry/protocol';
import { formatElapsedSeconds, formatTokenCount } from './live-counter.ts';

/**
 * WHAT A COMPACTION CARD SAYS, as plain data.
 *
 * Neither harness reports how far a compaction has got, so the percentage here is the protocol's
 * ESTIMATE (`compactionPercent`: elapsed over this daemon's usual duration, capped below 100 until the
 * end is observed) and every sentence calls it one. The components only draw what these functions
 * return, so what the reader is told is decided — and tested — in one place.
 */

export interface CompactionRunningReadout {
  readonly percent: number;
  /** The whole-seconds clock, `41s`. */
  readonly elapsed: string;
  /** The context the compaction began from, `412k tokens`; absent when the transcript did not say. */
  readonly from: string | null;
  /** Where the estimate comes from, or that it has run past it. */
  readonly note: string;
  /** The estimate is spent: the compaction is taking longer than this daemon's usual. */
  readonly overdue: boolean;
  /** What assistive technology reads for the bar. */
  readonly valueText: string;
}

/** A running compaction after `elapsedSeconds` whole seconds. */
export const compactionRunningReadout = (
  running: SessionCompactionRunning,
  elapsedSeconds: number,
): CompactionRunningReadout => {
  const elapsedMs = Math.max(0, elapsedSeconds) * 1000;
  const percent = compactionPercent(running, Date.parse(running.startedAt) + elapsedMs);
  const overdue = elapsedMs >= running.expectedMs;
  return {
    percent,
    elapsed: formatElapsedSeconds(elapsedSeconds),
    from: running.tokensBefore === undefined ? null : `${formatTokenCount(running.tokensBefore)} tokens`,
    note: overdue
      ? 'Taking longer than usual — still working'
      : running.basis === 'history'
        ? 'Estimate from this machine’s past compactions'
        : 'Estimate from typical timing — no history on this machine yet',
    overdue,
    valueText: `About ${percent} percent, estimated`,
  };
};

export interface CompactionDoneReadout {
  /** `Context compacted`, or `Context auto-compacted` when the harness did it unasked. */
  readonly headline: string;
  /** Short facts after the headline: `412k → 38k`, `freed 374k`, `41s`. */
  readonly facts: readonly string[];
}

/** A finished compaction, as the one-line divider reads it. */
export const compactionDoneReadout = (done: SessionCompactionDone): CompactionDoneReadout => {
  const facts: string[] = [];
  if (done.tokensBefore !== undefined && done.tokensAfter !== undefined) {
    facts.push(`${formatTokenCount(done.tokensBefore)} → ${formatTokenCount(done.tokensAfter)}`);
  } else if (done.tokensBefore !== undefined) {
    facts.push(`was ${formatTokenCount(done.tokensBefore)} tokens`);
  }
  const freed = compactionFreed(done);
  if (freed !== undefined) facts.push(`freed ${formatTokenCount(freed)}`);
  if (done.startedAt !== undefined) {
    const seconds = (Date.parse(done.endedAt) - Date.parse(done.startedAt)) / 1000;
    if (Number.isFinite(seconds) && seconds >= 0) facts.push(formatElapsedSeconds(seconds));
  }
  return { headline: done.trigger === 'auto' ? 'Context auto-compacted' : 'Context compacted', facts };
};

/**
 * Where a finished compaction's divider sits among transcript rows stamped with `at` (epoch ms): the
 * index of the first row after it, the row count when it is the newest thing, and `null` when it ended
 * before the oldest loaded row — an earlier page's event, which would otherwise float to the top.
 */
export const compactionStripIndex = (
  done: SessionCompactionDone,
  rows: readonly { readonly at?: number | undefined }[],
): number | null => {
  const endedMs = Date.parse(done.endedAt);
  if (!Number.isFinite(endedMs)) return null;
  const stamped = rows.map(row => row.at);
  const oldest = stamped.find((at): at is number => at !== undefined);
  if (oldest !== undefined && endedMs < oldest) return null;
  const index = stamped.findIndex(at => at !== undefined && at > endedMs);
  return index === -1 ? rows.length : index;
};
