/**
 * A TIME SERIES FROM AN AGGREGATE ANSWER: one bar per day (or week), one stacked series per other group.
 *
 * `sum(tokens) by (day)` is one series. `sum(tokens) by (model, day)` is a stack with one series per
 * model — it can only be a stack when the figures ADD (sum, count of a plain measure), so an avg/min/max, or
 * a ratio metric, split by another label is not drawn as a trend at all (the Query page says why instead).
 *
 * What keeps it honest:
 *
 * - A DAY WITH NO SESSIONS IS A KNOWN ZERO between the first and last day the answer has, so a quiet day
 *   reads as quiet rather than being squeezed out of the axis. Only for sum and count: an average of
 *   nothing is not zero, so avg/min/max series skip a day they have no figure for.
 * - A BAR THAT IS A LOWER BOUND (a group some sessions could not state) keeps the hatched cap, and its
 *   readout says "at least"; a bucket nothing could state is UNKNOWN in the readout, never $0.00.
 * - AT MOST FOUR SERIES: the three biggest, then everything else together as "Other", because the chart has
 *   four theme tones and a legend of twelve models is not readable.
 */

import type { AnalyticsAggregateResult, AnalyticsMeasure, AnalyticsMetric } from '../../../contract/index.ts';

import type { MetricChartPoint, MetricChartSeries, MetricChartTone } from './analytics-metric-chart.tsx';
import {
  type AnalyticsAggregateResponse,
  analyticsMetricMeasure,
  formatMetricMeasure,
} from './analytics-result-table.tsx';
import { isAdditive, isTimeLabel } from './analytics-query-trend.ts';

const TONES: readonly MetricChartTone[] = ['accent', 'ok', 'pend', 'info'];
const OTHER = 'Other';
/** How a series with no value for a label is spelled; a real value "unknown" keeps its own spelling. */
const MISSING = 'unknown (none)';
const DAY_MS = 86_400_000;
/** More buckets than a chart can show a bar each for; a longer fill is left as the answer's own days. */
const MAX_FILLED_BUCKETS = 400;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** An ISO week key, "2026-W42", which is how the daemon names a week bucket. */
const ISO_WEEK = /^(\d{4})-W(\d{2})$/;

/** The time label the answer is bucketed by, or undefined when it is not a time series. */
const trendBucketLabel = (response: AnalyticsAggregateResponse): 'day' | 'week' | undefined =>
  response.parsed.groupBy.find(isTimeLabel);

/** Whether an answer is drawn as a trend: it has a time label, and anything else it is split by can stack. */
export const isTrend = (response: AnalyticsAggregateResponse): boolean => {
  const bucket = trendBucketLabel(response);
  if (bucket === undefined) return false;
  const others = response.parsed.groupBy.filter(label => label !== bucket);
  return others.length === 0 || isAdditive(response.aggregation, response.parsed.metric);
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * The x-axis label of a bucket. A day is its MM-DD. A week is "W42" (an ISO week key) or its Monday as
 * "Sep 15" (a date key): a phone gives a week's bar about six characters, and "2026-W42" truncated to
 * "2026-…" made five weeks read alike. The year is added ("W01 '27") only on the first bucket and where it
 * changes, so a year boundary is never ambiguous. The bucket key and the hover readout keep the full key.
 */
const bucketLabel = (date: string, bucket: 'day' | 'week', previous: string | undefined): string => {
  const iso = bucket === 'week' ? ISO_WEEK.exec(date) : null;
  if (!iso && !DATE.test(date)) return date;
  if (bucket === 'day') return date.slice(5);
  const year = date.slice(0, 4);
  const text = iso ? `W${iso[2]}` : `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8))}`;
  return previous === undefined || previous.slice(0, 4) !== year ? `${text} '${year.slice(2)}` : text;
};

const shiftDate = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** Every bucket from the first to the last, step by step, or the buckets as given when they are not dates. */
const filledBuckets = (present: readonly string[], step: number): readonly string[] => {
  const first = present[0];
  const last = present.at(-1);
  if (first === undefined || last === undefined || !present.every(bucket => DATE.test(bucket))) return present;
  const span = Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / DAY_MS / step) + 1;
  if (span > MAX_FILLED_BUCKETS) return present;
  return Array.from({ length: span }, (_, index) => shiftDate(first, index * step));
};

/** What a bar draws for a measure: its value, else the lower bound it adds up to, else nothing. */
const drawn = (measure: AnalyticsMeasure): number => measure.value ?? measure.knownSum ?? 0;

/** Some sessions could not state the figure, or none could. */
const isPartial = (measure: AnalyticsMeasure): boolean => measure.known < measure.total || measure.value === null;

