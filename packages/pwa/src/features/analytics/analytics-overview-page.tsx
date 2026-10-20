/**
 * ANALYTICS › OVERVIEW — what a period took, across every machine: equivalent API cost, tokens, turns
 * and time, then where they went and which sessions took them.
 *
 * Answer first, in the order a reader asks: a status line (the period and which machines answered), a
 * strip of four equal figures, one chart of the chosen measure, the same measure split by model,
 * runtime, machine and project, and the sessions that took the most — each of which opens that
 * session on its own machine.
 *
 * The figures are computed from per-session rows (see `analytics-overview.ts`), so an unknown value
 * never wipes out a known total: the total stays a number and the gap is counted beside it, once.
 */

import { type ReactNode, useEffect, useMemo, useState } from 'react';

import { daemonId as toDaemonId } from '../../lib/daemon-connection.ts';
import { daemonSessionPath } from '../../lib/pages/routes.ts';
import { useOptionalRouter } from '../../lib/router.tsx';
import { RouteLink } from '../../shell/route-link.tsx';
import { Segmented } from '../fleet/conversations/conversation-picker.tsx';
import { MetricSplit } from './analytics-cost-rows.tsx';
import type { AnalyticsRequest } from './analytics-custom-query.tsx';
import { type AnalyticsMachine, type MachineOutcome, machinesSummary, readEveryMachine } from './analytics-fanout.ts';
import { AnalyticsMetricChart, type MetricChartPoint, type MetricChartSeries } from './analytics-metric-chart.tsx';
import {
  ANALYTICS_BUCKETINGS,
  ANALYTICS_RANGES,
  type AnalyticsBucketing,
  type AnalyticsOverview,
  type AnalyticsRange,
  analyticsOverview,
  analyticsRangeDays,
  DEFAULT_ANALYTICS_RANGE,
  durationAxisTicks,
  formatAxisDuration,
  formatAxisUsd,
  formatCount,
  formatDay,
  formatDuration,
  formatMetric,
  formatTokens,
  formatUsd,
  formatWeek,
  metricReading,
  OVERVIEW_METRICS,
  OVERVIEW_SPLITS,
  type OverviewBucket,
  type OverviewMetric,
  type OverviewSplit,
  type OverviewTopSession,
  overviewGroups,
  overviewWeeks,
  rankTopSessions,
  TOKEN_KIND_LABELS,
  TOKEN_KINDS,
  TOP_SESSION_ORDERS,
  type TopSessionOrder,
  tokenTotal,
  topSessionValue,
} from './analytics-overview.ts';
import { type MachineWindowRead, readMachineWindow } from './analytics-overview-load.ts';

/** How many sessions the overview lists before "See all". */
export const TOP_SESSIONS_SHOWN = 5;

const METRIC_LABELS: Readonly<Record<OverviewMetric, string>> = {
  cost: 'Cost',
  tokens: 'Tokens',
  turns: 'Turns',
  active: 'Active time',
};

const METRIC_TITLES: Readonly<Record<OverviewMetric, string>> = {
  cost: 'Equivalent API cost',
  tokens: 'Tokens',
  turns: 'Turns',
  active: 'Active time',
};

/** What a session with no figure for the metric is called. */
const UNKNOWN_WORDS: Readonly<Record<OverviewMetric, string>> = {
  cost: 'unpriced',
  tokens: 'not counted',
  turns: 'not counted',
  active: 'not timed',
};

const SPLIT_TITLES: Readonly<Record<OverviewSplit, string>> = {
  model: 'By model',
  runtime: 'By runtime',
  machine: 'By machine',
  project: 'By project',
};

const ORDER_LABELS: Readonly<Record<TopSessionOrder, string>> = {
  tokens: 'Tokens',
  duration: 'Duration',
  cost: 'Cost',
};

const ORDER_UNKNOWN: Readonly<Record<TopSessionOrder, string>> = {
  tokens: 'not counted',
  duration: 'not timed',
  cost: 'unpriced',
};

const TOKEN_SERIES: readonly MetricChartSeries[] = TOKEN_KINDS.map((kind, index) => ({
  key: kind,
  label: TOKEN_KIND_LABELS[kind],
  tone: (['accent', 'ok', 'pend', 'info'] as const)[index]!,
}));

