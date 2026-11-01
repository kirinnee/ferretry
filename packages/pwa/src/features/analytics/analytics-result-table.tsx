/**
 * The analytics ledger is intentionally a table, not a dashboard: a reader can
 * sort exact daemon-supplied aggregates without losing unknown prices or making
 * the surrounding pane scroll sideways on a phone.
 */

import {
  ANALYTICS_METRIC_MEASURES,
  ANALYTICS_RATIO_METRICS,
  type AnalyticsAggregateResult,
  type AnalyticsMeasure,
  type AnalyticsMetric,
  type AnalyticsResponse,
  analyticsMetricValue,
} from '@ferretry/protocol';
import { ArrowDown, ArrowDownUp, ArrowUp } from 'lucide-react';
import { useMemo, useState } from 'react';
import { cn } from '../../lib/class-names.ts';
import {
  type AnalyticsCostGaps,
  costGapEntries,
  costGapReason,
  sumCostGaps,
  unpricedLabel,
} from './analytics-cost-gaps.ts';
import { formatDollars } from './analytics-overview.ts';

export type AnalyticsSortKey =
  | 'group'
  | 'sessions'
  | 'input'
  | 'output'
  | 'cacheRead'
  | 'cacheWrite'
  | 'total'
  | 'cost'
  | 'costNow'
  | 'metric';
export type AnalyticsSortDirection = 'asc' | 'desc';
export type AnalyticsAggregateResponse = Extract<AnalyticsResponse, { readonly kind: 'aggregate' }>;

export interface AnalyticsTableRow {
  readonly key: string;
  readonly group: string;
  readonly sessions: number;
  readonly input: AnalyticsMeasure;
  readonly output: AnalyticsMeasure;
  readonly cacheRead: AnalyticsMeasure;
  readonly cacheWrite: AnalyticsMeasure;
  readonly total: AnalyticsMeasure;
  /** What the tokens cost at the rate in force on each session's day. */
  readonly cost: AnalyticsMeasure;
  /** The same tokens at the catalog rate as of today. */
  readonly costNow: AnalyticsMeasure;
  /** `costNow` in dollars, for a spend query that prints dollars and cents. */
  readonly costNowDollars: AnalyticsMeasure;
  /** Why some sessions have no cost, counted by reason; absent when every session has one. */
  readonly costGaps?: AnalyticsCostGaps | undefined;
  /** The selected metric in its own unit (dollars, seconds, a count); unknown when none is selected. */
  readonly metric: AnalyticsMeasure;
}

interface Column {
  readonly key: AnalyticsSortKey;
  readonly header: string;
  readonly hint?: string;
  readonly numeric: boolean;
}

export const ANALYTICS_TABLE_COLUMNS: readonly Column[] = [
  { key: 'group', header: 'Group', numeric: false },
  { key: 'sessions', header: 'Sessions', numeric: true },
  { key: 'input', header: 'Input', hint: 'gross input, including cache reads and writes', numeric: true },
  { key: 'output', header: 'Output', numeric: true },
  { key: 'cacheRead', header: 'Cache read', numeric: true },
  { key: 'cacheWrite', header: 'Cache write', numeric: true },
  { key: 'total', header: 'Total', numeric: true },
  {
    key: 'cost',
    header: 'Equivalent API cost',
    hint: 'what these tokens would cost at API rates, at the rate in force the day each session ran; never billed spend',
    numeric: true,
  },
  {
    key: 'costNow',
    header: "At today's prices",
    hint: 'the same tokens at the API rates in the catalog today; never billed spend',
    numeric: true,
  },
];

const UNKNOWN_MEASURE: AnalyticsMeasure = { value: null, known: 0, total: 0 };
const NUMBER_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

/** A row is named by its values; the column header names the labels, so `day=` is said once. */
const groupName = (result: AnalyticsAggregateResult): string =>
  Object.values(result.labels)
    .map(value => value ?? 'unknown')
    .join(' · ') || 'All sessions';

const LABEL_NAMES: Readonly<Record<string, string>> = { pricing_model: 'pricing model', token_data: 'token data' };

