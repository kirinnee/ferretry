import {
  type AnalyticsAggregateResult,
  AnalyticsAggregateResultSchema,
  type AnalyticsAggregation,
  type AnalyticsIndexStatus,
  type AnalyticsLabel,
  type AnalyticsMeasure,
  type AnalyticsMeasureKey,
  type AnalyticsMetric,
  type AnalyticsRawSession,
  type AnalyticsResponse,
  analyticsRawMetricValue,
} from './analytics.ts';

/** Two answers that are not answers to the same question, so no merge of them means anything. */
export class AnalyticsMergeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AnalyticsMergeError';
  }
}

/**
 * Every measure field of an aggregate row, DERIVED from the schema rather than listed: a measure the
 * protocol grows is merged the day it lands, instead of being silently dropped from a fleet view.
 */
const NOT_MEASURES = new Set(['labels', 'sessions', 'rates', 'costGaps']);
const MEASURE_KEYS = Object.keys(AnalyticsAggregateResultSchema.shape).filter(
  key => !NOT_MEASURES.has(key),
) as AnalyticsMeasureKey[];

/** What a part of a sum stated: its whole value when complete, else its lower bound, else nothing. */
const statedSum = (part: AnalyticsMeasure): number | undefined => part.value ?? part.knownSum;

function addKnownSums(left: AnalyticsMeasure, right: AnalyticsMeasure): number | undefined {
  const a = statedSum(left);
  const b = statedSum(right);
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}

/**
 * Two parts of one measure, as one.
 *
 * The daemon's own rule carries over: a value is stated only when every session behind it stated one,
 * so a null part makes the merged value null, and `known`/`total` still add so the reader sees how much
 * is known. `avg` merges weighted by `known`, which for a stated value equals its session count. A part
 * with `total: 0` adds nothing; `partOf` decides what such a part means before it gets here.
 */
function mergeMeasure(
  left: AnalyticsMeasure,
  right: AnalyticsMeasure,
  aggregation: AnalyticsAggregation,
): AnalyticsMeasure {
  if (right.total === 0) return left;
  if (left.total === 0) return right;
  const known = left.known + right.known;
  const total = left.total + right.total;
  if (aggregation === 'count') return { value: null, known, total };
  if (left.value === null || right.value === null) {
    // A sum keeps its lower bound across the merge: what each part stated, added.
    const bound = aggregation === 'sum' ? addKnownSums(left, right) : undefined;
    return bound === undefined ? { value: null, known, total } : { value: null, known, total, knownSum: bound };
  }
  const value =
    aggregation === 'sum'
      ? left.value + right.value
      : aggregation === 'min'
        ? Math.min(left.value, right.value)
        : aggregation === 'max'
          ? Math.max(left.value, right.value)
          : (left.value * left.known + right.value * right.known) / known;
  return { value, known, total };
}

/**
 * A row's measure as the merge must read it.
 *
 * `total: 0` on a row that HAS sessions is not "no sessions": it is an older daemon that never sent the
 * measure, defaulted on read. Those sessions exist and stated nothing, so they merge as unknown —
 * `{ value: null, known: 0, total: sessions }` — and the fleet value turns unknown instead of silently
 * describing only the machines that answered. `count` is the exception: it states no measure at all.
 */
function partOf(
  row: AnalyticsAggregateResult,
  key: AnalyticsMeasureKey,
  aggregation: AnalyticsAggregation,
): AnalyticsMeasure {
  const measure = row[key];
  return aggregation !== 'count' && measure.total === 0 && row.sessions > 0
    ? { value: null, known: 0, total: row.sessions }
    : measure;
}

/** Reason counts add; absent on both sides stays absent. */
function mergeCostGaps(
  left: Readonly<Record<string, number>> | undefined,
  right: Readonly<Record<string, number>> | undefined,
): Record<string, number> | undefined {
  if (left === undefined && right === undefined) return undefined;
  const merged: Record<string, number> = { ...left };
  for (const [reason, count] of Object.entries(right ?? {})) merged[reason] = (merged[reason] ?? 0) + count;
  return merged;
}

