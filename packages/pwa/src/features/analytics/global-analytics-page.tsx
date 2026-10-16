/**
 * ANALYTICS — what this machine's sessions cost over a period, and where it went.
 *
 * The page follows the Insights pattern: a status line with the range, a strip of at most four
 * figures, then the detail — one cost chart, the split by model, and the sessions that cost the most,
 * each of which opens that session. The query language is still here, last and closed, under "Custom
 * query" (see `analytics-custom-query.tsx`).
 *
 * The figures are computed from per-session rows (see `analytics-overview.ts`), so an unpriced session
 * never wipes out a known total: the total stays a number and the gap is a chip beside it.
 *
 * Everything below the frame is keyed by the daemon, so a switch to another paired daemon mounts a fresh
 * body and a late answer from the previous one cannot reach the screen.
 */

import { type ReactNode, useEffect, useMemo, useState } from 'react';

import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { daemonSessionPath } from '../../lib/pages/routes.ts';
import { useOptionalRouter } from '../../lib/router.tsx';
import { useDaemonFetch } from '../../lib/store.tsx';
import { INSIGHTS_COLUMN_CLASS } from '../../shell/insights-frame.tsx';
import { RouteLink } from '../../shell/route-link.tsx';
import { fetchAnalytics } from './analytics-api.ts';
import { AnalyticsCostChart } from './analytics-cost-chart.tsx';
import { CostSplit, UnpricedChip } from './analytics-cost-rows.tsx';
import { AnalyticsCustomQuery, type AnalyticsRequest } from './analytics-custom-query.tsx';
import {
  ANALYTICS_RANGES,
  type AnalyticsOverview,
  type AnalyticsRange,
  type AnalyticsTopSession,
  analyticsOverview,
  analyticsRangeDays,
  DEFAULT_ANALYTICS_RANGE,
  formatTokens,
  formatUsd,
} from './analytics-overview.ts';
import { readAnalyticsWindow } from './analytics-overview-load.ts';
import { analyticsErrorMessage } from './analytics-response-view.tsx';

/** How many sessions the overview lists before "See all". */
export const TOP_SESSIONS_SHOWN = 5;

/** The `?q=` a link brought, which opens Custom query with that query already run. */
export const analyticsLinkQuery = (search: string): string | null => new URLSearchParams(search).get('q');

export interface GlobalAnalyticsPageProps {
  readonly connection: DaemonConnection;
  /** Injectable for deterministic render and screenshot harnesses. */
  readonly requestAnalytics?: AnalyticsRequest;
  /** The clock the window ends on. */
  readonly now?: () => Date;
  /** A query handed in by a link; defaults to this page's own `?q=`. */
  readonly initialQuery?: string | null;
}

export function GlobalAnalyticsPage({
  connection,
  requestAnalytics: injected,
  now,
  initialQuery,
}: GlobalAnalyticsPageProps) {
  // Through the carrier router by default: a paired device has no bearer value of its own to read with.
  const fetcher = useDaemonFetch();
  const requestAnalytics = useMemo<AnalyticsRequest>(
    () => injected ?? ((daemon, query) => fetchAnalytics(daemon, query, fetcher)),
    [fetcher, injected],
  );
  const [linkQuery] = useState(() =>
    initialQuery === undefined ? analyticsLinkQuery(globalThis.location?.search ?? '') : initialQuery,
  );
  return (
    <main
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-thin"
      aria-label="Global analytics"
      data-daemon={connection.daemonId}
    >
      <AnalyticsBody
        key={connection.daemonId}
        connection={connection}
        requestAnalytics={requestAnalytics}
        now={now ?? (() => new Date())}
        initialQuery={linkQuery}
      />
    </main>
  );
}

type OverviewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly error: string }
  | { readonly status: 'ready'; readonly overview: AnalyticsOverview };