/** The group column header: the labels the rows are grouped by, in words. */
export const analyticsGroupHeader = (response: AnalyticsAggregateResponse): string => {
  const labels = Object.keys(response.results[0]?.labels ?? {});
  if (labels.length === 0) return 'Group';
  const words = labels.map(label => LABEL_NAMES[label] ?? label).join(' · ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const TIME_LABELS: ReadonlySet<string> = new Set(['day', 'week']);

/** What each metric is called as a column header; a mapped type, so a new metric cannot be missed. */
export const ANALYTICS_METRIC_LABELS: { readonly [M in AnalyticsMetric]: string } = {
  tokens: 'Tokens',
  tokens_input: 'Input tokens',
  tokens_output: 'Output tokens',
  tokens_cache_read: 'Cache read tokens',
  tokens_cache_write: 'Cache write tokens',
  tokens_reasoning: 'Reasoning tokens',
  cost_usd: 'Equivalent API cost',
  cost_now_usd: "At today's prices",
  turns: 'Turns',
  sessions: 'Sessions',
  duration_active_seconds: 'Active time',
  duration_wall_seconds: 'Wall time',
  duration_active_seconds_per_turn: 'Active time per turn',
};

/** One group's value for a metric, in the metric's unit, with how many sessions it is known for. */
export const analyticsMetricMeasure = (result: AnalyticsAggregateResult, metric: AnalyticsMetric): AnalyticsMeasure => {
  const { measure } = ANALYTICS_METRIC_MEASURES[metric];
  if (measure === 'sessions') return { value: result.sessions, known: result.sessions, total: result.sessions };
  // The protocol owns the arithmetic: the unit scale, and the division of a per-turn ratio.
  // A daemon older than the today-price figure sends no measure for it: unknown, never zero.
  const { knownSum, ...stated } = (result[measure] as AnalyticsMeasure | undefined) ?? UNKNOWN_MEASURE;
  const value = analyticsMetricValue(result, metric);
  // A lower bound is a sum, so it scales like one; a ratio of sums has no lower bound.
  if (knownSum === undefined || value !== null || ANALYTICS_RATIO_METRICS.has(metric)) return { ...stated, value };
  return { ...stated, value, knownSum: knownSum * ANALYTICS_METRIC_MEASURES[metric].scale };
};

/** Flattens a daemon response without inventing a value for missing pricing. */
export const analyticsTableRows = (
  response: AnalyticsAggregateResponse,
  metric?: AnalyticsMetric,
): AnalyticsTableRow[] =>
  response.results.map((result, index) => ({
    key: `${index}:${groupName(result)}`,
    group: groupName(result),
    sessions: result.sessions,
    input: result.inputTokens,
    output: result.outputTokens,
    cacheRead: result.cachedInputTokens,
    cacheWrite: result.cacheWriteInputTokens,
    total: result.tokens,
    cost: result.equivalentApiCostUsdMicros,
    costNow: result.equivalentApiCostCurrentUsdMicros ?? UNKNOWN_MEASURE,
    costNowDollars: analyticsMetricMeasure(result, 'cost_now_usd'),
    costGaps: result.costGaps,
    metric: metric ? analyticsMetricMeasure(result, metric) : UNKNOWN_MEASURE,
  }));

const measureFor = (row: AnalyticsTableRow, key: AnalyticsSortKey): AnalyticsMeasure | undefined =>
  key === 'group' || key === 'sessions' ? undefined : row[key];

/** What a group is known to be worth: its value, or the part of it that sessions did state. */
const sortableValue = (measure: AnalyticsMeasure | undefined): number | null =>
  measure?.value ?? measure?.knownSum ?? null;

/** Unknown numeric values remain last in either order; they are never zero. */
export const sortAnalyticsRows = (
  rows: readonly AnalyticsTableRow[],
  key: AnalyticsSortKey,
  direction: AnalyticsSortDirection,
): AnalyticsTableRow[] => {
  const sign = direction === 'desc' ? -1 : 1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      if (key === 'group') return sign * left.row.group.localeCompare(right.row.group) || left.index - right.index;
      const a = key === 'sessions' ? left.row.sessions : sortableValue(measureFor(left.row, key));
      const b = key === 'sessions' ? right.row.sessions : sortableValue(measureFor(right.row, key));
      if (a === null && b === null) return left.index - right.index;
      if (a === null) return 1;
      if (b === null) return -1;
      return sign * (a - b) || left.index - right.index;
    })
    .map(item => item.row);
};