const plural = (count: number, word: string): string => `${formatCount(count)} ${word}${count === 1 ? '' : 's'}`;

const unknownCount = (bucket: OverviewBucket, metric: OverviewMetric): number =>
  metricReading(bucket.totals, metric).unknown;

/** The chart's points for one measure: a value per bucket, stacked by token kind for tokens. */
export const overviewChartPoints = (
  buckets: readonly OverviewBucket[],
  metric: OverviewMetric,
  bucketing: AnalyticsBucketing,
): readonly MetricChartPoint[] =>
  buckets.map(bucket => {
    const unknown = unknownCount(bucket, metric);
    const label = bucketing === 'day' ? formatDay(bucket.key) : formatWeek(bucket.key);
    const values =
      metric === 'tokens'
        ? TOKEN_KINDS.map(kind => bucket.totals.tokens[kind])
        : [metricReading(bucket.totals, metric).value];
    const total = values.reduce((sum, value) => sum + value, 0);
    return {
      key: bucket.key,
      label,
      values,
      flagged: unknown > 0 || bucket.partial,
      empty: bucket.countedSessions === 0,
      readout: [
        label,
        formatMetric(metric, total),
        plural(bucket.countedSessions, 'session'),
        ...(unknown > 0 ? [`${unknown} ${UNKNOWN_WORDS[metric]}`] : []),
        ...(bucket.partial ? ['only partly listed'] : []),
      ].join(' · '),
    };
  });

type MachineReads = readonly MachineOutcome<MachineWindowRead>[];

export interface AnalyticsOverviewPageProps {
  readonly machines: readonly AnalyticsMachine[];
  readonly requestAnalytics: AnalyticsRequest;
  readonly now: () => Date;
}

export function AnalyticsOverviewPage({ machines, requestAnalytics, now }: AnalyticsOverviewPageProps) {
  const [range, setRange] = useState<AnalyticsRange>(DEFAULT_ANALYTICS_RANGE);
  const [bucketing, setBucketing] = useState<AnalyticsBucketing>('day');
  const [reads, setReads] = useState<MachineReads>([]);
  const [clock] = useState(now);
  const days = useMemo(() => analyticsRangeDays(range, clock), [clock, range]);

  useEffect(() => {
    let current = true;
    setReads([]);
    void readEveryMachine(
      machines,
      connection => {
        const machine = machines.find(candidate => candidate.connection === connection)!;
        return readMachineWindow(query => requestAnalytics(connection, query), days, {
          daemonId: connection.daemonId,
          name: machine.name,
        });
      },
      outcome => {
        if (current) setReads(previous => [...previous, outcome]);
      },
    );
    return () => {
      current = false;
    };
  }, [days, machines, requestAnalytics]);

  const answered = useMemo(
    () => reads.flatMap(outcome => (outcome.status === 'answered' ? [outcome.value] : [])),
    [reads],
  );
  const failed = reads.flatMap(outcome => (outcome.status === 'failed' ? [outcome] : []));
  const overview = useMemo(
    () =>
      analyticsOverview(
        days,
        answered.flatMap(read => read.rows),
        answered.flatMap(read => read.partial),
      ),
    [answered, days],
  );
  const pending = machines.length - reads.length;
  const summary = machinesSummary(reads, machines.length);

  return (
    <div className="grid min-w-0 gap-5" data-analytics-overview="">
      <div className="flex flex-wrap items-center justify-between gap-x-md gap-y-sm">
        <p className="m-0 min-w-0 text-meta text-muted" data-analytics-status="">
          Last {range} days{summary === null ? ' · this machine' : ` · ${summary}`}
          {pending > 0 && reads.length > 0 ? ` · waiting for ${plural(pending, 'machine')}` : ''}
        </p>
        <div className="flex flex-wrap items-center gap-sm">
          <div className="w-36">
            <Segmented<`${AnalyticsRange}`>
              label="Period"
              name="analytics-range"
              options={ANALYTICS_RANGES.map(option => ({ id: `${option}`, label: `${option}d` }))}
              value={`${range}`}
              onChoose={next => setRange(Number(next) as AnalyticsRange)}
            />
          </div>
          <div className="w-32">
            <Segmented<AnalyticsBucketing>
              label="Bucket"
              name="analytics-bucketing"
              options={ANALYTICS_BUCKETINGS.map(option => ({ id: option, label: option === 'day' ? 'Day' : 'Week' }))}
              value={bucketing}
              onChoose={setBucketing}
            />
          </div>
        </div>
      </div>

      {failed.length > 0 && (
        <ul role="status" className="m-0 grid list-none gap-xs p-0 text-meta text-warn" data-analytics-failed="">
          {failed.map(outcome => (
            <li key={outcome.machine.connection.daemonId}>
              {outcome.machine.name} did not answer: {outcome.error} Its sessions are not included.
            </li>
          ))}
        </ul>
      )}

      <div aria-live="polite" aria-busy={pending > 0} className="grid min-w-0 gap-5">
        {reads.length === 0 ? (
          <p role="status" className="m-0 py-6 text-cell text-muted">
            Reading this period's sessions…
          </p>
        ) : answered.length === 0 ? (
          <p
            role="alert"
            className="m-0 rounded-control border border-err-border bg-err-bg px-3 py-2 text-cell text-err"
          >
            No machine answered, so there is nothing to show. Nothing was assumed to be zero.
          </p>
        ) : (
          <OverviewSections overview={overview} bucketing={bucketing} machines={machines.length} />
        )}
      </div>
    </div>
  );
}

