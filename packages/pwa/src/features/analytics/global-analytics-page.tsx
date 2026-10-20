/**
 * ANALYTICS — two pages under one Insights tab: the OVERVIEW of a period, and the QUERY page.
 *
 * Each has its own address (`…/analytics` and `…/analytics/query?q=…`), and the switch between them is
 * the segmented control at the top, which stays put while the page under it scrolls. A link still lands
 * on the page it names and Back goes where it came from. A `?q=` link to the Overview address is a query
 * link from before the split: it is REPLACED by the Query address, so Back does not bounce through the
 * Overview, and the Query page's own runs are mirrored into `?q=` the same way, without new history.
 *
 * Both pages read EVERY paired machine (see `analytics-fanout.ts`), each through its own pairing, and
 * say which machines answered. The body is keyed by the machine set, so a change of machines mounts a
 * fresh one and a late answer from the previous set cannot reach the screen.
 */

import { type ComponentType, useEffect, useMemo, useState } from 'react';

import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { type AnalyticsView, daemonAnalyticsPath, daemonAnalyticsQueryPath } from '../../lib/pages/routes.ts';
import { useDaemonFetch } from '../../lib/store.tsx';
import { INSIGHTS_COLUMN_CLASS } from '../../shell/insights-frame.tsx';
import { Segmented } from '../fleet/conversations/conversation-picker.tsx';
import { daemonDisplayName } from '../settings/daemon-settings.tsx';
import { fetchAnalytics } from './analytics-api.ts';
import type { AnalyticsRequest } from './analytics-custom-query.tsx';
import { type AnalyticsMachine, askEveryMachine } from './analytics-fanout.ts';
import { AnalyticsOverviewPage } from './analytics-overview-page.tsx';
import { AnalyticsQueryPage, type AnalyticsQueryPageProps } from './analytics-query-page.tsx';

/** The `?q=` a link brought. */
export const analyticsLinkQuery = (search: string): string | null => new URLSearchParams(search).get('q');

/** Puts a query into the address without a new history entry. */
const replaceAddress = (to: string): void => globalThis.history.replaceState(globalThis.history.state, '', to);

const VIEWS = [
  { id: 'overview', label: 'Overview' },
  { id: 'query', label: 'Query' },
] as const;

export interface GlobalAnalyticsPageProps {
  readonly connection: DaemonConnection;
  /** Every paired machine to read, this one included; defaults to this machine alone. */
  readonly machines?: readonly AnalyticsMachine[];
  readonly view?: AnalyticsView;
  readonly onNavigate: (to: string) => void;
  /** Hears the Query page's canonical query after each run; defaults to mirroring it into `?q=`. */
  readonly onQueryChange?: (query: string) => void;
  /** Injectable for deterministic render and screenshot harnesses. */
  readonly requestAnalytics?: AnalyticsRequest;
  /** The clock the window ends on. */
  readonly now?: () => Date;
  /** A query handed in by a link; defaults to this page's own `?q=`. */
  readonly initialQuery?: string | null;
  /** The Query page body; injectable so a test can mount the shell alone. */
  readonly QueryPage?: ComponentType<AnalyticsQueryPageProps>;
}

export function GlobalAnalyticsPage({
  connection,
  machines: given,
  view = 'overview',
  onNavigate,
  onQueryChange,
  requestAnalytics: injected,
  now,
  initialQuery,
  QueryPage = AnalyticsQueryPage,
}: GlobalAnalyticsPageProps) {
  // Through the carrier router by default: a paired device has no bearer value of its own to read with.
  const fetcher = useDaemonFetch();
  const requestAnalytics = useMemo<AnalyticsRequest>(
    () => injected ?? ((daemon, query) => fetchAnalytics(daemon, query, fetcher)),
    [fetcher, injected],
  );
  const machines = useMemo<readonly AnalyticsMachine[]>(
    () => given ?? [{ connection, name: daemonDisplayName(connection) }],
    [connection, given],
  );
  // READ ONCE, when the page arrives. A run mirrors its own canonical query into the address; reading
  // the address again on a later render would hand the page a "new" link query and run it a second time.
  const [linkQuery] = useState(() =>
    initialQuery === undefined ? analyticsLinkQuery(globalThis.location?.search ?? '') : initialQuery,
  );
  const machineKey = machines.map(machine => machine.connection.daemonId).join('\n');
  // The reader's run asks every machine and merges, keeping who did not answer WITH its result; value
  // suggestions ask the same way and report nothing, so they never move the run's banner.
  const requestRun = useMemo(
    () => (query: string | undefined) => askEveryMachine(machines, requestAnalytics, query),
    [machines, requestAnalytics],
  );
  const requestValues = useMemo<AnalyticsRequest>(
    () => async (_connection, query) => (await askEveryMachine(machines, requestAnalytics, query)).response,
    [machines, requestAnalytics],
  );
  const legacyQuery = view === 'overview' && linkQuery ? linkQuery : null;
  useEffect(() => {
    if (legacyQuery === null) return;
    replaceAddress(daemonAnalyticsQueryPath(connection.daemonId, legacyQuery));
    // The router reads the address on popstate, so it now names the Query page.
    globalThis.dispatchEvent(new PopStateEvent('popstate'));
  }, [connection.daemonId, legacyQuery]);
  if (legacyQuery !== null) return null;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-analytics-view={view}>
      <header
        className={`${INSIGHTS_COLUMN_CLASS} flex shrink-0 flex-wrap items-center justify-between gap-x-md gap-y-sm pt-3 sm:pt-4`}
      >
        <h2 className="m-0 text-title font-semibold leading-tight text-fg">Analytics</h2>
        <div className="w-48">
          <Segmented<AnalyticsView>
            label="Analytics page"
            name="analytics-view"
            options={VIEWS}
            value={view}
            onChoose={next =>
              onNavigate(
                next === 'query'
                  ? daemonAnalyticsQueryPath(connection.daemonId)
                  : daemonAnalyticsPath(connection.daemonId),
              )
            }
          />
        </div>
      </header>
      {view === 'overview' ? (
        <main
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-thin"
          aria-label="Global analytics"
          data-daemon={connection.daemonId}
        >
          <div className={`${INSIGHTS_COLUMN_CLASS} grid min-w-0 grid-cols-[minmax(0,1fr)] pb-8 pt-3`}>
            <AnalyticsOverviewPage
              key={machineKey}
              machines={machines}
              requestAnalytics={requestAnalytics}
              now={now ?? (() => new Date())}
            />
          </div>
        </main>
      ) : (
        <QueryPage
          key={machineKey}
          connection={connection}
          connections={machines.map(machine => machine.connection)}
          requestAnalytics={requestValues}
          requestRun={requestRun}
          {...(now === undefined ? {} : { now })}
          onQueryChange={
            onQueryChange ?? (query => replaceAddress(daemonAnalyticsQueryPath(connection.daemonId, query)))
          }
          initialQuery={linkQuery}
        />
      )}
    </div>
  );
}
