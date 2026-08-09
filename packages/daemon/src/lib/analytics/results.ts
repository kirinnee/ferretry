import type {
  AnalyticsAggregateResult,
  AnalyticsIndexStatus,
  AnalyticsLabel,
  AnalyticsMeasure,
  AnalyticsRawSession,
  AnalyticsResponse,
  ParsedAnalyticsQuery,
} from '@ferretry/protocol';
import { parseAnalyticsQuery } from './query.ts';

export interface AnalyticsQueryRecordsOptions {
  readonly index: AnalyticsIndexStatus;
  readonly rawLimit?: number;
  readonly groupLimit?: number;
}

const DEFAULT_RAW_LIMIT = 100;
const DEFAULT_GROUP_LIMIT = 100;

/** Every field of an aggregate result that is a measure, so the table below cannot miss one. */
type AnalyticsMeasureKey = {
  [K in keyof AnalyticsAggregateResult]-?: NonNullable<AnalyticsAggregateResult[K]> extends AnalyticsMeasure
    ? K
    : never;
}[keyof AnalyticsAggregateResult];

/**
 * Which stored column answers each measure.
 *
 * A MAPPED TYPE, not a list of pairs. A list satisfies its constraint while missing entries — the
 * check proves every pair present is well-typed and says nothing about the ones nobody wrote. Keyed
 * on `AnalyticsMeasureKey`, a measure the protocol grows and this file does not answer is a compile
 * error here, rather than a column that silently aggregates to nothing in front of an operator.
 */
const metrics = {
  tokens: 'tokens',
  inputTokens: 'inputTokens',
  outputTokens: 'outputTokens',
  cachedInputTokens: 'cachedInputTokens',
  cacheWriteInputTokens: 'cacheWriteInputTokens',
  cacheWrite5mInputTokens: 'cacheWrite5mInputTokens',
  cacheWrite1hInputTokens: 'cacheWrite1hInputTokens',
  reasoningTokens: 'reasoningTokens',
  equivalentApiCostUsdMicros: 'equivalentApiCostUsdMicros',
  turns: 'turns',
  durationMs: 'durationMs',
  timeToFirstOutputMs: 'timeToFirstOutputMs',
  contextEndPercent: 'contextEndPercent',
} as const satisfies { readonly [K in AnalyticsMeasureKey]: keyof AnalyticsRawSession };

type LabelValues = Record<AnalyticsLabel, string | null>;

function labelValues(record: AnalyticsRawSession): LabelValues {
  return {
    id: record.id,
    agent: record.agent,
    model: record.model,
    pricing_model: record.pricingModel,
    context_window: record.contextWindow === null ? null : String(record.contextWindow),
    harness: record.harness,
    mode: record.mode,
    status: record.status,
    label: record.label,
    cwd: record.cwd,
    repo: record.cwd,
    parent: record.parent,
    tree: record.tree ?? null,
    day: record.day,
    week: record.week,
    token_data: record.tokens === null ? 'unknown' : 'known',
  };
}

function glob(value: string, pattern: string): boolean {
  const escaped = [...pattern]
    .map(character => {
      if (character === '*') return '.*';
      if (character === '?') return '.';
      return /[\\^$+.|()[\]{}]/.test(character) ? `\\${character}` : character;
    })
    .join('');
  return new RegExp(`^${escaped}$`).test(value);
}

function matches(record: AnalyticsRawSession, parsed: ParsedAnalyticsQuery): boolean {
  const values = labelValues(record);
  return parsed.matchers.every(matcher => {
    const value = values[matcher.label];
    if (value === null) return false;
    return matcher.wildcard ? glob(value, matcher.value) : value === matcher.value;
  });
}

