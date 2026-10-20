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
  try {
    return formatAnalyticsQuery({ aggregation, metric, groupBy, matchers, range });
  } catch (error) {
    // A combination the grammar refuses (a per-turn ratio under max) leaves the text as it was.
    if (error instanceof AnalyticsQueryError) return text;
    throw error;
  }
};

export const withAggregation = (text: string, aggregation: AnalyticsAggregation): string =>
  edit(text, () => ({ aggregation }));

/** `undefined` clears the metric: the table then shows every measure. */
export const withMetric = (text: string, metric: AnalyticsMetric | undefined): string =>
  edit(text, parsed => ({ metric, aggregation: parsed.aggregation ?? (metric ? 'sum' : undefined) }));

export const toggleGroupLabel = (text: string, label: AnalyticsLabel): string =>
  edit(text, parsed => ({
    groupBy: parsed.groupBy.includes(label)
      ? parsed.groupBy.filter(item => item !== label)
      : [...parsed.groupBy, label],
    aggregation: parsed.aggregation ?? 'sum',
  }));

/** A range written the way the grammar spells it (`7d`, `2026-10-01..2026-10-20`), or `undefined` to clear it. */
export const withRange = (text: string, range: string | undefined): string => {
  if (range === undefined) return edit(text, () => ({ range: undefined }));
  const read = readAnalyticsQuery(`sum [${range}]`);
  return read.ok ? edit(text, () => ({ range: read.parsed.range })) : text;
};

/** A relative range's length in seconds, as the grammar reads it, or `undefined` for any other range. */
const relativeSeconds = (text: string): number | undefined => {
  const read = readAnalyticsQuery(text);
  return read.ok && read.parsed.range?.kind === 'relative' ? read.parsed.range.seconds : undefined;
};

/**
 * The range chip that is active: the preset the query's relative range is AS LONG AS. Compared by
 * length, not spelling, because the canonical spelling is not the chip's — `[24h]` is written `[1d]`.
 */
export const activeRangeSource = (text: string, presets: readonly string[]): string | undefined => {
  const seconds = relativeSeconds(text);
  return seconds === undefined ? undefined : presets.find(preset => relativeSeconds(`sum [${preset}]`) === seconds);
};
