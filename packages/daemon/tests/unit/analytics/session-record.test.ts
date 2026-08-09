import { describe, it } from 'bun:test';
import should from 'should';
import type { AnalyticsPricingRate } from '../../../src/lib/analytics/pricing.ts';
import {
  deriveAnalyticsSessionRecord,
  rebuildAnalyticsSessionIndex,
  type FinishedAnalyticsSession,
  type FinishedAnalyticsSessionSource,
} from '../../../src/lib/analytics/session-record.ts';

const catalog: readonly AnalyticsPricingRate[] = [
  {
    pricingKey: 'openai:transcript-model@2026-01-01',
    modelId: 'transcript-model',
    aliases: ['TRANSCRIPT-MODEL-preview'],
    provider: 'openai',
    currency: 'USD',
    rates: {
      input: 1_000_000,
      output: 5_000_000,
      cachedInput: 100_000,
      cacheWrite: 1_250_000,
      cacheWrite5m: null,
      cacheWrite1h: null,
      reasoning: null,
      image: null,
      tool: null,
    },
    source: { kind: 'manual' },
    verifiedAt: '2026-01-01T00:00:00Z',
    validFrom: '2026-01-01T00:00:00Z',
    validThrough: null,
    lastSyncedAt: null,
  },
];

const finished: FinishedAnalyticsSession = {
  id: 'session-1',
  agent: 'codex-auto-example',
  selectedModel: 'Display-Model[1m]',
  harness: 'codex',
  mode: 'auto',
  status: 'completed',
  label: 'analytics',
  cwd: '/work/repo',
  parent: null,
  createdAt: '2026-07-30T12:00:00+00:00',
  startedAt: '2026-07-30T12:00:01Z',
  finishedAt: '2026-07-30T12:01:01.000Z',
  firstOutputAt: '2026-07-30T12:00:03Z',
  turns: 3,
  contextEndPercent: 42.5,
  stalled: false,
  failed: false,
  migrated: false,
  completed: true,
  usage: {
    pricingModel: 'TRANSCRIPT-MODEL-preview-20260701',
    inputTokens: 1_000,
    cachedInputTokens: 100,
    cacheWriteInputTokens: 50,
    outputTokens: 200,
  },
};