/** Measures added together: exact when every part is, else the lower bound the stated parts add up to. */
const addMeasures = (measures: readonly AnalyticsMeasure[]): AnalyticsMeasure => {
  const known = measures.reduce((sum, measure) => sum + measure.known, 0);
  const total = measures.reduce((sum, measure) => sum + measure.total, 0);
  const stated = measures.reduce((sum, measure) => sum + drawn(measure), 0);
  if (measures.every(measure => measure.value !== null)) return { value: stated, known, total };
  const any = measures.some(measure => measure.value !== null || measure.knownSum !== undefined);
  return { value: null, known, total, ...(any ? { knownSum: stated } : {}) };
};

/** The chart series and bars for a trend answer, in time order; empty when the answer has nothing. */
export const trendChartModel = (
  response: AnalyticsAggregateResponse,
  metric: AnalyticsMetric,
): { readonly series: readonly MetricChartSeries[]; readonly points: readonly MetricChartPoint[] } => {
  const bucket = trendBucketLabel(response);
  if (bucket === undefined) return { series: [], points: [] };
  const additive = isAdditive(response.aggregation, metric);
  const others = response.parsed.groupBy.filter(label => label !== bucket);
  // A series is its tuple of label values, kept apart from how it is spelled: a missing label is not the
  // text "unknown", and a value containing the display delimiter is still one value.
  const split = (result: AnalyticsAggregateResult): readonly (string | null)[] =>
    others.map(label => result.labels[label] ?? null);

  // Group the rows: series tuple -> bucket -> the measure the metric reads.
  const byName = new Map<string, { readonly name: string; readonly cells: Map<string, AnalyticsMeasure> }>();
  for (const result of response.results) {
    const when = result.labels[bucket];
    if (when === null || when === undefined) continue;
    const values = split(result);
    const key = JSON.stringify(values);
    const series = byName.get(key) ?? {
      name: values.map(value => value ?? MISSING).join(' · '),
      cells: new Map<string, AnalyticsMeasure>(),
    };
    series.cells.set(when, analyticsMetricMeasure(result, metric));
    byName.set(key, series);
  }
  const present = [...new Set([...byName.values()].flatMap(({ cells }) => [...cells.keys()]))].sort();
  if (present.length === 0) return { series: [], points: [] };
  const buckets = additive ? filledBuckets(present, bucket === 'week' ? 7 : 1) : present;

  // The biggest series first; beyond four, the rest are summed into one.
  const total = (cells: ReadonlyMap<string, AnalyticsMeasure>): number =>
    [...cells.values()].reduce((sum, cell) => sum + drawn(cell), 0);
  const ranked = [...byName.entries()].sort(
    (left, right) =>
      total(right[1].cells) - total(left[1].cells) ||
      left[1].name.localeCompare(right[1].name) ||
      left[0].localeCompare(right[0]),
  );
  const kept = ranked.length > TONES.length ? ranked.slice(0, TONES.length - 1) : ranked;
  const rest = ranked.slice(kept.length);
  const columns: { key: string; name: string; cells: Map<string, AnalyticsMeasure> }[] = kept.map(
    ([key, { name, cells }]) => ({ key: others.length === 0 ? metric : key, name, cells: new Map(cells) }),
  );
  if (rest.length > 0) {
    const parts = new Map<string, AnalyticsMeasure[]>();
    for (const [, { cells }] of rest)
      for (const [when, cell] of cells) parts.set(when, [...(parts.get(when) ?? []), cell]);
    // A tuple key is a JSON array, so "Other" can never be the key of a real series.
    columns.push({
      key: OTHER,
      name: OTHER,
      cells: new Map([...parts].map(([when, list]) => [when, addMeasures(list)])),
    });
  }
  const series = columns.map(
    (column, index): MetricChartSeries => ({
      key: column.key,
      label: column.name || 'All sessions',
      tone: TONES[index]!,
    }),
  );

  // A bucket a series has no row for is a known zero (only an additive trend is filled to have them).
  const NONE: AnalyticsMeasure = { value: 0, known: 1, total: 1 };
  const points = buckets.map((when, position): MetricChartPoint => {
    const measures = columns.map(column => column.cells.get(when) ?? NONE);
    const texts = measures.map(measure => formatMetricMeasure(metric, measure));
    const label = bucketLabel(when, bucket, buckets[position - 1]);
    // The hover line names a week by its full Monday date; the axis label is the short one.
    const named = bucket === 'week' && (DATE.test(when) || ISO_WEEK.test(when)) ? `week of ${when}` : label;
    const parts = series.length > 1 ? series.map((entry, index) => `${entry.label} ${texts[index]}`).join(' · ') : '';
    return {
      key: when,
      label,
      values: measures.map(drawn),
      texts,
      flagged: measures.some(isPartial),
      empty: measures.every(measure => measure.value === 0 && !isPartial(measure)),
      readout: parts === '' ? `${named} · ${texts[0]}` : `${named} · ${parts}`,
    };
  });
  return { series, points };
};
