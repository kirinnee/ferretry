/**
 * `ferret.side:usage`: Info › Usage — how full this ferret's context is, what its turns have cost, and how much of its
 * login's quota is left (today's `session-info/info-usage.tsx`).
 *
 * Every number has a source and none is invented: context, turns, tokens and cost are this ferret's own analytics
 * row (read scoped to the ferret, where the daemon enforces the id), and the quota is the daemon's passive usage feed
 * for the login the row names. A total the analytics could not price says "unknown", never $0.00, and a login with no
 * quota reading says "usage unknown".
 */
import { useOptionalRouter } from '@ferretry/app';
import { RouteLink } from '@ferretry/app/ui';
import { useEffect, useState } from 'react';
import type { AnalyticsRawSession } from '../../contract/index.ts';
import { fetchSessionAnalytics } from '../features/analytics/analytics-api.ts';
import { costGapReason } from '../features/analytics/analytics-cost-gaps.ts';
import { formatTokens, formatUsd } from '../features/analytics/analytics-overview.ts';
import { analyticsIdQuery } from '../features/analytics/session-analytics-query.ts';
import { useUsage } from '../hooks/use-usage.ts';
import type { DaemonUsageStore } from '../lib/usage-store.ts';
import { browserClock, daemonInsightsPath, type UsageClient, useDaemonConnection } from '../shell.ts';
import { quotaMoneyText, quotaResetsIn } from './quota-readout.tsx';

type Read =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly row: AnalyticsRawSession | null }
  | { readonly kind: 'failed'; readonly reason: string };

const percentOf = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));

function Row({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-sm text-cell" data-info-row={label}>
      <span className="text-muted">{label}</span>
      <span className="flex min-w-0 items-baseline gap-xs">{children}</span>
    </div>
  );
}

const Muted = ({ children }: { readonly children: React.ReactNode }) => <span className="text-muted">{children}</span>;

function Meter({ label, percent }: { readonly label: string; readonly percent: number }) {
  const value = percentOf(percent);
  return (
    <span className="flex items-center gap-xs">
      <progress aria-label={label} max={100} value={value} />
      <span className="mono tabular-nums">{value}%</span>
    </span>
  );
}

function tokensText(row: AnalyticsRawSession): string {
  const part = (label: string, value: number | null) => (value === null ? null : `${label} ${formatTokens(value)}`);
  const parts = [
    part('in', row.inputTokens),
    part('out', row.outputTokens),
    part('cache', row.cachedInputTokens),
  ].filter((text): text is string => text !== null);
  return parts.length === 0 ? 'unknown' : parts.join(' · ');
}

export function FerretUsageInfoPanel({
  client,
  store,
  subject,
  now = () => browserClock.now().getTime(),
}: {
  readonly client: UsageClient;
  readonly store: DaemonUsageStore;
  readonly subject?: string;
  readonly now?: () => number;
}) {
  const connection = useDaemonConnection();
  const router = useOptionalRouter();
  const [read, setRead] = useState<Read>({ kind: 'loading' });
  useUsage(store, connection);
  useEffect(() => {
    if (subject === undefined) return;
    let current = true;
    setRead({ kind: 'loading' });
    fetchSessionAnalytics(
      connection,
      client,
      { daemonId: connection.daemonId, sessionId: subject },
      analyticsIdQuery(subject),
    ).then(
      response => {
        if (!current) return;
        const row = response.kind === 'raw' ? (response.results.find(entry => entry.id === subject) ?? null) : null;
        setRead({ kind: 'ready', row });
      },
      (reason: unknown) => {
        if (current) setRead({ kind: 'failed', reason: reason instanceof Error ? reason.message : String(reason) });
      },
    );
    return () => {
      current = false;
    };
  }, [client, connection, subject]);
  if (subject === undefined) return null;

  const row = read.kind === 'ready' ? read.row : null;
  const quota =
    row?.agent == null ? null : store.quotaFor(connection.daemonId, { state: {}, config: { agent: row.agent } });
  const stamp = now();
  const windows = [
    ['5 hours', quota?.fiveHourPercent, quota?.fiveHourResetAt],
    ['Week', quota?.weeklyPercent, quota?.weeklyResetAt],
  ].flatMap(([label, percent, resetAt]) => {
    if (percent === undefined) return [];
    const resets = quotaResetsIn(resetAt as number | undefined, stamp);
    return [
      <Row key={label as string} label={label as string}>
        <Meter label={`${label} quota used`} percent={percent as number} />
        {resets === null ? null : <Muted>resets in {resets}</Muted>}
      </Row>,
    ];
  });

  return (
    <section aria-label="Usage" className="grid min-w-0 gap-sm px-panel py-3" data-info-usage={read.kind}>
      {read.kind === 'loading' ? <Muted>Reading…</Muted> : null}
      {read.kind === 'failed' ? <Muted>Couldn’t read: {read.reason}</Muted> : null}
      {read.kind === 'ready' && row === null ? <Muted>No turns recorded yet</Muted> : null}
      {row === null ? null : (
        <>
          <Row label="Context">
            {row.contextEndPercent === null ? (
              <Muted>Not reported yet</Muted>
            ) : (
              <Meter label="Context used" percent={row.contextEndPercent} />
            )}
          </Row>
          <Row label="Turns">{row.turns === null ? <Muted>unknown</Muted> : String(row.turns)}</Row>
          <Row label="Tokens">{tokensText(row)}</Row>
          <Row label="Cost (equiv.)">
            {row.equivalentApiCostUsdMicros === null ? (
              <Muted>
                usage unknown — {row.costGap == null ? 'no pricing for this model' : costGapReason(row.costGap)}
              </Muted>
            ) : (
              <>
                {formatUsd(row.equivalentApiCostUsdMicros)}
                <Muted>this ferret</Muted>
              </>
            )}
          </Row>
          <Row label="Insights">
            <RouteLink
              className="text-cell"
              data-info-open-insights=""
              to={daemonInsightsPath(connection.daemonId)}
              {...(router ? { onNavigate: router.navigate } : {})}
            >
              Open Insights
            </RouteLink>
          </Row>
          <h3 className="m-0 mt-2 text-meta font-semibold text-muted">Login quota · {row.agent ?? 'unknown login'}</h3>
          {windows.length === 0 ? (
            <Row label="Quota">{quotaMoneyText(quota) ?? <Muted>usage unknown</Muted>}</Row>
          ) : (
            windows
          )}
          {quota?.atLimit === true ? <Row label="State">At its limit</Row> : null}
        </>
      )}
    </section>
  );
}
