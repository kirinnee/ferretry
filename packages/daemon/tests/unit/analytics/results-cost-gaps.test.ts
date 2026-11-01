import { describe, it } from 'bun:test';
import type { AnalyticsIndexStatus, AnalyticsRawSession } from '@ferretry/protocol';
import should from 'should';
import { queryAnalyticsRecords } from '../../../src/lib/analytics/results.ts';

const index: AnalyticsIndexStatus = {
  schemaVersion: 4,
  sessions: 4,
  tokenSessions: 3,
  transcriptSources: 0,
  indexedTranscriptSources: 0,
  pendingTranscriptSources: 0,
  sourceErrors: 0,
  refreshing: false,
};

function session(id: string, patch: Partial<AnalyticsRawSession> = {}): AnalyticsRawSession {
  return {
    id,
    agent: 'claude-auto',
    model: 'claude-opus-5-5',
    contextWindow: null,
    harness: 'claude',
    mode: 'auto',
    status: 'completed',
    label: null,
    cwd: '/work',
    parent: null,
    tree: id,
    day: '2026-10-30',
    week: '2026-10-26',
    createdAt: '2026-10-30T12:00:00.000Z',
    pricingModel: 'claude-opus-5-5',
    equivalentApiCostUsdMicros: 1_000,
    tokens: 100,
    inputTokens: 70,
    outputTokens: 30,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    cacheWrite5mInputTokens: 0,
    cacheWrite1hInputTokens: 0,
    reasoningTokens: null,
    turns: 1,
    durationMs: 1_000,
    activeDurationMs: 500,
    machine: null,
    timeToFirstOutputMs: 100,
    contextEndPercent: 10,
    stalled: false,
    failed: false,
    migrated: false,
    completed: true,
    ...patch,
  };
}

const unpriced = (id: string, costGap: string, tokens: number | null = null): AnalyticsRawSession =>
  session(id, { equivalentApiCostUsdMicros: null, tokens, costGap });

const aggregate = (records: readonly AnalyticsRawSession[], query: string) => {
  const response = queryAnalyticsRecords(records, query, { index });
  if (response.kind !== 'aggregate') throw new Error('expected an aggregate response');
  return response.results;
};

describe('a group with some sessions unpriced', () => {
  it('should keep the sum of what priced as a lower bound instead of blanking the group', () => {
    // Arrange
    const records = [
      session('a'),
      session('b', { equivalentApiCostUsdMicros: 2_500 }),
      unpriced('c', 'transcript_damaged'),
    ];

    // Act
    const [row] = aggregate(records, 'sum by (model)');

    // Assert
    should(row!.equivalentApiCostUsdMicros).deepEqual({ value: null, known: 2, total: 3, knownSum: 3_500 });
  });

  it('should keep the token lower bound too, since the same gap blanks it', () => {
    // Arrange
    const records = [session('a'), session('b'), unpriced('c', 'transcript_damaged')];

    // Act
    const [row] = aggregate(records, 'sum by (model)');

    // Assert
    should(row!.tokens).deepEqual({ value: null, known: 2, total: 3, knownSum: 200 });
  });

  it('should count the gaps by reason, summing to the sessions that have no cost', () => {
    // Arrange
    const records = [
      session('a'),
      unpriced('b', 'transcript_damaged'),
      unpriced('c', 'missing_pricing_model', 50),
      unpriced('d', 'missing_pricing_model', 60),
    ];

    // Act
    const [row] = aggregate(records, 'sum by (model)');

    // Assert
    should(row!.costGaps).deepEqual({ transcript_damaged: 1, missing_pricing_model: 2 });
  });

  it('should name a cost gap with no stated reason, never drop it', () => {
    // Arrange
    const records = [session('a'), session('b', { equivalentApiCostUsdMicros: null, costGap: undefined })];

    // Act
    const [row] = aggregate(records, 'sum by (model)');

    // Assert
    should(row!.costGaps).deepEqual({ unknown: 1 });
  });

  it('should not state a lower bound or gaps for a fully priced group', () => {
    // Arrange
    const records = [session('a'), session('b')];

    // Act
    const [row] = aggregate(records, 'sum by (model)');

    // Assert
    should(row!.equivalentApiCostUsdMicros).deepEqual({ value: 2_000, known: 2, total: 2 });
    should(row!.costGaps).be.undefined();
  });

  it('should state no lower bound when no session priced at all', () => {
    // Arrange
    const records = [unpriced('a', 'transcript_unresolved'), unpriced('b', 'transcript_unresolved')];

    // Act
    const [row] = aggregate(records, 'sum by (model)');

    // Assert
    should(row!.equivalentApiCostUsdMicros).deepEqual({ value: null, known: 0, total: 2 });
    should(row!.costGaps).deepEqual({ transcript_unresolved: 2 });
  });

  it('should leave an average partial with no bound, because a partial mean is not a bound', () => {
    // Arrange
    const records = [session('a'), unpriced('b', 'transcript_damaged')];

    // Act
    const [row] = aggregate(records, 'avg by (model)');

    // Assert
    should(row!.equivalentApiCostUsdMicros).deepEqual({ value: null, known: 1, total: 2 });
  });
});
