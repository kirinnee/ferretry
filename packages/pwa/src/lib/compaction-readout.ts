import { compactionFreed, type SessionCompactionDone, type SessionCompactionRunning } from '@ferretry/protocol';
import { formatElapsedSeconds, formatTokenCount } from './live-counter.ts';

/**
 * WHAT A COMPACTION CARD SAYS, as plain data.
 *
 * A percentage appears only when the harness itself reported one (current Claude Code paints a bar and
 * a figure; the daemon carries it as `percent`). Without one — Codex, older Claude Code — the card says
 * only what is measured: a spinner, the real clock and how long a compaction usually takes here. It
 * never invents a figure from elapsed time. The components only draw what these functions return, so
 * what the reader is told is decided — and tested — in one place.
 */

export interface CompactionRunningReadout {
  /** The harness's own whole percent; `null` when it reported none (nothing is estimated). */
  readonly percent: number | null;
  /** The whole-seconds clock, `41s`. */
  readonly elapsed: string;
  /** The context the compaction began from, `412k tokens`; absent when the transcript did not say. */
  readonly from: string | null;
  /** What the harness says it has written so far, `37k tokens written`; absent when it paints no counter. */
  readonly written: string | null;
  /** The usual duration here, `Usually ~60s here`; `null` once a real percent says how far along it is. */
  readonly usual: string | null;
  /** The usual duration is spent: the compaction is taking longer. `false` whenever a real percent exists. */
  readonly overdue: boolean;
  /** What assistive technology reads. */
  readonly valueText: string;
}

/** `~45s`, `~2m`: the usual duration, rounded the way a person says it. */
const approximately = (ms: number): string => {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds < 120 ? `~${seconds}s` : `~${Math.round(seconds / 60)}m`;
};

/** A running compaction after `elapsedSeconds` whole seconds. */
export const compactionRunningReadout = (
  running: SessionCompactionRunning,
  elapsedSeconds: number,
): CompactionRunningReadout => {
  const percent = running.percent ?? null;
  const overdue = percent === null && Math.max(0, elapsedSeconds) * 1000 >= running.expectedMs;
  const usual =
    percent !== null
      ? null
      : overdue
        ? 'Taking longer than usual — still working'
        : running.basis === 'history'
          ? `Usually ${approximately(running.expectedMs)} here`
          : `Usually ${approximately(running.expectedMs)} — typical timing, no history on this machine yet`;
  return {
    percent,
    elapsed: formatElapsedSeconds(elapsedSeconds),
    from: running.tokensBefore === undefined ? null : `${formatTokenCount(running.tokensBefore)} tokens`,
    written: running.tokensWritten === undefined ? null : `${formatTokenCount(running.tokensWritten)} tokens written`,
    usual,
    overdue,
    valueText: percent === null ? 'Compacting context' : `${percent} percent`,
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