/**
 * Adds what every group states: its value, or for an incomplete group the part its stated sessions
 * add up to. `known < total` says the sum is short, and the renderer prints it as a lower bound
 * ("≥ $614.80") instead of letting one unpriced session erase it.
 */
const sumMeasures = (measures: readonly AnalyticsMeasure[]): AnalyticsMeasure => ({
  value: measures.some(measure => sortableValue(measure) !== null)
    ? measures.reduce((sum, measure) => sum + (sortableValue(measure) ?? 0), 0)
    : null,
  known: measures.reduce((sum, measure) => sum + measure.known, 0),
  total: measures.reduce((sum, measure) => sum + measure.total, 0),
});

/** The roll-up: complete groups summed, incomplete ones left out and counted. */
export const analyticsTotalRow = (rows: readonly AnalyticsTableRow[]): AnalyticsTableRow => ({
  key: 'total',
  group: 'Total',
  sessions: rows.reduce((sum, row) => sum + row.sessions, 0),
  input: sumMeasures(rows.map(row => row.input)),
  output: sumMeasures(rows.map(row => row.output)),
  cacheRead: sumMeasures(rows.map(row => row.cacheRead)),
  cacheWrite: sumMeasures(rows.map(row => row.cacheWrite)),
  total: sumMeasures(rows.map(row => row.total)),
  cost: sumMeasures(rows.map(row => row.cost)),
  costNow: sumMeasures(rows.map(row => row.costNow)),
  costNowDollars: sumMeasures(rows.map(row => row.costNowDollars)),
  costGaps: sumCostGaps(rows.map(row => row.costGaps)),
  metric: sumMeasures(rows.map(row => row.metric)),
});

const lowerBound = (measure: AnalyticsMeasure): string => (measure.known < measure.total ? '≥ ' : '');

/** The figure to print: the group's value, or the lower bound its stated sessions add up to. */
const shownValue = (measure: AnalyticsMeasure | undefined): number | null => sortableValue(measure);

export const formatTokenMeasure = (measure: AnalyticsMeasure | undefined): string => {
  const value = shownValue(measure);
  return value === null || measure === undefined ? '—' : `${lowerBound(measure)}${NUMBER_FORMAT.format(value)}`;
};

/** Whole dollars and fractional micros are formatted without a floating dollar value. */
export const formatUsdMicros = (value: bigint): string => {
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  const whole = absolute / 1_000_000n;
  const fraction = (absolute % 1_000_000n).toString().padStart(6, '0').replace(/0+$/u, '').padEnd(2, '0');
  return `${sign}$${whole.toLocaleString('en-US')}.${fraction}`;
};

export const formatEquivalentCost = (measure: AnalyticsMeasure | undefined): string => {
  const value = shownValue(measure);
  return value === null || measure === undefined
    ? 'Unpriced'
    : `${lowerBound(measure)}${formatUsdMicros(BigInt(Math.round(value)))}`;
};

export const coverageNote = (measure: AnalyticsMeasure | undefined): string | undefined => {
  const resolved = measure ?? UNKNOWN_MEASURE;
  return resolved.known < resolved.total ? `${resolved.known}/${resolved.total}` : undefined;
};

const isCostMetric = (metric: AnalyticsMetric | undefined): boolean =>
  metric === 'cost_usd' || metric === 'cost_now_usd';

const METRIC_COLUMN: Column = { key: 'metric', header: 'Value', numeric: true };

