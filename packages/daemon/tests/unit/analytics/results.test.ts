import { describe, it } from 'bun:test';
import should from 'should';
import { compareProtocolVersions, type AnalyticsIndexStatus, type AnalyticsRawSession } from '@ferretry/protocol';
import { queryAnalyticsRecords } from '../../../src/lib/analytics/results.ts';

const index: AnalyticsIndexStatus = {
  schemaVersion: 1,
  sessions: 3,
  tokenSessions: 2,
  transcriptSources: 0,
  indexedTranscriptSources: 0,
  pendingTranscriptSources: 0,
  sourceErrors: 0,
  refreshing: false,
};

function record(id: string, patch: Partial<AnalyticsRawSession> = {}): AnalyticsRawSession {
  return {
    id,
    agent: 'codex-auto',
    model: 'gpt-5',
    contextWindow: 1_000_000,
    harness: 'codex',
    mode: 'auto',
    status: 'completed',
    label: 'batch-a',
    cwd: '/work/a',
    parent: null,
    tree: 'root-a',
    day: '2026-07-30',
    week: '2026-07-27',
    createdAt: '2026-07-30T12:00:00.000Z',
    pricingModel: 'gpt-5',
    equivalentApiCostUsdMicros: 20,
    tokens: 100,
    inputTokens: 70,
    outputTokens: 30,
    cachedInputTokens: 5,
    cacheWriteInputTokens: 10,
    cacheWrite5mInputTokens: null,
    cacheWrite1hInputTokens: null,
    reasoningTokens: 12,
    turns: 2,
    durationMs: 1_000,
    timeToFirstOutputMs: 100,
    contextEndPercent: 40,
    stalled: false,
    failed: false,
    migrated: false,
    completed: true,
    ...patch,
  };
}

