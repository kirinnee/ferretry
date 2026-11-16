/**
 * TREND: the same question asked over time instead of as one number.
 *
 * `sum(cost_usd) by (model) {harness=claude} [7d]` is a SINGLE result: one figure per model. Its TREND is
 * the same measure, filters and range with a time bucket added to the grouping — `… by (model, day)` —
 * so the page can draw the figure day by day. Nothing here parses or spells a query itself: the protocol
 * grammar reads it and writes it back (see `analytics-query-text.ts`), and this file only decides what
 * to add and when to refuse.
 *
 * The editor keeps what the reader typed. The trend query is what is SENT, so switching back to a single
 * result is just asking the text again.
 */

import type { AnalyticsAggregation, AnalyticsLabel, AnalyticsMetric } from '../../../contract/index.ts';
import { ANALYTICS_RATIO_METRICS, AnalyticsQueryError, formatAnalyticsQuery } from '../../../contract/index.ts';

import { readAnalyticsQuery } from './analytics-query-text.ts';

/** One answer, or the same answer over time. */
export const QUERY_VIEWS = ['single', 'trend'] as const;
export type QueryView = (typeof QUERY_VIEWS)[number];

/** The time bucket a trend counts in. */
const TREND_BUCKETS = ['day', 'week'] as const;
export type TrendBucket = (typeof TREND_BUCKETS)[number];

/** The window a trend gets when the query names none: an unbounded daily series is thousands of groups. */
const TREND_DEFAULT_RANGE: Readonly<Record<TrendBucket, string>> = { day: '30d', week: '90d' };

/** The longest a query may group by (protocol `MAX_ANALYTICS_GROUP_LABELS`); a trend needs one for time. */
const MAX_GROUP_LABELS = 4;

/**
 * Whether the figures ADD across groups, so a stack of them is the total. avg/min/max are not stackable,
 * and neither is a RATIO metric even under sum: the sum of per-turn times is a ratio of sums, not a sum.
 */
export const isAdditive = (aggregation: AnalyticsAggregation | undefined, metric?: AnalyticsMetric): boolean =>
  (aggregation === 'sum' || aggregation === 'count') && !(metric !== undefined && ANALYTICS_RATIO_METRICS.has(metric));

export const isTimeLabel = (label: string): label is TrendBucket => label === 'day' || label === 'week';

export type TrendPlan =
  | {
      readonly ok: true;
      /** What to ask the daemon. */
      readonly query: string;
      /** The bucket the result is counted in. */
      readonly bucket: TrendBucket;
      /** The query's own grouping already names the bucket, so the Daily/Weekly control does not apply. */
      readonly fixed: boolean;
      /** A window was added because the query named none; said under the chart so it is not a surprise. */
      readonly addedRange: string | undefined;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * The query to send for a trend of `text`, or why there is no trend of it.
 *
 * Text the grammar cannot read is sent as it is: the daemon's own refusal is the clearest account of what
 * is wrong with it, and a trend that hid it would explain nothing.
 */
export const trendPlan = (text: string, bucket: TrendBucket): TrendPlan => {
  const read = readAnalyticsQuery(text);
  if (!read.ok) return { ok: true, query: text, bucket, fixed: false, addedRange: undefined };
  const { aggregation, metric, groupBy, matchers, range } = read.parsed;
  if (aggregation === undefined)
    return {
      ok: false,
      reason: 'A trend needs a total to follow. Start the query with sum, avg, min, max or count.',
    };
  const existing = groupBy.find(isTimeLabel);
  const others = groupBy.filter(label => !isTimeLabel(label));
  if (others.length > 0 && !isAdditive(aggregation, metric))
    return {
      ok: false,
      reason:
        metric !== undefined && ANALYTICS_RATIO_METRICS.has(metric)
          ? `A trend can only split a sum or a count by ${others.join(', ')}; ${metric} is a ratio and does not add up across groups. Remove the grouping.`
          : `A trend can only split a sum or a count by ${others.join(', ')}; an ${aggregation} does not add up across groups. Remove the grouping, or use sum.`,
    };
  const used = existing ?? bucket;
  const grouped: AnalyticsLabel[] = existing === undefined ? [...groupBy, bucket] : [...groupBy];
  if (grouped.length > MAX_GROUP_LABELS)
    return {
      ok: false,
      reason: `A trend adds a ${bucket} column, and a query can group by at most ${MAX_GROUP_LABELS} labels.`,
    };
  const addedRange = range === undefined ? TREND_DEFAULT_RANGE[used] : undefined;
  const added = addedRange === undefined ? undefined : readAnalyticsQuery(`sum [${addedRange}]`);
  const resolvedRange = range ?? (added?.ok ? added.parsed.range : undefined);
  try {
    return {
      ok: true,
      query: formatAnalyticsQuery({ aggregation, metric, groupBy: grouped, matchers, range: resolvedRange }),
      bucket: used,
      fixed: existing !== undefined,
      addedRange,
    };
  } catch (error) {
    // The added `by (…)` can push a query that was just inside the length limit over it.
    if (!(error instanceof AnalyticsQueryError)) throw error;
    return { ok: false, reason: `A trend of this query is not valid: ${error.message}. Shorten the query.` };
  }
};