/** The metric answers the question, so it is the first value column; without one, the whole ledger. */
export const analyticsColumnsFor = (
  aggregation: AnalyticsAggregateResponse['aggregation'],
  metric?: AnalyticsMetric,
): readonly Column[] => {
  if (aggregation === 'count')
    return ANALYTICS_TABLE_COLUMNS.filter(column => column.key === 'group' || column.key === 'sessions');
  if (metric === undefined) return ANALYTICS_TABLE_COLUMNS;
  const named = { ...METRIC_COLUMN, header: ANALYTICS_METRIC_LABELS[metric] };
  // Spend always reads with both prices and the tokens behind it, so the two costs sit side by side.
  if (metric === 'cost_usd')
    return [
      ANALYTICS_TABLE_COLUMNS[0]!,
      named,
      ANALYTICS_TABLE_COLUMNS.find(column => column.key === 'costNow')!,
      { ...ANALYTICS_TABLE_COLUMNS.find(column => column.key === 'total')!, header: 'Tokens' },
      ANALYTICS_TABLE_COLUMNS[1]!,
    ];
  return [ANALYTICS_TABLE_COLUMNS[0]!, named, ANALYTICS_TABLE_COLUMNS[1]!];
};

/**
 * A ledger over time reads in time order; any other grouping reads biggest first — sessions for a
 * count, cost for everything else.
 */
export const defaultAnalyticsSort = (
  response: AnalyticsAggregateResponse,
  metric?: AnalyticsMetric,
): { readonly key: AnalyticsSortKey; readonly direction: AnalyticsSortDirection } => {
  const labels = Object.keys(response.results[0]?.labels ?? {});
  if (labels.length > 0 && labels.every(label => TIME_LABELS.has(label))) return { key: 'group', direction: 'asc' };
  if (response.aggregation === 'count') return { key: 'sessions', direction: 'desc' };
  return { key: metric === undefined ? 'cost' : 'metric', direction: 'desc' };
};

const nextDirection = (column: AnalyticsSortKey, current: AnalyticsSortKey, direction: AnalyticsSortDirection) =>
  column !== current ? (column === 'group' ? 'asc' : 'desc') : direction === 'desc' ? 'asc' : 'desc';

const DURATION_UNITS: readonly (readonly [string, number])[] = [
  ['h', 3600],
  ['m', 60],
  ['s', 1],
];

/** Seconds as the two largest non-zero units: 4h 05m, 12m 08s, 38s. */
export const formatDurationSeconds = (seconds: number): string => {
  let rest = Math.round(seconds);
  if (rest <= 0) return '0s';
  const parts: string[] = [];
  for (const [unit, size] of DURATION_UNITS) {
    const count = Math.floor(rest / size);
    rest -= count * size;
    if (count > 0 || parts.length > 0)
      parts.push(`${parts.length > 0 ? String(count).padStart(2, '0') : count}${unit}`);
  }
  return parts.slice(0, 2).join(' ');
};

/** A metric's value in its own unit; the gap is worded per metric, never a zero. */
export const formatMetricMeasure = (metric: AnalyticsMetric, measure: AnalyticsMeasure): string => {
  const isCost = metric === 'cost_usd' || metric === 'cost_now_usd';
  const value = shownValue(measure);
  if (value === null) return isCost ? 'Unpriced' : 'Unknown';
  const bound = lowerBound(measure);
  // The metric column is read, not audited: to the cent, as every other cost on the page.
  if (isCost) return `${bound}${formatDollars(value)}`;
  if (metric.startsWith('duration_')) return `${bound}${formatDurationSeconds(value)}`;
  return `${bound}${NUMBER_FORMAT.format(value)}`;
};

/** The gap said in words: "priced 3 of 5". Present only when some sessions are missing. */
export const metricCoverageNote = (metric: AnalyticsMetric, measure: AnalyticsMeasure): string | undefined =>
  measure.known < measure.total
    ? `${isCostMetric(metric) ? 'priced' : 'known'} ${measure.known} of ${measure.total}`
    : undefined;