function mergeRow(
  left: AnalyticsAggregateResult,
  right: AnalyticsAggregateResult,
  aggregation: AnalyticsAggregation,
): AnalyticsAggregateResult {
  const sessions = left.sessions + right.sessions;
  // Rates are percentages OF SESSIONS, so they weigh by sessions; every row has at least one.
  const rate = (key: keyof AnalyticsAggregateResult['rates']) =>
    (left.rates[key] * left.sessions + right.rates[key] * right.sessions) / sessions;
  const measures = Object.fromEntries(
    MEASURE_KEYS.map(key => [
      key,
      mergeMeasure(partOf(left, key, aggregation), partOf(right, key, aggregation), aggregation),
    ]),
  ) as { [K in AnalyticsMeasureKey]: AnalyticsMeasure };
  const costGaps = mergeCostGaps(left.costGaps, right.costGaps);
  return {
    labels: left.labels,
    sessions,
    rates: { stall: rate('stall'), failure: rate('failure'), completion: rate('completion') },
    ...measures,
    ...(costGaps === undefined ? {} : { costGaps }),
  };
}

/** The order a daemon returns groups in: label by label, a null label after every named one. */
export function analyticsGroupSortKey(
  labels: Readonly<Record<string, string | null>>,
  groupBy: readonly AnalyticsLabel[],
): string {
  return groupBy.map(label => `${labels[label] === null ? '1' : '0'}${labels[label] ?? ''}`).join('\u0000');
}

/**
 * The order raw rows are returned in, ONE definition for a daemon and for a fleet merge.
 *
 * Newest first. A bare-metric query (`cost_usd {…}`) is "top sessions by that metric": highest first,
 * an unknown value after every known one, newest first among equals. Ties end on the session id and
 * then the machine, because two machines may hold the same id and the order must still be total.
 */
export function compareAnalyticsRawSessions(
  metric: AnalyticsMetric | undefined,
): (left: AnalyticsRawSession, right: AnalyticsRawSession) => number {
  return (left, right) => {
    if (metric !== undefined) {
      const a = analyticsRawMetricValue(left, metric);
      const b = analyticsRawMetricValue(right, metric);
      if (a !== b) {
        if (a === null) return 1;
        if (b === null) return -1;
        return b - a;
      }
    }
    const recency = (Date.parse(right.createdAt ?? '') || 0) - (Date.parse(left.createdAt ?? '') || 0);
    if (recency !== 0) return recency;
    if (left.id !== right.id) return left.id < right.id ? -1 : 1;
    const [a, b] = [left.machine ?? '', right.machine ?? ''];
    return a === b ? 0 : a < b ? -1 : 1;
  };
}

function laterInstant(left: string | undefined, right: string | undefined): string | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function mergeIndex(left: AnalyticsIndexStatus, right: AnalyticsIndexStatus): AnalyticsIndexStatus {
  const lastTokenRefreshAt = laterInstant(left.lastTokenRefreshAt, right.lastTokenRefreshAt);
  return {
    // The OLDEST derivation in the fleet, so a reader never mistakes a mixed fleet for an upgraded one.
    schemaVersion: Math.min(left.schemaVersion, right.schemaVersion),
    sessions: left.sessions + right.sessions,
    tokenSessions: left.tokenSessions + right.tokenSessions,
    transcriptSources: left.transcriptSources + right.transcriptSources,
    indexedTranscriptSources: left.indexedTranscriptSources + right.indexedTranscriptSources,
    pendingTranscriptSources: left.pendingTranscriptSources + right.pendingTranscriptSources,
    sourceErrors: left.sourceErrors + right.sourceErrors,
    refreshing: left.refreshing || right.refreshing,
    ...(lastTokenRefreshAt === undefined ? {} : { lastTokenRefreshAt }),
  };
}