describe('deriveAnalyticsSessionRecord', () => {
  it('should derive metrics while keeping display and pricing evidence distinct', () => {
    // Act
    const actual = deriveAnalyticsSessionRecord(finished, catalog);

    // Assert
    should(actual.raw.model).equal('display-model');
    should(actual.raw.contextWindow).equal(1_000_000);
    should(actual.raw.pricingModel).equal('transcript-model');
    should(actual.displayModelIdentity?.raw).equal('Display-Model[1m]');
    should(actual.pricing?.identity?.raw).equal('TRANSCRIPT-MODEL-preview-20260701');
    should(actual.raw.createdAt).equal('2026-07-30T12:00:00.000Z');
    should(actual.raw.day).equal('2026-07-30');
    should(actual.raw.week).equal('2026-07-27');
    should(actual.raw.tokens).equal(1_200);
    should(actual.raw.durationMs).equal(60_000);
    should(actual.raw.timeToFirstOutputMs).equal(2_000);
    should(actual.raw.equivalentApiCostUsdMicros).equal(1_923);
  });

  it('should carry a reasoning total without counting it a second time in the token total', () => {
    // Reasoning is already INSIDE `outputTokens`, so `tokens` — what the session billed — must not
    // grow by it. Adding it would inflate every Codex row by however much the model thought.
    // Act
    const counted = deriveAnalyticsSessionRecord(
      { ...finished, usage: { ...finished.usage!, reasoningTokens: 60 } },
      catalog,
    );
    const silent = deriveAnalyticsSessionRecord(finished, catalog);

    // Assert
    should(counted.raw.reasoningTokens).equal(60);
    should(counted.raw.outputTokens).equal(200);
    should(counted.raw.tokens).equal(1_200);
    // A transcript that named no reasoning figure leaves the column unknown, never zero: "this
    // session did no reasoning" is a claim, and nobody made it.
    should(silent.raw.reasoningTokens).be.null();
  });

  it('should honor an explicit context window and persist an effective rate snapshot', () => {
    // Act
    const actual = deriveAnalyticsSessionRecord({ ...finished, contextWindow: 200_000 }, catalog);

    // Assert
    should(actual.raw.contextWindow).equal(200_000);
    should(actual.pricing).have.property('kind', 'priced');
    if (actual.pricing?.kind === 'priced') {
      should(actual.pricing.rate.ratesUsdMicrosPerMillion).deepEqual({
        input: 1_000_000,
        cachedRead: 100_000,
        output: 5_000_000,
        cacheWrite: 1_250_000,
      });
    }
  });

  it('should keep every unknown metric unknown instead of inventing zeroes', () => {
    // Arrange
    const incomplete: FinishedAnalyticsSession = {
      ...finished,
      selectedModel: null,
      startedAt: 'invalid',
      finishedAt: 'also-invalid',
      firstOutputAt: null,
      turns: -1,
      contextEndPercent: 101,
      usage: { ...finished.usage!, outputTokens: null },
    };

    // Act
    const actual = deriveAnalyticsSessionRecord(incomplete, []);

    // Assert
    should(actual.raw.model).be.null();
    should(actual.raw.tokens).be.null();
    should(actual.raw.inputTokens).be.null();
    should(actual.raw.durationMs).be.null();
    should(actual.raw.timeToFirstOutputMs).be.null();
    should(actual.raw.turns).be.null();
    should(actual.raw.contextEndPercent).be.null();
    should(actual.raw.equivalentApiCostUsdMicros).be.null();
    should(actual.pricing).have.property('kind', 'unpriced');
  });

  it('should handle missing usage and clamp negative elapsed metrics', () => {
    // Arrange
    const noUsage: FinishedAnalyticsSession = {
      ...finished,
      startedAt: null,
      firstOutputAt: '2026-07-30T11:59:00Z',
      finishedAt: '2026-07-30T11:58:00Z',
      usage: null,
    };

    // Act
    const actual = deriveAnalyticsSessionRecord(noUsage, catalog);

    // Assert
    should(actual.pricing).be.null();
    should(actual.raw.pricingModel).be.null();
    should(actual.raw.tokens).be.null();
    should(actual.raw.durationMs).equal(0);
    should(actual.raw.timeToFirstOutputMs).equal(0);
  });

  it('should rebuild the disposable index from authoritative records and replace duplicate ids', () => {
    // Arrange
    const source: FinishedAnalyticsSessionSource = {
      listFinishedAnalyticsSessions: () => [
        { ...finished, id: 'first', label: 'old' },
        { ...finished, id: 'first', label: 'new' },
        { ...finished, id: 'second', usage: null },
      ],
    };

    // Act
    const actual = rebuildAnalyticsSessionIndex(source, catalog);

    // Assert
    should(actual.map(record => [record.raw.id, record.raw.label, record.pricing?.kind])).deepEqual([
      ['first', 'new', 'priced'],
      ['second', 'analytics', undefined],
    ]);
  });

  it('should leave every token metric unknown when the total cannot be represented safely', () => {
    // Act
    const actual = deriveAnalyticsSessionRecord(
      {
        ...finished,
        usage: {
          ...finished.usage!,
          inputTokens: Number.MAX_SAFE_INTEGER,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 1,
        },
      },
      catalog,
    );

    // Assert
    should(actual.raw.tokens).be.null();
    should(actual.raw.inputTokens).be.null();
    should(actual.raw.outputTokens).be.null();
    should(actual.raw.cachedInputTokens).be.null();
    should(actual.raw.cacheWriteInputTokens).be.null();
  });
});