function Figure({
  label,
  value,
  note,
  warn = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly note: ReactNode;
  readonly warn?: boolean;
}) {
  return (
    <div className="grid h-full min-w-0 content-start gap-xs bg-surface px-md py-sm" data-analytics-figure={label}>
      <span className="text-meta text-muted">{label}</span>
      <span className="mono text-title font-semibold leading-tight tabular-nums text-fg">{value}</span>
      <span className={`text-2xs ${warn ? 'text-warn' : 'text-muted'}`}>{note}</span>
    </div>
  );
}

function Figures({ overview }: { readonly overview: AnalyticsOverview }) {
  const { totals } = overview;
  const tokens = tokenTotal(totals.tokens);
  const input = totals.tokens.input + totals.tokens.cacheRead + totals.tokens.cacheWrite;
  const activeSessions = totals.sessions - totals.activeUnknown;
  const wallSessions = totals.sessions - totals.wallUnknown;
  const busiest = overview.days.reduce<OverviewBucket | null>(
    (best, bucket) =>
      bucket.countedSessions > 0 && (best === null || bucket.countedSessions > best.countedSessions) ? bucket : best,
    null,
  );
  const allUnpriced = totals.sessions > 0 && totals.unpriced === totals.sessions;
  return (
    <>
      <section
        aria-label="Summary"
        className="grid grid-cols-2 gap-px overflow-hidden rounded-panel border border-border bg-border lg:grid-cols-4"
      >
        <Figure
          label="Equivalent API cost"
          value={allUnpriced ? 'Unpriced' : formatUsd(totals.costMicros)}
          warn={totals.unpriced > 0}
          note={
            totals.unpriced > 0
              ? `${totals.unpriced} of ${plural(totals.sessions, 'session')} unpriced, not included`
              : 'At API rates; not what a plan bills'
          }
        />
        <Figure
          label="Tokens"
          value={formatTokens(tokens)}
          note={
            [
              ...(input > 0 ? [`${Math.round((100 * totals.tokens.cacheRead) / input)}% of input from cache`] : []),
              ...(totals.tokensUnknown > 0 ? [`${totals.tokensUnknown} not counted`] : []),
            ].join(' · ') || 'Input and output'
          }
        />
        <Figure
          label="Turns"
          value={formatCount(totals.turns)}
          note={totals.sessions > 0 ? `${(totals.turns / totals.sessions).toFixed(1)} per session` : 'No sessions'}
        />
        <Figure
          label="Active time"
          value={formatDuration(totals.activeMs / 1000)}
          warn={totals.activeUnknown > 0 && activeSessions === 0}
          note={
            activeSessions === 0
              ? totals.sessions === 0
                ? 'No sessions'
                : 'Not recorded for these sessions'
              : [
                  `${formatDuration(totals.activeMs / 1000 / activeSessions)} / session`,
                  ...(totals.activeTurns > 0
                    ? [`${formatDuration(totals.activeMs / 1000 / totals.activeTurns)} / turn`]
                    : []),
                ].join(' · ')
          }
        />
      </section>
      <dl className="m-0 flex flex-wrap gap-x-md gap-y-xs text-meta text-muted" data-analytics-secondary="">
        <div className="flex gap-xs">
          <dt>Sessions</dt>
          <dd className="m-0 tabular-nums text-fg">{formatCount(totals.sessions)}</dd>
        </div>
        <div className="flex gap-xs">
          <dt>Wall time</dt>
          <dd className="m-0 tabular-nums text-fg">
            {wallSessions === 0 ? '—' : formatDuration(totals.wallMs / 1000)}
            {wallSessions > 0 && (
              <span className="text-muted"> · {formatDuration(totals.wallMs / 1000 / wallSessions)} / session</span>
            )}
          </dd>
        </div>
        {busiest && (
          <div className="flex gap-xs">
            <dt>Busiest day</dt>
            <dd className="m-0 tabular-nums text-fg">
              {formatDay(busiest.key)} · {plural(busiest.countedSessions, 'session')}
            </dd>
          </div>
        )}
      </dl>
    </>
  );
}

