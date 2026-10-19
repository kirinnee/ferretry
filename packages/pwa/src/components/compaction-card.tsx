/**
 * THE COMPACTION CARD AND ITS DIVIDER — what the transcript shows while a harness compacts its context.
 *
 * RUNNING: a card with a progress bar, an "about N%" figure and the clock. Neither harness reports
 * progress, so the figure is an ESTIMATE the daemon's measured timing implies (`lib/compaction-readout.ts`),
 * is labelled as one, and holds below 100 until the end is seen. The clock runs in this page from the
 * compaction's own start, on the same ticker as the working line, and is hidden from assistive technology
 * (a status re-announced every second talks over everything); the bar's `aria-valuetext` is the
 * announcement.
 *
 * DONE: the card collapses to a divider reading `Context compacted · 412k → 38k · freed 374k · 41s`,
 * placed where the compaction happened.
 */

import type { SessionCompactionDone, SessionCompactionRunning } from '@ferretry/protocol';
import { type LiveScheduler, useLiveElapsed } from '../hooks/use-live-counter.ts';
import { compactionDoneReadout, compactionRunningReadout } from '../lib/compaction-readout.ts';

export interface CompactionCardProps {
  readonly compaction: SessionCompactionRunning;
  /** Injectable so a suite drives the clock; the browser's own otherwise. */
  readonly scheduler?: LiveScheduler;
}

/** The running card: bar, estimated percent, clock. */
export function CompactionCard({ compaction, scheduler }: CompactionCardProps) {
  const seconds = useLiveElapsed(Date.parse(compaction.startedAt), scheduler === undefined ? {} : { scheduler });
  const readout = compactionRunningReadout(compaction, seconds ?? 0);
  return (
    <div className="fy-compaction-card" data-compaction="running" data-overdue={readout.overdue ? '' : undefined}>
      <div className="fy-compaction-card__head">
        <b>Compacting context</b>
        <span aria-hidden="true" className="fy-compaction-card__percent">
          ~{readout.percent}%
        </span>
      </div>
      <div
        aria-label="Compacting context"
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={readout.percent}
        aria-valuetext={readout.valueText}
        className="fy-compaction-card__bar"
        role="progressbar"
      >
        <span className="fy-compaction-card__fill" style={{ width: `${readout.percent}%` }} />
      </div>
      <p aria-hidden="true" className="fy-compaction-card__meta">
        {[readout.elapsed, readout.from === null ? null : `from ${readout.from}`].filter(Boolean).join(' · ')}
      </p>
      <p className="fy-compaction-card__note">{readout.note}</p>
    </div>
  );
}

export interface CompactionStripProps {
  readonly compaction: SessionCompactionDone;
}

/** The collapsed divider a finished compaction leaves in the transcript. */
export function CompactionStrip({ compaction }: CompactionStripProps) {
  const readout = compactionDoneReadout(compaction);
  return (
    <div className="fy-compaction-strip" data-compaction="done">
      <span aria-hidden="true" className="fy-compaction-strip__rule" />
      <span className="fy-compaction-strip__text">
        <b>{readout.headline}</b>
        {readout.facts.map(fact => (
          <span key={fact}> · {fact}</span>
        ))}
      </span>
      <span aria-hidden="true" className="fy-compaction-strip__rule" />
    </div>
  );
}

export interface CompactionChipProps {
  readonly compaction: SessionCompactionRunning;
  readonly scheduler?: LiveScheduler;
}

/** The small header state: `Compacting ~40%`. */
export function CompactionChip({ compaction, scheduler }: CompactionChipProps) {
  const seconds = useLiveElapsed(Date.parse(compaction.startedAt), scheduler === undefined ? {} : { scheduler });
  const readout = compactionRunningReadout(compaction, seconds ?? 0);
  return (
    <span className="fy-compaction-chip" data-compaction-chip="" title={readout.valueText}>
      Compacting ~{readout.percent}%
    </span>
  );
}
