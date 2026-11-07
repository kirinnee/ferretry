/**
 * INSIGHTS — two screens under one Insights tab: the OVERVIEW of a period, and the QUERY screen.
 *
 * Each has its own address (`…/insights` and `…/insights/query?q=…`), and the switch between them is
 * the segmented control at the top, which stays put while the page under it scrolls. A link still lands
 * on the page it names and Back goes where it came from. A `?q=` link to the Overview address is a query
 * link: it is REPLACED by the Query address, so Back does not bounce through the Overview, and the
 * Query page's own runs are mirrored into `?q=` the same way, without new history.
 *
 * Both pages read the machines they are given (see `analytics-fanout.ts`) and say which machines
 * answered. A half is built per daemon (§9.6), so that is this daemon alone unless a host passes more. The
 * body is keyed by the machine set, so a change of machines mounts a fresh one and a late answer from the
 * previous set cannot reach the screen.
 */

import { type ComponentType, useEffect, useMemo, useState } from 'react';

import { useInsightsTimeZone } from '../../lib/insights-time-zone.ts';
import {
  type DaemonConnection,
  daemonInsightsPath,
  daemonInsightsQueryPath,
  type InsightsView,
  THIS_MACHINE_NAME,
  type UsageClient,
} from '../../shell.ts';
import { INSIGHTS_COLUMN_CLASS } from '../../shell/insights-frame.tsx';
import { Segmented } from '../../shell/segmented.tsx';
import { fetchAnalytics } from './analytics-api.ts';
import type { AnalyticsRequest } from './analytics-custom-query.tsx';
import { type AnalyticsMachine, askEveryMachine } from './analytics-fanout.ts';
import { AnalyticsOverviewPage } from './analytics-overview-page.tsx';
import { AnalyticsQueryPage, type AnalyticsQueryPageProps } from './analytics-query-page.tsx';
import { InsightsTimeZonePicker } from './insights-time-zone-picker.tsx';

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
  /** This daemon's client; the default reads go through it. */
  readonly client: UsageClient;
  /** Every machine to read, this one included; defaults to this machine alone. */
  readonly machines?: readonly AnalyticsMachine[];
  readonly view?: InsightsView;
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
  client,
  machines: given,
  view = 'overview',
  onNavigate,
  onQueryChange,
  requestAnalytics: injected,
  now,
  initialQuery,
  QueryPage = AnalyticsQueryPage,
}: GlobalAnalyticsPageProps) {
  // Through the shell's per-daemon client by default.
  // The zone days are counted in is the READER's (kept on this device); every request carries it, so the
  // daemon groups and filters `day`/`week` on the same calendar the page draws.
  const { choice: zoneChoice, zone, setChoice: chooseZone } = useInsightsTimeZone();
  const requestAnalytics = useMemo<AnalyticsRequest>(
    () => injected ?? ((_daemon, query) => fetchAnalytics(client, query, zone)),
    [client, injected, zone],
  );
  const machines = useMemo<readonly AnalyticsMachine[]>(
    () => given ?? [{ connection, name: THIS_MACHINE_NAME }],
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
  const queryLink = view === 'overview' && linkQuery ? linkQuery : null;
  useEffect(() => {
    if (queryLink === null) return;
    replaceAddress(daemonInsightsQueryPath(connection.daemonId, queryLink));
    // The router reads the address on popstate, so it now names the Query page.
    globalThis.dispatchEvent(new PopStateEvent('popstate'));
  }, [connection.daemonId, queryLink]);
  if (queryLink !== null) return null;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-analytics-view={view}>
      <header
        className={`${INSIGHTS_COLUMN_CLASS} flex shrink-0 flex-wrap items-center justify-between gap-x-md gap-y-sm pt-3 sm:pt-4`}
      >
        <h2 className="m-0 text-title font-semibold leading-tight text-fg">Insights</h2>
        <div className="flex min-w-0 flex-wrap items-center gap-x-md gap-y-sm">
          <InsightsTimeZonePicker choice={zoneChoice} onChoose={chooseZone} />
          <div className="w-48">
            <Segmented<InsightsView>
              label="Insights page"
              name="analytics-view"
              options={VIEWS}
              value={view}
              onChoose={next =>
                onNavigate(
                  next === 'query'
                    ? daemonInsightsQueryPath(connection.daemonId)
                    : daemonInsightsPath(connection.daemonId),
                )
              }
            />
          </div>
        </div>
      </header>
      {view === 'overview' ? (
        <main
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-thin"
          aria-label="Global insights"
          data-daemon={connection.daemonId}
        >
          <div className={`${INSIGHTS_COLUMN_CLASS} grid min-w-0 grid-cols-[minmax(0,1fr)] pb-8 pt-3`}>
            <AnalyticsOverviewPage
              key={machineKey}
              machines={machines}
              requestAnalytics={requestAnalytics}
              now={now ?? (() => new Date())}
              timeZone={zone}
            />
          </div>
        </main>
      ) : (
        <QueryPage
          key={machineKey}
          connection={connection}
          client={client}
          connections={machines.map(machine => machine.connection)}
          requestAnalytics={requestValues}
          requestRun={requestRun}
          timeZone={zone}
          {...(now === undefined ? {} : { now })}
          onQueryChange={
            onQueryChange ?? (query => replaceAddress(daemonInsightsQueryPath(connection.daemonId, query)))
          }
          initialQuery={linkQuery}
        />
      )}
    </div>
  );
}
