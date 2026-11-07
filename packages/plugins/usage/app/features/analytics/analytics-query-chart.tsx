/**
 * The chart of a query result: ONE metric, drawn with the shared metric chart. A result with a day or week
 * in its grouping is a TREND — bars in time order, one stacked series per other group (see
 * `analytics-trend-points.ts`); any other grouping is a set of bars, biggest first.
 */

import type { AnalyticsMetric } from '../../../contract/index.ts';
import { AnalyticsMetricChart, type MetricChartPoint } from './analytics-metric-chart.tsx';
import { isTrend, trendChartModel } from './analytics-trend-points.ts';
import { durationAxisTicks, formatAxisDuration } from './analytics-overview.ts';
import {
  ANALYTICS_METRIC_LABELS,
  type AnalyticsAggregateResponse,
  analyticsMetricMeasure,
  formatMetricMeasure,
} from './analytics-result-table.tsx';

/** The most bars a categorical chart draws; the table below still lists every group. */
export const QUERY_CHART_MAX_BARS = 12;

/** The metric a result is drawn for: the one asked for, else cost (sessions for a count). */
export const queryChartMetric = (response: AnalyticsAggregateResponse): AnalyticsMetric =>
  response.parsed.metric ?? (response.aggregation === 'count' ? 'sessions' : 'cost_usd');

const pointLabel = (labels: Readonly<Record<string, string | null>>): string =>
  Object.values(labels)
    .map(value => value ?? 'unknown')
    .join(' · ') || 'All sessions';

/** One bar per group; a group the metric is not fully known for is flagged as a lower bound. */
export const queryChartPoints = (response: AnalyticsAggregateResponse, metric: AnalyticsMetric): MetricChartPoint[] => {
  const points = response.results.map((result, index): MetricChartPoint => {
    const measure = analyticsMetricMeasure(result, metric);
    // A group some sessions could not state still draws what the others did, hatched as a lower bound.
    const value = measure.value ?? measure.knownSum ?? 0;
    const label = pointLabel(result.labels);
    return {
      key: `${index}:${label}`,
      label,
      values: [value],
      flagged: measure.known < measure.total,
      empty: measure.value === 0 && measure.known === measure.total,
      readout: `${label} · ${formatMetricMeasure(metric, measure)}`,
    };
  });
  return points.sort((left, right) => (right.values[0] ?? 0) - (left.values[0] ?? 0)).slice(0, QUERY_CHART_MAX_BARS);
};

export function AnalyticsQueryChart({ response }: { readonly response: AnalyticsAggregateResponse }) {
  const metric = queryChartMetric(response);
  const trend = isTrend(response);
  const { series, points } = trend
    ? trendChartModel(response, metric)
    : {
        series: [{ key: metric, label: ANALYTICS_METRIC_LABELS[metric], tone: 'accent' as const }],
        points: queryChartPoints(response, metric),
      };
  if (points.length === 0) return null;
  // Model ids and the like are too long to sit flat under a bar; a date is short and stays flat.
  const rotateLabels = !trend && points.some(point => point.label.length > 6);
  const isDuration = metric.startsWith('duration_');
  const format = (value: number) => formatMetricMeasure(metric, { value, known: 1, total: 1 });
  return (
    <AnalyticsMetricChart
      title={ANALYTICS_METRIC_LABELS[metric]}
      series={series}
      points={points}
      rotateLabels={rotateLabels}
      {...(trend ? { resting: 'last' as const } : {})}
      format={format}
      {...(isDuration ? { formatAxis: formatAxisDuration, axisTicks: durationAxisTicks } : {})}
      flagNote={
        metric === 'cost_usd' || metric === 'cost_now_usd'
          ? 'at least — some sessions are unpriced'
          : 'at least — some sessions are unknown'
      }
      emptyText="Nothing to draw: every value is zero."
    />
  );
}