function OverviewSections({
  overview,
  bucketing,
  machines,
}: {
  readonly overview: AnalyticsOverview;
  readonly bucketing: AnalyticsBucketing;
  readonly machines: number;
}) {
  const [metric, setMetric] = useState<OverviewMetric>('cost');
  const buckets = bucketing === 'day' ? overview.days : overviewWeeks(overview.days, overview.rows);
  const points = overviewChartPoints(buckets, metric, bucketing);
  return (
    <>
      <Figures overview={overview} />

      {overview.partialDays > 0 && (
        <p role="status" className="m-0 text-meta text-warn">
          {overview.partialDays} busy day{overview.partialDays === 1 ? ' was' : 's were'} only partly listed, so the
          figures for {overview.partialDays === 1 ? 'it are' : 'them are'} a lower bound.
        </p>
      )}

      <section aria-label="Over time" className="kt-panel grid min-w-0 gap-sm px-md py-md">
        <div className="sm:w-fit sm:min-w-[24rem]">
          <Segmented<OverviewMetric>
            fit
            label="Measure"
            name="analytics-metric"
            options={OVERVIEW_METRICS.map(option => ({ id: option, label: METRIC_LABELS[option] }))}
            value={metric}
            onChoose={setMetric}
          />
        </div>
        <AnalyticsMetricChart
          title={`${METRIC_TITLES[metric]} per ${bucketing}`}
          series={metric === 'tokens' ? TOKEN_SERIES : [{ key: metric, label: METRIC_TITLES[metric], tone: 'accent' }]}
          points={points}
          format={value => formatMetric(metric, value)}
          formatAxis={
            metric === 'cost' ? formatAxisUsd : metric === 'active' ? formatAxisDuration : value => formatTokens(value)
          }
          {...(metric === 'active' ? { axisTicks: durationAxisTicks } : {})}
          flagNote={`has ${UNKNOWN_WORDS[metric]} sessions`}
          emptyText="Nothing in this period."
        />
      </section>

      <div className="grid min-w-0 gap-5 lg:grid-cols-2">
        {OVERVIEW_SPLITS.map(split => (
          <section
            key={split}
            aria-labelledby={`analytics-split-${split}`}
            className="kt-panel grid min-w-0 content-start gap-sm px-md py-md"
            data-analytics-split={split}
          >
            <h3 id={`analytics-split-${split}`} className="m-0 flex items-baseline justify-between gap-md text-cell">
              <span className="font-semibold text-fg">{SPLIT_TITLES[split]}</span>
              <span className="text-meta font-normal text-muted">{METRIC_TITLES[metric]}</span>
            </h3>
            <MetricSplit
              label={`${METRIC_TITLES[metric]} ${SPLIT_TITLES[split].toLowerCase()}`}
              rows={overviewGroups(overview.rows, split, metric).map(group => {
                const reading = metricReading(group.totals, metric);
                return {
                  key: group.key,
                  value: reading.value,
                  unknown: reading.unknown,
                  sessions: group.totals.sessions,
                };
              })}
              format={value => formatMetric(metric, value)}
              unknownWord={UNKNOWN_WORDS[metric]}
              limit={5}
            />
          </section>
        ))}
      </div>

      <TopSessions sessions={overview.topSessions} machines={machines} />
    </>
  );
}

