/**
 * One job of a run: a header you can open, and under it its steps, each with its duration and an inline bar placed
 * inside the job's own span (so the bar says what share of the job a step took, and where it sat).
 *
 * The header is a real button (`aria-expanded`); the "Logs on GitHub" link sits BESIDE it, never inside, so a tap on one
 * can never be a tap on the other. Logs are never read into Ferretry: the link is the whole feature.
 */
import { ExternalLink, useMotionAllowed } from '@ferretry/app/ui';
import { ChevronRight, Turtle } from 'lucide-react';
import { useState } from 'react';
import type { CiJob, CiStep } from '../../../contract/wire.ts';
import {
  barMs,
  drawnSpan,
  formatDuration,
  jobFrame,
  jobSettled,
  shownStepStatus,
  STATUS_WORD,
  STEPS_FIRST_PAGE,
  stepSpan,
} from './ci-format.ts';
import { STATUS_FILL, StatusIcon, STATUS_TEXT } from './ci-status.tsx';

/** What a duration cell says for an item: its length (the same number its bar is drawn from), or why it has none. */
function durationText(item: CiStep | CiJob, nowMs: number, ticking: boolean): string {
  const ms = barMs(item, nowMs, ticking);
  if (ms !== undefined) return formatDuration(ms);
  return item.status === 'skipped' ? 'skipped' : '–';
}

function StepRow({
  step,
  job,
  nowMs,
  runLive,
  slowest,
}: {
  readonly step: CiStep;
  readonly job: CiJob;
  readonly nowMs: number;
  /** Is the run live? A step only ticks while its job and its run are live too. */
  readonly runLive: boolean;
  readonly slowest: boolean;
}) {
  // A job that is over ticks nothing, and a step in it is drawn stopped, never spinning.
  const ticking = runLive && job.live === true && !jobSettled(job);
  const status = shownStepStatus(step, job);
  const span = stepSpan(step, jobFrame(job, nowMs, runLive), nowMs, ticking);
  const drawn = span === undefined ? undefined : drawnSpan(span);
  const live = ticking && step.live === true;
  const moving = useMotionAllowed();
  return (
    <li
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-sm gap-y-0.5 py-1 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_4.5rem]"
      data-ci-step={step.number}
      data-ci-slowest={slowest ? 'true' : undefined}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <StatusIcon status={status} size={14} />
        <span
          className={`min-w-0 text-cell [overflow-wrap:anywhere] ${step.status === 'skipped' ? 'text-faint' : 'text-fg'}`}
        >
          {step.name}
        </span>
        <span className="sr-only">, {STATUS_WORD[status]}</span>
        {slowest && (
          <span className="inline-flex shrink-0 items-center gap-0.5 rounded-control border border-warn-border bg-warn-bg px-1 text-meta font-medium text-warn">
            <Turtle aria-hidden="true" size={12} />
            Slowest
          </span>
        )}
        {step.clamped === true && (
          <span
            className="shrink-0 text-2xs text-faint"
            title="This step’s clock disagreed with its job’s; it is drawn inside the job."
          >
            adjusted
          </span>
        )}
      </span>
      <span
        className="mono text-right text-cell tabular-nums text-fg-soft sm:order-3"
        data-ci-duration={live ? 'live' : 'done'}
      >
        {durationText(step, nowMs, ticking)}
        {live && <span className="ml-1 font-sans text-2xs text-accent">live</span>}
      </span>
      {/* The bar is a picture of the duration beside it; the number is the information. */}
      <span aria-hidden="true" className="relative col-span-2 h-1.5 rounded-full bg-border sm:order-2 sm:col-span-1">
        {drawn !== undefined && (
          <span
            className={`absolute inset-y-0 min-w-[3px] rounded-full ${STATUS_FILL[status]}${live && moving ? ' animate-pulse' : ''}`}
            style={{ left: `${drawn.left}%`, width: `${drawn.width}%` }}
          />
        )}
      </span>
    </li>
  );
}

