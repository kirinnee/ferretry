/**
 * The CI tab (r9 E9): every run of one pull request's (or branch's) head commit, as rows that open the run page.
 * E4's PR page mounts `CiTab` by its path (`app/features/ci-run/ci-runs-list.tsx`); nothing here knows the PR page.
 */
import { useRouter, useScreenHref } from '@ferretry/app';
import { Loading, RouteLink } from '@ferretry/app/ui';
import { ChevronRight } from 'lucide-react';
import { repoSegment } from '../../../contract/repo-segment.ts';
import type { CiRun } from '../../../contract/wire.ts';
import { CiFailedPanel } from './ci-failed.tsx';
import { type CiClient, type CiScope, type CiTarget, fetchRuns } from './ci-api.ts';
import { barMs, formatDuration, orderRuns, runsSummary, shortSha, STATUS_WORD, triggerWord } from './ci-format.ts';
import { StatusIcon, STATUS_TEXT } from './ci-status.tsx';
import { runsLive, useLiveRead, useSecondClock } from './use-ci.ts';

export interface CiTabProps {
  readonly client: CiClient;
  readonly daemon: string;
  readonly scope: CiScope;
  readonly target: CiTarget;
  /** A fixed clock (a test, a screenshot): no timer starts and "now" is this instant. */
  readonly nowMs?: number;
}

/** When a run began, in the device's own time. */
const startedAt = (run: CiRun): string =>
  new Date(run.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** A run's length in words: its wall time, or how long it has been going. */
const runLength = (run: CiRun, nowMs: number): string => {
  if (run.live === true && run.start === undefined) return `waiting ${formatDuration(run.queuedMs)}`;
  const ms =
    run.live === true ? Math.max(run.wallMs, barMs({ start: run.createdAt, live: true }, nowMs) ?? 0) : run.wallMs;
  return formatDuration(ms);
};

function RunRow({
  run,
  href,
  nowMs,
  onOpen,
}: {
  readonly run: CiRun;
  readonly href: string | undefined;
  readonly nowMs: number;
  readonly onOpen: (to: string) => void;
}) {
  const body = (
    <>
      <StatusIcon status={run.status} size={18} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
          <span className="min-w-0 break-words text-ui font-medium text-fg">{run.name}</span>
          <span className={`text-meta font-medium ${STATUS_TEXT[run.status]}`}>{STATUS_WORD[run.status]}</span>
          {run.attempt > 1 && (
            <span className="rounded-control border border-border-strong px-1 text-2xs text-fg-soft">
              Attempt {run.attempt}
            </span>
          )}
        </span>
        <span className="block text-meta text-muted">
          {triggerWord(run.trigger)} · <span className="mono">{shortSha(run.headSha)}</span> · {startedAt(run)}
          {run.queuedMs > 0 && <> · queued {formatDuration(run.queuedMs)}</>}
        </span>
      </span>
      <span className={`mono shrink-0 text-cell tabular-nums ${STATUS_TEXT[run.status]}`}>{runLength(run, nowMs)}</span>
      {href !== undefined && <ChevronRight aria-hidden="true" size={16} className="shrink-0 text-muted" />}
    </>
  );
  const row = 'flex min-h-control items-center gap-sm px-control-x py-row-y text-left no-underline';
  return (
    <li data-ci-run={run.id} data-ci-run-status={run.status}>
      {href === undefined ? (
        <div className={row}>{body}</div>
      ) : (
        <RouteLink to={href} onNavigate={onOpen} className={`${row} hover:bg-hover-fill`}>
          {body}
        </RouteLink>
      )}
    </li>
  );
}

export function CiTab({ client, daemon, scope, target, nowMs: fixedNow }: CiTabProps) {
  const key = `${scope.project}/${scope.repo.owner}/${scope.repo.name}/${'pr' in target ? `pr${target.pr}` : target.branch}`;
  const { state, reload } = useLiveRead(key, signal => fetchRuns(client, scope, target, signal), runsLive);
  const hrefOf = useScreenHref();
  const { navigate } = useRouter();
  const live = state.kind === 'ready' && runsLive(state.value);
  const now = useSecondClock(live, fixedNow);

  if (state.kind === 'loading') return <Loading kind="page" compact label="Reading CI runs…" />;
  if (state.kind === 'failed') return <CiFailedPanel failure={state.failure} onRetry={reload} />;
  const runs = orderRuns(state.value);
  return (
    <div className="mx-auto grid w-full max-w-3xl gap-sm" data-ci-tab="true">
      {runs.length > 0 && (
        <p className="m-0 px-1 pt-1 text-meta text-muted" aria-live="polite">
          {runsSummary(runs)}
          {state.refreshFailed !== undefined && <> · could not refresh: {state.refreshFailed.message}</>}
        </p>
      )}
      {runs.length === 0 ? (
        <p className="kt-panel m-0 p-panel text-ui text-muted">No CI has run for this commit yet.</p>
      ) : (
        <ul className="kt-panel m-0 list-none divide-y divide-border-soft p-0">
          {runs.map(run => (
            <RunRow
              key={`${run.id}-${run.attempt}`}
              run={run}
              nowMs={now}
              onOpen={navigate}
              href={hrefOf(daemon, 'pulls', 'ci-run', {
                project: scope.project,
                repo: repoSegment(scope.repo),
                runId: String(run.id),
              })}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