function mergeScope(left: AnalyticsResponse['scope'], right: AnalyticsResponse['scope']): AnalyticsResponse['scope'] {
  const window =
    left.window === undefined
      ? right.window
      : right.window === undefined
        ? left.window
        : {
            from: Date.parse(right.window.from) < Date.parse(left.window.from) ? right.window.from : left.window.from,
            to: laterInstant(left.window.to, right.window.to) ?? left.window.to,
          };
  return {
    allSessions: true,
    indexed: left.indexed + right.indexed,
    matched: left.matched + right.matched,
    ...(window === undefined ? {} : { window }),
  };
}

function assertSameQuestion(left: AnalyticsResponse, right: AnalyticsResponse): void {
  if (left.kind !== right.kind)
    throw new AnalyticsMergeError(`cannot merge a ${left.kind} answer with a ${right.kind} one`);
  if (left.parsed.aggregation !== right.parsed.aggregation) {
    throw new AnalyticsMergeError('cannot merge answers aggregated differently');
  }
  if (left.parsed.metric !== right.parsed.metric)
    throw new AnalyticsMergeError('cannot merge answers about different metrics');
  if (left.parsed.groupBy.join('\u0000') !== right.parsed.groupBy.join('\u0000')) {
    throw new AnalyticsMergeError('cannot merge answers grouped differently');
  }
}

function mergePair(left: AnalyticsResponse, right: AnalyticsResponse): AnalyticsResponse {
  assertSameQuestion(left, right);
  const base = {
    query: left.query,
    parsed: left.parsed,
    scope: mergeScope(left.scope, right.scope),
    index: mergeIndex(left.index, right.index),
  };
  if (left.kind === 'raw' && right.kind === 'raw') {
    const limit = Math.max(left.limit, right.limit);
    const rows = [...left.results, ...right.results].sort(compareAnalyticsRawSessions(left.parsed.metric));
    return {
      ...base,
      kind: 'raw',
      limit,
      truncated: left.truncated || right.truncated || rows.length > limit,
      results: rows.slice(0, limit),
    };
  }
  // assertSameQuestion proved both kinds equal, so both are aggregate here.
  const aggregate = left as Extract<AnalyticsResponse, { kind: 'aggregate' }>;
  const other = right as Extract<AnalyticsResponse, { kind: 'aggregate' }>;
  const { groupBy } = aggregate.parsed;
  const key = (row: AnalyticsAggregateResult) => JSON.stringify(groupBy.map(label => row.labels[label] ?? null));
  const rows = new Map<string, AnalyticsAggregateResult>();
  for (const row of [...aggregate.results, ...other.results]) {
    const existing = rows.get(key(row));
    rows.set(key(row), existing === undefined ? row : mergeRow(existing, row, aggregate.aggregation));
  }
  const results = [...rows.values()].sort((a, b) =>
    analyticsGroupSortKey(a.labels, groupBy).localeCompare(analyticsGroupSortKey(b.labels, groupBy)),
  );
  return { ...base, kind: 'aggregate', aggregation: aggregate.aggregation, results };
}

/**
 * One answer from several machines' answers to the same query.
 *
 * EXACT for sum, count, min and max, and for avg up to floating-point rounding, because each part is
 * merged from what it carries rather than from a rounded summary: averages weigh by `known`, rates by
 * sessions, and a ratio metric (active time per turn) is read AFTER the merge from the merged
 * numerator and denominator, never by averaging per-machine ratios. Rows merge only when every grouping
 * label matches. Refuses an empty list and answers to different questions.
 */
export function mergeAnalyticsResponses(responses: readonly AnalyticsResponse[]): AnalyticsResponse {
  const [first, ...rest] = responses;
  if (first === undefined) throw new AnalyticsMergeError('there is no answer to merge');
  return rest.reduce(mergePair, first);
}