const ORDER_FORMAT: Readonly<Record<TopSessionOrder, (value: number) => string>> = {
  tokens: formatTokens,
  duration: formatDuration,
  cost: value => formatUsd(Math.round(value * 1_000_000)),
};

const orderUnknown = (session: OverviewTopSession, order: TopSessionOrder): number =>
  order === 'tokens'
    ? session.totals.tokensUnknown
    : order === 'duration'
      ? session.totals.activeUnknown
      : session.totals.unpriced;

function TopSessions({
  sessions,
  machines,
}: {
  readonly sessions: readonly OverviewTopSession[];
  readonly machines: number;
}) {
  const [order, setOrder] = useState<TopSessionOrder>('tokens');
  const [all, setAll] = useState(false);
  const ranked = rankTopSessions(sessions, order);
  const shown = all ? ranked : ranked.slice(0, TOP_SESSIONS_SHOWN);
  return (
    <section
      aria-labelledby="analytics-top-sessions"
      className="kt-panel grid min-w-0 content-start gap-sm px-md py-md"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-md gap-y-sm">
        <h3 id="analytics-top-sessions" className="m-0 text-cell font-semibold text-fg">
          Top sessions
        </h3>
        <div className="w-60">
          <Segmented<TopSessionOrder>
            label="Rank sessions by"
            name="analytics-top-order"
            options={TOP_SESSION_ORDERS.map(option => ({ id: option, label: ORDER_LABELS[option] }))}
            value={order}
            onChoose={setOrder}
          />
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="m-0 text-cell text-muted">No sessions in this period.</p>
      ) : (
        <ul aria-label={`Sessions by ${ORDER_LABELS[order].toLowerCase()}`} className="m-0 grid list-none gap-0 p-0">
          {shown.map(session => (
            <TopSessionRow
              key={`${session.daemonId}\n${session.id}`}
              session={session}
              order={order}
              showMachine={machines > 1}
            />
          ))}
        </ul>
      )}
      {ranked.length > TOP_SESSIONS_SHOWN && (
        <button
          type="button"
          className="min-h-[44px] justify-self-start text-meta text-accent hover:underline"
          aria-expanded={all}
          onClick={() => setAll(current => !current)}
        >
          {all ? 'Show fewer' : `See all ${ranked.length}`}
        </button>
      )}
    </section>
  );
}

function TopSessionRow({
  session,
  order,
  showMachine,
}: {
  readonly session: OverviewTopSession;
  readonly order: TopSessionOrder;
  readonly showMachine: boolean;
}) {
  const router = useOptionalRouter();
  const value = topSessionValue(session, order);
  const unknown = orderUnknown(session, order);
  const meta = [
    session.runtime,
    session.project,
    ...(showMachine ? [session.machine] : []),
    session.model,
    ...(session.children > 0 ? [`+${session.children} child${session.children === 1 ? '' : 'ren'}`] : []),
  ].filter((part): part is string => part !== null);
  return (
    <li className="border-t border-border-soft first:border-t-0">
      <RouteLink
        to={daemonSessionPath(toDaemonId(session.daemonId), session.id)}
        {...(router ? { onNavigate: router.navigate } : {})}
        className="grid min-h-[44px] grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-md gap-y-xs py-sm text-cell hover:bg-surface-2"
        data-top-session={session.id}
      >
        <span className="min-w-0 truncate font-semibold text-fg">{session.label ?? session.id}</span>
        <span
          className={`mono whitespace-nowrap text-right font-semibold tabular-nums ${value === null ? 'text-warn' : 'text-fg'}`}
          title={
            unknown > 0
              ? `${unknown} of ${plural(session.totals.sessions, 'session')} ${ORDER_UNKNOWN[order]}`
              : undefined
          }
        >
          {value === null ? ORDER_UNKNOWN[order] : `${unknown > 0 ? '≥ ' : ''}${ORDER_FORMAT[order](value)}`}
        </span>
        <span className="col-span-2 min-w-0 truncate text-2xs text-muted">{meta.join(' · ')}</span>
      </RouteLink>
    </li>
  );
}
