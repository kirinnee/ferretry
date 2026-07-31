import type {
  AnalyticsAggregateResult,
  AnalyticsIndexStatus,
  AnalyticsMeasure,
  AnalyticsRawSession,
  AnalyticsResponse,
} from '@ferretry/protocol';
import type { IAnalyticsGateway, IAnalyticsOutput } from '../../../src/lib/analytics/ports';

/** A fully-known measure. */
export function known(value: number, total = 4): AnalyticsMeasure {
  return { value, known: total, total };
}

/** A measure covering only part of its group — the case kteam printed as if it were complete. */
export function partial(value: number | null, knownCount: number, total: number): AnalyticsMeasure {
  return { value, known: knownCount, total };
}

/** A measure the index knows nothing about. */
export function unknown(total = 4): AnalyticsMeasure {
  return { value: null, known: 0, total };
}

export const INDEX: AnalyticsIndexStatus = {
  schemaVersion: 1,
  sessions: 40,
  tokenSessions: 32,
  transcriptSources: 10,
  indexedTranscriptSources: 10,
  pendingTranscriptSources: 0,
  sourceErrors: 0,
  refreshing: false,
};

export function aggregate(overrides: Partial<AnalyticsAggregateResult> = {}): AnalyticsAggregateResult {
  return {
    labels: { agent: 'sol' },
    sessions: 4,
    rates: { stall: 5, failure: 12.5, completion: 82.5 },
    tokens: known(1_234_567),
    inputTokens: known(1_000_000),
    outputTokens: known(234_567),
    cachedInputTokens: known(900_000),
    cacheWriteInputTokens: known(100_000),
    cacheWrite5mInputTokens: known(80_000),
    cacheWrite1hInputTokens: known(20_000),
    equivalentApiCostUsdMicros: known(12_500_000),
    turns: known(48),
    durationMs: known(3_725_000),
    timeToFirstOutputMs: known(850),
    contextEndPercent: known(64.25),
    ...overrides,
  };
}

export function rawSession(overrides: Partial<AnalyticsRawSession> = {}): AnalyticsRawSession {
  return {
    id: 'ms8kkfyd',
    agent: 'claude-auto-loge',
    model: 'claude-opus-5',
    contextWindow: 1_000_000,
    harness: 'claude',
    mode: 'auto',
    status: 'completed',
    label: 'cli2',
    cwd: '/work/ferretry',
    parent: null,
    day: '2026-07-31',
    week: '2026-W31',
    createdAt: '2026-07-31T08:00:00.000Z',
    pricingModel: 'claude-opus-5',
    equivalentApiCostUsdMicros: 4_500_000,
    tokens: 512_000,
    inputTokens: 400_000,
    outputTokens: 112_000,
    cachedInputTokens: 300_000,
    cacheWriteInputTokens: 50_000,
    cacheWrite5mInputTokens: 40_000,
    cacheWrite1hInputTokens: 10_000,
    turns: 21,
    durationMs: 95_000,
    timeToFirstOutputMs: 620,
    contextEndPercent: 41.5,
    stalled: false,
    failed: false,
    migrated: false,
    completed: true,
    ...overrides,
  };
}

export function aggregateResponse(
  results: readonly AnalyticsAggregateResult[],
  overrides: Partial<Omit<AnalyticsResponse & { kind: 'aggregate' }, 'kind'>> = {},
): AnalyticsResponse {
  return {
    kind: 'aggregate',
    query: 'sum(tokens) by agent',
    parsed: { aggregation: 'sum', groupBy: ['agent'], matchers: [] },
    scope: { allSessions: true, indexed: 40, matched: 24 },
    index: INDEX,
    aggregation: 'sum',
    results: [...results],
    ...overrides,
  };
}

export function rawResponse(
  results: readonly AnalyticsRawSession[],
  overrides: Partial<Omit<AnalyticsResponse & { kind: 'raw' }, 'kind'>> = {},
): AnalyticsResponse {
  return {
    kind: 'raw',
    query: 'agent="claude-auto-loge"',
    parsed: { groupBy: [], matchers: [] },
    scope: { allSessions: true, indexed: 40, matched: 24 },
    index: INDEX,
    limit: 20,
    truncated: false,
    results: [...results],
    ...overrides,
  };
}

/** Answers with a canned response and records the query the controller decided to send. */
export class RecordingAnalyticsGateway implements IAnalyticsGateway {
  readonly queries: Array<string | undefined> = [];

  constructor(private readonly response: AnalyticsResponse) {}

  analytics(query?: string): Promise<AnalyticsResponse> {
    this.queries.push(query);
    return Promise.resolve(this.response);
  }
}

/** Captures what the controller printed. */
export class CapturingOutput implements IAnalyticsOutput {
  readonly messages: string[] = [];

  success(message: string): void {
    this.messages.push(message);
  }
}
