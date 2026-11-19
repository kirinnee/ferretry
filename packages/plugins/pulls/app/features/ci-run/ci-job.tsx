/**
 * One job of a run: a header you can open, and under it its steps, each with its duration and an inline bar placed
 * inside the job's own span (so the bar says what share of the job a step took, and where it sat).
 *
 * The header is a real button (`aria-expanded`); the "Logs on GitHub" link sits BESIDE it, never inside, so a tap on one
 * can never be a tap on the other. Logs are never read into Ferretry: the link is the whole feature.
 */
import { ExternalLink, useMotionAllowed } from '@ferretry/app/ui';
import { ChevronRight, Turtle } from 'lucide-react';
import type { CiJob, CiStep } from '../../../contract/wire.ts';
import { barMs, drawnSpan, formatDuration, jobFrame, STATUS_WORD, stepSpan } from './ci-format.ts';
import { STATUS_FILL, StatusIcon, STATUS_TEXT } from './ci-status.tsx';

/** What a duration cell says for an item: its length, or why it has none. */
function durationText(item: CiStep | CiJob, nowMs: number): string {
  const ms = barMs(item, nowMs);
  if (ms !== undefined) return formatDuration(ms);
  return item.status === 'skipped' ? 'skipped' : '–';
}

function StepRow({
  step,
  job,
  nowMs,
  slowest,
}: {
  readonly step: CiStep;
  readonly job: CiJob;
  readonly nowMs: number;
  readonly slowest: boolean;
}) {
  const span = stepSpan(step, jobFrame(job, nowMs), nowMs);
  const drawn = span === undefined ? undefined : drawnSpan(span);
  const live = step.live === true;
  const moving = useMotionAllowed();
  return (
    <li
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-sm gap-y-0.5 py-1 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_4.5rem]"
      data-ci-step={step.number}
      data-ci-slowest={slowest ? 'true' : undefined}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <StatusIcon status={step.status} size={14} />
        <span className={`min-w-0 break-words text-cell ${step.status === 'skipped' ? 'text-faint' : 'text-fg'}`}>
          {step.name}
        </span>
        <span className="sr-only">, {STATUS_WORD[step.status]}</span>
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
        {durationText(step, nowMs)}
        {live && <span className="ml-1 font-sans text-2xs text-accent">live</span>}
      </span>
      {/* The bar is a picture of the duration beside it; the number is the information. */}
      <span aria-hidden="true" className="relative col-span-2 h-1.5 rounded-full bg-border sm:order-2 sm:col-span-1">
        {drawn !== undefined && (
          <span
            className={`absolute inset-y-0 min-w-[3px] rounded-full ${STATUS_FILL[step.status]}${live && moving ? ' animate-pulse' : ''}`}
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
  readonly open: boolean;
  readonly onToggle: () => void;
  /** The step number that took longest in the whole run, when it is in this job. */
  readonly slowestStep: number | undefined;
}

export function CiJobView({ job, nowMs, open, onToggle, slowestStep }: CiJobViewProps) {
  const bodyId = `ci-job-${job.id}`;
  return (
    <section className="kt-panel overflow-hidden" data-ci-job={job.id} data-ci-job-status={job.status}>
      <div className="flex flex-wrap items-center gap-x-sm">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
          className="flex min-h-control min-w-[12rem] flex-1 items-center gap-1.5 bg-transparent px-control-x py-row-y text-left"
        >
          <ChevronRight
            aria-hidden="true"
            size={14}
            className={`shrink-0 text-muted transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
          />
          <StatusIcon status={job.status} />
          <span className="min-w-0 break-words text-ui font-medium text-fg">{job.name}</span>
          <span className={`shrink-0 text-meta ${STATUS_TEXT[job.status]}`}>{STATUS_WORD[job.status]}</span>
        </button>
        <span className={`mono shrink-0 text-cell tabular-nums ${STATUS_TEXT[job.status]}`}>
          {durationText(job, nowMs)}
          {job.live === true && <span className="ml-1 font-sans text-2xs text-accent">live</span>}
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
            <ol className="m-0 list-none divide-y divide-border-soft p-0">
              {job.steps.map(step => (
                <StepRow key={step.number} step={step} job={job} nowMs={nowMs} slowest={step.number === slowestStep} />
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}