function MetricCell({
  metric,
  measure,
  gaps,
}: {
  readonly metric: AnalyticsMetric;
  readonly measure: AnalyticsMeasure;
  readonly gaps?: AnalyticsCostGaps | undefined;
}) {
  const note = gaps ? undefined : metricCoverageNote(metric, measure);
  return (
    <td className="whitespace-nowrap px-cell-x py-row-y text-right font-mono tabular-nums text-fg">
      <span className={shownValue(measure) === null ? 'text-muted' : 'font-semibold'}>
        {formatMetricMeasure(metric, measure)}
      </span>
      {note && <span className="ml-1 text-2xs text-faint">{note}</span>}
      <UnpricedReasons gaps={gaps} />
    </td>
  );
}

/** "10 unpriced", openable: the reasons the sessions have no cost, biggest first. Never guessed. */
function UnpricedReasons({
  gaps,
  className,
}: {
  readonly gaps: AnalyticsCostGaps | undefined;
  readonly className?: string;
}) {
  const label = unpricedLabel(gaps);
  if (label === undefined || gaps === undefined) return null;
  return (
    <details className={cn('text-2xs text-faint', className)} data-analytics-unpriced="">
      <summary className="cursor-pointer select-none">{label}</summary>
      <ul className="m-0 list-none p-0">
        {costGapEntries(gaps).map(([reason, count]) => (
          <li key={reason}>
            {NUMBER_FORMAT.format(count)} · {costGapReason(reason)}
          </li>
        ))}
      </ul>
    </details>
  );
}

function MeasureCell({
  measure,
  cost = false,
  gaps,
}: {
  readonly measure: AnalyticsMeasure;
  readonly cost?: boolean;
  readonly gaps?: AnalyticsCostGaps | undefined;
}) {
  const coverage = coverageNote(measure);
  return (
    <td className="whitespace-nowrap px-cell-x py-row-y text-right font-mono tabular-nums text-fg">
      <span className={cost && shownValue(measure) !== null ? 'font-semibold' : undefined}>
        {cost ? formatEquivalentCost(measure) : formatTokenMeasure(measure)}
      </span>
      {coverage && !gaps && (
        <span className="ml-1 text-2xs text-faint" title={`counted for ${coverage} sessions`}>
          [{coverage}]
        </span>
      )}
      <UnpricedReasons gaps={gaps} />
    </td>
  );
}

function Row({
  row,
  columns,
  metric,
  emphasis = false,
}: {
  readonly row: AnalyticsTableRow;
  readonly columns: readonly Column[];
  readonly metric?: AnalyticsMetric;
  readonly emphasis?: boolean;
}) {
  return (
    <tr className={cn('kt-row', emphasis && 'border-t border-border font-semibold')}>
      {columns.map(column => {
        if (column.key === 'group')
          return (
            <th
              key={column.key}
              scope="row"
              className="sticky left-0 z-10 max-w-[16rem] truncate bg-surface px-cell-x py-row-y text-left font-normal text-fg"
              title={row.group}
            >
              {row.group}
            </th>
          );
        if (column.key === 'sessions')
          return (
            <td
              key={column.key}
              className="whitespace-nowrap px-cell-x py-row-y text-right font-mono tabular-nums text-muted"
            >
              {NUMBER_FORMAT.format(row.sessions)}
            </td>
          );
        if (column.key === 'costNow' && metric === 'cost_usd')
          return <MetricCell key={column.key} metric="cost_now_usd" measure={row.costNowDollars} gaps={row.costGaps} />;
        if (column.key === 'metric' && metric)
          return (
            <MetricCell
              key={column.key}
              metric={metric}
              measure={row.metric}
              gaps={isCostMetric(metric) ? row.costGaps : undefined}
            />
          );
        return (
          <MeasureCell
            key={column.key}
            measure={row[column.key]}
            cost={column.key === 'cost' || column.key === 'costNow'}
            gaps={column.key === 'cost' ? row.costGaps : undefined}
          />
        );
      })}
    </tr>
  );
}

/**
 * THE PHONE LEDGER: one row per group with the cost on the right, where the eight-column table would
 * have put it off screen. Sessions and total tokens go on the line under the group name.
 */
