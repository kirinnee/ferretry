/**
 * The run page (r9 E9): one workflow run, its jobs and their steps with duration and an inline bar, the queue time, the
 * slowest step marked, a "Logs on GitHub" link per job, and live while anything still runs.
 *
 * Failed and running jobs open by themselves (they are what a person came to find); the rest stay shut until asked. A
 * person's own open/close is kept while the run refreshes underneath.
 */
import { ExternalLink, Loading } from '@ferretry/app/ui';
import { useState } from 'react';
import type { CiRun } from '../../../contract/wire.ts';
import { CiFailedPanel } from './ci-failed.tsx';
import { type CiClient, type CiScope, fetchRun } from './ci-api.ts';
import { barMs, formatDuration, isLive, opensByDefault, shortSha, slowestSentence, triggerWord } from './ci-format.ts';
import { CiJobView } from './ci-job.tsx';
import { StatusMark } from './ci-status.tsx';
import { useLiveRead, useSecondClock } from './use-ci.ts';
import { slowestStep } from '../../../contract/ci-timing.ts';

export interface CiRunPageProps {
  readonly client: CiClient;
  readonly scope: CiScope;
  readonly runId: number;
  readonly attempt?: number;
  /** A fixed clock (a test, a screenshot): no timer starts and "now" is this instant. */
  readonly nowMs?: number;
}

function RunView({
  run,
  nowMs,
  refreshFailed,
}: {
  readonly run: CiRun;
  readonly nowMs: number;
  readonly refreshFailed: string | undefined;
}) {
  // The person's own choices; a job they never touched follows `opensByDefault`.
  const [chosen, setChosen] = useState<ReadonlyMap<number, boolean>>(new Map());
  // The slowest step is only named once the run has finished: a step still running has no final length.
  const slowest = isLive(run) ? undefined : slowestStep(run, nowMs);
  const slowestMs = slowest === undefined ? 0 : (barMs(slowest.step, nowMs) ?? 0);
  const wall = run.live === true ? Math.max(run.wallMs, nowMs - Date.parse(run.createdAt)) : run.wallMs;
  return (
    <article className="mx-auto grid w-full max-w-3xl gap-sm" data-ci-run-page={run.id} data-ci-run-status={run.status}>
      <header className="kt-panel grid gap-1 p-panel">
        <div className="flex flex-wrap items-center gap-x-sm gap-y-1">
          <h2 className="m-0 min-w-0 break-words text-title font-semibold text-fg">{run.name}</h2>
          <StatusMark status={run.status} />
          {isLive(run) && <span className="text-meta font-medium text-accent">Live</span>}
          {run.attempt > 1 && (
            <span className="rounded-control border border-border-strong px-1 text-2xs text-fg-soft">
              Attempt {run.attempt}
            </span>
          )}
        </div>
        <p className="m-0 text-meta text-muted">
          {triggerWord(run.trigger)} · <span className="mono">{shortSha(run.headSha)}</span>
          {run.url !== undefined && (
            <>
              {' · '}
              <ExternalLink href={run.url} className="text-accent underline-offset-2 hover:underline">
                Open run on GitHub
              </ExternalLink>
            </>
          )}
        </p>
        <dl className="m-0 mt-1 flex flex-wrap gap-x-md gap-y-sm">
          <Fact term="Total" value={formatDuration(wall)} />
          {run.jobs.length > 0 && <Fact term="Queue wait" value={formatDuration(run.queuedMs)} />}
          {run.jobs.length > 0 && <Fact term="Jobs" value={String(run.jobs.length)} />}
        </dl>
        {slowest !== undefined && (
          <p className="m-0 text-meta text-fg-soft" data-ci-slowest-line="true">
            {slowestSentence(slowest.job.name, slowest.step.name, slowestMs)}
          </p>
        )}
      </header>
      {refreshFailed !== undefined && (
        <p className="m-0 text-meta text-muted" role="status">
          Could not refresh: {refreshFailed}. Showing the last read.
        </p>
      )}
      {run.jobs.length === 0 ? (
        <p className="kt-panel m-0 p-panel text-ui text-muted">
          This CI reports a single check, not jobs and steps
          {run.url === undefined ? '.' : '. Its details are on GitHub.'}
        </p>
      ) : (
        <div className="grid gap-sm">
          {run.jobs.map(job => (
            <CiJobView
              key={job.id}
              job={job}
              nowMs={nowMs}
              open={chosen.get(job.id) ?? opensByDefault(job)}
              onToggle={() =>
                setChosen(previous => new Map(previous).set(job.id, !(previous.get(job.id) ?? opensByDefault(job))))
              }
              slowestStep={slowest?.job.id === job.id ? slowest.step.number : undefined}
            />
          ))}
        </div>
      )}
    </article>
  );
}

function Fact({ term, value }: { readonly term: string; readonly value: string }) {
  return (
    <div>
      <dt className="m-0 text-label font-semibold uppercase tracking-label text-faint">{term}</dt>
      <dd className="mono m-0 text-row tabular-nums text-fg">{value}</dd>
    </div>
  );
}

export function CiRunPage({ client, scope, runId, attempt, nowMs: fixedNow }: CiRunPageProps) {
  const key = `${scope.project}/${scope.repo.owner}/${scope.repo.name}/${runId}/${attempt ?? ''}`;
  const { state, reload } = useLiveRead(key, signal => fetchRun(client, scope, runId, attempt, signal), isLive);
  const now = useSecondClock(state.kind === 'ready' && isLive(state.value), fixedNow);
  if (state.kind === 'loading') return <Loading kind="page" compact label="Reading this run…" />;
  if (state.kind === 'failed') return <CiFailedPanel failure={state.failure} onRetry={reload} />;
  return <RunView run={state.value} nowMs={now} refreshFailed={state.refreshFailed?.message} />;
}