function AnalyticsBody({
  connection,
  requestAnalytics,
  now,
  initialQuery,
}: {
  readonly connection: DaemonConnection;
  readonly requestAnalytics: AnalyticsRequest;
  readonly now: () => Date;
  readonly initialQuery: string | null;
}) {
  const [range, setRange] = useState<AnalyticsRange>(DEFAULT_ANALYTICS_RANGE);
  const [state, setState] = useState<OverviewState>({ status: 'loading' });
  const [clock] = useState(now);

  useEffect(() => {
    let current = true;
    setState({ status: 'loading' });
    const days = analyticsRangeDays(range, clock);
    readAnalyticsWindow(query => requestAnalytics(connection, query), days).then(
      read => {
        if (current) setState({ status: 'ready', overview: analyticsOverview(days, read.rows, read.partial) });
      },
      (reason: unknown) => {
        if (current) setState({ status: 'error', error: analyticsErrorMessage(reason) });
      },
    );
    return () => {
      current = false;
    };
  }, [clock, connection, range, requestAnalytics]);

  return (
    <div className={`${INSIGHTS_COLUMN_CLASS} grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 pb-8 pt-3 sm:pt-4`}>
      <header className="flex flex-wrap items-center justify-between gap-x-md gap-y-sm">
        <div className="min-w-0">
          <h2 className="m-0 text-title font-semibold leading-tight text-fg">Analytics</h2>
          <p className="m-0 text-meta text-muted">
            Equivalent API cost, last {range} days · every session on this machine
          </p>
        </div>
        <fieldset className="m-0 flex border-0 p-0" aria-label="Period">
          {ANALYTICS_RANGES.map(option => (
            <button
              key={option}
              type="button"
              aria-pressed={option === range}
              onClick={() => setRange(option)}
              className={`kt-btn kt-btn--sm min-h-[44px] min-w-[44px] ${option === range ? 'text-accent' : 'text-muted'}`}
              data-variant={option === range ? undefined : 'ghost'}
              data-analytics-range={option}
            >
              {option}d
            </button>
          ))}
        </fieldset>
      </header>

      <div aria-live="polite" aria-busy={state.status === 'loading'} className="grid min-w-0 gap-5">
        {state.status === 'loading' && (
          <p role="status" className="m-0 py-6 text-cell text-muted">
            Reading this period's sessions…
          </p>
        )}
        {state.status === 'error' && (
          <p role="alert" className="m-0 rounded-control border border-err/40 bg-err/10 px-3 py-2 text-cell text-err">
            Analytics could not load: {state.error} Nothing was assumed to be zero.
          </p>
        )}
        {state.status === 'ready' && <OverviewSections overview={state.overview} connection={connection} />}
      </div>

      <AnalyticsCustomQuery
        connection={connection}
        requestAnalytics={requestAnalytics}
        {...(initialQuery ? { initialQuery } : {})}
      />
    </div>
  );
}

function Figure({
  label,
  value,
  note,
  chip,
}: {
  readonly label: string;
  readonly value: string;
  readonly note: string;
  readonly chip?: ReactNode;
}) {
  return (
    <div className="grid min-w-0 content-start gap-xs bg-surface px-md py-sm" data-analytics-figure={label}>
      <span className="text-meta text-muted">{label}</span>
      <span className="flex flex-wrap items-center gap-x-sm gap-y-xs">
        <span className="mono text-title font-semibold tabular-nums text-fg">{value}</span>
        {chip}
      </span>
      <span className="text-2xs text-muted">{note}</span>
    </div>
  );
}