function AnalyticsResultList({
  rows,
  cost,
  metric,
}: {
  readonly rows: readonly AnalyticsTableRow[];
  readonly cost: boolean;
  readonly metric?: AnalyticsMetric;
}) {
  if (metric)
    return (
      <ul className="kt-panel m-0 grid list-none p-0 sm:hidden" data-analytics-result-list="">
        {rows.map(row => {
          const note = metricCoverageNote(metric, row.metric);
          return (
            <li
              key={row.key}
              className={cn(
                'grid grid-cols-[minmax(0,1fr)_auto] gap-x-md px-cell-x py-row-y text-cell',
                row.key === 'total'
                  ? 'border-t border-border font-semibold'
                  : 'border-t border-border-soft first:border-t-0',
              )}
            >
              <span className="min-w-0 break-words text-fg">{row.group}</span>
              <span className="mono text-right tabular-nums text-fg">{formatMetricMeasure(metric, row.metric)}</span>
              <span className="text-2xs text-muted">
                {NUMBER_FORMAT.format(row.sessions)} session{row.sessions === 1 ? '' : 's'}
                {metric === 'cost_usd' ? ` · ${formatTokenMeasure(row.total)} tokens` : ''}
              </span>
              {metric === 'cost_usd' && row.costNow.total > 0 ? (
                <span className="text-right text-2xs text-muted">
                  today{' '}
                  <span className="mono tabular-nums">{formatMetricMeasure('cost_now_usd', row.costNowDollars)}</span>
                </span>
              ) : (
                <span className="text-right text-2xs text-faint">
                  {isCostMetric(metric) && row.costGaps ? undefined : note}
                </span>
              )}
              {isCostMetric(metric) && <UnpricedReasons gaps={row.costGaps} className="col-span-2" />}
            </li>
          );
        })}
      </ul>
    );
  return (
    <ul className="kt-panel m-0 grid list-none p-0 sm:hidden" data-analytics-result-list="">
      {rows.map(row => {
        const coverage = coverageNote(row.cost);
        const showNow = cost && row.costNow.total > 0;
        return (
          <li
            key={row.key}
            className={cn(
              'grid grid-cols-[minmax(0,1fr)_auto] gap-x-md px-cell-x py-row-y text-cell',
              row.key === 'total'
                ? 'border-t border-border font-semibold'
                : 'border-t border-border-soft first:border-t-0',
            )}
          >
            <span className="min-w-0 break-words text-fg">{row.group}</span>
            {cost ? (
              <span className="mono text-right tabular-nums text-fg">{formatEquivalentCost(row.cost)}</span>
            ) : (
              <span />
            )}
            <span className="text-2xs text-muted">
              {NUMBER_FORMAT.format(row.sessions)} session{row.sessions === 1 ? '' : 's'}
              {cost ? ` · ${formatTokenMeasure(row.total)} tokens` : ''}
            </span>
            {showNow ? (
              <span className="text-right text-2xs text-muted">
                today <span className="mono tabular-nums">{formatEquivalentCost(row.costNow)}</span>
              </span>
            ) : cost && coverage && !row.costGaps ? (
              <span className="text-right text-2xs text-faint">priced for {coverage}</span>
            ) : (
              <span />
            )}
            {cost && <UnpricedReasons gaps={row.costGaps} className="col-span-2" />}
          </li>
        );
      })}
    </ul>
  );
}

export interface AnalyticsResultTableProps {
  readonly response: AnalyticsAggregateResponse;
  readonly caption?: string;
  /** The selected metric: its column comes first and carries the sort. */
  readonly metric?: AnalyticsMetric;
  /** The date "today's prices" are read at, as the page shows it; defaults to the current day. */
  readonly today?: string;
}

/** Says which rate each cost uses, so two figures for one thing are never a puzzle. */
function RateLegend({ today }: { readonly today: string }) {
  return (
    <p className="m-0 text-2xs text-muted" data-analytics-rate-legend="">
      <strong className="font-semibold">At the time</strong>: each session at the rate in force the day it ran.{' '}
      <strong className="font-semibold">At today's prices</strong> ({today}): the same tokens at the catalog rate now.
    </p>
  );
}

