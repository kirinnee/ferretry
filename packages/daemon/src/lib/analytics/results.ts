import {
  type AnalyticsAggregateResult,
  type AnalyticsIndexStatus,
  type AnalyticsLabel,
  type AnalyticsMeasure,
  type AnalyticsMeasureKey,
  type AnalyticsRawSession,
  type AnalyticsResponse,
  analyticsGroupSortKey,
  compareAnalyticsRawSessions,
  type ParsedAnalyticsQuery,
} from '@ferretry/protocol';
import { parseAnalyticsQuery } from './query.ts';

export interface AnalyticsQueryRecordsOptions {
  readonly index: AnalyticsIndexStatus;
  /**
   * The instant the daemon answers at, which a RELATIVE range (`[7d]`) ends at. Required only by such a
   * query: one without it is refused rather than measured against a clock this function does not own.
   */
  readonly now?: string;
  /** This daemon's machine name, stamped on every row so a fleet view can tell machines apart. */
  readonly machine?: string | null;
  readonly rawLimit?: number;
  readonly groupLimit?: number;
}

const DEFAULT_RAW_LIMIT = 100;
const DEFAULT_GROUP_LIMIT = 100;

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
  equivalentApiCostCurrentUsdMicros: 'equivalentApiCostCurrentUsdMicros',
  turns: 'turns',
  durationMs: 'durationMs',
  activeDurationMs: 'activeDurationMs',
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
    runtime: record.agent,
    project: record.cwd,
    session: record.id,
    machine: record.machine,
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
  if (known.length !== values.length || known.length === 0) {
    // A sum of the sessions that stated a figure is a lower bound, and is said as one; a partial mean,
    // minimum or maximum is not a bound on anything, so it stays unknown.
    const lowerBound = operation === 'sum' && known.length > 0 ? known.reduce((total, next) => total + next, 0) : null;
    return {
      value: null,
      known: known.length,
      total: values.length,
      ...(lowerBound === null ? {} : { knownSum: lowerBound }),
    };
  }
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
    analyticsGroupSortKey(left.labels, parsed.groupBy).localeCompare(
      analyticsGroupSortKey(right.labels, parsed.groupBy),
    ),
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
    const costGaps = costGapCounts(group.rows);
    return {
      labels: group.labels,
      sessions,
      rates: {
        stall: (100 * group.rows.filter(row => row.stalled).length) / sessions,
        failure: (100 * group.rows.filter(row => row.failed).length) / sessions,
        completion: (100 * group.rows.filter(row => row.status === 'completed').length) / sessions,
      },
      ...measures,
      ...(costGaps === undefined ? {} : { costGaps }),
    };
  });
}

/** Why each session without a cost has none, counted per reason; undefined when every session priced. */
function costGapCounts(rows: readonly AnalyticsRawSession[]): Record<string, number> | undefined {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    if (row.equivalentApiCostUsdMicros !== null) continue;
    const reason = row.costGap ?? 'unknown';
    counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return Object.keys(counts).length === 0 ? undefined : counts;
}

/**
 * The half-open window a range selects, in epoch milliseconds, or `undefined` when it selects everything.
 * A relative range ends when the daemon answers; an absolute one is exactly what it names.
 */
function rangeWindow(parsed: ParsedAnalyticsQuery, now: string | undefined): { from: number; to: number } | undefined {
  const { range } = parsed;
  if (range === undefined) return undefined;
  if (range.kind === 'absolute') return { from: Date.parse(range.from), to: Date.parse(range.to) };
  const end = now === undefined ? Number.NaN : Date.parse(now);
  if (!Number.isFinite(end)) throw new Error('a relative analytics range needs the instant the daemon answers at');
  return { from: end - range.seconds * 1_000, to: end };
}

/** Query already-derived records without coupling analytics decisions to a store implementation. */
export function queryAnalyticsRecords(
  records: readonly AnalyticsRawSession[],
  source: string | undefined,
  options: AnalyticsQueryRecordsOptions,
): AnalyticsResponse {
  const parsed = parseAnalyticsQuery(source);
  const window = rangeWindow(parsed, options.now);
  const stamped =
    options.machine === undefined ? records : records.map(record => ({ ...record, machine: options.machine ?? null }));
  const matched = stamped.filter(record => {
    if (window !== undefined) {
      // A session with no creation instant has no place in any window, so a range never counts it.
      const created = record.createdAt === null ? Number.NaN : Date.parse(record.createdAt);
      if (!(created >= window.from && created < window.to)) return false;
    }
    return matches(record, parsed);
  });
  const responseBase = {
    query: parsed.canonical,
    parsed: {
      aggregation: parsed.aggregation,
      ...(parsed.metric === undefined ? {} : { metric: parsed.metric }),
      groupBy: parsed.groupBy,
      matchers: parsed.matchers,
      ...(parsed.range === undefined ? {} : { range: parsed.range }),
    },
    scope: {
      allSessions: true as const,
      indexed: options.index.sessions,
      matched: matched.length,
      ...(window === undefined
        ? {}
        : { window: { from: new Date(window.from).toISOString(), to: new Date(window.to).toISOString() } }),
    },
    index: options.index,
  };
  if (parsed.aggregation === undefined) {
    const limit = options.rawLimit ?? DEFAULT_RAW_LIMIT;
    const ordered = [...matched].sort(compareAnalyticsRawSessions(parsed.metric));
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
