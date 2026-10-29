/**
 * THE COMPACTION CARD AND ITS DIVIDER — what the transcript shows while a harness compacts its context.
 *
 * RUNNING, with a real figure: current Claude Code reports its own progress, so the card draws that bar
 * and "49%" and the tokens written. RUNNING without one (Codex, older Claude Code): a spinner, the real
 * clock and how long a compaction usually takes here — NO percentage, because none was measured
 * (`lib/compaction-readout.ts`). The clock runs in this page from the compaction's own start, on the
 * same ticker as the working line, and is hidden from assistive technology (a status re-announced every
 * second talks over everything); the bar's `aria-valuetext` is the announcement.
 *
 * DONE: the card collapses to a divider reading `Context compacted · 412k → 38k · freed 374k · 41s`,
 * placed where the compaction happened.
 */

import type { SessionCompactionDone, SessionCompactionRunning } from '@ferretry/protocol';
import { type LiveScheduler, useLiveElapsed } from '../hooks/use-live-counter.ts';
import { compactionDoneReadout, compactionRunningReadout } from '../lib/compaction-readout.ts';
import { Spinner } from './spinner.tsx';

export interface CompactionCardProps {
  readonly compaction: SessionCompactionRunning;
  /** Injectable so a suite drives the clock; the browser's own otherwise. */
  readonly scheduler?: LiveScheduler;
}

/** The running card: the harness's own bar and percent when it gave one, else a spinner and the clock. */
export function CompactionCard({ compaction, scheduler }: CompactionCardProps) {
  const seconds = useLiveElapsed(Date.parse(compaction.startedAt), scheduler === undefined ? {} : { scheduler });
  const readout = compactionRunningReadout(compaction, seconds ?? 0);
  const meta = [readout.elapsed, readout.written, readout.from === null ? null : `from ${readout.from}`]
    .filter(Boolean)
    .join(' · ');
  return (
    <div
      className="fy-compaction-card"
      data-compaction="running"
      data-overdue={readout.overdue ? '' : undefined}
      data-percent={readout.percent === null ? undefined : ''}
    >
      <div className="fy-compaction-card__head">
        <b>Compacting context</b>
        {readout.percent === null ? (
          <Spinner className="fy-compaction-card__spinner" size={14} />
        ) : (
          <span aria-hidden="true" className="fy-compaction-card__percent">
            {readout.percent}%
          </span>
        )}
      </div>
      {readout.percent === null ? null : (
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
      )}
      <p aria-hidden="true" className="fy-compaction-card__meta">
        {meta}
      </p>
      {readout.usual === null ? null : <p className="fy-compaction-card__note">{readout.usual}</p>}
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

/** The small header state: `Compacting 49%` with the harness's own figure, else `Compacting…`. */
export function CompactionChip({ compaction, scheduler }: CompactionChipProps) {
  const seconds = useLiveElapsed(Date.parse(compaction.startedAt), scheduler === undefined ? {} : { scheduler });
  const readout = compactionRunningReadout(compaction, seconds ?? 0);
  return (
    <span className="fy-compaction-chip" data-compaction-chip="" title={readout.valueText}>
      {readout.percent === null ? 'Compacting…' : `Compacting ${readout.percent}%`}
    </span>
  );
}
