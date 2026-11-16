import {
  type AnalyticsAggregateResult,
  AnalyticsGroupLimitError,
  AnalyticsQueryError,
  type AnalyticsIndexStatus,
  type AnalyticsLabel,
  type AnalyticsMeasure,
  type AnalyticsMeasureKey,
  type AnalyticsRawSession,
  type AnalyticsResponse,
  analyticsGroupSortKey,
  compareAnalyticsRawSessions,
  type ParsedAnalyticsQuery,
} from '../../../contract/index.ts';
import { parseAnalyticsQuery } from './query.ts';
import { utcDateOf, zonedDay, zonedMidnight, zonedWeek } from './time-zone.ts';

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
  /**
   * The IANA zone whose calendar the `day` and `week` labels, and the dates of an absolute range, are
   * read in. Absent, they are UTC's — the day each row was stored with. The caller has validated it.
   */
  readonly timeZone?: string;
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

function labelValues(record: AnalyticsRawSession, timeZone: string | undefined): LabelValues {
  // A session with no creation instant keeps the day it was stored with (null) rather than inventing one.
  const zoned = timeZone !== undefined && record.createdAt !== null;
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
    day: zoned ? zonedDay(record.createdAt!, timeZone) : record.day,
    week: zoned ? zonedWeek(record.createdAt!, timeZone) : record.week,
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

/** A raw row as the zone reads it: the same session, on the `day` and `week` the reader's clock gives it. */
function inZone(record: AnalyticsRawSession, timeZone: string | undefined): AnalyticsRawSession {
  if (timeZone === undefined || record.createdAt === null) return record;
  return { ...record, day: zonedDay(record.createdAt, timeZone), week: zonedWeek(record.createdAt, timeZone) };
}

function matches(record: AnalyticsRawSession, parsed: ParsedAnalyticsQuery, timeZone: string | undefined): boolean {
  const values = labelValues(record, timeZone);
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
  timeZone: string | undefined,
): AnalyticsAggregateResult[] {
  const grouped = new Map<string, { labels: Record<string, string | null>; rows: AnalyticsRawSession[] }>();
  for (const record of records) {
    const values = labelValues(record, timeZone);
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
  if (groups.length > groupLimit) throw new AnalyticsGroupLimitError(groupLimit);
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
 * An absolute range, with a WHOLE-DAY bound read on the zone's clock.
 *
 * The parsed range says which bounds were WRITTEN as dates (`[2026-10-01..2026-10-20]`): in a zone, only
 * those open (or close) at THAT zone's midnight, so the range covers the days the reader sees. A bound
 * written as an instant — a midnight one included — is exactly what it names. A range with one date bound
 * and one instant bound cannot be ordered until the zone is applied, so the order is checked HERE: a
 * window that ends before it starts is the caller's mistake (400), never a different window. One that
 * starts and ends together is empty (a day the zone skipped, such as Pacific/Apia 2011-12-30), and matches
 * nothing rather than a UTC day the reader never asked for.
 */
function absoluteWindow(
  range: Extract<NonNullable<ParsedAnalyticsQuery['range']>, { kind: 'absolute' }>,
  timeZone: string | undefined,
): { from: number; to: number } {
  const start = Date.parse(range.from);
  const end = Date.parse(range.to);
  const onZoneClock = (at: number, date: boolean | undefined): number =>
    timeZone !== undefined && date === true ? zonedMidnight(utcDateOf(at), timeZone) : at;
  const from = onZoneClock(start, range.dates?.from);
  const to = onZoneClock(end, range.dates?.to);
  if (from > to) throw new AnalyticsQueryError('a range must end after it starts');
  return { from, to };
}

/**
 * The half-open window a range selects, in epoch milliseconds, or `undefined` when it selects everything.
 * A relative range ends when the daemon answers; an absolute one is exactly what it names.
 */
function rangeWindow(
  parsed: ParsedAnalyticsQuery,
  now: string | undefined,
  timeZone: string | undefined,
): { from: number; to: number } | undefined {
  const { range } = parsed;
  if (range === undefined) return undefined;
  if (range.kind === 'absolute') return absoluteWindow(range, timeZone);
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
  const window = rangeWindow(parsed, options.now, options.timeZone);
  const stamped =
    options.machine === undefined ? records : records.map(record => ({ ...record, machine: options.machine ?? null }));
  const matched = stamped.filter(record => {
    if (window !== undefined) {
      // A session with no creation instant has no place in any window, so a range never counts it.
      const created = record.createdAt === null ? Number.NaN : Date.parse(record.createdAt);
      if (!(created >= window.from && created < window.to)) return false;
    }
    return matches(record, parsed, options.timeZone);
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
      results: ordered.slice(0, limit).map(row => inZone(row, options.timeZone)),
    };
  }
  return {
    ...responseBase,
    kind: 'aggregate',
    aggregation: parsed.aggregation,
    results: aggregate(matched, parsed, options.groupLimit ?? DEFAULT_GROUP_LIMIT, options.timeZone),
  };
}
