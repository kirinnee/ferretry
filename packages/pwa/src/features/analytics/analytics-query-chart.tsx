/**
 * The chart of a query result: ONE metric, drawn with the shared metric chart. A result grouped only by
 * day or week is a series in time order; any other grouping is a set of bars, biggest first.
 */

import { type AnalyticsMetric, analyticsMetricValue } from '@ferretry/protocol';

import { durationAxisTicks, formatAxisDuration } from './analytics-overview.ts';
import { AnalyticsMetricChart, type MetricChartPoint } from './analytics-metric-chart.tsx';
import {
  ANALYTICS_METRIC_LABELS,
  type AnalyticsAggregateResponse,
  analyticsMetricMeasure,
  formatMetricMeasure,
} from './analytics-result-table.tsx';

/** The most bars a categorical chart draws; the table below still lists every group. */
export const QUERY_CHART_MAX_BARS = 12;

const TIME_LABELS: ReadonlySet<string> = new Set(['day', 'week']);

/** The metric a result is drawn for: the one asked for, else cost (sessions for a count). */
export const queryChartMetric = (response: AnalyticsAggregateResponse): AnalyticsMetric =>
  response.parsed.metric ?? (response.aggregation === 'count' ? 'sessions' : 'cost_usd');

export const isTimeGrouped = (response: AnalyticsAggregateResponse): boolean => {
  const labels = Object.keys(response.results[0]?.labels ?? {});
  return labels.length > 0 && labels.every(label => TIME_LABELS.has(label));
};

const pointLabel = (labels: Readonly<Record<string, string | null>>, timeGrouped: boolean): string => {
  const text = Object.values(labels)
    .map(value => value ?? 'unknown')
    .join(' · ');
  return timeGrouped && /^\d{4}-\d{2}-\d{2}$/.test(text) ? text.slice(5) : text || 'All sessions';
};

/** One bar per group; a group the metric is not fully known for is flagged as a lower bound. */
export const queryChartPoints = (response: AnalyticsAggregateResponse, metric: AnalyticsMetric): MetricChartPoint[] => {
  const timeGrouped = isTimeGrouped(response);
  const points = response.results.map((result, index): MetricChartPoint & { readonly sortKey: string } => {
    const measure = analyticsMetricMeasure(result, metric);
    const value = analyticsMetricValue(result, metric) ?? 0;
    const label = pointLabel(result.labels, timeGrouped);
    return {
      key: `${index}:${label}`,
      sortKey: Object.values(result.labels).join('\u0000'),
      label,
      values: [value],
      flagged: measure.known < measure.total,
      empty: measure.value === 0 && measure.known === measure.total,
      readout: `${label} · ${formatMetricMeasure(metric, measure)}`,
    };
  });
  const ordered = timeGrouped
    ? points.sort((left, right) => left.sortKey.localeCompare(right.sortKey))
    : points.sort((left, right) => (right.values[0] ?? 0) - (left.values[0] ?? 0)).slice(0, QUERY_CHART_MAX_BARS);
  return ordered.map(({ sortKey: _sortKey, ...point }) => point);
};

export function AnalyticsQueryChart({ response }: { readonly response: AnalyticsAggregateResponse }) {
  const metric = queryChartMetric(response);
  const points = queryChartPoints(response, metric);
  if (points.length === 0) return null;
  const isDuration = metric === 'duration_active_seconds' || metric === 'duration_wall_seconds';
  const format = (value: number) => formatMetricMeasure(metric, { value, known: 1, total: 1 });
  return (
    <AnalyticsMetricChart
      title={ANALYTICS_METRIC_LABELS[metric]}
      series={[{ key: metric, label: ANALYTICS_METRIC_LABELS[metric], tone: 'accent' }]}
      points={points}
      format={format}
      {...(isDuration ? { formatAxis: formatAxisDuration, axisTicks: durationAxisTicks } : {})}
      flagNote={metric === 'cost_usd' ? 'at least — some sessions are unpriced' : 'at least — some sessions are unknown'}
      emptyText="Nothing to draw: every value is zero."
    />
  );
}