function OverviewSections({
  overview,
  connection,
}: {
  readonly overview: AnalyticsOverview;
  readonly connection: DaemonConnection;
}) {
  const [allSessions, setAllSessions] = useState(false);
  const shown = allSessions ? overview.topSessions : overview.topSessions.slice(0, TOP_SESSIONS_SHOWN);
  return (
    <>
      <section
        aria-label="Summary"
        className="grid grid-cols-2 gap-px overflow-hidden rounded-panel border border-border bg-border lg:grid-cols-4"
      >
        <Figure
          label="Equivalent cost"
          value={formatUsd(overview.costMicros)}
          note="At API rates; never billed spend"
          chip={<UnpricedChip count={overview.unpriced} />}
        />
        <Figure
          label="Sessions"
          value={String(overview.sessions)}
          note={overview.busiest ? `${overview.busiest.sessions} on the busiest day` : 'None in this period'}
        />
        <Figure
          label="Tokens"
          value={formatTokens(overview.tokens)}
          note={
            [
              ...(overview.cacheReadPercent === null ? [] : [`${Math.round(overview.cacheReadPercent)}% cache reads`]),
              ...(overview.tokensUnknown > 0 ? [`${overview.tokensUnknown} not counted`] : []),
            ].join(' · ') || 'Input and output'
          }
        />
        <Figure
          label="Avg / session"
          value={overview.averageMicros === null ? '—' : formatUsd(overview.averageMicros)}
          note="Priced sessions only"
        />
      </section>

      {overview.partialDays > 0 && (
        <p role="status" className="m-0 text-meta text-warn">
          {overview.partialDays} busy day{overview.partialDays === 1 ? ' was' : 's were'} only partly listed, so cost on{' '}
          {overview.partialDays === 1 ? 'it' : 'them'} is a lower bound.
        </p>
      )}

      <section aria-label="Cost per day" className="kt-panel min-w-0 px-md py-md">
        <AnalyticsCostChart days={overview.days} />
      </section>

      <div className="grid min-w-0 gap-5 lg:grid-cols-2 lg:items-start">
        <section
          aria-labelledby="analytics-by-model"
          className="kt-panel grid min-w-0 content-start gap-sm px-md py-md"
        >
          <h3 id="analytics-by-model" className="m-0 text-cell font-semibold text-fg">
            By model
          </h3>
          <CostSplit label="Equivalent cost by model" shares={overview.models} unpriced={overview.unpriced} limit={4} />
        </section>

        <section
          aria-labelledby="analytics-top-sessions"
          className="kt-panel grid min-w-0 content-start gap-sm px-md py-md"
        >
          <div className="flex items-center justify-between gap-md">
            <h3 id="analytics-top-sessions" className="m-0 text-cell font-semibold text-fg">
              Top sessions
            </h3>
            {overview.topSessions.length > TOP_SESSIONS_SHOWN && (
              <button
                type="button"
                className="min-h-[44px] text-meta text-accent hover:underline"
                aria-expanded={allSessions}
                onClick={() => setAllSessions(current => !current)}
              >
                {allSessions ? 'Show fewer' : `See all ${overview.topSessions.length}`}
              </button>
            )}
          </div>
          {shown.length === 0 ? (
            <p className="m-0 text-cell text-muted">No sessions in this period.</p>
          ) : (
            <ul aria-label="Sessions by equivalent cost" className="m-0 grid list-none gap-0 p-0">
              {shown.map(session => (
                <TopSessionRow key={session.id} session={session} connection={connection} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}

function TopSessionRow({
  session,
  connection,
}: {
  readonly session: AnalyticsTopSession;
  readonly connection: DaemonConnection;
}) {
  const router = useOptionalRouter();
  const where = [session.project, session.label].filter(part => part !== null).join(' · ');
  return (
    <li className="border-t border-border-soft first:border-t-0">
      <RouteLink
        to={daemonSessionPath(connection.daemonId, session.id)}
        {...(router ? { onNavigate: router.navigate } : {})}
        className="grid min-h-[44px] grid-cols-[minmax(0,1fr)_auto] items-start gap-x-md gap-y-xs py-sm text-cell hover:bg-surface-2"
        data-top-session={session.id}
      >
        <span className="min-w-0">
          <span className="font-semibold text-fg">{session.agent ?? session.id}</span>
          {where && <span className="text-muted"> · {where}</span>}
        </span>
        <span className="mono text-right font-semibold tabular-nums text-fg">{formatUsd(session.costMicros)}</span>
        <span className="col-span-2 flex flex-wrap items-center gap-xs text-2xs text-muted">
          {session.model && <span className="mono">{session.model}</span>}
          {session.children > 0 && (
            <span>
              +{session.children} child{session.children === 1 ? '' : 'ren'}
            </span>
          )}
          <UnpricedChip count={session.unpriced} />
        </span>
      </RouteLink>
    </li>
  );
}