/** A responsive, sortable aggregate ledger from one daemon-bound response. */
export function AnalyticsResultTable({
  response,
  caption = 'Analytics aggregate result',
  metric,
  today = new Date().toISOString().slice(0, 10),
}: AnalyticsResultTableProps) {
  const [sort, setSort] = useState<{ key: AnalyticsSortKey; direction: AnalyticsSortDirection } | null>(null);
  const columns = analyticsColumnsFor(response.aggregation, metric);
  const shownMetric = columns.some(column => column.key === 'metric') ? metric : undefined;
  const activeSort =
    sort && columns.some(column => column.key === sort.key) ? sort : defaultAnalyticsSort(response, metric);
  const groupHeader = analyticsGroupHeader(response);
  const headerOf = (column: Column): string => (column.key === 'group' ? groupHeader : column.header);
  const rows = useMemo(() => analyticsTableRows(response, metric), [response, metric]);
  const sorted = useMemo(
    () => sortAnalyticsRows(rows, activeSort.key, activeSort.direction),
    [activeSort.direction, activeSort.key, rows],
  );
  // A ratio of sums does not add across groups, so a per-turn result has no total row.
  const total =
    response.aggregation === 'sum' && rows.length > 1 && !(metric !== undefined && ANALYTICS_RATIO_METRICS.has(metric))
      ? analyticsTotalRow(rows)
      : null;

  if (rows.length === 0)
    return (
      <p className="m-0 text-cell text-muted" role="status">
        No groups matched. Nothing was assumed to be zero.
      </p>
    );

  const showsCost = columns.some(column => column.key === 'cost') || isCostMetric(shownMetric);
  return (
    <div className="grid min-w-0 gap-2">
      {showsCost && <RateLegend today={today} />}
      <AnalyticsResultList
        rows={total ? [...sorted, total] : sorted}
        cost={columns.some(column => column.key === 'cost')}
        metric={shownMetric}
      />
      <div className="kt-panel hidden min-w-0 max-w-full overflow-x-auto overscroll-x-contain scroll-thin sm:block">
        <table className="w-full min-w-[44rem] border-collapse text-cell">
          <caption className="sr-only">
            {caption}. Sorted by {headerOf(columns.find(column => column.key === activeSort.key) ?? columns[0]!)}{' '}
            {activeSort.direction === 'desc' ? 'descending' : 'ascending'}.
          </caption>
          <thead>
            <tr>
              {columns.map(column => {
                const active = column.key === activeSort.key;
                const direction = nextDirection(column.key, activeSort.key, activeSort.direction);
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={active ? (activeSort.direction === 'desc' ? 'descending' : 'ascending') : 'none'}
                    className={cn(
                      'kt-label border-b border-border bg-surface-2 p-0',
                      column.key === 'group' && 'sticky left-0 z-20',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => setSort({ key: column.key, direction })}
                      title={column.hint}
                      aria-label={`${headerOf(column)}: sort ${direction === 'desc' ? 'descending' : 'ascending'}`}
                      className={cn(
                        'flex min-h-[44px] w-full items-center gap-1 whitespace-nowrap px-cell-x py-row-y',
                        column.numeric ? 'justify-end text-right' : 'justify-start text-left',
                        active ? 'text-accent' : 'text-muted hover:text-fg',
                      )}
                    >
                      {headerOf(column)}
                      {active ? (
                        activeSort.direction === 'desc' ? (
                          <ArrowDown size={12} aria-hidden="true" />
                        ) : (
                          <ArrowUp size={12} aria-hidden="true" />
                        )
                      ) : (
                        <ArrowDownUp size={12} className="opacity-50" aria-hidden="true" />
                      )}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.map(row => (
              <Row key={row.key} row={row} columns={columns} metric={shownMetric} />
            ))}
          </tbody>
          {total && (
            <tfoot>
              <Row row={total} columns={columns} metric={shownMetric} emphasis />
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
