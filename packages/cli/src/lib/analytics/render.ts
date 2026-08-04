import type { AnalyticsAggregateResult, AnalyticsRawSession, AnalyticsResponse } from '@ferretry/protocol';
import { DASH, compactNumber, duration, measure, percent, renderTable, usdMicros } from './format.ts';

/**
 * The one sentence every surface must print beside an equivalent cost.
 *
 * It names the OPERATOR as the source of the rates because that is now where they come from, and a
 * number attributed to a public table an operator never used is misattributed even when it happens
 * to match. What the sentence must never stop saying is that this is not a bill: fleet accounts are
 * commonly subscriptions, where marginal token cost is not what the human actually pays.
 */
export const EQUIVALENT_API_COST_CAVEAT =
  'Equivalent API cost is what this usage would cost at the rates this daemon’s operator configured — a comparison, not a bill.';

const COVERAGE_LEGEND =
  '[known/total] marks a group the index cannot fully account for; no zero or partial value is substituted.';

const NO_MATCHES = 'No sessions match the query.';

const COUNT_HEADER = ['GROUP', 'SESSIONS', 'STALL', 'FAIL', 'DONE'] as const;

const AGGREGATE_HEADER = [
  'GROUP',
  'SESSIONS',
  'INPUT',
  'OUTPUT',
  'CACHE READ',
  'CACHE WRITE',
  'TOTAL',
  'EQUIV API COST',
  'TURNS',
  'DURATION',
  'TTFO',
  'CTX END',
  'STALL',
  'FAIL',
  'DONE',
] as const;

const RAW_HEADER = [
  'ID',
  'STATUS',
  'AGENT',
  'MODEL',
  'HARNESS',
  'LABEL',
  'TOKENS',
  'EQUIV API COST',
  'TURNS',
  'DURATION',
] as const;

/** How a group of labels reads in the GROUP column; an ungrouped query covers everything. */
function groupLabel(labels: Record<string, string | null>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return 'all';
  return entries.map(([label, value]) => `${label}=${value ?? DASH}`).join(', ');
}

/**
 * Most expensive group first, unknown cost last.
 *
 * kteam sorted on cost alone, so two groups of equal cost — every group, under `count` — came out in
 * whatever order the engine happened to emit. Ties now break on sessions then group label, which
 * makes the table reproducible and diffable.
 */
function byCostDescending(left: AnalyticsAggregateResult, right: AnalyticsAggregateResult): number {
  const leftCost = left.equivalentApiCostUsdMicros.value;
  const rightCost = right.equivalentApiCostUsdMicros.value;
  if (leftCost === null && rightCost !== null) return 1;
  if (rightCost === null && leftCost !== null) return -1;
  if (leftCost !== null && rightCost !== null && leftCost !== rightCost) return rightCost - leftCost;
  if (left.sessions !== right.sessions) return right.sessions - left.sessions;
  return groupLabel(left.labels).localeCompare(groupLabel(right.labels));
}

const optional = (value: string | null): string => value ?? DASH;

const optionalNumber = (value: number | null, format: (number: number) => string): string =>
  value === null ? DASH : format(value);

function countRow(result: AnalyticsAggregateResult): string[] {
  return [groupLabel(result.labels), String(result.sessions), ...rates(result)];
}

function rates(result: AnalyticsAggregateResult): string[] {
  return [percent(result.rates.stall), percent(result.rates.failure), percent(result.rates.completion)];
}

function aggregateRow(result: AnalyticsAggregateResult): string[] {
  return [
    groupLabel(result.labels),
    String(result.sessions),
    measure(result.inputTokens, compactNumber),
    measure(result.outputTokens, compactNumber),
    measure(result.cachedInputTokens, compactNumber),
    measure(result.cacheWriteInputTokens, compactNumber),
    measure(result.tokens, compactNumber),
    measure(result.equivalentApiCostUsdMicros, usdMicros),
    measure(result.turns, compactNumber),
    measure(result.durationMs, duration),
    measure(result.timeToFirstOutputMs, duration),
    measure(result.contextEndPercent, percent),
    ...rates(result),
  ];
}

function rawRow(result: AnalyticsRawSession): string[] {
  return [
    result.id,
    optional(result.status),
    optional(result.agent),
    optional(result.model),
    optional(result.harness),
    optional(result.label),
    optionalNumber(result.tokens, compactNumber),
    optionalNumber(result.equivalentApiCostUsdMicros, usdMicros),
    optionalNumber(result.turns, compactNumber),
    optionalNumber(result.durationMs, duration),
  ];
}

/** How complete the token index is behind the numbers just printed. */
function indexFooter(index: AnalyticsResponse['index']): string {
  const pending = index.pendingTranscriptSources === 0 ? '' : ` (${index.pendingTranscriptSources} pending)`;
  const errors = index.sourceErrors === 0 ? '' : `, ${index.sourceErrors} errors`;
  return (
    `Token index: ${index.tokenSessions}/${index.sessions} sessions known; ` +
    `${index.indexedTranscriptSources}/${index.transcriptSources} transcript sources indexed${pending}${errors}.`
  );
}

function body(response: AnalyticsResponse): string[] {
  if (response.kind === 'aggregate') {
    const countOnly = response.aggregation === 'count';
    const results = countOnly ? response.results : [...response.results].sort(byCostDescending);
    if (results.length === 0) return [NO_MATCHES];
    return countOnly
      ? [renderTable(COUNT_HEADER, results.map(countRow))]
      : [renderTable(AGGREGATE_HEADER, results.map(aggregateRow))];
  }

  if (response.results.length === 0) return [NO_MATCHES];
  const table = renderTable(RAW_HEADER, response.results.map(rawRow));
  if (!response.truncated) return [table];
  return [table, '', `Showing ${response.limit} of ${response.scope.matched} rows; add a filter.`];
}

/** The stable, colour-free terminal form. `--json` callers get the protocol object verbatim instead. */
export function renderAnalytics(response: AnalyticsResponse): string {
  const lines = [
    `All sessions: ${response.scope.indexed} indexed, ${response.scope.matched} matched`,
    `Query: ${response.query === '' ? '(none)' : response.query}`,
    '',
    ...body(response),
    '',
    indexFooter(response.index),
  ];
  if (response.index.refreshing) lines.push('Token backfill is running in the daemon.');
  lines.push(COVERAGE_LEGEND, EQUIVALENT_API_COST_CAVEAT);
  return lines.join('\n');
}
