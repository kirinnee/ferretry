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
