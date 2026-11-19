/**
 * The CI tab (r9 E9): every run of one pull request's (or branch's) head commit, as rows that open the run page.
 * E4's PR page mounts `CiTab` by its path (`app/features/ci-run/ci-runs-list.tsx`); nothing here knows the PR page.
 */
import { useRouter, useScreenHref } from '@ferretry/app';
import { ExternalLink, Loading, RouteLink } from '@ferretry/app/ui';
import { ChevronRight } from 'lucide-react';
import { repoSegment } from '../../../contract/repo-segment.ts';
import type { CiRun } from '../../../contract/wire.ts';
import { CiFailedPanel } from './ci-failed.tsx';
import { type CiClient, type CiScope, type CiTarget, fetchRuns } from './ci-api.ts';
import {
  barMs,
  checkHref,
  formatDuration,
  isCheck,
  orderRuns,
  runsSummary,
  shortSha,
  STATUS_WORD,
  triggerWord,
} from './ci-format.ts';
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
    run.live === true
      ? Math.max(run.wallMs, barMs({ start: run.createdAt, live: true }, nowMs, true) ?? 0)
      : run.wallMs;
  return formatDuration(ms);
};

function RunRow({
  run,
  href,
  nowMs,
  onOpen,
}: {
  readonly run: CiRun;
  /** The run screen for an Actions run; `undefined` for a check from another CI (it has no run screen). */
  readonly href: string | undefined;
  readonly nowMs: number;
  readonly onOpen: (to: string) => void;
}) {
  const body = (
    <>
      <StatusIcon status={run.status} size={18} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
          <span className="min-w-0 text-ui font-medium text-fg [overflow-wrap:anywhere]">{run.name}</span>
          <span className={`text-meta font-medium ${STATUS_TEXT[run.status]}`}>{STATUS_WORD[run.status]}</span>
          {run.attempt > 1 && (
            <span className="rounded-control border border-border-strong px-1 text-2xs text-fg-soft">
              Attempt {run.attempt}
            </span>
          )}
        </span>
        <span className="block text-meta text-muted [overflow-wrap:anywhere]">
          {triggerWord(run.trigger)} · <span className="mono">{shortSha(run.headSha)}</span> · {startedAt(run)}
          {run.queuedMs > 0 && <> · queued {formatDuration(run.queuedMs)}</>}
        </span>
      </span>
      <span className={`mono shrink-0 text-cell tabular-nums ${STATUS_TEXT[run.status]}`}>{runLength(run, nowMs)}</span>
      {!isCheck(run) && href !== undefined && (
        <ChevronRight aria-hidden="true" size={16} className="shrink-0 text-muted" />
      )}
    </>
  );
  const row = 'flex min-h-control items-center gap-sm px-control-x py-row-y text-left no-underline';
  // A check from another CI has no run screen: the daemon only reads `/actions/runs/{id}`, so its id there would be a
  // different run or none. It links to its own page on GitHub when that is a github.com address, else it is not a link.
  const outside = isCheck(run) ? checkHref(run) : undefined;
  return (
    <li data-ci-run={run.id} data-ci-run-status={run.status} data-ci-check={isCheck(run) ? 'true' : undefined}>
      {isCheck(run) ? (
        outside === undefined ? (
          <div className={row}>{body}</div>
        ) : (
          <ExternalLink href={outside} className={`${row} hover:bg-hover-fill`}>
            {body}
            <span className="sr-only"> (opens on GitHub)</span>
          </ExternalLink>
        )
      ) : href === undefined ? (
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
  const { state, reload } = useLiveRead(
    key,
    (signal, press) => fetchRuns(client, scope, target, signal, press),
    runsLive,
  );
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
              key={`${isCheck(run) ? 'check' : 'run'}-${run.id}-${run.attempt}`}
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