describe('queryAnalyticsRecords', () => {
  it('should accept equivalent protocol prereleases while interpreting query results', () => {
    // Act
    const actual = compareProtocolVersions('1.0.0-rc.1', '1.0.0-rc.1');

    // Assert
    should(actual).equal(0);
  });

  it('should aggregate matched records while preserving unknown measures', () => {
    // Arrange
    const records = [
      record('a'),
      record('b', { label: 'batch-b', tokens: null, inputTokens: null, status: 'failed', failed: true, stalled: true }),
      record('c', { day: '2026-07-31', model: null, contextWindow: null, completed: false }),
    ];

    // Act
    const actual = queryAnalyticsRecords(records, 'sum by (day) {label=batch-*}', { index });

    // Assert
    should(actual).have.property('kind', 'aggregate');
    if (actual.kind !== 'aggregate') throw new Error('expected aggregate result');
    should(actual.query).equal('sum by (day) {label=batch-*}');
    should(actual.scope).deepEqual({ allSessions: true, indexed: 3, matched: 3 });
    should(actual.results).have.length(2);
    should(actual.results[0]).match({ labels: { day: '2026-07-30' }, sessions: 2 });
    should(actual.results[0]!.rates).deepEqual({ stall: 50, failure: 50, completion: 50 });
    should(actual.results[0]!.tokens).deepEqual({ value: null, known: 1, total: 2 });
    should(actual.results[1]!.tokens).deepEqual({ value: 100, known: 1, total: 1 });
  });

  it('should support all aggregate operations and reject excessive groups', () => {
    // Arrange
    const records = [record('a', { tokens: 10 }), record('b', { tokens: 30 }), record('c', { tokens: 20 })];

    // Act
    const avg = queryAnalyticsRecords(records, 'avg by (harness)', { index });
    const min = queryAnalyticsRecords(records, 'min by (harness)', { index });
    const max = queryAnalyticsRecords(records, 'max by (harness)', { index });
    const count = queryAnalyticsRecords(records, 'count by (harness)', { index });
    let limited: unknown;
    try {
      queryAnalyticsRecords(records, 'sum by (id)', { index, groupLimit: 2 });
    } catch (error) {
      limited = error;
    }

    // Assert
    for (const [result, value] of [
      [avg, 20],
      [min, 10],
      [max, 30],
    ] as const) {
      should(result).have.property('kind', 'aggregate');
      if (result.kind === 'aggregate') should(result.results[0]!.tokens.value).equal(value);
    }
    should(count).have.property('kind', 'aggregate');
    if (count.kind === 'aggregate') should(count.results[0]!.tokens).deepEqual({ value: null, known: 0, total: 0 });
    should((limited as Error).message).containEql('more than 2 groups');
  });

  it('should group and filter by the model a transcript was priced against', () => {
    // THE QUESTION #28 NAMES. `model` is what a person selected and `pricing_model` is what the
    // transcript proves was billed, and they disagree often enough that grouping cost by `model`
    // alone attributes it to the wrong row. Without the second label the disagreement is not even
    // expressible: there is nothing to group the other half of the comparison by.
    // Arrange
    const records = [
      record('agreeing', { model: 'gpt-5', pricingModel: 'gpt-5', equivalentApiCostUsdMicros: 20 }),
      record('disagreeing', { model: 'gpt-5', pricingModel: 'gpt-5-mini', equivalentApiCostUsdMicros: 5 }),
      record('unpriced', { model: 'gpt-5', pricingModel: null, equivalentApiCostUsdMicros: null }),
    ];

    // Act
    const grouped = queryAnalyticsRecords(records, 'sum by (pricing_model)', { index });
    const filtered = queryAnalyticsRecords(records, '{pricing_model=gpt-5-mini}', { index });

    // Assert
    should(grouped).have.property('kind', 'aggregate');
    if (grouped.kind !== 'aggregate') throw new Error('expected aggregate result');
    should(
      grouped.results.map(result => [result.labels.pricing_model, result.equivalentApiCostUsdMicros.value]),
    ).deepEqual([
      ['gpt-5', 20],
      ['gpt-5-mini', 5],
      // A session nobody could price is its own group with an unknown cost, never folded into a total
      // and never counted as zero.
      [null, null],
    ]);
    should(filtered).have.property('kind', 'raw');
    if (filtered.kind === 'raw') should(filtered.results.map(result => result.id)).deepEqual(['disagreeing']);
  });

  it('should aggregate the reasoning measure like every other one', () => {
    // Arrange: one row states a reasoning total and one states none, which is exactly the shape that
    // must come back as a partially-known measure rather than as a sum of the halves it could read.
    const records = [record('a', { reasoningTokens: 12 }), record('b', { reasoningTokens: 30 })];

    // Act
    const summed = queryAnalyticsRecords(records, 'sum by (harness)', { index });
    const partial = queryAnalyticsRecords(
      [record('a', { reasoningTokens: 12 }), record('b', { reasoningTokens: null })],
      'sum by (harness)',
      { index },
    );

    // Assert
    should(summed).have.property('kind', 'aggregate');
    if (summed.kind === 'aggregate') {
      should(summed.results[0]!.reasoningTokens).deepEqual({ value: 42, known: 2, total: 2 });
    }
    should(partial).have.property('kind', 'aggregate');
    if (partial.kind === 'aggregate') {
      should(partial.results[0]!.reasoningTokens).deepEqual({ value: null, known: 1, total: 2 });
    }
  });

  it('should return newest raw rows, apply exact and glob filters, and expose truncation', () => {
    // Arrange
    const records = [
      record('old', { createdAt: '2026-07-30T00:00:00.000Z', label: 'literal-*', contextWindow: null, tokens: null }),
      record('new', { createdAt: '2026-07-31T00:00:00.000Z', label: 'batch-a' }),
      record('same-time-b', { createdAt: '2026-07-31T00:00:00.000Z', label: 'batch-b' }),
    ];

    // Act
    const raw = queryAnalyticsRecords(records, '{label=~batch-?, token_data=known}', { index, rawLimit: 1 });
    const exact = queryAnalyticsRecords(records, '{label==literal-*}', { index });
    const nullMatcher = queryAnalyticsRecords(records, '{context_window=1000000}', { index });

    // Assert
    should(raw).have.property('kind', 'raw');
    if (raw.kind === 'raw') {
      should(raw.truncated).be.true();
      should(raw.limit).equal(1);
      should(raw.results.map(result => result.id)).deepEqual(['new']);
    }
    should(exact).have.property('kind', 'raw');
    if (exact.kind === 'raw') should(exact.results.map(result => result.id)).deepEqual(['old']);
    should(nullMatcher).have.property('kind', 'raw');
    if (nullMatcher.kind === 'raw')
      should(nullMatcher.results.map(result => result.id)).deepEqual(['new', 'same-time-b']);
  });
});