export interface CiJobViewProps {
  readonly job: CiJob;
  readonly nowMs: number;
  /** Is the run itself live? A job and its steps only tick while it is. */
  readonly runLive: boolean;
  readonly open: boolean;
  readonly onToggle: () => void;
  /** The step number that took longest in the whole run, when it is in this job. */
  readonly slowestStep: number | undefined;
}

export function CiJobView({ job, nowMs, runLive, open, onToggle, slowestStep }: CiJobViewProps) {
  const bodyId = `ci-job-${job.id}`;
  // How many steps are drawn: a job may carry 500, so a page of them at first, then twice as many each time asked.
  const [limit, setLimit] = useState(STEPS_FIRST_PAGE);
  // The slowest step is always drawn, even past the limit: it is what the run's header names.
  const drawnSteps = job.steps.filter((step, index) => index < limit || step.number === slowestStep);
  const left = job.steps.length - drawnSteps.length;
  return (
    <section className="kt-panel overflow-hidden" data-ci-job={job.id} data-ci-job-status={job.status}>
      <div className="flex flex-wrap items-center gap-x-sm">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
          className="flex min-h-control flex-[1_1_12rem] items-center gap-1.5 bg-transparent px-control-x py-row-y text-left"
        >
          <ChevronRight
            aria-hidden="true"
            size={14}
            className={`shrink-0 text-muted transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
          />
          <StatusIcon status={job.status} />
          <span className="min-w-0 text-ui font-medium text-fg [overflow-wrap:anywhere]">{job.name}</span>
          <span className={`shrink-0 text-meta ${STATUS_TEXT[job.status]}`}>{STATUS_WORD[job.status]}</span>
        </button>
        <span className={`mono shrink-0 text-cell tabular-nums ${STATUS_TEXT[job.status]}`}>
          {durationText(job, nowMs, runLive)}
          {runLive && job.live === true && <span className="ml-1 font-sans text-2xs text-accent">live</span>}
        </span>
        {job.url !== undefined && job.status !== 'queued' && (
          <ExternalLink
            href={job.url}
            className="shrink-0 px-control-x text-meta text-accent underline-offset-2 hover:underline"
          >
            Logs<span className="sr-only"> for {job.name}</span> on GitHub
          </ExternalLink>
        )}
        {(job.url === undefined || job.status === 'queued') && <span className="pr-control-x" />}
      </div>
      {open && (
        <div id={bodyId} className="border-t border-border-soft px-control-x py-1">
          {job.queuedMs > 0 && (
            <p className="m-0 py-0.5 text-meta text-muted" data-ci-queued={job.queuedMs}>
              Waited {formatDuration(job.queuedMs)} to start
            </p>
          )}
          {job.steps.length === 0 ? (
            <p className="m-0 py-1 text-meta text-muted">
              {job.status === 'queued' ? 'This job has not started.' : 'GitHub listed no steps for this job.'}
            </p>
          ) : (
            <>
              <ol className="m-0 list-none divide-y divide-border-soft p-0">
                {drawnSteps.map(step => (
                  <StepRow
                    key={step.number}
                    step={step}
                    job={job}
                    nowMs={nowMs}
                    runLive={runLive}
                    slowest={step.number === slowestStep}
                  />
                ))}
              </ol>
              {left > 0 && (
                <p
                  className="m-0 flex flex-wrap items-center gap-x-sm py-1 text-meta text-muted"
                  data-ci-more-steps={left}
                >
                  <span aria-live="polite">
                    Showing {drawnSteps.length} of {job.steps.length} steps
                  </span>
                  <button
                    type="button"
                    onClick={() => setLimit(previous => previous * 2)}
                    className="min-h-control rounded-control px-control-x text-accent underline-offset-2 hover:underline"
                  >
                    Show {Math.min(left, limit)} more<span className="sr-only"> steps of {job.name}</span>
                  </button>
                </p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