function measure(
  values: readonly (number | null)[],
  operation: NonNullable<ParsedAnalyticsQuery['aggregation']>,
): AnalyticsMeasure {
  if (operation === 'count') return { value: null, known: 0, total: 0 };
  const known = values.filter((value): value is number => value !== null);
  if (known.length !== values.length || known.length === 0)
    return { value: null, known: known.length, total: values.length };
  const value =
    operation === 'sum'
      ? known.reduce((total, next) => total + next, 0)
      : operation === 'avg'
        ? known.reduce((total, next) => total + next, 0) / known.length
        : operation === 'min'
          ? Math.min(...known)
          : Math.max(...known);
  return { value, known: known.length, total: values.length };
}

function labelSortKey(labels: Record<string, string | null>, groupBy: readonly AnalyticsLabel[]): string {
  return groupBy.map(label => `${labels[label] === null ? '1' : '0'}${labels[label] ?? ''}`).join('\u0000');
}

function aggregate(
  records: readonly AnalyticsRawSession[],
  parsed: ParsedAnalyticsQuery,
  groupLimit: number,
): AnalyticsAggregateResult[] {
  const grouped = new Map<string, { labels: Record<string, string | null>; rows: AnalyticsRawSession[] }>();
  for (const record of records) {
    const values = labelValues(record);
    const labels = Object.fromEntries(parsed.groupBy.map(label => [label, values[label]]));
    const key = JSON.stringify(parsed.groupBy.map(label => values[label]));
    const group = grouped.get(key);
    if (group === undefined) grouped.set(key, { labels, rows: [record] });
    else group.rows.push(record);
  }
  const groups = [...grouped.values()].sort((left, right) =>
    labelSortKey(left.labels, parsed.groupBy).localeCompare(labelSortKey(right.labels, parsed.groupBy)),
  );
  if (groups.length > groupLimit)
    throw new Error(`analytics query produces more than ${groupLimit} groups; add a matcher`);
  return groups.map(group => {
    const sessions = group.rows.length;
    // Built FROM the table rather than beside it: a hand-written set of placeholder measures is a
    // second enumeration of the same list, and the two drift the moment a measure is added to one.
    const measures = Object.fromEntries(
      Object.entries(metrics).map(([resultKey, recordKey]) => [
        resultKey,
        measure(
          group.rows.map(row => (row[recordKey as keyof AnalyticsRawSession] as number | null | undefined) ?? null),
          parsed.aggregation!,
        ),
      ]),
    ) as { readonly [K in AnalyticsMeasureKey]: AnalyticsMeasure };
    return {
      labels: group.labels,
      sessions,
      rates: {
        stall: (100 * group.rows.filter(row => row.stalled).length) / sessions,
        failure: (100 * group.rows.filter(row => row.failed).length) / sessions,
        completion: (100 * group.rows.filter(row => row.status === 'completed').length) / sessions,
      },
      ...measures,
    };
  });
}

/** Query already-derived records without coupling analytics decisions to a store implementation. */
export function queryAnalyticsRecords(
  records: readonly AnalyticsRawSession[],
  source: string | undefined,
  options: AnalyticsQueryRecordsOptions,
): AnalyticsResponse {
  const parsed = parseAnalyticsQuery(source);
  const matched = records.filter(record => matches(record, parsed));
  const responseBase = {
    query: parsed.canonical,
    parsed: { aggregation: parsed.aggregation, groupBy: parsed.groupBy, matchers: parsed.matchers },
    scope: { allSessions: true as const, indexed: options.index.sessions, matched: matched.length },
    index: options.index,
  };
  if (parsed.aggregation === undefined) {
    const limit = options.rawLimit ?? DEFAULT_RAW_LIMIT;
    const ordered = [...matched].sort(
      (left, right) =>
        Date.parse(right.createdAt ?? '') - Date.parse(left.createdAt ?? '') || left.id.localeCompare(right.id),
    );
    return {
      ...responseBase,
      kind: 'raw',
      limit,
      truncated: ordered.length > limit,
      results: ordered.slice(0, limit),
    };
  }
  return {
    ...responseBase,
    kind: 'aggregate',
    aggregation: parsed.aggregation,
    results: aggregate(matched, parsed, options.groupLimit ?? DEFAULT_GROUP_LIMIT),
  };
}
