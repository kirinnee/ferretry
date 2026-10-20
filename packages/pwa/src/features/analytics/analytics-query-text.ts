/**
 * The query text is the source of truth; the metric picker, range chips and group-by chips are
 * editors of it. Each edit parses the text with the protocol grammar, changes one part and re-emits
 * the protocol's canonical spelling — there is no second parser or spelling here.
 */

import {
  type AnalyticsAggregation,
  type AnalyticsLabel,
  type AnalyticsMetric,
  AnalyticsQueryError,
  formatAnalyticsQuery,
  type ParsedAnalyticsQuery,
  parseAnalyticsQuery,
} from '@ferretry/protocol';

export type QueryRead =
  | { readonly ok: true; readonly parsed: ParsedAnalyticsQuery }
  | { readonly ok: false; readonly error: string };

/** Parses with the protocol grammar; a blank text reads as the protocol's default query. */
export const readAnalyticsQuery = (text: string): QueryRead => {
  try {
    return { ok: true, parsed: parseAnalyticsQuery(text) };
  } catch (error) {
    if (error instanceof AnalyticsQueryError) return { ok: false, error: error.message };
    throw error;
  }
};

const edit = (text: string, change: (parsed: ParsedAnalyticsQuery) => Partial<ParsedAnalyticsQuery>): string => {
  const read = readAnalyticsQuery(text);
  if (!read.ok) return text;
  const { aggregation, metric, groupBy, matchers, range } = { ...read.parsed, ...change(read.parsed) };
  return formatAnalyticsQuery({ aggregation, metric, groupBy, matchers, range });
};

export const withAggregation = (text: string, aggregation: AnalyticsAggregation): string =>
  edit(text, () => ({ aggregation }));

/** `undefined` clears the metric: the table then shows every measure. */
export const withMetric = (text: string, metric: AnalyticsMetric | undefined): string =>
  edit(text, parsed => ({ metric, aggregation: parsed.aggregation ?? (metric ? 'sum' : undefined) }));

export const toggleGroupLabel = (text: string, label: AnalyticsLabel): string =>
  edit(text, parsed => ({
    groupBy: parsed.groupBy.includes(label) ? parsed.groupBy.filter(item => item !== label) : [...parsed.groupBy, label],
    aggregation: parsed.aggregation ?? 'sum',
  }));

/** A range written the way the grammar spells it (`7d`, `2026-10-01..2026-10-20`), or `undefined` to clear it. */
export const withRange = (text: string, range: string | undefined): string => {
  if (range === undefined) return edit(text, () => ({ range: undefined }));
  const read = readAnalyticsQuery(`sum [${range}]`);
  return read.ok ? edit(text, () => ({ range: read.parsed.range })) : text;
};

/** The range chip that is active: a relative range written exactly as one of the offered presets. */
export const activeRangeSource = (text: string, presets: readonly string[]): string | undefined => {
  const match = text.match(/\[\s*([^\]]*?)\s*\]\s*$/);
  return match && presets.includes(match[1]!) ? match[1] : undefined;
};
